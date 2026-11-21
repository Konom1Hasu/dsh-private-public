import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { projectKey, rankAndDedupe, shouldUseFts } from "./core.mjs";

/**
 * @yg/dsh-private-memory
 *
 * 项目记忆库。存的不是对话，是**事实**：定过什么、不能违反什么、踩过什么坑、
 * 哪段代码能复用。每条一句话，短、可检索、能复用。
 *
 * 为什么按 workspace 分库：项目记忆本来就该隔离。跨项目通用的东西用
 * kind=note + project=__global__ 标记。
 *
 * 为什么用 node:sqlite：内置，不引外部依赖；dsh 自己的 session-query 也在用。
 *
 * @module @yg/dsh-private-memory
 */

const name = "private-memory";
const inject = ["tools", "workingDirectory"];

const KINDS = ["decision", "constraint", "pitfall", "snippet", "note"];

const Config = z.object({
  /** 库文件根目录；每个 workspace 一个 <hash>.db */
  dir: z.string().default("C:\\Users\\KonomiHasu\\.dsh\\memory"),
  /** 单个库的条数上限，超了按 hits 最低淘汰（0 = 不限） */
  maxEntries: z.number().default(5000),
  /** 搜索返回条数上限 */
  searchLimit: z.number().default(10),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  tags          TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_kind    ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_title   ON entries(title);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
  USING fts5(title, body, tags, content='entries', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
`;

function apply(ctx, config) {
  let db = null;
  let dbKey = "";

  /**
   * 取当前会话的工作目录。
   * workingDirectory.ensure 要完整的 Agent 对象，从 tool 的 exec 里拿；
   * 拿不到就退到 process.cwd()，至少不会抛错。
   */
  async function resolveCwd(exec) {
    if (exec && exec.agent) {
      try {
        return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch { /* 退到 cwd */ }
    }
    return process.cwd();
  }

  /** 打开（或复用）当前 workspace 的库。 */
  function open(cwd) {
    const key = projectKey(cwd);
    if (db && dbKey === key) return db;
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; }

    mkdirSync(config.dir, { recursive: true });
    const file = join(config.dir, `${key}.db`);
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    migrateFts(db);
    dbKey = key;
    return db;
  }

  /**
   * 把老的 unicode61 分词器换成 trigram。
   *
   * 为什么换：unicode61 把整段中文当一个 token，搜「孤儿包」命中为零。
   * 实测 trigram（3 字符滑窗）能搜中 3 字以上的中文，代价是索引大约 69%。
   * 2 字查询仍然要靠 LIKE，那是分词器做不到的部分，不假装能解决。
   *
   * `CREATE VIRTUAL TABLE IF NOT EXISTS` 对已有库不会重建，所以这里手动判一次。
   */
  function migrateFts(handle) {
    try {
      const row = handle.prepare("SELECT sql FROM sqlite_master WHERE name='entries_fts'").get();
      if (!row || String(row.sql || "").includes("trigram")) return;

      handle.exec("DROP TRIGGER IF EXISTS entries_ai");
      handle.exec("DROP TRIGGER IF EXISTS entries_ad");
      handle.exec("DROP TRIGGER IF EXISTS entries_au");
      handle.exec("DROP TABLE IF EXISTS entries_fts");
      handle.exec(
        "CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, tags, content='entries', content_rowid='id', tokenize='trigram')",
      );
      handle.exec("INSERT INTO entries_fts(rowid, title, body, tags) SELECT id, title, body, tags FROM entries");
      handle.exec(`
        CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
        END;
        CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
        END;
        CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
          INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
        END;
      `);
      const n = handle.prepare("SELECT COUNT(*) AS c FROM entries_fts").get();
      console.log(`[memory] FTS 已切到 trigram，重建 ${n?.c ?? "?"} 条索引`);
    } catch (e) {
      // 重建失败不该让整个插件挂掉 —— 退回 LIKE 仍然能用，只是慢
      console.warn(`[memory] FTS 迁移失败（检索会退回 LIKE）: ${e?.message || e}`);
    }
  }

  /**
   * 列出记忆目录下所有 workspace 库。
   *
   * 为什么需要跨库：库按 workspace 的 cwd 哈希命名，同一个用户在
   * `C:\Users\X` 和 `C:\Users\X\.dsh` 下工作会落进两个库。只搜当前库
   * 会让「在 TUI 记的、在 Web 搜不到」，那正好违背记忆库存在的意义。
   */
  function listDbFiles() {
    try {
      return readdirSync(config.dir)
        .filter((f) => f.endsWith(".db"))
        .map((f) => join(config.dir, f));
    } catch {
      return [];
    }
  }

  /** 以只读方式打开一个库，失败返回 null（别的进程可能在写）。 */
  function openReadOnly(file) {
    try {
      return new DatabaseSync(`file:${file.replace(/\\/g, "/")}?mode=ro`, { readOnly: true });
    } catch {
      try { return new DatabaseSync(file); } catch { return null; }
    }
  }

  function now() { return Date.now(); }

  /** 同一个 title 已经存在时，把旧的标成 superseded，而不是覆盖。 */
  function supersede(d, project, title, newId) {
    const old = d.prepare(
      "SELECT id FROM entries WHERE project = ? AND title = ? AND superseded_by IS NULL ORDER BY id DESC"
    ).all(project, title);
    for (const row of old) {
      if (row.id === newId) continue;
      d.prepare("UPDATE entries SET superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(newId, now(), row.id);
    }
  }

  function trim(d) {
    if (!config.maxEntries) return;
    const c = d.prepare("SELECT COUNT(*) AS n FROM entries").get();
    if (c.n <= config.maxEntries) return;
    const overflow = c.n - config.maxEntries;
    // 淘汰命中次数最低、最久未用的
    d.prepare(
      `DELETE FROM entries WHERE id IN (
         SELECT id FROM entries ORDER BY hits ASC, COALESCE(last_hit_at, created_at) ASC LIMIT ?
       )`
    ).run(overflow);
  }

  // ── memory_write ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "memory_write",
      description:
        "把一条项目记忆写进记忆库。kind 五类：decision（定过什么）、constraint（不能违反什么）、" +
        "pitfall（踩过的坑）、snippet（可复用的代码/命令）、note（其他）。" +
        "一条一句话，短、具体、能复用。同一个 title 再写会自动把旧的标记为已取代，不覆盖历史。",
      parameters: {
        kind: { type: "string", required: true, enum: KINDS, description: "记忆类型" },
        title: { type: "string", required: true, description: "一句话标题，尽量短（< 40 字）" },
        body: { type: "string", required: true, description: "具体内容，一句到三句" },
        tags: { type: "string", description: "逗号分隔的标签，可选" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            id: { type: "number" },
            text: { type: "string", required: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args, exec) {
        const cwd = await resolveCwd(exec);
        const project = String(cwd || ".").replace(/\\/g, "/");
        const d = open(cwd);
        const t = now();
        const info = d.prepare(
          "INSERT INTO entries (kind, project, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(args.kind, project, args.title.trim(), args.body.trim(), (args.tags || "").trim(), t, t);
        const id = Number(info.lastInsertRowid);
        supersede(d, project, args.title.trim(), id);
        trim(d);
        return { ok: true, id, text: `已记住 #${id} [${args.kind}] ${args.title}` };
      },
      presentCall: (a) => ({
        card: "generic",
        title: `memory_write ${a.kind}`,
        kind: "other",
        rawInput: a.title,
      }),
    }),
  );

  // ── memory_search ───────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "memory_search",
      description:
        "在记忆库里搜。改任何文件之前先搜一次，看有没有定过的方案、踩过的坑、能复用的代码。" +
        "默认跨所有 workspace 搜索（在不同目录下记的东西都能找到），结果标注来源目录。" +
        "返回按相关度和命中次数排序的简短条目。",
      parameters: {
        query: { type: "string", required: true, description: "关键词（中文英文都行）" },
        kind: { type: "string", enum: KINDS, description: "只看某一类" },
        local: { type: "boolean", description: "true = 只搜当前 workspace 的库，默认搜全部" },
        limit: { type: "number", description: "返回条数，默认 10" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            found: { type: "boolean", required: true },
            count: { type: "number", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args, exec) {
        const cwd = await resolveCwd(exec);
        const limit = Math.min(args.limit || config.searchLimit, 50);
        const q = String(args.query || "").trim().replace(/["]/g, " ");
        if (!q) return { found: false, count: 0, text: "给个关键词" };

        // 决定搜哪些库：默认全部（跨 workspace），local=true 只搜当前
        const curFile = join(config.dir, `${projectKey(cwd)}.db`);
        let files = listDbFiles();
        if (args.local) files = files.filter((f) => f === curFile);
        // 当前库排最前，让本项目的命中优先出现
        files.sort((a, b) => (a === curFile ? -1 : b === curFile ? 1 : 0));

        const collected = [];
        for (const file of files) {
          const d = openReadOnly(file);
          if (!d) continue;
          let rows = [];
          let needLike = false;
          // trigram 分词器要求查询至少 3 个字符。短查询直接走 LIKE，
          // 省一次注定为空的 FTS 调用。
          const useFts = shouldUseFts(q);
          try {
            if (!useFts) throw new Error("short-query");
            const where = ["e.superseded_by IS NULL"];
            const params = [];
            if (args.kind) { where.push("e.kind = ?"); params.push(args.kind); }
            rows = d.prepare(
              `SELECT e.id, e.kind, e.project, e.title, e.body, e.tags, e.hits, e.created_at
               FROM entries_fts f JOIN entries e ON e.id = f.rowid
               WHERE entries_fts MATCH ? AND ${where.join(" AND ")}
               ORDER BY bm25(entries_fts) ASC, e.hits DESC LIMIT ?`
            ).all(`"${q}"`, ...params, limit);
            // FTS 命中零条也要用 LIKE 兜一次 —— 分词切不开的写法只有子串能找回来
            if (!rows.length) needLike = true;
          } catch {
            needLike = true;
          }

          if (needLike) {
            try {
              rows = d.prepare(
                `SELECT id, kind, project, title, body, tags, hits, created_at FROM entries
                 WHERE (title LIKE ? OR body LIKE ? OR tags LIKE ?) AND superseded_by IS NULL
                 ${args.kind ? "AND kind = ?" : ""}
                 ORDER BY hits DESC, updated_at DESC LIMIT ?`
              ).all(`%${q}%`, `%${q}%`, `%${q}%`, ...(args.kind ? [args.kind] : []), limit);
            } catch { /* 这个库读不了就跳过 */ }
          }

          const isCurrent = file === curFile;
          for (const r of rows) collected.push({ ...r, __cur: isCurrent, __file: file });
          try { d.close(); } catch { /* ignore */ }
        }

        if (!collected.length) {
          return { found: false, count: 0, text: `没有匹配「${args.query}」的记忆` };
        }

        // 先排序再���重：让当前库的记录先入表，去重时才保留"当前库那条"，
        // 标注才不会把自家记录说成"来自其他 workspace"。
        const top = rankAndDedupe(collected, limit);

        // 命中计数只写当前库（跨库只读打开，不抢写锁）
        try {
          const dw = open(cwd);
          const bump = dw.prepare("UPDATE entries SET hits = hits + 1, last_hit_at = ? WHERE id = ?");
          for (const r of top) if (r.__cur) bump.run(now(), r.id);
        } catch { /* ignore */ }

        const lines = top.map((r) => {
          const mark = r.__cur ? "" : `  ← ${r.project}`;
          return `#${r.id} [${r.kind}] ${r.title}\n    ${String(r.body).slice(0, 160)}  (hit ${r.hits})${mark}`;
        });
        const crossCount = top.filter((r) => !r.__cur).length;
        const head = crossCount ? `（其中 ${crossCount} 条来自其他 workspace）\n` : "";
        return { found: true, count: top.length, text: head + lines.join("\n") };
      },
      presentCall: (a) => ({
        card: "generic",
        title: `memory_search ${String(a.query).slice(0, 20)}`,
        kind: "read",
        rawInput: a.query,
      }),
    }),
  );

  // ── memory_recall ───────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "memory_recall",
      description:
        "按 id 取一条记忆的完整内容。搜索结果是摘要，需要细节时用这个。" +
        "id 在每个 workspace 库里独立编号，所以先找当前库，找不到再跨库找。",
      parameters: {
        id: { type: "number", required: true, description: "记忆 id" },
        project: { type: "string", description: "可选：限定某个 workspace 路径（搜索结果里 ← 后面那个）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            found: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args, exec) {
        const cwd = await resolveCwd(exec);
        const curFile = join(config.dir, `${projectKey(cwd)}.db`);

        // 候选库：给了 project 就按它挑；否则当前库优先，再跨库找
        let files = listDbFiles();
        if (args.project) {
          const want = String(args.project).replace(/\\/g, "/");
          files = files.filter((f) => {
            const d0 = openReadOnly(f);
            if (!d0) return false;
            try {
              const row = d0.prepare("SELECT project FROM entries WHERE id = ?").get(args.id);
              return row && String(row.project).replace(/\\/g, "/") === want;
            } catch { return false; } finally { try { d0.close(); } catch { /* ignore */ } }
          });
        } else {
          files.sort((a, b) => (a === curFile ? -1 : b === curFile ? 1 : 0));
        }

        for (const file of files) {
          const d = openReadOnly(file);
          if (!d) continue;
          let r = null;
          try {
            r = d.prepare(
              "SELECT id, kind, project, title, body, tags, created_at, hits, superseded_by FROM entries WHERE id = ?"
            ).get(args.id);
          } catch { /* 跳过坏库 */ }
          try { d.close(); } catch { /* ignore */ }
          if (!r) continue;

          const note = r.superseded_by ? `\n（已被 #${r.superseded_by} 取代）` : "";
          return {
            found: true,
            text:
              `#${r.id} [${r.kind}] ${r.title}\n` +
              `项目: ${r.project}\n` +
              `时间: ${new Date(r.created_at).toISOString()}\n` +
              `命中: ${r.hits}\n` +
              `标签: ${r.tags || '(无)'}\n` +
              `\n${r.body}${note}`,
          };
        }
        return { found: false, text: `没有 #${args.id}${args.project ? `（限定 ${args.project}）` : ""}` };
      },
      presentCall: (a) => ({
        card: "generic",
        title: `memory_recall #${a.id}`,
        kind: "read",
        rawInput: String(a.id),
      }),
    }),
  );
}

export { Config, apply, inject, name };
