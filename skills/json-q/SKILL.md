---
name: json-q
description: Use when you need to query or reshape a JSON file without jq installed — 按路径取值、列出所有键、统计结构、多文件合并、格式美化。当用户说「这个 json 里 xxx 是什么」「把所有 name 提出来」「这个响应结构长什么样」「合并这几个 json」时用。不用于写业务代码。
---

# json-q — JSON 查询与整形

脚本：`C:\Users\KonomiHasu\dsh-private\skills\json-q\jsonq.py`（Python 标准库）

## 什么时候用

这台机器没有 `jq`。要看结构化数据时，这个脚本覆盖 90% 的日常需求：

- 从 API 响应里挖某个字段
- 列出嵌套结构的形状（键路径树）
- 批量提取字段做清单
- 合并/过滤多个 json
- 格式化难看的一行 json

## 命令

```powershell
$J = "C:\Users\KonomiHasu\dsh-private\skills\json-q\jsonq.py"

python $J get   data.json "a.b[0].c"          # 路径取值
python $J keys  data.json                     # 键路径树（看结构用）
python $J pick  data.json "users[].name"      # 批量抽字段 -> 每行一个
python $J fmt   data.json                     # 美化/压紧
python $J merge a.json b.json -o merged.json  # 数组合并
python $J grep  data.json "关键词"             # 在值里搜
```

路径语法：`a.b[0].c`、`users[].name`（`[]` = 遍历所有元素）、`d.*`（所有键的值）。

## 机制要点（别踩）

- **`[]` 和 `*` 不是一回事**：`[]` 只用于数组遍历，`*` 用于对象所有键。混用会返回空。
- **中文/非 ASCII 不该被转义**：脚本统一 `ensure_ascii=False`，输出是可读中文而不是 `\u4e2d`。
- 大文件用 `--stream` 读 JSONL（每行一个 JSON），否则会整个读进内存。
- 数字精度：JSON 里的 `1.0` 和 `1` 在 Python 里会变 `1.0`/`1`，反序列化后再序列化可能改格式。要保原文就用 `fmt --raw`。

## 已知限制

- 不支持 jq 的完整表达式语法（`select()`、`map()`、管道）。复杂查询请用 Python 直接写。
- 不支持 JSON5 / 带注释的 JSON。
- BOM 会让 `json.loads` 失败——脚本已自动剥离。
