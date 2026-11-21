# skill 库

## 为什么不放全局

全局目录 `~/.dsh/skills` 走 `skill-filesystem` 的 `includeDefaultRoots`，**每个 profile、每个会话都会扫描它**。每个 skill 的 `description` 常驻系统提示——装多了就是每轮固定开销。

所以这里的做法是：

```
dsh-private/skills/            ← 库（不挂载时零开销）
    ├── dump/                  ← 7 个 skill，各带脚本
    └── ...
$DSH_HOME/profiles/<name>/cordis.patch.yml
    └── customSkillDirs: [C:/Users/KonomiHasu/dsh-private/skills]   ← 需要时才加
```

挂载靠 `skill-filesystem` 的 `customSkillDirs`（这个键是官方支持的），改完 HMR 热生效，不用重启。

**实测**：目录移出 `~/.dsh/skills` 后，当前会话的可用 skill 列表**立即**从 4 个减到 0 个（原有的 bili 不动），没有任何重启。

## 现有 7 个

| skill | 脚本 | 用途 | 实测 |
|---|---|---|---|
| `dsh-forensics` | forensics.mjs | 会话解压检索、日志扫错、dump 对比、profile 体检 | 检索到 365 处命中 |
| `archive-ops` | archive.py | zip/apk/jar/tar/gz 列内容、选择性解压、包内查找 | list/find/info/extract 全通 |
| `binary-triage` | triage.py | 魔数识别、PE 节表+熵+.NET、strings | 9 个节、熵值正确 |
| `win-diag` | diag.ps1 | 端口占用、进程树、监听、按 PID 杀 | 3080/3081 查询正确 |
| `sqlite-ops` | sqlite_ops.py | 表结构、查询、全库找值、导出 JSONL | 真实 memory.db：34 表/191 条消息 |
| `doc-extract` | doc_extract.py | docx/xlsx/pptx 提取文本（无 Office） | 真实 xlsx：2 表 1802×22 |
| `json-q` | jsonq.py | 路径取值、键树、批量抽字段、合并、grep | config.json 取值得出 `deepseek` |

全部脚本语法校验通过；`.ps1` 均带 UTF-8 BOM。

## 启停

```powershell
$S = "C:\Users\KonomiHasu\dsh-private\scripts\skills.ps1"

powershell -File $S list                       # 库里有什么
powershell -File $S status                     # 各 profile 挂没挂
powershell -File $S enable  -Profile private   # 挂载
powershell -File $S disable -Profile private   # 卸载
```

挂载段用注释标记包围（`# >>> dsh-private skills library`），`disable` 按标记精确删除，不会误伤手写配置。

## 新增一个 skill

1. 在 `dsh-private/skills/<name>/` 建目录
2. 写 `SKILL.md`，frontmatter 只要 `name` 和 `description`
   - **description 决定什么时候被选中**，要写清「用户说什么话时用」和「不用于什么」
3. 脚本放同目录，SKILL.md 里写清命令、机制要点（踩过的坑）、已知限制
4. 挂载目录已经指向这里，**写完即生效**，不用重新挂

## 与 tool 的区别

| | skill | tool |
|---|---|---|
| 形式 | markdown + 脚本 | cordis 插件 |
| 加载 | 按需（模型自己决定读不读） | 每轮都带 schema |
| token | 几乎为零 | 每步固定开销 |
| 生效 | 写完即用 | 需重启 |
| 适合 | 操作手册、多步流程、CLI 包装 | 高频原子操作 |

高频且简单的操作才值得做成 tool；其余都该是 skill。

---

## tool 清单（5 个）

包：`dsh-private/packages/dsh-private-tools/`
挂载：`profiles/private/cordis.patch.yml` 的 `insert:` 段（`# >>> dsh-private tools` 标记包围）

| tool | kinds | 用途 | 实现 |
|---|---|---|---|
| `sys_query` | port / process / listen | 端口占用、进程、监听清单 | 内联 PowerShell |
| `file_triage` | file / pe / strings | 魔数、PE 节表熵、字符串 | 调 `binary-triage/triage.py` |
| `archive_peek` | list / find / info | 不解压看包内容 | 调 `archive-ops/archive.py` |
| `sqlite_query` | tables / schema / query | 只读查库 | 调 `sqlite-ops/sqlite_ops.py` |
| `dsh_health` | — | dsh profile 配置体检 | 调 `dsh-forensics/forensics.mjs` |

四个「薄包装」tool 的逻辑都在 skill 脚本里，tool 只做参数校验、超时、截断、
结构化返回。好处是**不用维护两份实现**，而且 tool 不依赖 skill 是否挂载
（脚本路径固定）。

`sqlite_query` 额外做了写操作拦截：只允许 `SELECT` / `PRAGMA` / `EXPLAIN`。

### 实测（2026-11-13）

| 调用 | 结果 |
|---|---|
| `sys_query {port:3080}` | PID=8280 node.exe 完整命令行 |
| `file_triage {file:objdump.exe}` | `PE executable (Windows, exe/dll)` |
| `file_triage {pe:objdump.exe}` | `x64 / EXE / is_dotnet:false / 9 节` |
| `archive_peek {info:tz.zip}` | `zip-family, 246B` |
| `archive_peek {find:conf}` | `matched 1` |
| `sqlite_query {tables:memory.db}` | 34 个表 + 行数 |
| `dsh_health {profile:private}` | 4 个 bundles + 依赖数 + patch 状态 |

注册验证：`apply()` 后 `ctx.tools.register` 收到 5 个工具，`defineTool` 均已把
`parameters` 转成标准 JSON Schema。

### 拆成 kind 而不是拆成 tool

一个工具用 `kind` 参数覆盖多种操作，比拆成多个 tool 省 schema 开销
——工具定义每轮请求都整份发出。`sys_query` 一个顶三个，其余同理。

### 生效方式与 skill 不同

| | skill | tool |
|---|---|---|
| 改完 | **立即生效**（目录扫描） | **必须重启进程** |
| 挂载 | `skills.ps1 enable` | 在 patch 里 `insert` |
| 卸载 | `skills.ps1 disable` | 删掉 insert 段 |

所以 tool 开发期要反复重启，**先写成 skill 验证逻辑，稳定了再升级成 tool** —— 这是推荐的顺序。
