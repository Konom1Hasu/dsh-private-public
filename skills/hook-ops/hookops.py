#!/usr/bin/env python3
"""hookops.py -- Frida 动态插桩：trace / dump / call / bypass / 自定义 JS。

  hookops.py list   [--filter X]
  hookops.py info   <pid|name>
  hookops.py trace  <pid|name> --func NAME [--module DLL] [--count N] [--timeout S]
  hookops.py dump   <pid|name> --addr 0xADDR --size N [--out FILE]
  hookops.py call   <pid|name> --func NAME [--module DLL] [--args '0,0']
  hookops.py bypass <pid|name> [--profile anti-debug|anti-vm|all] [--timeout S]
  hookops.py js     <pid|name> --file SCRIPT.js [--timeout S]
  hookops.py js     --spawn EXE --file SCRIPT.js [--timeout S]

注意：只能注入同位数进程。x64 Python 注入不了 32 位目标。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import frida
except ImportError:
    print("需要 frida：python -m pip install frida")
    sys.exit(2)


# ── 定位目标 ─────────────────────────────────────────────────────────
def resolve_pid(target: str) -> int:
    """pid 数字直接用；否则按进程名模糊匹配。"""
    s = str(target).strip()
    if s.isdigit():
        return int(s)
    dev = frida.get_local_device()
    procs = dev.enumerate_processes()
    exact = [p for p in procs if p.name.lower() == s.lower()]
    if exact:
        return exact[0].pid
    part = [p for p in procs if s.lower() in p.name.lower()]
    if not part:
        names = ", ".join(sorted({p.name for p in procs})[:20])
        raise SystemExit(f"没找到进程 '{s}'。样例：{names} ...")
    if len(part) > 1:
        print(f"匹配到 {len(part)} 个，用第一个：")
        for p in part[:10]:
            print(f"  pid={p.pid:<6} {p.name}")
    return part[0].pid


def attach(pid: int):
    try:
        return frida.attach(pid)
    except frida.PermissionDeniedError:
        raise SystemExit(f"attach {pid} 被拒绝：权限不足（试试管理员）或目标有保护")
    except frida.ProcessNotFoundError:
        raise SystemExit(f"进程 {pid} 不存在")
    except Exception as e:
        raise SystemExit(f"attach {pid} 失败：{e}")


def with_watchdog(seconds: float, what: str = ""):
    """起一个兜底计时器：到点直接 os._exit。

    frida 的 C 层错误（"Unable to allocate target memory" 等）既不抛到 Python，
    也不会自己返回——attach 阶段就能卡死。所以 watchdog 必须罩住 attach，
    不能只罩脚本执行。返回一个 cancel 函数。
    """
    import os
    import threading

    def bark():
        print(f"\n[watchdog] {seconds:.0f}s 超时（{what}），强制退出。\n"
              f"  常见原因：目标进程正在退出 / 刚被别的程序 attach 过 / "
              f"有反调试保护 / 位数不匹配", file=sys.stderr)
        os._exit(3)

    t = threading.Timer(seconds, bark)
    t.daemon = True
    t.start()
    return t.cancel


def run_script(session, source: str, timeout: float, printer, cancel=None) -> None:
    """加载脚本、跑 timeout 秒、断开。"""
    script = session.create_script(source)
    script.on("message", printer)
    try:
        script.load()
    except Exception as e:
        if cancel:
            cancel()
        raise SystemExit(f"脚本加载失败：{e}")
    try:
        time.sleep(timeout)
    except KeyboardInterrupt:
        pass
    finally:
        if cancel:
            cancel()
        try:
            session.detach()
        except Exception:
            pass


def make_printer():
    def printer(message, data):
        if message.get("type") == "send":
            payload = message.get("payload")
            if isinstance(payload, dict):
                kind = payload.get("kind", "")
                if kind == "event":
                    print(payload.get("text", ""))
                elif kind == "info":
                    print(payload.get("text", ""))
                else:
                    print(json.dumps(payload, ensure_ascii=False))
            else:
                print(payload)
        elif message.get("type") == "error":
            print("[JS 错误] " + str(message.get("description", ""))[:400])
        else:
            print(json.dumps(message, ensure_ascii=False)[:400])
    return printer


# ── JS 模板 ──────────────────────────────────────────────────────────
TRACE_JS = r"""
(function () {
  var moduleName = %(module)s;   // null = 自动搜
  var funcName = %(func)s;
  var limit = %(count)d;

  // 定位导出：指定了模块就只查它；没指定就遍历所有模块找第一个命中的。
  // 直接拿主模块会找不到 KERNEL32 里的函数（实测踩过）。
  var addr = null, foundIn = null;
  if (moduleName) {
    var mod = Process.getModuleByName(moduleName);
    if (!mod) { send({kind:'info', text:'模块不存在: ' + moduleName}); return; }
    addr = mod.getExportByName(funcName);
    foundIn = mod.name;
  } else {
    var mods = Process.enumerateModules();
    for (var i = 0; i < mods.length; i++) {
      try {
        var e = mods[i].findExportByName(funcName);
        if (e) { addr = e; foundIn = mods[i].name; break; }
      } catch (err) {}
    }
  }
  if (!addr) { send({kind:'info', text:'所有模块里都没有导出: ' + funcName}); return; }

  var hits = 0;

  // 尝试把指针当字符串读。要求「可打印字符占比够高」，否则指针会被
  // 误读成一串乱码（实测 arg2 这种无关指针会读出 \ufffd）。
  function asString(p) {
    function clean(s) {
      if (!s || s.length < 2) return null;
      var ok = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c === 0xfffd) return null;                    // 替换字符 → 不是文本
        if ((c >= 0x20 && c < 0x7f) || (c >= 0x4e00 && c <= 0x9fff)) ok++;
      }
      return ok / s.length >= 0.85 ? s : null;
    }
    try {
      if (p.isNull()) return null;
      var a = clean(p.readUtf8String(80));
      if (a) return a;
    } catch (e) {}
    try {
      var w = clean(p.readUtf16String(80));
      if (w) return w;
    } catch (e) {}
    return null;
  }

  Interceptor.attach(addr, {
    onEnter: function (args) {
      hits++;
      this._skip = (limit > 0 && hits > limit);
      if (this._skip) return;
      var text = '[' + funcName + '] #' + hits + '  ret=' + this.returnAddress;
      for (var i = 0; i < 4; i++) {
        var v = args[i];
        var sv = asString(v);
        text += '\n   arg' + i + ' = ' + v;
        if (sv) text += '   "' + sv + '"';
      }
      send({kind:'event', text: text});
    },
    onLeave: function (retval) {
      if (this._skip) return;
      send({kind:'event', text: '   → 返回 ' + retval});
    }
  });
  send({kind:'info', text:'已 hook ' + foundIn + '!' + funcName + ' @ ' + addr});
})();
"""

CALL_JS = r"""
(function () {
  var moduleName = %(module)s;
  var funcName = %(func)s;
  var argList = %(args)s;
  var mod = moduleName ? Process.getModuleByName(moduleName) : Process.enumerateModules()[0];
  if (!mod) { send({kind:'info', text:'模块不存在'}); return; }
  var addr = mod.getExportByName(funcName);
  if (!addr) { send({kind:'info', text:'导出不存在: ' + funcName}); return; }
  try {
    var fn = new NativeFunction(addr, 'pointer', argList.map(function(){ return 'pointer'; }));
    var r = fn.apply(null, argList);
    send({kind:'event', text: funcName + '(' + argList.join(',') + ') = ' + r});
  } catch (e) {
    send({kind:'info', text:'调用失败: ' + e});
  }
})();
"""

# 反调试 / 反 VM 绕过
BYPASS_ANTI_DEBUG = r"""
(function () {
  var log = [];
  function say(t) { send({kind:'event', text: t}); }

  var k32 = Process.getModuleByName('KERNEL32.DLL');
  var ntdll = null;
  try { ntdll = Process.getModuleByName('ntdll.dll'); } catch (e) {}

  // IsDebuggerPresent → 0
  try {
    Interceptor.replace(k32.getExportByName('IsDebuggerPresent'),
      new NativeCallback(function () { return 0; }, 'int', []));
    say('[绕过] IsDebuggerPresent → 0');
  } catch (e) { say('[跳过] IsDebuggerPresent: ' + e); }

  // CheckRemoteDebuggerPresent → 输出 0, 返回 1
  try {
    Interceptor.replace(k32.getExportByName('CheckRemoteDebuggerPresent'),
      new NativeCallback(function (h, out) {
        try { out.writeU32(0); } catch (e) {}
        return 1;
      }, 'int', ['pointer', 'pointer']));
    say('[绕过] CheckRemoteDebuggerPresent → false');
  } catch (e) { say('[跳过] CheckRemoteDebuggerPresent: ' + e); }

  // NtQueryInformationProcess：调试相关三个 class 全返回「无调试」
  if (ntdll) {
    try {
      var ntq = ntdll.getExportByName('NtQueryInformationProcess');
      Interceptor.attach(ntq, {
        onEnter: function (args) {
          this.cls = args[1].toInt32();
          this.out = args[2];
        },
        onLeave: function (ret) {
          // 7=ProcessDebugPort, 0x1e=ProcessDebugObjectHandle, 0x1f=ProcessDebugFlags
          if (this.cls === 7) { try { this.out.writePointer(ptr(0)); } catch (e) {} }
          else if (this.cls === 0x1e) { try { this.out.writePointer(ptr(0)); } catch (e) {} }
          else if (this.cls === 0x1f) { try { this.out.writeU32(1); } catch (e) {} }
        }
      });
      say('[绕过] NtQueryInformationProcess (Port/Handle/Flags)');
    } catch (e) { say('[跳过] NtQueryInformationProcess: ' + e); }

    // NtSetInformationThread(HideFromDebugger) 直接放行
    try {
      var nts = ntdll.getExportByName('NtSetInformationThread');
      Interceptor.attach(nts, {
        onEnter: function (args) {
          if (args[1].toInt32() === 0x11) this.hide = true;  // ThreadHideFromDebugger
        },
        onLeave: function () {}
      });
      say('[放行] NtSetInformationThread(HideFromDebugger)');
    } catch (e) {}
  }

  // OutputDebugString 空操作（有些程序靠它的异常行为探测）
  try {
    Interceptor.replace(k32.getExportByName('OutputDebugStringW'),
      new NativeCallback(function (s) {}, 'void', ['pointer']));
    Interceptor.replace(k32.getExportByName('OutputDebugStringA'),
      new NativeCallback(function (s) {}, 'void', ['pointer']));
    say('[绕过] OutputDebugString → nop');
  } catch (e) {}

  // 时间检测：抹平 GetTickCount / QueryPerformanceCounter 的跳跃
  try {
    var lastTick = 0;
    Interceptor.attach(k32.getExportByName('GetTickCount'), {
      onLeave: function (ret) {
        var real = ret.toInt32();
        if (lastTick && real - lastTick > 2000) {           // 单步/断点会跳很多
          this.retval = ptr(lastTick + 16);
        }
        lastTick = this.retval.toInt32();
      }
    });
    say('[绕过] GetTickCount 时间差抹平');
  } catch (e) {}

  send({kind:'info', text:'反调试绕过完成'});
})();
"""

BYPASS_ANTI_VM = r"""
(function () {
  function say(t) { send({kind:'event', text: t}); }

  // CPUID hypervisor 位（ECX bit 31）
  // Frida 不能直接 hook 指令，但可以 patch 常见检测点的结果。
  // 更实际的做法：拦 GetSystemFirmwareTable / WMI 查询，或直接改注册表访问结果。
  try {
    var advapi = Process.getModuleByName('advapi32.dll');
    var RegQueryValueExW = advapi.getExportByName('RegQueryValueExW');
    var vmKeys = [/vmware/i, /virtualbox/i, /vbox/i, /qemu/i, /hyper-v/i, /xen/i];
    Interceptor.attach(RegQueryValueExW, {
      onEnter: function (args) {
        try {
          var key = args[1].readUtf16String();
          for (var i = 0; i < vmKeys.length; i++) {
            if (vmKeys[i].test(key)) { this.vm = true; }
          }
        } catch (e) {}
      },
      onLeave: function (ret) {
        if (this.vm && ret.toInt32() === 0) {
          this.retval = ptr(2);   // ERROR_FILE_NOT_FOUND
        }
      }
    });
    say('[绕过] 注册表 VM 特征键 → 返回不存在');
  } catch (e) { say('[跳过] 注册表 VM 检测: ' + e); }

  // MAC 地址前缀（VM 常用 00:05:69 / 00:0C:29 / 00:50:56 / 08:00:27）
  try {
    var iphlp = Process.getModuleByName('iphlpapi.dll');
    var GetAdaptersInfo = iphlp.getExportByName('GetAdaptersInfo');
    Interceptor.attach(GetAdaptersInfo, {
      onEnter: function (args) { this.buf = args[0]; },
      onLeave: function (ret) {
        if (ret.toInt32() !== 0 || this.buf.isNull()) return;
        // MAC 在偏移 0x1A8 附近（Windows IP_ADAPTER_INFO 结构），逐个清首字节，
        // 把 VM 前缀改成普通网卡前缀 0x3C。
        try {
          var p = this.buf;
          var mac = p.add(0x1A8);
          var b0 = mac.readU8();
          if (b0 === 0x00 || b0 === 0x08) {
            mac.writeU8(0x3C);
            say('[绕过] MAC 前缀 ' + b0.toString(16) + ' → 3c');
          }
        } catch (e) {}
      }
    });
    say('[绕过] MAC 地址 VM 前缀');
  } catch (e) { say('[跳过] MAC 检测: ' + e); }

  send({kind:'info', text:'反 VM 绕过完成（只覆盖用户态常见检测，内核级过不了）'});
})();
"""

DUMP_JS = r"""
(function () {
  var addr = ptr('%(addr)s');
  var size = %(size)d;
  var outPath = %(out)s;
  try {
    var data = addr.readByteArray(size);
    var f = new File(outPath, 'wb');
    f.write(data);
    f.flush();
    f.close();
    send({kind:'event', text:'已 dump ' + size + ' 字节 → ' + outPath});
  } catch (e) {
    send({kind:'info', text:'dump 失败: ' + e});
  }
})();
"""

INFO_JS = r"""
(function () {
  var mods = Process.enumerateModules();
  var main = mods[0];
  var lines = [
    'pid      : ' + Process.id,
    'arch     : ' + Process.arch,
    'platform : ' + Process.platform,
    '主模块   : ' + main.name + '  base=' + main.base + '  size=' + main.size,
    '模块数   : ' + mods.length,
    '',
    '关键模块:'
  ];
  var want = ['kernel32', 'ntdll', 'user32', 'advapi32', 'ws2_32', 'winhttp', 'crypt32'];
  for (var i = 0; i < mods.length; i++) {
    for (var j = 0; j < want.length; j++) {
      if (mods[i].name.toLowerCase().indexOf(want[j]) === 0) {
        lines.push('  ' + mods[i].name + '  ' + mods[i].base);
        break;
      }
    }
  }
  send({kind:'event', text: lines.join('\n')});
})();
"""


# ── 命令 ─────────────────────────────────────────────────────────────
def cmd_list(args):
    dev = frida.get_local_device()
    procs = dev.enumerate_processes()
    f = (args.filter or "").lower()
    shown = 0
    for p in sorted(procs, key=lambda x: x.name.lower()):
        if f and f not in p.name.lower():
            continue
        print(f"{p.pid:<8} {p.name}")
        shown += 1
    print(f"\n{shown} 个（共 {len(procs)}）")
    return 0


def cmd_info(args):
    pid = resolve_pid(args.target)
    session = attach(pid)
    run_script(session, INFO_JS, args.timeout, make_printer())
    return 0


def cmd_trace(args):
    pid = resolve_pid(args.target)
    session = attach(pid)
    src = TRACE_JS % {
        "module": json.dumps(args.module) if args.module else "null",
        "func": json.dumps(args.func),
        "count": args.count,
    }
    where = args.module or "自动定位（遍历所有模块）"
    print(f"attach {pid}，查找 {where}!{args.func}，"
          f"{args.count if args.count > 0 else '不限'} 次，{args.timeout}s 后断开")
    run_script(session, src, args.timeout, make_printer())
    return 0


def cmd_dump(args):
    pid = resolve_pid(args.target)
    out = args.out or f"dump_{pid}_{args.addr}.bin"
    session = attach(pid)
    # json.dumps 已经把反斜杠转义成 \\，JS 里会还原成一个 \。不要再 replace 一次。
    out_js = json.dumps(str(Path(out).resolve()))
    src = DUMP_JS % {"addr": args.addr, "size": args.size, "out": out_js}
    run_script(session, src, min(args.timeout, 10), make_printer())
    p = Path(out)
    if p.exists():
        print(f"\n本地文件: {p.resolve()}  {p.stat().st_size} 字节")
    return 0


def cmd_call(args):
    pid = resolve_pid(args.target)
    try:
        vals = [int(x.strip(), 0) for x in (args.args or "").split(",") if x.strip()]
    except ValueError:
        print("--args 用逗号分隔的整数，如 0,1,0x100")
        return 1
    session = attach(pid)
    src = CALL_JS % {
        "module": json.dumps(args.module) if args.module else "null",
        "func": json.dumps(args.func),
        "args": json.dumps(vals),
    }
    run_script(session, src, min(args.timeout, 10), make_printer())
    return 0


def cmd_bypass(args):
    pid = resolve_pid(args.target)
    parts = []
    if args.profile in ("anti-debug", "all"):
        parts.append(BYPASS_ANTI_DEBUG)
    if args.profile in ("anti-vm", "all"):
        parts.append(BYPASS_ANTI_VM)
    session = attach(pid)
    print(f"attach {pid}，应用 {args.profile}，保持 {args.timeout}s")
    run_script(session, "\n".join(parts), args.timeout, make_printer())
    return 0


def cmd_js(args):
    src_path = Path(args.file)
    if not src_path.is_file():
        print(f"脚本不存在: {src_path}")
        return 1
    source = src_path.read_text(encoding="utf-8")

    if args.spawn:
        dev = frida.get_local_device()
        try:
            pid = dev.spawn([args.spawn])
        except Exception as e:
            print(f"spawn 失败: {e}")
            return 1
        print(f"已 spawn {args.spawn} → pid={pid}")
        session = dev.attach(pid)
        hook_done = []

        def printer(message, data):
            make_printer()(message, data)
            if message.get("type") == "send" and not hook_done:
                hook_done.append(1)
                try:
                    dev.resume(pid)
                    print("[已 resume，程序继续运行]")
                except Exception as e:
                    print(f"[resume 失败] {e}")

        run_script(session, source, args.timeout, printer)
        return 0

    if not args.target:
        print("要么给目标 pid/名字，要么用 --spawn")
        return 1
    pid = resolve_pid(args.target)
    session = attach(pid)
    run_script(session, source, args.timeout, make_printer())
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list"); p.add_argument("--filter"); p.set_defaults(handler=cmd_list)

    p = sub.add_parser("info"); p.add_argument("target")
    p.add_argument("--timeout", type=float, default=3.0)
    p.set_defaults(handler=cmd_info)

    p = sub.add_parser("trace"); p.add_argument("target")
    p.add_argument("--func", required=True)
    p.add_argument("--module")
    p.add_argument("--count", type=int, default=20)
    p.add_argument("--timeout", type=float, default=10.0)
    p.set_defaults(handler=cmd_trace)

    p = sub.add_parser("dump"); p.add_argument("target")
    p.add_argument("--addr", required=True)
    p.add_argument("--size", type=lambda x: int(x, 0), required=True)
    p.add_argument("--out")
    p.add_argument("--timeout", type=float, default=10.0)
    p.set_defaults(handler=cmd_dump)

    p = sub.add_parser("call"); p.add_argument("target")
    p.add_argument("--func", required=True)
    p.add_argument("--module")
    p.add_argument("--args", default="")
    p.add_argument("--timeout", type=float, default=8.0)
    p.set_defaults(handler=cmd_call)

    p = sub.add_parser("bypass"); p.add_argument("target")
    p.add_argument("--profile", default="anti-debug",
                   choices=["anti-debug", "anti-vm", "all"])
    p.add_argument("--timeout", type=float, default=30.0)
    p.set_defaults(handler=cmd_bypass)

    p = sub.add_parser("js")
    p.add_argument("target", nargs="?")
    p.add_argument("--file", required=True)
    p.add_argument("--spawn")
    p.add_argument("--timeout", type=float, default=15.0)
    p.set_defaults(handler=cmd_js)

    args = ap.parse_args()

    # 最后一道防线：任何命令卡在 frida C 层都掐掉。
    # attach 阶段就会卡，所以 watchdog 必须在这里起，不能等 run_script。
    budget = getattr(args, "timeout", 15.0) + 25.0
    cancel = with_watchdog(budget, f"{args.cmd}")
    try:
        rc = args.handler(args) or 0
    finally:
        cancel()
    sys.exit(rc)


if __name__ == "__main__":
    main()
