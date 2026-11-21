/**
 * @yg/dsh-private-tasks
 *
 * 持久任务层。给私有工作台的「待办」卡供数据。
 *
 * ── 为什么不复用原生 todo ───────────────────────────────────────
 * dsh 原生 todo（`todo/write` 事件）是**单次会话里的临时草稿**：
 *   · 数据只有 `{ content, status }`，没有 id
 *   · 每次写入是整份列表替换（last-wins）
 *   · 源码注释明说这是刻意设计："No id, priority, or activeForm —
 *     the list is replaced wholesale on every write, so entries need no
 *     stable identity."
 * 模型会随时重写列表、改措辞、合并条目。想从这种快照反推出稳定身份，
 * 不管按文本匹配还是按位置匹配，都会在模型改写时断掉历史或造出幽灵任务。
 *
 * 所以这里**不试图映射原生 todo**，而是另立一套显式 id 的账本：
 *   原生 todo  = 当前会话的执行进度条（草稿，不进这里）
 *   task       = 跨会话存活的真任务（本模块管的）
 * 想同时看两边，工作台自己去读会话投影，两边不互相污染。
 *
 * ── Task / Run 为什么分开 ─────────────────────────────────────
 * 一个任务的「身份」和「谁在干」是两件事。子代理挂了重试，任务还是那个任务，
 * 变的只是执行记录。合成一张表的话，重试就会把任务历史冲掉。
 *
 * @module @yg/dsh-private-tasks
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  TASK_STATES,
  BLOCK_KINDS,
  assertState,
  assertBlockKind,
  assertBlockQuestion,
  canOverrideBlock,
  canUnblock,
  canStartRun,
  statusAfterRunEnd,
  statusAfterUnblock,
} from "./core.mjs";

const name = "@yg/dsh-private-tasks";
const inject = ["tools", "webServer"];

// 状态枚举、阻塞优先级、参数校验都在 ./core.mjs —— 那边是纯函数，有测试覆盖。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  parent_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  blocked_kind TEXT,
  blocked_question TEXT,
  blocked_by TEXT,
  blocked_at INTEGER,
  status_before_block TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  source TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER,
  ended_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
`;

const uid = (p) => p + "_" + randomBytes(4).toString("hex");
const now = () => Date.now();

function fmtTask(t, runs) {
  const tag = {
    pending: "○",
    in_progress: "▶",
    blocked: "!",
    done: "✓",
    cancelled: "×",
  }[t.status] || "?";
  const bits = [`${tag} ${t.id}  ${t.title}`];
  if (t.priority) bits.push(`  P${t.priority}`);
  if (t.status === "blocked") {
    const who = t.blocked_by === "human" ? "你标的" : t.blocked_by === "system" ? "系统探测" : "模型报的";
    bits.push(`  [${t.blocked_kind} / ${who}]`);
    if (t.blocked_question) bits.push(`\n     问：${t.blocked_question}`);
  }
  if (runs && runs.length) {
    const live = runs.find((r) => r.status === "running");
    if (live) {
      bits.push(`\n     在跑：${live.session_id || "(无会话)"}${live.agent_id ? ` / ${live.agent_id}` : ""}`);
    }
  }
  if (t.detail) bits.push(`\n     ${t.detail.slice(0, 200)}`);
  return bits.join("");
}

export const Config = z.object({
  /** 库文件目录，默认 ~/.dsh */
  dir: z.string().default(""),
  /** 会话无事件多久算卡死（分钟），供 system 触发 blocked 用 */
  stallMinutes: z.number().default(20),
});

export function apply(ctx, config) {
  const dir = config.dir || join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
  const file = join(dir, "tasks.db");
  let db = null;

  function open() {
    if (db) return db;
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    migrate(db);
    return db;
  }

  /**
   * 给已有库补列。
   *
   * SCHEMA 里的 CREATE TABLE IF NOT EXISTS 只对新库生效，
   * 老库已经有表了，新加的列得单独 ALTER。每次都查一遍，幂等。
   */
  function migrate(handle) {
    const cols = handle.prepare("PRAGMA table_info(tasks)").all();
    const has = (n) => cols.some((c) => c.name === n);
    if (!has("status_before_block")) {
      handle.exec("ALTER TABLE tasks ADD COLUMN status_before_block TEXT");
    }
  }

  const q = {
    all: (sql, ...p) => open().prepare(sql).all(...p),
    get: (sql, ...p) => open().prepare(sql).get(...p),
    run: (sql, ...p) => open().prepare(sql).run(...p),
  };

  function getTask(id) {
    return q.get("SELECT * FROM tasks WHERE id = ?", id);
  }

  function runsOf(id) {
    return q.all("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC", id);
  }

  function touch(id) {
    q.run("UPDATE tasks SET updated_at = ? WHERE id = ?", now(), id);
  }

  /* ── 任务操作 ───────────────────────────────────────────── */

  function createTask({ title, detail, parent_id, priority, source }) {
    const t = String(title || "").trim();
    if (!t) throw new Error("title 不能为空");
    if (parent_id && !getTask(parent_id)) throw new Error(`父任务不存在: ${parent_id}`);
    const id = uid("task");
    const ts = now();
    q.run(
      "INSERT INTO tasks (id, title, detail, status, parent_id, priority, created_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?)",
      id, t, detail || null, "pending", parent_id || null, Number(priority) || 0, ts, ts, source || "agent",
    );
    return getTask(id);
  }

  function setStatus(id, status) {
    assertState(status);   // 校验在 core，有测试盯着
    const t = getTask(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    q.run(
      "UPDATE tasks SET status = ?, updated_at = ?, done_at = ? WHERE id = ?",
      status,
      now(),
      status === "done" ? now() : null,
      id,
    );
    return getTask(id);
  }

  /**
   * 标记阻塞。
   *
   * 判断逻辑全在 core.mjs：谁能覆盖谁、模型要不要给 question 都有测试。
   * 这里只负责落库。
   */
  function blockTask({ id, kind, question, by, force }) {
    const t = getTask(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    const who = by || "model";

    assertBlockKind(kind);
    assertBlockQuestion(who, question);

    if (!force && t.status === "blocked" && t.blocked_by && !canOverrideBlock(t.blocked_by, who)) {
      return {
        task: t,
        rejected: `已有 ${t.blocked_by} 标的阻塞，优先级更高，${who} 覆盖不了。要改请让人来解除。`,
      };
    }

    const ts = now();
    // 记住阻塞前的状态，解除时才能回到原位（pending 不该被推成 in_progress）
    const before = t.status === "blocked" ? t.status_before_block || "pending" : t.status;
    q.run(
      "UPDATE tasks SET status='blocked', blocked_kind=?, blocked_question=?, blocked_by=?, blocked_at=?, status_before_block=?, updated_at=? WHERE id=?",
      kind, question || null, who, ts, before, ts, id,
    );
    return { task: getTask(id) };
  }

  /** 解除阻塞。人工标的只能人工解，规则在 core。 */
  function unblockTask({ id, answer, by }) {
    const t = getTask(id);
    if (!t) return t;   // 不存在时交给调用方报错
    if (t.status !== "blocked") return t;
    const who = by || "human";
    if (!canUnblock(t.blocked_by, who)) {
      throw new Error("这条是人工标的阻塞，只能人工解除");
    }
    // 回答挂到 detail 上，下次执行时能看到
    const detail = answer ? `${t.detail || ""}${t.detail ? "\n" : ""}[解除阻塞] ${answer}`.trim() : t.detail;
    const hasRuns = q.all("SELECT id FROM runs WHERE task_id=?", id).length > 0;
    const back = statusAfterUnblock(t.status_before_block, hasRuns);
    q.run(
      "UPDATE tasks SET status=?, blocked_kind=NULL, blocked_question=NULL, blocked_by=NULL, blocked_at=NULL, status_before_block=NULL, detail=?, updated_at=? WHERE id=?",
      back, detail || null, now(), id,
    );
    return getTask(id);
  }

  /* ── 执行记录 ───────────────────────────────────────────── */

  function startRun({ task_id, session_id, agent_id }) {
    const t = getTask(task_id);
    if (!t) throw new Error(`任务不存在: ${task_id}`);
    if (!canStartRun(t.status)) {
      throw new Error(`任务已${t.status === "done" ? "完成" : "取消"}，不能再开执行记录`);
    }
    const id = uid("run");
    q.run(
      "INSERT INTO runs (id, task_id, session_id, agent_id, status, started_at) VALUES (?,?,?,?,?,?)",
      id, task_id, session_id || null, agent_id || null, "running", now(),
    );
    if (t.status === "pending") setStatus(task_id, "in_progress");
    touch(task_id);
    return q.get("SELECT * FROM runs WHERE id = ?", id);
  }

  function endRun({ run_id, status, note }) {
    const r = q.get("SELECT * FROM runs WHERE id = ?", run_id);
    if (!r) throw new Error(`执行记录不存在: ${run_id}`);
    const st = status || "done";
    if (!["done", "failed", "abandoned"].includes(st)) throw new Error(`未知 run 状态: ${st}`);
    q.run("UPDATE runs SET status=?, ended_at=?, note=? WHERE id=?", st, now(), note || null, run_id);

    // 任务该变成什么，交给 core 判定：失败不完结任务，成功且没有别的 run 才结。
    const task = getTask(r.task_id);
    if (task) {
      const stillRunning = q.all("SELECT id FROM runs WHERE task_id=? AND status='running'", r.task_id).length;
      const next = statusAfterRunEnd(task.status, st, stillRunning);
      if (next !== task.status) setStatus(r.task_id, next);
    }
    return q.get("SELECT * FROM runs WHERE id = ?", run_id);
  }

  /* ── 系统探测：卡死检测 ─────────────────────────────────── */
  /**
   * 找出「有 run 在跑但很久没更新」的任务。
   * 只报告，不自动标 blocked —— 自动标会把慢但正常的长任务误判。
   * 由工作台展示、人决定，或等到 stallMinutes 后由 system 触发。
   */
  function stalls() {
    const cutoff = now() - Math.max(1, config.stallMinutes) * 60_000;
    return q.all(
      `SELECT r.*, t.title FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE r.status='running' AND r.started_at < ? AND t.status != 'blocked'
       ORDER BY r.started_at ASC`,
      cutoff,
    );
  }

  /* ── 工具 ───────────────────────────────────────────────── */
  ctx.tools.register(
    defineTool({
      name: "task",
      description:
        "跨会话任务账本：稳定 id、可关联子代理执行记录、有 blocked 状态。需要人拍板时用 block。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["create", "list", "get", "update", "block", "unblock", "done", "cancel", "run_start", "run_end", "stalls"],
          description: "操作",
        },
        id: { type: "string", description: "任务 id" },
        title: { type: "string", description: "任务名" },
        detail: { type: "string", description: "细节" },
        parent_id: { type: "string", description: "父任务 id" },
        priority: { type: "number", description: "越大越靠前" },
        status: { type: "string", description: "新状态" },
        kind: { type: "string", description: "阻塞原因" },
        question: { type: "string", description: "要人回答什么，block 必填" },
        answer: { type: "string", description: "人的回答" },
        by: { type: "string", description: "谁触发，默认 model" },
        run_id: { type: "string", description: "执行记录 id" },
        session_id: { type: "string", description: "会话 id" },
        agent_id: { type: "string", description: "子代理 id" },
        note: { type: "string", description: "执行结果" },
        limit: { type: "number", description: "条数" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args) {
        try {
          switch (args.action) {
            case "create": {
              const t = createTask(args);
              return { ok: true, text: `已建 ${t.id}\n${fmtTask(t)}` };
            }
            case "list": {
              const st = args.status;
              const rows = st
                ? q.all("SELECT * FROM tasks WHERE status=? ORDER BY priority DESC, created_at ASC LIMIT ?", st, args.limit || 50)
                : q.all(
                    "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY priority DESC, created_at ASC LIMIT ?",
                    args.limit || 50,
                  );
              if (!rows.length) return { ok: true, text: "没有任务" };
              return { ok: true, text: rows.map((t) => fmtTask(t, runsOf(t.id))).join("\n\n") };
            }
            case "get": {
              const t = getTask(args.id);
              if (!t) return { ok: false, text: `任务不存在: ${args.id}` };
              const runs = runsOf(t.id);
              const head = fmtTask(t, runs);
              const rl = runs.length
                ? "\n\n执行记录：\n" + runs.map((r) => `  ${r.id} ${r.status} ${r.session_id || "-"} ${new Date(r.started_at).toLocaleString()}`).join("\n")
                : "";
              return { ok: true, text: head + rl };
            }
            case "update": {
              const t = getTask(args.id);
              if (!t) return { ok: false, text: `任务不存在: ${args.id}` };
              if (args.title != null) q.run("UPDATE tasks SET title=? WHERE id=?", String(args.title).trim(), args.id);
              if (args.detail != null) q.run("UPDATE tasks SET detail=? WHERE id=?", args.detail, args.id);
              if (args.priority != null) q.run("UPDATE tasks SET priority=? WHERE id=?", Number(args.priority), args.id);
              if (args.status != null) setStatus(args.id, args.status);
              touch(args.id);
              return { ok: true, text: fmtTask(getTask(args.id), runsOf(args.id)) };
            }
            case "block": {
              const r = blockTask(args);
              if (r.rejected) return { ok: false, text: r.rejected };
              return { ok: true, text: `已标阻塞\n${fmtTask(r.task)}` };
            }
            case "unblock": {
              const t = unblockTask(args);
              return { ok: true, text: `已解除\n${fmtTask(t, runsOf(t.id))}` };
            }
            case "done": {
              const t = setStatus(args.id, "done");
              return { ok: true, text: `已完成\n${fmtTask(t)}` };
            }
            case "cancel": {
              const t = setStatus(args.id, "cancelled");
              return { ok: true, text: `已取消\n${fmtTask(t)}` };
            }
            case "run_start": {
              const r = startRun({ task_id: args.id, session_id: args.session_id, agent_id: args.agent_id });
              return { ok: true, text: `执行记录 ${r.id} 已开（任务 ${r.task_id}）` };
            }
            case "run_end": {
              const r = endRun(args);
              return { ok: true, text: `执行记录 ${r.id} → ${r.status}${r.note ? `：${r.note}` : ""}` };
            }
            case "stalls": {
              const s = stalls();
              if (!s.length) return { ok: true, text: `没有超过 ${config.stallMinutes} 分钟没动静的执行` };
              return {
                ok: true,
                text: s.map((r) => `${r.task_id} ${r.title}\n   ${r.id} 从 ${new Date(r.started_at).toLocaleString()} 起没结束`).join("\n\n"),
              };
            }
            default:
              return { ok: false, text: `未知 action: ${args.action}` };
          }
        } catch (e) {
          return { ok: false, text: String(e?.message || e) };
        }
      },
      presentCall: (a) => ({
        card: "generic",
        title: `task ${a.action}${a.id ? " " + a.id : ""}`,
        kind: a.action === "list" || a.action === "get" ? "read" : "other",
        rawInput: a.title || a.id || a.action,
      }),
    }),
  );

  /* ── HTTP：给工作台读 ───────────────────────────────────── */
  ctx.webServer.register({
    kind: "exact",
    path: "/private/tasks.json",
    handler: async (req, res) => {
      try {
        const rows = q.all(
          "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY priority DESC, created_at ASC",
        );
        const done = q.all(
          "SELECT * FROM tasks WHERE status='done' ORDER BY done_at DESC LIMIT 20",
        );
        const payload = {
          ok: true,
          counts: {
            pending: rows.filter((t) => t.status === "pending").length,
            in_progress: rows.filter((t) => t.status === "in_progress").length,
            blocked: rows.filter((t) => t.status === "blocked").length,
            done: done.length,
          },
          tasks: rows.map((t) => ({ ...t, runs: runsOf(t.id) })),
          recentDone: done.map((t) => ({ id: t.id, title: t.title, done_at: t.done_at })),
          stalls: stalls(),
          generatedAt: now(),
        };
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      }
    },
  });
}

export { name, inject };
