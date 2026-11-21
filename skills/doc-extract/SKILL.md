---
name: doc-extract
description: Use when you need text out of Office files without Word/Excel installed — docx/xlsx/pptx/odt/ods 提取纯文本或表格数据。当用户说「把这个 word 里的字提出来」「这个表格转成文本」「ppt 讲了什么」时用。不处理 pdf（那需要额外库）。
---

# doc-extract — Office 文档提取文本

脚本：`C:\Users\KonomiHasu\dsh-private\skills\doc-extract\doc_extract.py`（Python 标准库）

## 什么时候用

- 机器上没有 Office / LibreOffice，但要看文档内容
- 要把 docx 转成纯文本喂给模型
- 要从 xlsx 里把某张表读成 CSV/JSONL
- 想知道 pptx 每页讲什么

## 原理（重要，决定了它为什么不需要 Office）

docx / xlsx / pptx / odt **本质都是 zip + XML**：

| 格式 | 内容 |
|---|---|
| docx | `word/document.xml`，正文在 `<w:t>` 标签里 |
| xlsx | `xl/sharedStrings.xml`（共享字符串）+ `xl/worksheets/sheetN.xml`（单元格引用 `t="s"` 指向共享串） |
| pptx | `ppt/slides/slideN.xml`，文本在 `<a:t>` 里 |
| odt/ods | `content.xml` |

所以只要 `zipfile` + `xml.etree` 就够了，不需要任何 Office 组件。

## 命令

```powershell
$D = "C:\Users\KonomiHasu\dsh-private\skills\doc-extract\doc_extract.py"

python $D text   report.docx                 # docx 正文（按段落换行）
python $D text   slides.pptx                 # pptx（每页一段，带分隔）
python $D sheets report.xlsx                 # 列出所有工作表 + 尺寸
python $D table  report.xlsx -s Sheet1       # 某张表转 CSV
python $D table  report.xlsx -s Sheet1 --json -o out.jsonl
python $D list   report.docx                 # 看包里有哪些 part（调试用）
```

## 机制要点（别踩）

- **xlsx 的单元格值可能是三种**：`t="s"`（共享字符串索引）、`t="inlineStr"`（内联）、或直接数值。漏了任何一种都会读出空表。
- **空格子会被跳过**，所以行内列号要对齐 `r` 属性（如 `C5` 的 C），不能按出现顺序硬排。
- docx 的换行在 `<w:br/>` 和 `<w:p>` 上，不是 `\n`；分段要按 `<w:p>` 切。
- pptx 的文字可能被拆在多个 `<a:t>` 里（同一段落），要按 `<a:p>` 聚。
- 中文没问题，XML 是 UTF-8。

## 已知限制

- **不支持 pdf**（需要 pdfminer/pymupdf，本机没装）。
- 不提取图片、图表、嵌入对象。
- 公式（OMML）只会输出占位，不还原。
- 复杂表格（合并单元格）只能按左上角坐标近似，会丢合并信息。
