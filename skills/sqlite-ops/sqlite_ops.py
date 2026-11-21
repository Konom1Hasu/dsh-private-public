#!/usr/bin/env python3
"""sqlite_ops.py -- SQLite 只读检视（标准库 sqlite3）。

  python sqlite_ops.py tables  <db>
  python sqlite_ops.py schema  <db> <table>
  python sqlite_ops.py query   <db> "SQL"
  python sqlite_ops.py find    <db> <value> [--tables t1,t2]
  python sqlite_ops.py export  <db> <table> [--limit N] [-o out.jsonl]
  python sqlite_ops.py info    <db>
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import sys

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def connect_ro(path: str) -> sqlite3.Connection:
    """只读打开，避免写坏正在被使用的库。"""
    p = pathlib.Path(path).resolve()
    if not p.exists():
        raise SystemExit(f"库不存在: {p}")
    uri = f"file:{p.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=3.0)
    conn.row_factory = sqlite3.Row
    return conn


def sidecars(path: str):
    base = pathlib.Path(path)
    out = []
    for suf in ('-wal', '-shm', '-journal'):
        alt = base.with_name(base.name + suf)
        if alt.exists():
            out.append((suf, alt.stat().st_size))
    return out


def cmd_info(args):
    size = os.path.getsize(args.db)
    print(f"db    : {args.db}")
    print(f"size  : {size/1024:.1f} KB")
    sc = sidecars(args.db)
    if sc:
        print("sidecar:")
        for suf, sz in sc:
            print(f"  {suf:9} {sz/1024:>8.1f} KB")
    else:
        print("sidecar: 无（WAL 模式会有 -wal/-shm）")
    conn = connect_ro(args.db)
    cur = conn.execute("PRAGMA page_size")
    print(f"page  : {cur.fetchone()[0]}")
    cur = conn.execute("PRAGMA page_count")
    print(f"pages : {cur.fetchone()[0]}")
    cur = conn.execute("PRAGMA encoding")
    print(f"enc   : {cur.fetchone()[0]}")
    cur = conn.execute("PRAGMA journal_mode")
    print(f"journal: {cur.fetchone()[0]}")
    conn.close()
    return 0


def cmd_tables(args):
    conn = connect_ro(args.db)
    rows = conn.execute(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
    ).fetchall()
    print(f"{'name':<32} {'type':<7} {'rows':>8}")
    for r in rows:
        name, typ, sql = r['name'], r['type'], r['sql'] or ''
        try:
            n = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        except Exception:
            n = -1
        tag = ' [fts]' if 'USING fts' in sql.lower() else ''
        print(f"{name:<32} {typ:<7} {n:>8}{tag}")
    conn.close()
    return 0


def cmd_schema(args):
    conn = connect_ro(args.db)
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name=? COLLATE NOCASE", (args.table,)
    ).fetchone()
    if not row:
        print(f"没有这张表: {args.table}")
        return 1
    print(row[0])
    idx = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? COLLATE NOCASE",
        (args.table,),
    ).fetchall()
    if idx:
        print("\n--- indexes ---")
        for r in idx:
            print(f"{r['name']}: {r['sql'] or '(auto)'}")
    conn.close()
    return 0


def cmd_query(args):
    conn = connect_ro(args.db)
    try:
        cur = conn.execute(args.sql)
    except Exception as e:
        print(f"SQL 执行失败: {e}")
        return 1
    if cur.description is None:
        print("(无结果集)")
        conn.close()
        return 0
    cols = [d[0] for d in cur.description]
    print(" | ".join(cols))
    print("-+-".join('-' * len(c) for c in cols))
    n = 0
    for r in cur:
        vals = []
        for c in cols:
            v = r[c]
            s = '(' + str(len(v)) + ' bytes)' if isinstance(v, (bytes, bytearray)) else str(v)
            vals.append(s.replace('\n', ' ')[:80])
        print(" | ".join(vals))
        n += 1
        if args.limit and n >= args.limit:
            print(f"… 已截断到 {args.limit} 行")
            break
    print(f"\n[{n} rows]")
    conn.close()
    return 0


def cmd_find(args):
    conn = connect_ro(args.db)
    if args.tables:
        names = [t.strip() for t in args.tables.split(',') if t.strip()]
    else:
        names = [r['name'] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    needle = f"%{args.value}%"
    total = 0
    for name in names:
        try:
            cols = [d[1] for d in conn.execute(f'PRAGMA table_info("{name}")').fetchall()]
        except Exception:
            continue
        if not cols:
            continue
        where = " OR ".join([f'CAST("{c}" AS TEXT) LIKE ?' for c in cols])
        try:
            cur = conn.execute(f'SELECT COUNT(*) FROM "{name}" WHERE {where}', [needle] * len(cols))
            n = cur.fetchone()[0]
        except Exception as e:
            print(f"[skip] {name}: {e}")
            continue
        if n:
            print(f"{name}: {n} 行命中")
            try:
                sample = conn.execute(
                    f'SELECT rowid, * FROM "{name}" WHERE {where} LIMIT 3', [needle] * len(cols)
                ).fetchall()
                for s in sample:
                    vals = [str(v)[:40] for v in tuple(s)[1:]]
                    print("    " + " | ".join(vals))
            except Exception:
                pass
        total += n
    print(f"\n合计 {total} 行命中")
    conn.close()
    return 0


def cmd_export(args):
    conn = connect_ro(args.db)
    try:
        cur = conn.execute(f'SELECT * FROM "{args.table}"')
    except Exception as e:
        print(f"导出失败: {e}")
        return 1
    cols = [d[0] for d in cur.description]
    out = open(args.out, 'w', encoding='utf-8') if args.out else sys.stdout
    n = 0
    for r in cur:
        rec = {}
        for c in cols:
            v = r[c]
            rec[c] = ('<binary %d bytes>' % len(v)) if isinstance(v, (bytes, bytearray)) else v
        out.write(json.dumps(rec, ensure_ascii=False) + '\n')
        n += 1
        if args.limit and n >= args.limit:
            break
    if args.out:
        out.close()
        print(f"导出 {n} 行 -> {args.out}", file=sys.stderr)
    conn.close()
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('info');    p.add_argument('db'); p.set_defaults(func=cmd_info)
    p = sub.add_parser('tables');  p.add_argument('db'); p.set_defaults(func=cmd_tables)
    p = sub.add_parser('schema');  p.add_argument('db'); p.add_argument('table'); p.set_defaults(func=cmd_schema)

    p = sub.add_parser('query');   p.add_argument('db'); p.add_argument('sql')
    p.add_argument('--limit', type=int, default=50); p.set_defaults(func=cmd_query)

    p = sub.add_parser('find');    p.add_argument('db'); p.add_argument('value')
    p.add_argument('--tables'); p.set_defaults(func=cmd_find)

    p = sub.add_parser('export');  p.add_argument('db'); p.add_argument('table')
    p.add_argument('--limit', type=int, default=0); p.add_argument('-o', '--out')
    p.set_defaults(func=cmd_export)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == '__main__':
    main()
