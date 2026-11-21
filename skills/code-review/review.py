#!/usr/bin/env python3
"""review.py -- 代码审查：只报能出事的。

  python review.py scan   <path>            全量扫
  python review.py diff   <repo>            只审 git diff 的改动
  python review.py focus  <path> --rule X   只跑指定规则
  python review.py rules                    列出规则

设计立场：不做风格批评（缩进/命名/行长），只报会导致
数据损坏、越权、静默失败、资源泄漏的东西。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SEV_ORDER = {"严重": 0, "高": 1, "中": 2, "低": 3}

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
             ".next", ".cache", "target", "bin", "obj", ".pnpm-store"}
SKIP_EXT = {".pyc", ".pyo", ".so", ".dll", ".exe", ".zip", ".gz", ".png", ".jpg",
            ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".db",
            ".zstd", ".lock", ".map", ".min.js"}


@dataclass
class Rule:
    id: str
    sev: str
    lang: str          # py / js / ps / any
    pattern: str
    msg: str
    hint: str = ""
    flags: int = 0


# ── 规则表 ────────────────────────────────────────────────────────────
# 每条都对应一个真实会出事的场景，不是拍脑袋的风格检查。
RULES: list[Rule] = [
    # ===== 严重：能被外部输入触发 / 越权 =====
    Rule("sql-concat", "严重", "any",
         r"(?i)(execute|query|raw)\s*\(\s*[f\"'`][^)]*(\+|%|\{)[^)]*\)",
         "SQL 语句由拼接/插值构造，参数未参数化",
         "改为参数化查询：cursor.execute(sql, (a, b))"),
    Rule("shell-true", "严重", "py",
         r"subprocess\.\w+\([^)]*shell\s*=\s*True",
         "subprocess 开了 shell=True，拼接的命令可被注入",
         "改用数组参数 [prog, arg1, arg2]，或至少 shlex.quote"),
    Rule("node-exec-concat", "严重", "js",
         r"\b(exec|execSync|spawn|spawnSync)\s*\(\s*[`'\"][^`'\"]*[`'\"]\s*\+",
         "child_process 的命令由字符串拼接，可被注入",
         "改用 execFile/spawn 传数组参数，不经过 shell"),
    Rule("node-exec-template", "严重", "js",
         r"\b(exec|execSync)\s*\(\s*`[^`]*\$\{",
         "child_process 用模板字符串拼命令，可被注入",
         "改用 execFile/spawn 传数组参数"),
    Rule("eval-exec", "严重", "py",
         r"\b(eval|exec)\s*\(",
         "eval/exec 执行动态字符串",
         "确认输入不可控；可控就换 ast.literal_eval 或解析器"),
    Rule("innerhtml", "严重", "js",
         r"\.(innerHTML|outerHTML)\s*=",
         "innerHTML 赋值，拼接用户输入会 XSS",
         "改用 textContent，或对内容做转义"),
    Rule("dangerous-html", "严重", "js",
         r"dangerouslySetInnerHTML",
         "React dangerouslySetInnerHTML",
         "确认内容已消毒；否则用文本节点"),
    Rule("pickle-loads", "严重", "py",
         r"\bpickle\.loads?\s*\(",
         "pickle 反序列化不可信数据 = 任意代码执行",
         "改用 json，或签名校验后再反序列化"),
    Rule("yaml-unsafe", "严重", "py",
         r"yaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)",
         "yaml.load 未指定 SafeLoader",
         "改用 yaml.safe_load"),
    Rule("hardcoded-secret", "严重", "any",
         r"(?i)(password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*[\"'][^\"']{8,}[\"']",
         "疑似硬编码凭证",
         "移入环境变量或凭据存储"),

    # ===== 高：静默失败 / 结果不可信 =====
    Rule("bare-except", "高", "py",
         r"except\s*:\s*$|except\s+Exception\s*:\s*(pass|\.\.\.)\s*$",
         "裸 except / 吞掉所有异常",
         "捕获具体异常；确实要忽略就写注释说明为什么",
         re.M),
    Rule("except-pass", "高", "py",
         r"except[^\n]*:\s*\n\s*(pass|\.\.\.)\s*(#|$)",
         "异常被静默吞掉",
         "至少记一条日志，否则故障不可见",
         re.M),
    Rule("empty-catch", "高", "js",
         r"catch\s*\([^)]*\)\s*\{\s*\}",
         "空 catch 块，错误被吞",
         "记录或转抛；不能默默继续"),
    Rule("catch-swallow", "高", "js",
         r"\|\|\s*true\b",
         "用 || true 把失败兜成成功",
         "这是最可疑的兜底——失败会被当成通过",),
    Rule("exit-zero-on-fail", "高", "any",
         r"(?i)(fail|error|failed|失败)[^\n]{0,60}process\.exit\(0\)",
         "失败分支里显式 exit(0)，测试/脚本永远绿",
         "改成 exit(1) 或非零退出码"),
    Rule("fail-open", "高", "js",
         r"(?i)(checked|ok)\s*:\s*true[^\n]{0,40}(review|check|valid|verify)",
         "校验/审查失败时返回 ok:true —— fail-open",
         "失败必须是 ok:false，或单独的 checked:false 计数"),

    # ===== 中：资源泄漏 / 挂死 =====
    Rule("open-no-with", "中", "py",
         r"=\s*open\s*\((?![^)]*\).*with)",
         "open() 未用 with，异常时文件句柄不关",
         "用 with open(...) as f"),
    Rule("fetch-no-timeout", "中", "js",
         r"\bfetch\s*\((?![^)]*signal)",
         "fetch 没设超时/signal，挂死时一直等",
         "加 AbortSignal.timeout(ms)"),
    Rule("requests-no-timeout", "中", "py",
         r"requests\.(get|post|put|delete|head)\s*\((?![^)]*timeout)",
         "requests 没设 timeout，可能永久阻塞",
         "加 timeout=(connect, read)"),
    Rule("no-erroraction", "中", "ps",
         r"^\s*(Get|Set|Remove|Stop|Start|New|Copy|Move)-\w+(?![^\n]*-ErrorAction)",
         "PowerShell cmdlet 未指定 -ErrorAction，失败会继续执行",
         "加 -ErrorAction Stop 或 SilentlyContinue（明确意图）",
         re.M),
    Rule("set-content-utf8", "中", "ps",
         r"Set-Content[^\n]*-Encoding\s+UTF8",
         "PS 5.1 的 -Encoding UTF8 会加 BOM，JSON/JS 文件会解析失败",
         "用 [System.IO.File]::WriteAllText($p, $s, UTF8Encoding($false))"),
    Rule("write-output-in-func", "中", "ps",
         r"^\s*Write-Output\s+[\"']",
         "函数内 Write-Output 会被 $x = f() 捕获，不是打印",
         "要打印用 Write-Host；要返回值用 return",
         re.M),

    # ===== 低：可维护性 =====
    Rule("todo", "低", "any", r"\b(TODO|FIXME|XXX|HACK)\b", "遗留标记", ""),
    Rule("console-log", "低", "js", r"\bconsole\.(log|debug)\s*\(", "调试输出残留", "上线前清掉或改成 logger"),
]

LANG_BY_EXT = {
    ".py": "py", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js",
    ".ps1": "ps", ".psm1": "ps",
}


def rules_of(lang: str) -> list[Rule]:
    return [r for r in RULES if r.lang in ("any", lang)]


def scan_text(text: str, lang: str, path: str, only: set[str] | None) -> list[tuple]:
    hits = []
    for rule in rules_of(lang):
        if only and rule.id not in only:
            continue
        try:
            for m in re.finditer(rule.pattern, text, rule.flags):
                line = text.count("\n", 0, m.start()) + 1
                frag = m.group(0).strip().replace("\n", " ")[:70]
                hits.append((rule.sev, path, line, rule.id, rule.msg, frag, rule.hint))
        except re.error:
            continue
    return hits


def iter_files(root: Path):
    if root.is_file():
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            p = Path(dirpath) / fn
            if any(fn.endswith(e) for e in SKIP_EXT):
                continue
            yield p


def read_text(p: Path) -> str | None:
    try:
        raw = p.read_bytes()
    except Exception:
        return None
    if b"\x00" in raw[:2048]:      # 二进制
        return None
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def report(hits: list[tuple], limit: int):
    if not hits:
        print("没有命中规则。")
        return 0
    hits.sort(key=lambda h: (SEV_ORDER.get(h[0], 9), h[1], h[2]))
    counts = {}
    for sev, path, line, rid, msg, frag, hint in hits[:limit]:
        counts[sev] = counts.get(sev, 0) + 1
        rel = path
        print(f"[{sev}] {rel}:{line}  ({rid})")
        print(f"       {msg}")
        if frag:
            print(f"       命中: {frag}")
        if hint:
            print(f"       建议: {hint}")
    if len(hits) > limit:
        print(f"\n… 还有 {len(hits) - limit} 条未显示")
    print("\n按严重度统计: " + "  ".join(f"{k}={counts[k]}" for k in ["严重", "高", "中", "低"] if k in counts))
    return 1 if counts.get("严重") or counts.get("高") else 0


def cmd_scan(args):
    root = Path(args.path)
    if not root.exists():
        print(f"路径不存在: {root}")
        return 2
    only = set(args.rule.split(",")) if args.rule else None
    hits = []
    nfiles = 0
    for p in iter_files(root):
        lang = LANG_BY_EXT.get(p.suffix.lower())
        if not lang:
            continue
        text = read_text(p)
        if text is None:
            continue
        nfiles += 1
        hits += scan_text(text, lang, str(p), only)
    print(f"扫了 {nfiles} 个源文件\n")
    return report(hits, args.limit)


def cmd_diff(args):
    repo = Path(args.repo)
    try:
        base = args.base or "HEAD"
        names = subprocess.run(["git", "-C", str(repo), "diff", "--name-only", base],
                               capture_output=True, text=True, timeout=30).stdout.split()
        diff = subprocess.run(["git", "-C", str(repo), "diff", base],
                              capture_output=True, text=True, timeout=60,
                              errors="replace").stdout
    except Exception as e:
        print(f"git 调用失败: {e}")
        return 2
    changed = {str((repo / n).resolve()) for n in names}
    hits = []
    for p in iter_files(repo):
        if str(p.resolve()) not in changed:
            continue
        lang = LANG_BY_EXT.get(p.suffix.lower())
        if not lang:
            continue
        text = read_text(p)
        if text is None:
            continue
        hits += scan_text(text, lang, str(p), None)
    print(f"改动文件 {len(changed)} 个（base={base}）\n")
    return report(hits, args.limit)


def cmd_rules(_args):
    print(f"{'ID':<22} {'严重':<5} {'语言':<5} 说明")
    print("-" * 90)
    for r in sorted(RULES, key=lambda x: (SEV_ORDER[x.sev], x.id)):
        print(f"{r.id:<22} {r.sev:<5} {r.lang:<5} {r.msg}")
    print(f"\n共 {len(RULES)} 条")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("scan"); p.add_argument("path")
    p.add_argument("--rule", help="逗号分隔的规则 id")
    p.add_argument("--limit", type=int, default=60)
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("diff"); p.add_argument("repo")
    p.add_argument("--base", default="HEAD")
    p.add_argument("--limit", type=int, default=60)
    p.set_defaults(func=cmd_diff)

    p = sub.add_parser("focus"); p.add_argument("path")
    p.add_argument("--rule", required=True)
    p.add_argument("--limit", type=int, default=60)
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("rules"); p.set_defaults(func=cmd_rules)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
