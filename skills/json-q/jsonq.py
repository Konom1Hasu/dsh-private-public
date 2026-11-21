#!/usr/bin/env python3
"""jsonq.py -- JSON 查询/整形（标准库，jq 的轻量替代）。

  python jsonq.py get   <file> <path>
  python jsonq.py keys  <file> [--depth N]
  python jsonq.py pick  <file> <path>          # 批量抽字段，每行一个
  python jsonq.py fmt   <file> [--compact] [-o out]
  python jsonq.py merge <f1> <f2> ... [-o out]
  python jsonq.py grep  <file> <keyword>
"""
from __future__ import annotations

import argparse
import json
import re
import sys

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def load(path: str, stream: bool = False):
    raw = open(path, 'rb').read()
    if raw.startswith(b'\xef\xbb\xbf'):   # 剥 BOM，否则 json 解析失败
        raw = raw[3:]
    text = raw.decode('utf-8', 'replace')
    if stream:
        return [json.loads(l) for l in text.splitlines() if l.strip()]
    return json.loads(text)


TOKEN_RE = re.compile(r'([^.\[\]*]+)|(\[\])|(\[\d+\])|(\*)')


def walk(obj, path: str):
    """按 a.b[0].c / users[].name / d.* 求值，返回列表。"""
    if not path:
        return [obj]
    tokens = []
    for m in TOKEN_RE.finditer(path):
        if m.group(1):
            tokens.append(('key', m.group(1)))
        elif m.group(2):
            tokens.append(('each', None))
        elif m.group(3):
            tokens.append(('idx', int(m.group(3)[1:-1])))
        elif m.group(4):
            tokens.append(('all', None))
    cur = [obj]
    for kind, arg in tokens:
        nxt = []
        for v in cur:
            if kind == 'key':
                if isinstance(v, dict) and arg in v:
                    nxt.append(v[arg])
            elif kind == 'idx':
                if isinstance(v, list) and -len(v) <= arg < len(v):
                    nxt.append(v[arg])
            elif kind == 'each':
                if isinstance(v, list):
                    nxt.extend(v)
            elif kind == 'all':
                if isinstance(v, dict):
                    nxt.extend(v.values())
                elif isinstance(v, list):
                    nxt.extend(v)
        cur = nxt
    return cur


def cmd_get(args):
    obj = load(args.file, args.stream)
    vals = walk(obj, args.path)
    if not vals:
        print(f"(路径无结果: {args.path})", file=sys.stderr)
        return 1
    if len(vals) == 1 and not isinstance(vals[0], (dict, list)):
        print(vals[0])
    else:
        print(json.dumps(vals if len(vals) > 1 else vals[0], ensure_ascii=False, indent=2))
    return 0


def cmd_keys(args):
    obj = load(args.file, args.stream)

    def rec(v, prefix, depth):
        if depth > args.depth:
            return
        if isinstance(v, dict):
            for k, sub in v.items():
                p = f"{prefix}.{k}" if prefix else k
                t = type(sub).__name__
                if isinstance(sub, list):
                    t = f"list[{len(sub)}]"
                elif isinstance(sub, dict):
                    t = f"dict[{len(sub)}]"
                print(f"{'  ' * depth}{p}  ({t})")
                rec(sub, p, depth + 1)
        elif isinstance(v, list) and v:
            rec(v[0], prefix + "[0]", depth + 1)

    rec(obj, '', 0)
    return 0


def cmd_pick(args):
    obj = load(args.file, args.stream)
    vals = walk(obj, args.path)
    for v in vals:
        if isinstance(v, (dict, list)):
            print(json.dumps(v, ensure_ascii=False))
        else:
            print(v)
    print(f"\n[{len(vals)} 条]", file=sys.stderr)
    return 0


def cmd_fmt(args):
    obj = load(args.file, args.stream)
    text = json.dumps(obj, ensure_ascii=False,
                      indent=None if args.compact else 2,
                      separators=(',', ':') if args.compact else None)
    if args.out:
        open(args.out, 'w', encoding='utf-8').write(text)
        print(f"-> {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_merge(args):
    merged = []
    for f in args.files:
        d = load(f, args.stream)
        if isinstance(d, list):
            merged.extend(d)
        else:
            merged.append(d)
    text = json.dumps(merged, ensure_ascii=False, indent=2)
    if args.out:
        open(args.out, 'w', encoding='utf-8').write(text)
        print(f"{len(merged)} 条 -> {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_grep(args):
    obj = load(args.file, args.stream)
    kw = args.keyword.lower()
    hits = 0

    def rec(v, path):
        nonlocal hits
        if isinstance(v, dict):
            for k, sub in v.items():
                rec(sub, f"{path}.{k}" if path else k)
        elif isinstance(v, list):
            for i, sub in enumerate(v):
                rec(sub, f"{path}[{i}]")
        else:
            if kw in str(v).lower():
                print(f"{path} = {v}")
                hits += 1

    rec(obj, '')
    print(f"\n[{hits} 处命中]", file=sys.stderr)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    def common(p):
        p.add_argument('file')
        p.add_argument('--stream', action='store_true', help='按 JSONL 读')

    p = sub.add_parser('get');    common(p); p.add_argument('path'); p.set_defaults(func=cmd_get)
    p = sub.add_parser('keys');   common(p); p.add_argument('--depth', type=int, default=3); p.set_defaults(func=cmd_keys)
    p = sub.add_parser('pick');   common(p); p.add_argument('path'); p.set_defaults(func=cmd_pick)
    p = sub.add_parser('fmt');    common(p); p.add_argument('--compact', action='store_true'); p.add_argument('-o', '--out'); p.set_defaults(func=cmd_fmt)
    p = sub.add_parser('grep');   common(p); p.add_argument('keyword'); p.set_defaults(func=cmd_grep)

    p = sub.add_parser('merge')
    p.add_argument('files', nargs='+')
    p.add_argument('--stream', action='store_true')
    p.add_argument('-o', '--out')
    p.set_defaults(func=cmd_merge)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == '__main__':
    main()
