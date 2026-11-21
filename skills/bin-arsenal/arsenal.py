#!/usr/bin/env python3
"""arsenal.py -- 二进制静态分析 / 反汇编 / 模拟执行 / 特征扫描。

  arsenal.py info     <file>                      架构/壳/入口点
  arsenal.py sections <file>                      节表 + 每节熵
  arsenal.py imports  <file>                      导入表 / 动态符号
  arsenal.py exports  <file>
  arsenal.py strings  <file> [--min N] [--off] [--utf16] [--grep RE]
  arsenal.py entropy  <file> [--block N] [--top N]
  arsenal.py disasm   <file> [--va ADDR | --file-off OFF] [-n N]
  arsenal.py search   <file> --bytes HEX
  arsenal.py emu      <file> --va ADDR [-n N] [--step N]
  arsenal.py yara     <path> --rule <inline 或 .yar 文件>
  arsenal.py carve    <file> --ext .png,.zip

设计：只报有依据的结论。壳识别给四条独立信号，任一命中就说明是哪条。
"""
from __future__ import annotations

import argparse
import math
import re
import struct
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ── 通用 ─────────────────────────────────────────────────────────────
def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    freq = [0] * 256
    for b in data:
        freq[b] += 1
    n = len(data)
    e = -sum((c / n) * math.log2(c / n) for c in freq if c)
    return max(0.0, e)


def read(path: str) -> bytes:
    return Path(path).read_bytes()


PACKER_SECTIONS = {
    "upx0": "UPX", "upx1": "UPX", "upx2": "UPX", ".upx": "UPX",
    ".aspack": "ASPack", ".adata": "ASPack",
    ".themida": "Themida", ".winlice": "Themida",
    ".vmp0": "VMProtect", ".vmp1": "VMProtect", ".vmp2": "VMProtect",
    ".enigma1": "Enigma", ".enigma2": "Enigma",
    ".mpress1": "MPRESS", ".mpress2": "MPRESS",
    ".packed": "generic packer", ".petite": "Petite",
    ".nsp": "NsPack", ".neolite": "NeoLite", ".y0da": "Yoda",
    ".perplex": "Perplex", ".svkp": "SVKP",
}


# ── PE ───────────────────────────────────────────────────────────────
def pe_info(data: bytes) -> dict | None:
    try:
        import pefile
    except ImportError:
        return None
    try:
        pe = pefile.PE(data=data, fast_load=True)
    except Exception:
        return None

    machine = pe.FILE_HEADER.Machine
    arch = {
        0x14c: "x86", 0x8664: "x64", 0xaa64: "ARM64",
        0x1c0: "ARM", 0x1c4: "ARMv7", 0x1f0: "PowerPC",
    }.get(machine, hex(machine))
    is_dll = bool(pe.FILE_HEADER.Characteristics & 0x2000)
    ep_rva = pe.OPTIONAL_HEADER.AddressOfEntryPoint
    image_base = pe.OPTIONAL_HEADER.ImageBase

    sections = []
    for s in pe.sections:
        name = s.Name.rstrip(b"\x00").decode("latin1", "replace")
        body = s.get_data()
        sections.append({
            "name": name,
            "va": s.VirtualAddress,
            "vsize": s.Misc_VirtualSize,
            "rawsize": s.SizeOfRawData,
            "rawptr": s.PointerToRawData,
            "entropy": round(entropy(body), 2),
            "chars": hex(s.Characteristics),
        })

    # 入口点落在哪节
    ep_section = None
    for sec in pe.sections:
        start = sec.VirtualAddress
        end = start + max(sec.Misc_VirtualSize, sec.SizeOfRawData)
        if start <= ep_rva < end:
            ep_section = sec.Name.rstrip(b"\x00").decode("latin1", "replace")
            break

    # 导入表（数量 + 是否靠 LoadLibrary/GetProcAddress）
    imports = []
    try:
        pe.parse_data_directories(directories=[
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
        for entry in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) or []:
            dll = entry.dll.decode("latin1", "replace") if entry.dll else "?"
            funcs = []
            for imp in entry.imports or []:
                if imp.name:
                    funcs.append(imp.name.decode("latin1", "replace"))
                elif imp.ordinal:
                    funcs.append(f"ord{imp.ordinal}")
            imports.append({"dll": dll, "funcs": funcs})
    except Exception:
        pass

    info = {
        "format": "PE",
        "arch": arch,
        "kind": "DLL" if is_dll else "EXE",
        "ep_rva": ep_rva,
        "ep_va": image_base + ep_rva,
        "ep_section": ep_section,
        "image_base": image_base,
        "sections": sections,
        "imports": imports,
        "is_dotnet": False,
    }
    # CLR 目录 = .NET
    try:
        ddir = pe.OPTIONAL_HEADER.DATA_DIRECTORY
        if len(ddir) > 14 and ddir[14].VirtualAddress and ddir[14].Size:
            info["is_dotnet"] = True
    except Exception:
        pass
    try:
        pe.close()
    except Exception:
        pass
    return info


def elf_info(data: bytes) -> dict | None:
    if not data.startswith(b"\x7fELF"):
        return None
    is64 = data[4] == 2
    little = data[5] == 1
    endian = "<" if little else ">"
    e_machine = struct.unpack_from(endian + "H", data, 18)[0]
    arch = {
        3: "x86", 62: "x64", 40: "ARM", 183: "ARM64",
        8: "MIPS", 20: "PowerPC", 243: "RISC-V",
    }.get(e_machine, f"machine={e_machine}")
    return {"format": "ELF", "arch": arch, "is64": is64, "little": little}


def detect_packer(info: dict, data: bytes) -> list[str]:
    """四条独立信号，命中就说明是哪条。不写"可能"。"""
    reasons = []
    if info.get("format") != "PE":
        return reasons

    # 1) 节名白名单
    for sec in info["sections"]:
        low = sec["name"].lower().strip(".")
        if low in PACKER_SECTIONS:
            reasons.append(f"节名 `{sec['name']}` → {PACKER_SECTIONS[low]}")

    # 2) 入口点不在 .text
    ep_sec = (info.get("ep_section") or "").lower()
    if ep_sec and ep_sec not in (".text", ".code", "code", "text"):
        reasons.append(f"入口点在 `{info['ep_section']}` 而非 .text")

    # 3) 高熵节（>7.2）
    hot = [s for s in info["sections"] if s["entropy"] > 7.2 and s["rawsize"] > 1024]
    for s in hot[:3]:
        reasons.append(f"节 `{s['name']}` 熵 {s['entropy']}（>7.2 = 压缩/加密）")

    # 4) rawsize≈0 但 vsize 很大
    #    必须排除标准的未初始化数据段——.bss/.tbss 的 rawsize 本来就是 0，
    #    报它们等于把所有正常程序都标成壳。
    BSS_LIKE = {".bss", "bss", ".tbss", "tbss", ".sbss", "sbss", ".common", ".stack", ".heap"}
    for s in info["sections"]:
        if s["name"].lower() in BSS_LIKE:
            continue
        if s["vsize"] > 0x4000 and s["rawsize"] < 0x400:
            reasons.append(f"节 `{s['name']}` 原始大小 {s['rawsize']} 但虚拟大小 {s['vsize']} → 运行时解压")

    # 5) 导入极少 + 只有内存 API
    total_imports = sum(len(e["funcs"]) for e in info.get("imports") or [])
    mem_apis = {"LoadLibraryA", "LoadLibraryW", "GetProcAddress", "VirtualAlloc",
                "VirtualProtect", "LdrLoadDll"}
    found_mem = set()
    for e in info.get("imports") or []:
        found_mem |= (set(e["funcs"]) & mem_apis)
    if total_imports and total_imports < 12 and found_mem:
        reasons.append(f"导入仅 {total_imports} 个且含动态解析 API（{', '.join(sorted(found_mem)[:3])}）→ 运行时解析")

    return reasons


# ── 命令 ─────────────────────────────────────────────────────────────
def cmd_info(args):
    data = read(args.file)
    info = pe_info(data) or elf_info(data)
    if not info:
        head = data[:16]
        print(f"不是 PE/ELF。头部: {head.hex()}")
        return 1

    print(f"file    : {args.file}")
    print(f"size    : {len(data):,} bytes")
    print(f"format  : {info['format']} {info['arch']} {info.get('kind', '')}".rstrip())
    if info.get("is_dotnet"):
        print("runtime : .NET (CLR 目录非空)")
    if info.get("format") == "PE":
        print(f"imagebase: {hex(info['image_base'])}")
        print(f"entry   : RVA {hex(info['ep_rva'])} → VA {hex(info['ep_va'])}  节 {info['ep_section']}")
    total_imp = sum(len(e["funcs"]) for e in info.get("imports") or [])
    print(f"imports : {len(info.get('imports') or [])} 个 DLL / {total_imp} 个函数")

    packer = detect_packer(info, data)
    print()
    if packer:
        print("壳特征（命中以下信号）：")
        for r in packer:
            print(f"  • {r}")
    else:
        print("壳特征：未命中任何信号（节名/入口点/熵/导入都正常）")
    return 0


def cmd_sections(args):
    info = pe_info(read(args.file))
    if not info:
        print("不是 PE")
        return 1
    print(f"{'name':<10} {'VA':>10} {'vsize':>10} {'rawsize':>10} {'rawptr':>10} {'entropy':>8}")
    for s in info["sections"]:
        flag = "  ←高熵" if s["entropy"] > 7.2 else ""
        print(f"{s['name']:<10} {hex(s['va']):>10} {s['vsize']:>10} {s['rawsize']:>10} "
              f"{hex(s['rawptr']):>10} {s['entropy']:>8}{flag}")
    return 0


def cmd_imports(args):
    info = pe_info(read(args.file))
    if not info:
        print("不是 PE（ELF 动态符号请用 readelf -s）")
        return 1
    for e in info.get("imports") or []:
        print(f"\n{e['dll']}  ({len(e['funcs'])})")
        for i in range(0, len(e["funcs"]), 4):
            print("   " + "  ".join(f"{f:<24}" for f in e["funcs"][i:i + 4]).rstrip())
    if not info.get("imports"):
        print("没有导入表（可能静态链接、或壳清空了导入）")
    return 0


def cmd_exports(args):
    try:
        import pefile
    except ImportError:
        print("需要 pefile")
        return 2
    pe = pefile.PE(args.file, fast_load=True)
    pe.parse_data_directories(directories=[
        pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"]])
    exp = getattr(pe, "DIRECTORY_ENTRY_EXPORT", None)
    if not exp or not exp.symbols:
        print("没有导出表")
        return 0
    print(f"共 {len(exp.symbols)} 个导出")
    for s in exp.symbols[:200]:
        name = s.name.decode("latin1", "replace") if s.name else f"ord{s.ordinal}"
        print(f"  {hex(s.address):>10}  {name}")
    return 0


ASCII_RE = re.compile(rb"[\x20-\x7e]{4,}")
UTF16_RE = re.compile(rb"(?:[\x20-\x7e]\x00){4,}")


def cmd_strings(args):
    data = read(args.file)
    pat = re.compile(args.grep, re.I) if args.grep else None
    out = []
    if args.utf16:
        for m in UTF16_RE.finditer(data):
            s = m.group().decode("utf-16-le", "replace")
            if len(s) >= args.min and (not pat or pat.search(s)):
                out.append((m.start(), s))
    else:
        for m in ASCII_RE.finditer(data):
            s = m.group().decode("ascii", "replace")
            if len(s) >= args.min and (not pat or pat.search(s)):
                out.append((m.start(), s))
    for off, s in out[:args.limit]:
        print(f"{hex(off):>10}  {s}" if args.off else s)
    print(f"\n[{len(out)} 条，显示 {min(len(out), args.limit)}]", file=sys.stderr)
    return 0


def cmd_entropy(args):
    data = read(args.file)
    block = args.block
    n = len(data) // block
    if n == 0:
        print("文件太小")
        return 1
    vals = []
    for i in range(n):
        chunk = data[i * block:(i + 1) * block]
        vals.append((i * block, entropy(chunk)))
    # 顶部高熵块
    hot = sorted(vals, key=lambda x: -x[1])[:args.top]
    print(f"块大小 {block} 字节，共 {n} 块")
    print(f"整体熵: {entropy(data):.2f}")
    print(f"\n熵最高的 {len(hot)} 块：")
    for off, e in hot:
        bar = "█" * int(e * 4)
        print(f"  {hex(off):>10}  {e:5.2f}  {bar}")
    # 连续高熵区间
    runs = []
    cur = None
    for off, e in vals:
        if e > 7.2:
            if cur is None:
                cur = [off, off]
            else:
                cur[1] = off
        else:
            if cur:
                runs.append(tuple(cur))
                cur = None
    if cur:
        runs.append(tuple(cur))
    if runs:
        print("\n连续高熵区间（>7.2，加密/压缩）：")
        for a, b in runs[:10]:
            print(f"  {hex(a)} - {hex(b + block)}  ({(b + block - a) / 1024:.1f} KB)")
    return 0


ARCH_CS = {
    "x86": ("CS_ARCH_X86", "CS_MODE_32"),
    "x64": ("CS_ARCH_X86", "CS_MODE_64"),
    "ARM": ("CS_ARCH_ARM", "CS_MODE_ARM"),
    "ARMv7": ("CS_ARCH_ARM", "CS_MODE_THUMB"),
    "ARM64": ("CS_ARCH_ARM64", "CS_MODE_ARM"),
    "MIPS": ("CS_ARCH_MIPS", "CS_MODE_MIPS32"),
}


def cmd_disasm(args):
    import capstone
    data = read(args.file)
    info = pe_info(data) or elf_info(data)
    if not info:
        print("需要 PE/ELF 才能自动判断架构；也可用 --arch 指定")
        return 1
    arch = args.arch or info["arch"]
    if arch not in ARCH_CS:
        print(f"不支持的架构 {arch}")
        return 1
    a_name, m_name = ARCH_CS[arch]
    md = capstone.Cs(getattr(capstone, a_name), getattr(capstone, m_name))

    if args.file_off is not None:
        off = args.file_off
    elif args.va is not None:
        # VA → 文件偏移（仅 PE）
        if info.get("format") != "PE":
            print("非 PE 请用 --file-off")
            return 1
        rva = args.va - info["image_base"]
        off = None
        for s in info["sections"]:
            if s["va"] <= rva < s["va"] + max(s["vsize"], s["rawsize"]):
                off = s["rawptr"] + (rva - s["va"])
                break
        if off is None:
            print(f"VA {hex(args.va)} 不落在任何节内")
            return 1
    else:
        print("给 --va 或 --file-off")
        return 1

    blob = data[off:off + args.n * 8]
    va = args.va if args.va is not None else None
    print(f"# 反汇编 @ file_off={hex(off)} arch={arch}")
    count = 0
    for insn in md.disasm(blob, va if va is not None else off):
        addr = f"{hex(insn.address):>12}" if va is not None else f"{hex(off + (insn.address - (va or off))):>12}"
        note = ""
        m = insn.mnemonic
        if m == "call":
            note = "  ; 调用"
        elif m in ("xor",) and "," in insn.op_str:
            a, b = [x.strip() for x in insn.op_str.split(",", 1)]
            if a == b:
                note = "  ; 清零"
        elif m == "ret":
            note = "  ; 返回"
        print(f"{addr}  {insn.bytes.hex():<16} {m:<8} {insn.op_str}{note}")
        count += 1
        if count >= args.n:
            break
    if count == 0:
        print("(没解出指令，可能偏移不对或数据不是代码)")
    return 0


def cmd_search(args):
    data = read(args.file)
    try:
        needle = bytes.fromhex(args.bytes.replace(" ", ""))
    except ValueError:
        print("--bytes 要十六进制，如 488d or 4d5a")
        return 1
    hits = []
    start = 0
    while True:
        i = data.find(needle, start)
        if i == -1:
            break
        hits.append(i)
        start = i + 1
        if len(hits) >= args.limit:
            break
    print(f"找到 {len(hits)} 处（显示最多 {args.limit}）")
    for h in hits:
        ctx = data[max(0, h - 8):h + len(needle) + 8].hex()
        print(f"  {hex(h):>10}  ...{ctx}...")
    return 0


def cmd_emu(args):
    try:
        from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_MODE_64, UcError
        from unicorn.x86_const import UC_X86_REG_RIP, UC_X86_REG_EIP
    except ImportError:
        print("需要 unicorn")
        return 2

    data = read(args.file)
    info = pe_info(data) or elf_info(data)
    if not info:
        print("需要 PE/ELF")
        return 1
    if info.get("format") != "PE":
        print("emu 目前只支持 PE")
        return 1

    is64 = info["arch"] == "x64"
    mu = Uc(UC_ARCH_X86, UC_MODE_64 if is64 else UC_MODE_32)

    # 按 ImageBase 映射整个镜像（对齐到 0x1000），否则 [rip+off] 读不到
    image_base = info["image_base"]
    end = image_base
    for s in info["sections"]:
        end = max(end, image_base + s["va"] + max(s["vsize"], s["rawsize"]))
    span = ((end - image_base) + 0xFFFF) & ~0xFFFF
    if span <= 0:
        span = 0x10000
    try:
        mu.mem_map(image_base, span)
    except UcError as e:
        print(f"映射镜像失败（{hex(image_base)} + {hex(span)}）: {e}")
        return 1

    # 把每个节的原始数据写进去
    raw = Path(args.file).read_bytes()
    mapped = 0
    for s in info["sections"]:
        if s["rawsize"] == 0 or s["rawptr"] == 0:
            continue
        chunk = raw[s["rawptr"]:s["rawptr"] + s["rawsize"]]
        if not chunk:
            continue
        try:
            mu.mem_write(image_base + s["va"], chunk)
            mapped += 1
        except UcError:
            pass

    # 栈
    stack_base = 0x20000000
    try:
        mu.mem_map(stack_base, 0x100000)
        if is64:
            from unicorn.x86_const import UC_X86_REG_RSP
            mu.reg_write(UC_X86_REG_RSP, stack_base + 0x80000)
        else:
            from unicorn.x86_const import UC_X86_REG_ESP
            mu.reg_write(UC_X86_REG_ESP, stack_base + 0x80000)
    except UcError:
        print("(栈映射失败，继续)")

    start = args.va
    print(f"镜像 {hex(image_base)} + {hex(span)}，写入 {mapped}/{len(info['sections'])} 节")
    print(f"从 {hex(start)} 开始，上限 {args.step} 步")

    before = None
    try:
        before = bytes(mu.mem_read(start, min(64, 0x40)))
    except UcError:
        pass

    try:
        mu.emu_start(start, start + args.n, count=args.step)
    except UcError as e:
        print(f"在第 {args.step} 步内停下: {e}")

    pc = mu.reg_read(UC_X86_REG_RIP if is64 else UC_X86_REG_EIP)
    print(f"结束于 {hex(pc)}")

    # 看栈上有没有被写（函数的返回值/局部变量的痕迹）
    try:
        sp = mu.reg_read(UC_X86_REG_RSP if is64 else UC_X86_REG_ESP)
        frame = bytes(mu.mem_read(sp, 64))
        nonzero = sum(1 for b in frame if b)
        print(f"栈顶 {hex(sp)}：{nonzero}/64 字节非零")
        if nonzero:
            print(f"  {frame.hex()}")
    except UcError:
        pass
    return 0


def cmd_yara(args):
    try:
        import yara
    except ImportError:
        print("需要 yara-python")
        return 2

    rule_src = args.rule
    # 先判断是不是文件路径——内联规则里有 { } " 等字符，
    # Windows 下直接丢给 Path() 会抛 OSError（非法路径），必须包住。
    is_file = False
    try:
        is_file = len(rule_src) < 260 and Path(rule_src).is_file()
    except (OSError, ValueError):
        is_file = False

    if is_file:
        rules = yara.compile(filepath=rule_src)
    else:
        # YARA 语法要求 strings: 和 condition: 分行，单行规则会 parse 失败
        # （syntax error, unexpected identifier, expecting text string）。
        # 所以两种内联写法都自动展开成多行。
        if "rule " not in rule_src:
            # 纯字符串 → 简易规则（转义反斜杠和双引号，别用 replace 粗暴处理）
            lit = rule_src.replace("\\", "\\\\").replace('"', '\\"')
            rule_src = (
                "rule inline {\n"
                "  strings:\n"
                f'    $a = "{lit}"\n'
                "  condition:\n"
                "    $a\n"
                "}"
            )
        else:
            # 用户给了规则体，但可能是单行 → 在 strings:/condition: 后补换行
            rule_src = re.sub(r"strings:\s*", "strings:\n    ", rule_src)
            rule_src = re.sub(r"\s+condition:\s*", "\n  condition:\n    ", rule_src)
            rule_src = re.sub(r"\s+\}\s*$", "\n}", rule_src)
        rules = yara.compile(source=rule_src)

    target = Path(args.path)
    files = [target] if target.is_file() else [
        p for p in target.rglob("*") if p.is_file() and p.stat().st_size < 200 * 1024 * 1024
    ]
    total = 0
    for f in files:
        try:
            ms = rules.match(str(f))
        except Exception as e:
            print(f"  {f}: 扫描失败 {e}")
            continue
        for m in ms:
            total += 1
            print(f"命中 {m.rule}  {f}")
            # yara-python 4.5 返回 StringMatch 对象；老版本返回 (off, id, data) 元组。
            # 两种都兜住，否则 unpack 直接 TypeError。
            shown = 0
            for s in m.strings or []:
                if shown >= 5:
                    break
                if hasattr(s, "instances"):
                    ident = getattr(s, "identifier", "?")
                    for inst in (s.instances or [])[:2]:
                        off = getattr(inst, "offset", -1)
                        val = bytes(getattr(inst, "matched_data", b"") or b"")
                        print(f"   {ident} @ {hex(off)}  {val[:40]!r}")
                        shown += 1
                else:
                    try:
                        off, ident, val = s
                        print(f"   {ident} @ {hex(off)}  {bytes(val)[:40]!r}")
                        shown += 1
                    except (TypeError, ValueError):
                        print(f"   {s!r}")
                        shown += 1
    print(f"\n共 {total} 处命中，扫了 {len(files)} 个文件")
    return 0 if total == 0 else 1


MAGICS = [
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF8", ".gif"),
    (b"PK\x03\x04", ".zip"),
    (b"\x1f\x8b", ".gz"),
    (b"7z\xbc\xaf\x27\x1c", ".7z"),
    (b"Rar!\x1a\x07", ".rar"),
    (b"%PDF", ".pdf"),
    (b"MZ", ".exe"),
    (b"\x7fELF", ".elf"),
    (b"SQLite format 3", ".sqlite"),
    (b"BZh", ".bz2"),
    (b"\xfd7zXZ\x00", ".xz"),
]


def cmd_carve(args):
    data = read(args.file)
    want = {e.strip() if e.strip().startswith(".") else "." + e.strip()
            for e in args.ext.split(",")} if args.ext else None
    outdir = Path(args.out or (args.file + ".carved"))
    outdir.mkdir(parents=True, exist_ok=True)

    found = []
    for magic, ext in MAGICS:
        if want and ext not in want:
            continue
        start = 0
        while True:
            i = data.find(magic, start)
            if i == -1:
                break
            # 粗略长度：到下一个魔数或文件尾，上限 32MB
            end = len(data)
            for m2, _ in MAGICS:
                j = data.find(m2, i + len(magic))
                if j != -1 and j < end:
                    end = j
            end = min(end, i + 32 * 1024 * 1024)
            found.append((ext, i, end))
            start = i + len(magic)

    found.sort(key=lambda x: x[1])
    print(f"切出 {len(found)} 个候选：")
    for n, (ext, a, b) in enumerate(found[:args.limit]):
        out = outdir / f"{n:04d}_{a:08x}{ext}"
        out.write_bytes(data[a:b])
        print(f"  {out.name:<28} {hex(a):>10} - {hex(b):>10}  {(b - a) / 1024:.1f} KB")
    print(f"\n输出目录: {outdir}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info"); p.add_argument("file"); p.set_defaults(func=cmd_info)
    p = sub.add_parser("sections"); p.add_argument("file"); p.set_defaults(func=cmd_sections)
    p = sub.add_parser("imports"); p.add_argument("file"); p.set_defaults(func=cmd_imports)
    p = sub.add_parser("exports"); p.add_argument("file"); p.set_defaults(func=cmd_exports)

    p = sub.add_parser("strings"); p.add_argument("file")
    p.add_argument("--min", type=int, default=6)
    p.add_argument("--off", action="store_true")
    p.add_argument("--utf16", action="store_true")
    p.add_argument("--grep")
    p.add_argument("--limit", type=int, default=200)
    p.set_defaults(func=cmd_strings)

    p = sub.add_parser("entropy"); p.add_argument("file")
    p.add_argument("--block", type=int, default=256)
    p.add_argument("--top", type=int, default=10)
    p.set_defaults(func=cmd_entropy)

    p = sub.add_parser("disasm"); p.add_argument("file")
    p.add_argument("--va", type=lambda x: int(x, 0))
    p.add_argument("--file-off", dest="file_off", type=lambda x: int(x, 0))
    p.add_argument("--arch")
    p.add_argument("-n", type=int, default=40)
    p.set_defaults(func=cmd_disasm)

    p = sub.add_parser("search"); p.add_argument("file")
    p.add_argument("--bytes", required=True)
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("emu"); p.add_argument("file")
    p.add_argument("--va", type=lambda x: int(x, 0), required=True)
    p.add_argument("-n", type=int, default=200)
    p.add_argument("--step", type=int, default=5000)
    p.set_defaults(func=cmd_emu)

    p = sub.add_parser("yara"); p.add_argument("path")
    p.add_argument("--rule", required=True)
    p.set_defaults(func=cmd_yara)

    p = sub.add_parser("carve"); p.add_argument("file")
    p.add_argument("--ext")
    p.add_argument("--out")
    p.add_argument("--limit", type=int, default=40)
    p.set_defaults(func=cmd_carve)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
