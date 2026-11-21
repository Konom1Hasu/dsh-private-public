#!/usr/bin/env python3
"""archive.py -- 归档检视与解包，纯标准库。

支持：zip / apk / ipa / jar / whl / nupkg / epub / tar / tar.gz / tgz / tar.bz2 / tar.xz
     以及单文件 .gz / .bz2 / .xz

用法：
  python archive.py list    <file> [--limit N] [--grep REGEX]
  python archive.py extract <file> -o <dir> [--grep REGEX]
  python archive.py find    <file> <substr>
  python archive.py info    <file>
"""
from __future__ import annotations

import argparse
import bz2
import gzip
import io
import lzma
import os
import re
import sys
import tarfile
import zipfile

# Windows 控制台默认 GBK，直接 print 中文会乱码。强制 stdout 走 UTF-8。
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---- 文件名解码：zipfile 对非 UTF-8 条目会按 cp437 解，中文包常是 GBK ----
def decode_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:  # UTF-8 标志位
        return name
    try:
        return name.encode('cp437').decode('gbk')
    except Exception:
        return name


def fmt_size(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f"{n:.1f}{unit}" if unit != 'B' else f"{n}B"
        n /= 1024
    return f"{n:.1f}GB"


def safe_join(base: str, name: str) -> str:
    """防路径穿越：归一化后必须在 base 之内。"""
    target = os.path.normpath(os.path.join(base, name))
    base_abs = os.path.abspath(base)
    if not os.path.abspath(target).startswith(base_abs + os.sep) and os.path.abspath(target) != base_abs:
        raise ValueError(f"path traversal blocked: {name}")
    return target


# ---------------- zip 系 ----------------
def is_zip(path: str) -> bool:
    try:
        return zipfile.is_zipfile(path)
    except Exception:
        return False


def zip_entries(path: str):
    zf = zipfile.ZipFile(path)
    for info in zf.infolist():
        if info.is_dir():
            continue
        yield decode_name(info), info.file_size, info.compress_size
    zf.close()


def zip_extract(path: str, outdir: str, grep: str | None):
    pat = re.compile(grep, re.I) if grep else None
    zf = zipfile.ZipFile(path)
    n = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = decode_name(info)
        if pat and not pat.search(name):
            continue
        target = safe_join(outdir, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, 'wb') as dst:
            dst.write(src.read())
        n += 1
    zf.close()
    print(f"extracted {n} file(s) -> {outdir}")


# ---------------- tar 系 ----------------
def tar_entries(path: str):
    with tarfile.open(path, 'r:*') as tf:
        for m in tf:
            if m.isfile():
                yield m.name, m.size, m.size


def tar_extract(path: str, outdir: str, grep: str | None):
    pat = re.compile(grep, re.I) if grep else None
    n = 0
    with tarfile.open(path, 'r:*') as tf:
        for m in tf:
            if not m.isfile():
                continue
            if pat and not pat.search(m.name):
                continue
            target = safe_join(outdir, m.name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            with open(target, 'wb') as dst:
                dst.write(f.read())
            n += 1
    print(f"extracted {n} file(s) -> {outdir}")


# ---------------- 单文件压缩 ----------------
def single_decompress(path: str, outdir: str):
    """a.log.gz / a.bin.bz2 / a.bin.xz -> 解出单个文件。"""
    low = path.lower()
    if low.endswith('.gz'):
        opener, strip = gzip.open, '.gz'
    elif low.endswith('.bz2'):
        opener, strip = bz2.open, '.bz2'
    elif low.endswith('.xz'):
        opener, strip = lzma.open, '.xz'
    else:
        raise SystemExit("not a single-file compressed format")
    name = os.path.basename(path)[:-len(strip)]
    target = safe_join(outdir, name)
    os.makedirs(outdir, exist_ok=True)
    with opener(path, 'rb') as src, open(target, 'wb') as dst:
        dst.write(src.read())
    print(f"decompressed -> {target}")


# ---------------- 命令 ----------------
def cmd_list(args):
    if is_zip(args.file):
        rows = list(zip_entries(args.file))
    elif tarfile.is_tarfile(args.file):
        rows = list(tar_entries(args.file))
    else:
        print("不是 zip 或 tar，尝试按单文件压缩处理（用 extract）")
        return 1
    pat = re.compile(args.grep, re.I) if args.grep else None
    shown = 0
    total_raw = 0
    total_cmp = 0
    for name, raw, cmp_ in rows:
        total_raw += raw
        total_cmp += cmp_
        if pat and not pat.search(name):
            continue
        if args.limit and shown >= args.limit:
            continue
        ratio = (cmp_ / raw * 100) if raw else 0
        print(f"{fmt_size(raw):>9}  {ratio:5.1f}%  {name}")
        shown += 1
    print(f"\n条目 {len(rows)}  原始 {fmt_size(total_raw)}  压缩后 {fmt_size(total_cmp)}  "
          f"显示 {shown}")
    return 0


def cmd_extract(args):
    os.makedirs(args.out, exist_ok=True)
    if is_zip(args.file):
        zip_extract(args.file, args.out, args.grep)
    elif tarfile.is_tarfile(args.file):
        tar_extract(args.file, args.out, args.grep)
    else:
        single_decompress(args.file, args.out)
    return 0


def cmd_find(args):
    rows = None
    if is_zip(args.file):
        rows = zip_entries(args.file)
    elif tarfile.is_tarfile(args.file):
        rows = tar_entries(args.file)
    if rows is None:
        print("不支持的格式")
        return 1
    n = 0
    for name, raw, _ in rows:
        if args.substr.lower() in name.lower():
            print(f"{fmt_size(raw):>9}  {name}")
            n += 1
    print(f"\nmatched {n}")
    return 0


def cmd_info(args):
    f = args.file
    size = os.path.getsize(f)
    kind = 'unknown'
    if is_zip(f):
        kind = 'zip-family (zip/apk/jar/whl/nupkg/epub)'
    elif tarfile.is_tarfile(f):
        kind = 'tar-family'
    elif f.lower().endswith(('.gz', '.bz2', '.xz')):
        kind = 'single-file compressed'
    print(f"file  : {f}")
    print(f"size  : {fmt_size(size)}")
    print(f"kind  : {kind}")
    if kind.startswith('zip') or kind.startswith('tar'):
        rows = list(zip_entries(f) if kind.startswith('zip') else tar_entries(f))
        raw = sum(r[1] for r in rows)
        cmp_ = sum(r[2] for r in rows)
        print(f"entries: {len(rows)}")
        print(f"raw   : {fmt_size(raw)}")
        print(f"packed: {fmt_size(cmp_)}  ({cmp_ / raw * 100 if raw else 0:.1f}%)")
    return 0


def main():
    ap = argparse.ArgumentParser(description='archive inspector (stdlib only)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('list'); p.add_argument('file'); p.add_argument('--limit', type=int, default=0); p.add_argument('--grep')
    p.set_defaults(func=cmd_list)

    p = sub.add_parser('extract'); p.add_argument('file'); p.add_argument('-o', '--out', required=True); p.add_argument('--grep')
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser('find'); p.add_argument('file'); p.add_argument('substr')
    p.set_defaults(func=cmd_find)

    p = sub.add_parser('info'); p.add_argument('file')
    p.set_defaults(func=cmd_info)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == '__main__':
    main()
