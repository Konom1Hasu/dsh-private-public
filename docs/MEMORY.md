# 记忆库与上下文边界

> 记录 `@yg/dsh-private-memory` 的设计、2026-11-13 修掉的四个 bug，
> 以及「TUI 与 Web 的对话上下文为什么不能共享、能怎么绕过」。

## 一、记忆库存什么

存的不是对话，是**事实**：

| kind | 什么时候写 | 例子 |
|---|---|---|
| `decision` | 定了方案/架构 | 「会话目录不按 profile 隔离，按 workspace 分」 |
| `constraint` | 不能违反的规则 | 「改 .ps1 必须带 BOM，package.json 必须不带」 |
| `pitfall` | 踩坑 + 根因 | 「PowerShell 函数所有 Write-Output 会被 `$x =` 捕获」 |
| `snippet` | 可复用命令/代码 | 「重启 dsh：按端口杀 + 校验新 PID≠旧 PID」 |
| `note` | 其他 | 「用户偏好保留后路」 |

一条一句话，短、可检索、能复用。

## 二、为什么按 workspace 分库

一个 workspace 一个 SQLite 文件：

```
~/.dsh/memory/<sha1(归一化cwd)前12位>.db
```

理由：项目记忆本该隔离，A 项目的坑不该污染 B 项目的搜索结果。

代价：**同一个路径的不同写法会算出不同 key**（见下面的 bug ①）。

## 三、2026-11-13 修掉的四个 bug

### bug ① projectKey 不归一化分隔符

同一个 workspace 的两种路径写法算出两个不同的库：

```
projectKey(C:\Users\KonomiHasu\.dsh) = 598fcd06b1bb   旧
projectKey(C:/Users/KonomiHasu/.dsh) = f2205579b180   新
```

实测因此裂出过一个空库。而库里 `project` 字段一直用正斜杠——**文件名和字段不一致**。

修法：先归一化再 hash。

```js
function projectKey(cwd) {
  const norm = String(cwd || ".")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}
```

### bug ② 迁移用文件复制会丢 WAL

SQLite 开着 WAL 模式时，未 checkpoint 的数据在 `-wal` 文件里。只复制 `.db` 会丢。

修法：`VACUUM INTO`，它把 WAL 合并进目标文件。

```js
const d = new DatabaseSync(oldPath);
d.exec(`VACUUM INTO '${newPath}'`);
```

### bug ③ 去重在排序之前

```js
// 错：collected 未排序，先遍历到旧库那条（__cur=false），保留了它
for (const r of collected) { ... }

// 对：先按 __cur 排序，让当前库的先入表
collected.sort((a, b) => (b.__cur - a.__cur) || (b.hits - a.hits));
for (const r of collected) { ... }
```

后果是把自己的记录标注成「来自其他 workspace」。

### bug ④ FTS5 的 unicode61 对中文分词很弱

「已验证」这类子串会被当成整体 token，`entries_fts MATCH '"已验证"'` 返回 0 行。

修法：FTS 零结果时降级 `LIKE` 再搜一次。

```js
rows = ftsQuery(...);
if (!rows.length) needLike = true;   // 不报错也要兜底
if (needLike) rows = likeQuery(...);
```

注意：不能只在 `catch` 里兜底——FTS 不报错，只是返回空。

## 四、跨库搜索（默认行为）

`memory_search` **默认搜所有 workspace 库**，因为「不会丢失项目记忆」包括跨目录的记忆。

| 参数 | 行为 |
|---|---|
| 默认 | 搜全部库，当前库优先 |
| `local: true` | 只搜当前 workspace 的库 |
| 结果标注 | 跨库的附 `← <workspace 路径>` |

去重规则：`project + title + body前120字` 相同视为同一条。为什么需要：bug ① 的遗留旧库可能还在。

## 五、对话上下文：为什么不能共享

**一个会话 = 一个 `.jsonl.zstd` 文件，由一个进程持有写锁。**

两个 dsh 实例（TUI + Web）同时打开同一个会话会冲突——表现就是「当前会话已被占用」。

这不是缺陷，是持久化模型的必然：会话日志是 append-only 的单一真相源。

### 三条路，按实用性排

**A. 单实例切换（推荐）**

只开一个 dsh，用会话管理切：

| TUI | Web |
|---|---|
| `/resume` `/home` `/agentview` | 左侧会话列表 |

这样「上下文」天然连续，没有同步问题。

**B. 记忆库传递结论**

跨端接续任务时，在结束那端写几条记忆：

```
memory_write decision "X 方案已定" "采用 A 而非 B，因为…"
```

另一端 `memory_search` 就能接上。**只传结论，不传过程。**

**C. 官方跨会话引用（有限制）**

dsh 有两个包：

| 包 | 形态 | TUI 可用 |
|---|---|---|
| `@deepseek-ai/dsh-session-reference` | host 侧服务，`@label` → 只读快照 | 需 TUI 有 UI 入口 |
| `dsh-client-ui-session-mention` | 浏览器组件，输入 `@` 弹会话列表 | ❌ 纯 client-ui |

**实测**：TUI 包里搜不到 `sessionReference` / `sessionMention` 的实现，也没有 `@` 提及入口。所以 **C 在 TUI 里用不了**（Web 侧已经装了 `session-mention`，可用）。

### 结论

| 需求 | 方案 |
|---|---|
| 长期事实不丢 | 记忆库（已实现，跨 workspace） |
| 跨端接续任务 | 记忆库存结论 |
| 完整对话连续 | **只用一边**，`/resume` 切 |
| 引用另一端的某段对话 | 目前只能手动 `/export` 后粘贴 |

**「对话上下文共享」在当前的持久化模型下没有干净解法。** 谁承诺能，都是在两个进程间同步 append-only 日志，迟早冲突。

## 六、库文件位置与备份

```
~/.dsh/memory/<key>.db          活库
dsh-private/backups/memory-*/   迁移时的快照
```

诊断命令：

```powershell
# 列出所有库和条数
python dsh-private\skills\sqlite-ops\sqlite_ops.py tables ~/.dsh/memory/<key>.db
```

或者用 `memory_search` + `memory_recall`。
