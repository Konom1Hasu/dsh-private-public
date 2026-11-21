#!/usr/bin/env python3
"""triage.py -- 文件类型快速判定（Python 标准库，无外部依赖）。

  python triage.py file   <path>              魔数 + 结构判定
  python triage.py pe     <path>              PE 详情：架构/节表/导入/.NET/熵
  python triage.py strings <path> [--min 6] [--utf16] [--grep REGEX]
  python triage.py scan   <dir>               批量分类
"""
from __future__ import annotations

import argparse
import math
import os
import re
import struct
import sys

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---------------- 魔数表 ----------------
MAGICS = [
    (b'MZ',                      'PE executable (Windows, exe/dll)'),
    (b'\x7fELF',                 'ELF executable (Linux)'),
    (b'\xfe\xed\xfa\xce',        'Mach-O 32-bit'),
    (b'\xfe\xed\xfa\xcf',        'Mach-O 64-bit'),
    (b'\xca\xfe\xba\xbe',        'Mach-O universal / Java class'),
    (b'PK\x03\x04',              'ZIP family (zip/apk/jar/whl/nupkg/epub/docx)'),
    (b'PK\x05\x06',              'ZIP empty archive'),
    (b'\x1f\x8b',                'gzip'),
    (b'BZh',                     'bzip2'),
    (b'\xfd7zXZ\x00',            'xz'),
    (b'7z\xbc\xaf\x27\x1c',      '7-Zip archive'),
    (b'Rar!\x1a\x07',            'RAR archive'),
    (b'\x89PNG\r\n\x1a\n',       'PNG image'),
    (b'\xff\xd8\xff',            'JPEG image'),
    (b'GIF8',                    'GIF image'),
    (b'BM',                      'BMP image'),
    (b'RIFF',                    'RIFF container (wav/avi/webp)'),
    (b'ID3',                     'MP3 with ID3'),
    (b'OggS',                    'OGG container'),
    (b'fLaC',                    'FLAC audio'),
    (b'%PDF',                    'PDF document'),
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'OLE2 (doc/xls/ppt legacy)'),
    (b'SQLite format 3',         'SQLite database'),
    (b'\x00asm',                 'WebAssembly'),
    (b'ustar',                   'tar archive'),
    (b'#!',                      'script with shebang'),
]


def read_head(path: str, n: int = 16) -> bytes:
    with open(path, 'rb') as f:
        return f.read(n)


def detect(path: str) -> tuple[str, str]:
    """返回 (kind, note)。"""
    head = read_head(path, 512)
    for magic, kind in MAGICS:
        if head.startswith(magic):
            note = ''
            if magic == b'#!':
                note = head.split(b'\n', 1)[0].decode('utf-8', 'replace')[:80]
            return kind, note
    # tar 的魔数在偏移 257
    if len(head) >= 265 and head[257:262] == b'ustar':
        return 'tar archive', ''
    # 全可打印 → 文本
    sample = head[:256]
    if sample and all((32 <= b < 127) or b in (9, 10, 13) or b >= 128 for b in sample):
        try:
            open(path, 'r', encoding='utf-8').read(4096)
            return 'text (UTF-8)', ''
        except UnicodeDecodeError:
            return 'text (non-UTF8)', '可能是 GBK/GB18030 或二进制'
    return 'unknown', f'head={head[:8].hex()}'


# ---------------- PE ----------------
def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    freq = [0] * 256
    for b in data:
        freq[b] += 1
    n = len(data)
    ent = -sum((c / n) * math.log2(c / n) for c in freq if c)
    return max(0.0, ent)  # 单字节分布会算出 -0.0，归一化
def parse_pe(path: str) -> dict | None:
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'MZ':
        return None
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b'PE\0\0':
        return None
    coff = e_lfanew + 4
    machine, nsec, _, _, _, opt_size, chars = struct.unpack_from('<HHIIIHH', data, coff)
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    is64 = magic == 0x20B
    info = {
        'machine': {0x14C: 'x86 (32-bit)', 0x8664: 'x64', 0xAA64: 'ARM64', 0x1C0: 'ARM'}.get(machine, hex(machine)),
        'is64': is64,
        'sections': nsec,
        'characteristics': hex(chars),
        'is_dll': bool(chars & 0x2000),
        'subsystem': None,
        'is_dotnet': False,
        'sect_table': [],
    }
    # 数据目录：找 CLR Runtime Header（第 15 项）
    dd_off = opt + (112 if is64 else 96)
    try:
        ndirs = struct.unpack_from('<I', data, dd_off - 4)[0]
        if ndirs > 14:
            clr_rva, clr_size = struct.unpack_from('<II', data, dd_off + 14 * 8)
            info['is_dotnet'] = clr_rva != 0 and clr_size != 0
    except Exception:
        pass
    try:
        info['subsystem'] = struct.unpack_from('<H', data, opt + (68 if is64 else 68))[0]
    except Exception:
        pass
    # 节表
    sect = opt + opt_size
    for i in range(min(nsec, 32)):
        off = sect + i * 40
        try:
            name = data[off:off + 8].rstrip(b'\0').decode('latin1')
            vsize, vaddr, rawsize, rawptr = struct.unpack_from('<IIII', data, off + 8)
            body = data[rawptr:rawptr + rawsize] if rawsize else b''
            info['sect_table'].append({
                'name': name, 'vsize': vsize, 'rawsize': rawsize,
                'entropy': round(entropy(body), 2),
            })
        except Exception:
            break
    packed = any(s['name'].lower().startswith(('upx', '.aspack', '.themida', '.vmp')) for s in info['sect_table'])
    high_ent = [s for s in info['sect_table'] if s['entropy'] > 7.2]
    info['likely_packed'] = packed or len(high_ent) > 0
    return info


# ---------------- strings ----------------
ASCII_RE = re.compile(rb'[\x20-\x7e]{4,}')
UTF16_RE = re.compile(rb'(?:[\x20-\x7e]\x00){4,}')


def cmd_strings(args):
    with open(args.file, 'rb') as f:
        data = f.read(args.head)
    pat = re.compile(args.grep, re.I) if args.grep else None
    out = []
    if not args.utf16:
        for m in ASCII_RE.finditer(data):
            s = m.group().decode('ascii', 'replace')
            if len(s) >= args.min and (not pat or pat.search(s)):
                out.append(s)
    else:
        for m in UTF16_RE.finditer(data):
            s = m.group().decode('utf-16-le', 'replace')
            if len(s) >= args.min and (not pat or pat.search(s)):
                out.append(s)
    for s in out[:args.limit]:
        print(s)
    print(f"\n[{len(out)} matches, showing {min(len(out), args.limit)}]", file=sys.stderr)


# ---------------- 命令 ----------------
def cmd_file(args):
    kind, note = detect(args.file)
    size = os.path.getsize(args.file)
    print(f"file : {args.file}")
    print(f"size : {size} bytes")
    print(f"kind : {kind}")
    if note:
        print(f"note : {note}")
    if kind.startswith('PE'):
        pe = parse_pe(args.file)
        if pe:
            print(f"arch : {pe['machine']}{'  (DLL)' if pe['is_dll'] else ''}")
            print(f".NET : {pe['is_dotnet']}")
            print(f"packed(likely): {pe['likely_packed']}")
    return 0


def cmd_pe(args):
    pe = parse_pe(args.file)
    if not pe:
        print('不是 PE 文件')
        return 1
    print(f"arch      : {pe['machine']}")
    print(f"kind      : {'DLL' if pe['is_dll'] else 'EXE'}")
    print(f"is_dotnet : {pe['is_dotnet']}")
    print(f"packed?   : {pe['likely_packed']}  (启发式)")
    print(f"sections  : {pe['sections']}")
    print('\n  name         vsize   rawsize  entropy')
    for s in pe['sect_table']:
        flag = '  <-- 高熵' if s['entropy'] > 7.2 else ''
        print(f"  {s['name'][:10]:<12} {s['vsize']:>7} {s['rawsize']:>8}  {s['entropy']:>5}{flag}")
    return 0


def cmd_scan(args):
    buckets = {}
    for root, _, files in os.walk(args.dir):
        for fn in files:
            p = os.path.join(root, fn)
            try:
                kind, _ = detect(p)
            except Exception as e:
                kind = f'error: {e}'
            buckets.setdefault(kind, []).append(p)
    for kind in sorted(buckets, key=lambda k: -len(buckets[k])):
        items = buckets[kind]
        print(f"\n=== {kind} ({len(items)}) ===")
        for p in items[:args.limit]:
            print(f"  {os.path.getsize(p):>10}  {p}")
        if len(items) > args.limit:
            print(f"  … {len(items) - args.limit} more")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('file'); p.add_argument('file'); p.set_defaults(func=cmd_file)
    p = sub.add_parser('pe'); p.add_argument('file'); p.set_defaults(func=cmd_pe)

    p = sub.add_parser('strings'); p.add_argument('file')
    p.add_argument('--min', type=int, default=4); p.add_argument('--utf16', action='store_true')
    p.add_argument('--grep'); p.add_argument('--limit', type=int, default=200)
    p.add_argument('--head', type=int, default=8 * 1024 * 1024)
    p.set_defaults(func=cmd_strings)

    p = sub.add_parser('scan'); p.add_argument('dir'); p.add_argument('--limit', type=int, default=8)
    p.set_defaults(func=cmd_scan)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == '__main__':
    main()
