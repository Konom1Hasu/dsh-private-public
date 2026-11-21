#!/usr/bin/env python3
"""doc_extract.py -- 从 docx/xlsx/pptx/odt 提取文本（zip + XML，无需 Office）。

  python doc_extract.py text   <file>                    正文
  python doc_extract.py sheets <xlsx>                    工作表清单
  python doc_extract.py table  <xlsx> -s <sheet> [--json] [-o out]
  python doc_extract.py list   <file>                    包内 part 列表
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

NS_W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
NS_A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
NS_S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS_R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def open_zip(path: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path)
    except Exception as e:
        raise SystemExit(f"不是有效的 zip/OOXML: {e}")


# ---------------- docx ----------------
def docx_text(path: str) -> str:
    z = open_zip(path)
    out = []
    with z.open('word/document.xml') as f:
        tree = ET.parse(f)
    body = tree.getroot().find(NS_W + 'body')
    if body is None:
        return ''
    for p in body.iter(NS_W + 'p'):
        parts = []
        for node in p.iter():
            if node.tag == NS_W + 't' and node.text:
                parts.append(node.text)
            elif node.tag == NS_W + 'br':
                parts.append('\n')
            elif node.tag == NS_W + 'tab':
                parts.append('\t')
        line = ''.join(parts).strip()
        if line:
            out.append(line)
    z.close()
    return '\n'.join(out)


# ---------------- pptx ----------------
def pptx_text(path: str) -> str:
    z = open_zip(path)
    slides = sorted(
        [n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
        key=lambda n: int(re.search(r'slide(\d+)', n).group(1)),
    )
    out = []
    for i, name in enumerate(slides, 1):
        with z.open(name) as f:
            tree = ET.parse(f)
        lines = []
        for p in tree.getroot().iter(NS_A + 'p'):
            txt = ''.join(t.text or '' for t in p.iter(NS_A + 't')).strip()
            if txt:
                lines.append(txt)
        out.append(f"--- slide {i} ---")
        out.extend(lines)
    z.close()
    return '\n'.join(out)


# ---------------- xlsx ----------------
def col_index(ref: str) -> int:
    """'C5' -> 2 (0-based)"""
    letters = re.match(r'([A-Z]+)', ref or '')
    if not letters:
        return 0
    n = 0
    for ch in letters.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def xlsx_sheets(path: str):
    """返回 [(sheetName, partPath)]。"""
    z = open_zip(path)
    names = z.namelist()
    if 'xl/workbook.xml' not in names:
        z.close()
        raise SystemExit('不是 xlsx（缺 xl/workbook.xml）')
    with z.open('xl/workbook.xml') as f:
        wb = ET.parse(f)
    rels = {}
    if 'xl/_rels/workbook.xml.rels' in names:
        with z.open('xl/_rels/workbook.xml.rels') as f:
            rt = ET.parse(f)
        for r in rt.getroot():
            rels[r.get('Id')] = r.get('Target')
    out = []
    for s in wb.getroot().iter(NS_S + 'sheet'):
        rid = s.get(NS_R + 'id')
        target = rels.get(rid, '')
        if target and not target.startswith('xl/'):
            target = 'xl/' + target.lstrip('/')
        out.append((s.get('name'), target))
    z.close()
    return out


def xlsx_shared_strings(z: zipfile.ZipFile):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    with z.open('xl/sharedStrings.xml') as f:
        tree = ET.parse(f)
    out = []
    for si in tree.getroot().iter(NS_S + 'si'):
        out.append(''.join(t.text or '' for t in si.iter(NS_S + 't')))
    return out


def xlsx_table(path: str, sheet_name: str):
    z = open_zip(path)
    sheets = xlsx_sheets(path)
    # 重新打开（xlsx_sheets 已 close）
    z = open_zip(path)
    target = None
    for name, part in sheets:
        if name == sheet_name:
            target = part
            break
    if not target:
        z.close()
        raise SystemExit(f"没有工作表 '{sheet_name}'，可选: " + ', '.join(n for n, _ in sheets))
    shared = xlsx_shared_strings(z)
    with z.open(target) as f:
        tree = ET.parse(f)
    rows = []
    for row in tree.getroot().iter(NS_S + 'row'):
        cells = {}
        maxc = -1
        for c in row.iter(NS_S + 'c'):
            ci = col_index(c.get('r', ''))
            t = c.get('t')
            v = c.find(NS_S + 'v')
            if t == 's' and v is not None:
                idx = int(v.text)
                val = shared[idx] if 0 <= idx < len(shared) else ''
            elif t == 'inlineStr':
                is_ = c.find(NS_S + 'is')
                val = ''.join(x.text or '' for x in is_.iter(NS_S + 't')) if is_ is not None else ''
            else:
                val = v.text if v is not None else ''
            cells[ci] = val
            maxc = max(maxc, ci)
        rows.append([cells.get(i, '') for i in range(maxc + 1)])
    z.close()
    return rows


# ---------------- 通用 ----------------
def cmd_text(args):
    low = args.file.lower()
    if low.endswith('.docx'):
        print(docx_text(args.file))
    elif low.endswith('.pptx'):
        print(pptx_text(args.file))
    elif low.endswith(('.xlsx', '.xlsm')):
        for name, _ in xlsx_sheets(args.file):
            print(f"### {name}")
            for r in xlsx_table(args.file, name):
                print(' | '.join(r))
            print()
    elif low.endswith(('.odt', '.ods', '.odp')):
        z = open_zip(args.file)
        with z.open('content.xml') as f:
            raw = f.read().decode('utf-8', 'replace')
        z.close()
        # 去掉所有标签，保留文本
        txt = re.sub(r'<[^>]+>', ' ', raw)
        txt = re.sub(r'[ \t]{2,}', ' ', txt)
        print(txt.strip())
    else:
        print('不支持的格式（支持 docx/pptx/xlsx/odt/ods/odp）')
        return 1
    return 0


def cmd_sheets(args):
    for name, part in xlsx_sheets(args.file):
        rows = xlsx_table(args.file, name)
        width = max((len(r) for r in rows), default=0)
        print(f"{name:<24} {len(rows):>5} 行 x {width:>3} 列   ({part})")
    return 0


def cmd_table(args):
    rows = xlsx_table(args.file, args.sheet)
    if args.json:
        buf = io.StringIO()
        cols = rows[0] if rows else []
        for r in rows[1:]:
            rec = {cols[i] if i < len(cols) else f'col{i}': (r[i] if i < len(r) else '')
                   for i in range(len(cols))}
            buf.write(json.dumps(rec, ensure_ascii=False) + '\n')
        text = buf.getvalue()
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in rows:
            w.writerow(r)
        text = buf.getvalue()
    if args.out:
        open(args.out, 'w', encoding='utf-8', newline='').write(text)
        print(f"{len(rows)} 行 -> {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_list(args):
    z = open_zip(args.file)
    for n in z.namelist():
        info = z.getinfo(n)
        print(f"{info.file_size:>10}  {n}")
    z.close()
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('text');   p.add_argument('file'); p.set_defaults(func=cmd_text)
    p = sub.add_parser('sheets'); p.add_argument('file'); p.set_defaults(func=cmd_sheets)
    p = sub.add_parser('list');   p.add_argument('file'); p.set_defaults(func=cmd_list)

    p = sub.add_parser('table');  p.add_argument('file')
    p.add_argument('-s', '--sheet', required=True)
    p.add_argument('--json', action='store_true')
    p.add_argument('-o', '--out')
    p.set_defaults(func=cmd_table)

    args = ap.parse_args()
    sys.exit(args.func(args) or 0)


if __name__ == '__main__':
    main()
