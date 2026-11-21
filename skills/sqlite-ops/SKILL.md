---
name: sqlite-ops
description: Use when you need to read or inspect a SQLite database file — 列表结构、查表、导出、找某个值在哪张表、看 FTS 索引。当用户说「查一下这个 db」「memory.db 里有什么」「这张表结构是什么」「帮我找这个值」时用。不用于写业务代码里的 ORM。
---

# sqlite-ops — SQLite 直查

脚本：`C:\Users\KonomiHasu\dsh-private\skills\sqlite-ops\sqlite_ops.py`（Python 标准库 sqlite3）

## 什么时候用

- 手边有个 `.db` / `.sqlite` 文件，想知道里面有什么
- 要查某个值出现在哪些表哪些行
- 要看 FTS5 索引建得对不对
- 要导出成 JSONL/CSV 给别的工具用

这台机器上现成的例子：`C:\Users\KonomiHasu\Desktop\微信QQ接入\memory\memory.db`（QQ bot 的记忆库）

## 命令

```powershell
$Q = "C:\Users\KonomiHasu\dsh-private\skills\sqlite-ops\sqlite_ops.py"

python $Q tables  memory.db                    # 所有表 + 行数
python $Q schema  memory.db messages           # 建表语句 + 索引
python $Q query   memory.db "SELECT * FROM messages LIMIT 5"
python $Q find    memory.db "某个值"            # 全库扫这个值在哪
python $Q export  memory.db messages --limit 100 -o out.jsonl
python $Q info    memory.db                    # 文件大小、页数、编码、journal 模式
```

## 机制要点（别踩）

- **只读打开**：脚本用 `file:...?mode=ro` URI 打开，避免意外写坏正在被程序使用的库。
- **WAL 模式**的库有 `-wal` 和 `-shm` 旁文件，少了它们会看到旧数据。脚本会提示旁文件是否存在。
- `find` 用的是对每张表做 `CAST(col AS TEXT) LIKE`，大库会慢；先用 `--tables` 限定范围。
- FTS5 虚拟表在 `sqlite_master` 里 type='table'，但 `sqlite_master.sql` 里能看到 `USING fts5`。
- 中文路径没问题，但**库被别的进程独占写**时只读打开也可能失败，那就先把程序停掉。

## 已知限制

- 不处理加密库（SQLCipher 等）。
- 不做 schema 迁移、不写数据（要写请用专门的工具，别在生产库上乱来）。
- `find` 不搜 BLOB 列。
