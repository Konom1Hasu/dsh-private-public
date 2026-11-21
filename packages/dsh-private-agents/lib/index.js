/**
 * @yg/dsh-private-agents — Agent 编队工作台
 *
 * 从 `~/.dsh/sessions/<workspace>/<会话目录>/session.v4.jsonl.zstd` 重建：
 *   · agent 树（父子关系靠「父会话 subagent 工具调用时间 == 子会话 createdAt」匹配）
 *   · 每个 agent 的规模指标（事件/轮/步/消息/工具/时长/估算 token）
 *   · 活动时间线（泳道用）
 *   · 派发任务表（子会话对应的 subagent 调用参数）
 *
 * 只读本地文件，不发起模型调用。
 *
 * 挂载两个路由：
 *   GET /private/agents        HTML 工作台
 *   GET /private/agents.json   数据
 */
import z from "@deepseek-ai/schemastery";
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const name = "private-agents";
const inject = ["webServer"];

const Config = z.object({
  sessionsRoot: z.string().default(""),
  maxSessions: z.number().default(200),
  cacheMs: z.number().default(15000),
});

// ── zstd 多帧解压 ────────────────────────────────────────────────────
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function zstdFrames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const n = buf.indexOf(ZSTD_MAGIC, i + 4);
    const end = n === -1 ? buf.length : n;
    out.push(buf.subarray(i, end));
    if (n === -1) break;
    i = n;
  }
  return out;
}

function readSessionFile(file) {
  const buf = readFileSync(file);
  let txt = "";
  for (const fr of zstdFrames(buf)) {
    try {
      txt += zlib.zstdDecompressSync(fr).toString("utf8");
    } catch {
      /* 跳过坏帧 */
    }
  }
  return txt;
}

// ── 估算 token ───────────────────────────────────────────────────────
// session 日志里没有 usage 字段（token 是运行时 projection 算的），
// 所以历史会话只能按内容长度估。中文 ~1.6 字符/token，英文 ~3.8。
function estimateTokens(s) {
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
    else other++;
  }
  return Math.round(cjk / 1.6 + other / 3.8);
}

function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const part of content) {
    if (part && typeof part.text === "string") s += part.text;
  }
  return s;
}

// ── 解析一个会话 ─────────────────────────────────────────────────────
function parseSession(file, dirName) {
  const txt = readSessionFile(file);
  const lines = txt.split("\n").filter(Boolean);

  const S = {
    id: dirName,
    title: "",
    depth: null,
    created: 0,
    cwd: "",
    preset: "",
    provider: "",
    model: "",
    reasoning: "",
    maxTokens: 0,
    events: lines.length,
    turns: 0,
    steps: 0,
    userMsgs: 0,
    asstMsgs: 0,
    toolCalls: 0,
    toolErrors: 0,
    turnErrors: 0,
    estTokens: 0,
    lastTime: 0,
    activity: [],       // {t, k} 极简活动点
    subagentCalls: [],  // 派给子会话的调用
    tools: {},          // 工具名 → 次数
    // ── 供工作台可视化用 ──
    // 上下文八段（按内容长度估算，session 日志没有精确 token）
    parts: { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, result: 0 },
    workItems: [],      // 泳道方块：{t, kind, ok, label}
    msgCount: 0,        // 消息总数
    toolDefCount: 0,    // 工具定义个数
  };

  for (const line of lines) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const t = j.time || (j.data && j.data.message && j.data.message.timestamp) || 0;
    if (t > S.lastTime) S.lastTime = t;
    const d = j.data || {};

    switch (j.type) {
      case "session":
        // 注意：session 事件的字段在顶层，不在 j.data 里
        // （其他事件类型才用 data 包裹）。读错位置会让所有会话都变成 depth 0。
        S.id = j.id || S.id;
        S.created = j.createdAt || 0;
        S.cwd = j.cwd || "";
        S.depth = typeof j.delegationDepth === "number" ? j.delegationDepth : 0;
        S.preset = j.agentPreset || "";
        break;
      case "session/title":
        if (d.title) S.title = d.title;
        break;
      case "request/header": {
        const cfg = (d.header && d.header.config) || {};
        if (cfg.provider) S.provider = cfg.provider;
        if (cfg.model) S.model = cfg.model;
        if (cfg.reasoningEffort) S.reasoning = cfg.reasoningEffort;
        if (cfg.maxTokens) S.maxTokens = cfg.maxTokens;
        // 工具定义本身占的上下文：每个工具名 + 描述 + schema
        const tdefs = (d.header && d.header.tools) || [];
        if (tdefs.length > S.toolDefCount) S.toolDefCount = tdefs.length;
        if (tdefs.length) {
          let tok = 0;
          for (const td of tdefs) tok += estimateTokens(td.name || "") + estimateTokens(td.description || "") + 40;
          S.parts.tools = Math.max(S.parts.tools, tok);
        }
        break;
      }
      case "system/message": {
        const txt = textOf(d.message && d.message.content);
        // 系统提示里含技能注入段落，粗略按关键词切出去
        const skillHit = /SKILL\.md|技能|skill/i.test(txt);
        const tok = estimateTokens(txt);
        if (skillHit) {
          S.parts.skill += Math.round(tok * 0.35);
          S.parts.sys += Math.round(tok * 0.65);
        } else {
          S.parts.sys += tok;
        }
        S.estTokens += tok;
        S.msgCount++;
        break;
      }
      case "developer/message": {
        const tok = estimateTokens(textOf(d.message && d.message.content));
        S.parts.sys += tok;
        S.estTokens += tok;
        S.msgCount++;
        break;
      }
      case "agent/inbox/spliced": {
        // 注入内容（用户消息、队列、子代理回传都从这里进）
        const ins = d.inserted || [];
        for (const item of ins) {
          const tok = estimateTokens(textOf(item && item.content));
          S.parts.inject += tok;
          S.estTokens += tok;
        }
        break;
      }
      case "turn/start":
        S.turns++;
        break;
      case "step/start":
        S.steps++;
        break;
      case "turn/end":
        if (d.reason && d.reason.kind === "error") {
          S.turnErrors++;
          S.workItems.push({ t, kind: "turn-error", ok: false, label: String(d.reason.error?.message || "轮次失败").slice(0, 90) });
        }
        break;
      case "user/message": {
        S.userMsgs++;
        S.msgCount++;
        // 注意结构：user/message 的内容在 d.content，
        // 而 assistant/message 在 d.message.content。取错位置会让「用户消息」永远是 0。
        const content = d.content || (d.message && d.message.content) || [];
        const txt = textOf(content);
        let tok = estimateTokens(txt);
        // 图片等非文本附件给个固定估值，否则纯图片输入会算成 0
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.type === "image") tok += 1200;
            else if (part && part.type && part.type !== "text") tok += 200;
          }
        }
        S.parts.user += tok;
        S.estTokens += tok;
        S.workItems.push({
          t,
          kind: "user",
          ok: true,
          label: (txt || (content.some?.((p) => p && p.type === "image") ? "[图片]" : "")).slice(0, 90),
        });
        break;
      }
      case "assistant/message": {
        S.asstMsgs++;
        S.msgCount++;
        const content = (d.message && d.message.content) || [];
        // 思考 + 正文都算助手侧
        const tok = estimateTokens(textOf(content));
        S.parts.asst += tok;
        S.estTokens += tok;
        for (const part of content) {
          if (part && part.type === "tool-call") {
            S.toolCalls++;
            const nm = part.name || "?";
            S.tools[nm] = (S.tools[nm] || 0) + 1;
            S.workItems.push({ t, kind: "tool", ok: true, label: nm });
            if (nm.startsWith("subagent")) {
              let args = {};
              try {
                args = JSON.parse(part.arguments || "{}");
              } catch {
                /* 参数不是 JSON 就留空 */
              }
              S.subagentCalls.push({
                t: t || S.created,
                name: nm,
                description: String(args.description || "").slice(0, 120),
                prompt: String(args.prompt || "").slice(0, 300),
              });
            }
          }
        }
        break;
      }
      case "tool/result": {
        const isErr = !!(d.message && d.message.isError);
        if (isErr) S.toolErrors++;
        const tok = estimateTokens(textOf(d.message && d.message.content));
        S.parts.result += tok;
        S.estTokens += tok;
        if (isErr) {
          S.workItems.push({
            t,
            kind: "tool-error",
            ok: false,
            label: String(textOf(d.message && d.message.content)).slice(0, 90),
          });
        }
        break;
      }
      default:
        break;
    }

    if (t) S.activity.push({ t, k: j.type });
  }

  S.durationMs = S.created && S.lastTime ? Math.max(0, S.lastTime - S.created) : 0;
  // 活动点太多会拖垮前端，按事件类型抽样
  if (S.activity.length > 4000) {
    const stride = Math.ceil(S.activity.length / 4000);
    S.activity = S.activity.filter((_, i) => i % stride === 0);
  }
  // 工作项也限流（泳道方块过多会糊成一团）
  if (S.workItems.length > 600) {
    const stride = Math.ceil(S.workItems.length / 600);
    S.workItems = S.workItems.filter((_, i) => i % stride === 0);
  }
  return S;
}

// ── 增量尾巴读取 ─────────────────────────────────────────────────────
/**
 * dsh 的 session 文件是多帧 zstd：每批写入追加一帧。
 * 因此可以只读新增字节、只解压新帧，不必重扫整个文件
 * （最大的会话有 4 万多个事件、十几 MB）。
 *
 * 返回 { events, consumed }：
 *   events   新解出的事件数组
 *   consumed 已安全消费的字节数（末尾可能是半帧，要留到下次）
 */
function readNewFrames(buf) {
  const events = [];
  let consumed = 0;
  let i = 0;
  while (i < buf.length) {
    const next = buf.indexOf(ZSTD_MAGIC, i + 4);
    const end = next === -1 ? buf.length : next;
    const frame = buf.subarray(i, end);
    let text = null;
    try {
      text = zlib.zstdDecompressSync(frame).toString("utf8");
    } catch {
      // 半帧：留给下一次读取
      break;
    }
    if (text) {
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    consumed = end;
    if (next === -1) break;
    i = next;
  }
  return { events, consumed };
}

/** 从一个事件里抽取"对界面有用"的摘要。 */
function summarize(ev) {
  const t = ev.time || 0;
  const d = ev.data || {};
  switch (ev.type) {
    case "tool/call":
      return { k: "tool", t, name: d.name || "?" };
    case "tool/result":
      return { k: "result", t, err: !!(d.message && d.message.isError) };
    case "step/start":
      return { k: "step", t, n: d.step || 0 };
    case "step/end":
      return { k: "stepEnd", t, n: d.step || 0 };
    case "turn/start":
      return { k: "turn", t, n: d.turn || 0 };
    case "turn/end":
      return {
        k: "turnEnd",
        t,
        n: d.turn || 0,
        err: !!(d.reason && d.reason.kind === "error"),
        msg: d.reason && d.reason.error ? String(d.reason.error.message || "").slice(0, 120) : "",
      };
    case "assistant/message": {
      const content = (d.message && d.message.content) || [];
      let tools = 0;
      let sub = 0;
      const names = [];
      for (const p of content) {
        if (p && p.type === "tool-call") {
          tools++;
          const nm = p.name || "?";
          names.push(nm);
          if (nm.startsWith("subagent")) sub++;
        }
      }
      return { k: "assistant", t, tools, names: names.slice(0, 8), sub };
    }
    case "user/message":
      return { k: "user", t };
    case "session/title":
      return { k: "title", t, title: d.title || "" };
    default:
      return null;
  }
}
// 单个会话的解析结果按 (file, mtime) 缓存：只有变过的文件才重新解压。
// 不做这层的话，每次请求都要解压十几万个事件（实测 8 秒）。
const fileCache = new Map();

function parseSessionCached(file, dirName, mtime) {
  const hit = fileCache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  const data = parseSession(file, dirName);
  fileCache.set(file, { mtime, data });
  return data;
}

function scanAll(root, maxSessions) {
  const sessions = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return sessions;
  }

  for (const ws of dirs) {
    const wsPath = join(root, ws.name);
    let subs = [];
    try {
      subs = readdirSync(wsPath, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const sub of subs) {
      const file = join(wsPath, sub.name, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      try {
        const parsed = parseSessionCached(file, sub.name, st.mtimeMs);
        sessions.push({
          ...parsed,
          workspace: ws.name,
          file,
          mtime: st.mtimeMs,
          bytes: st.size,
        });
      } catch {
        /* 读不动的会话跳过，不让一个坏文件毁掉整个面板 */
      }
    }
  }

  sessions.sort((a, b) => b.created - a.created);
  return sessions.slice(0, maxSessions);
}

// ── 重建父子关系 ─────────────────────────────────────────────────────
function buildTree(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    s.children = [];
    s.parent = null;
  }

  const kids = sessions.filter((s) => (s.depth || 0) > 0);
  const parents = sessions.filter((s) => (s.depth || 0) === 0);

  for (const kid of kids) {
    let best = null;
    for (const p of parents) {
      for (const c of p.subagentCalls) {
        // 父会话派发调用的时间 == 子会话创建时间（实测差 0ms），放宽到前后 2 分钟
        const dt = kid.created - c.t;
        if (dt >= -2000 && dt < 120000) {
          if (!best || Math.abs(dt) < Math.abs(best.dt)) best = { p, c, dt };
        }
      }
    }
    if (best) {
      kid.parent = best.p.id;
      best.p.children.push({
        id: kid.id,
        description: best.c.description,
        prompt: best.c.prompt,
        tool: best.c.name,
        lagMs: best.dt,
      });
    }
  }

  // 深度 >1 的挂到最近的上一级
  for (const kid of kids.filter((s) => (s.depth || 0) > 1)) {
    if (kid.parent) continue;
    const candidates = kids.filter(
      (s) => (s.depth || 0) === (kid.depth || 0) - 1 && s.created < kid.created,
    );
    let best = null;
    for (const p of candidates) {
      for (const c of p.subagentCalls) {
        const dt = kid.created - c.t;
        if (dt >= -2000 && dt < 120000 && (!best || Math.abs(dt) < Math.abs(best.dt))) {
          best = { p, c, dt };
        }
      }
    }
    if (best) {
      kid.parent = best.p.id;
      best.p.children.push({ id: kid.id, description: best.c.description, lagMs: best.dt });
    }
  }

  return byId;
}

// ── 缓存 ─────────────────────────────────────────────────────────────
let cache = { at: 0, data: null };

function buildSnapshot(cfg) {
  const now = Date.now();
  if (cache.data && now - cache.at < cfg.cacheMs) return cache.data;

  const root = cfg.sessionsRoot || join(homedir(), ".dsh", "sessions");
  const sessions = scanAll(root, cfg.maxSessions);
  buildTree(sessions);

  const data = {
    asOf: now,
    root,
    sessions: sessions.map((s) => ({
      id: s.id,
      short: s.id.replace(/^session-/, "").slice(0, 8),
      title: s.title || "(未命名)",
      depth: s.depth || 0,
      created: s.created,
      cwd: s.cwd,
      workspace: s.workspace,
      provider: s.provider,
      model: s.model,
      reasoning: s.reasoning,
      maxTokens: s.maxTokens,
      preset: s.preset,
      events: s.events,
      turns: s.turns,
      steps: s.steps,
      userMsgs: s.userMsgs,
      asstMsgs: s.asstMsgs,
      toolCalls: s.toolCalls,
      toolErrors: s.toolErrors,
      turnErrors: s.turnErrors,
      estTokens: s.estTokens,
      durationMs: s.durationMs,
      bytes: s.bytes,
      parent: s.parent,
      children: s.children,
      msgCount: s.msgCount,
      toolDefCount: s.toolDefCount,
      parts: s.parts,
      workItems: s.workItems.slice(-150),
      topTools: Object.entries(s.tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, c]) => ({ n, c })),
      activity: s.activity.slice(0, 400),
      subagentCalls: s.subagentCalls.map((c) => ({ t: c.t, name: c.name, description: c.description })),
    })),
  };

  const totals = {
    sessions: data.sessions.length,
    agents: data.sessions.length,
    roots: data.sessions.filter((s) => !s.parent).length,
    children: data.sessions.filter((s) => s.parent).length,
    events: data.sessions.reduce((a, s) => a + s.events, 0),
    tools: data.sessions.reduce((a, s) => a + s.toolCalls, 0),
    msgs: data.sessions.reduce((a, s) => a + s.msgCount, 0),
    workItems: data.sessions.reduce((a, s) => a + s.workItems.length, 0),
    estTokens: data.sessions.reduce((a, s) => a + s.estTokens, 0),
    errors: data.sessions.reduce((a, s) => a + s.turnErrors + s.toolErrors, 0),
    // 「运行中」按最近 3 分钟内有活动来判；历史会话都是空闲
    running: data.sessions.filter((s) => Date.now() - (s.created + s.durationMs) < 180000).length,
  };
  data.totals = totals;

  cache = { at: now, data };
  return data;
}

// ── 实时尾巴：轮询文件增量 → SSE 推送 ───────────────────────────────
/**
 * 不用 fs.watch：Windows 上它对 recursive 和压缩文件的重命名/追加行为不稳。
 * 直接 statSync 比对大小，代价极小，800ms 一次足够"实时"。
 */
function listSessionFiles(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const ws of dirs) {
    const wsPath = join(root, ws.name);
    let subs = [];
    try {
      subs = readdirSync(wsPath, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const sub of subs) {
      const f = join(wsPath, sub.name, "session.v4.jsonl.zstd");
      if (existsSync(f)) out.push(f);
    }
  }
  return out;
}

function createTailer(root, emit) {
  const tails = new Map();   // file → { offset, sid, depth, title, started }

  /**
   * 从文件头捞 session 元数据（id / depth / title）。
   * baseline 把 offset 定在文件末尾，等于跳过了开头的 session 事件，
   * 不补这一步所有推送都会带着 sid=null，前端没法把事件挂到具体 agent 上。
   */
  function readHeadMeta(file) {
    const buf = readRange(file, 0, 16384);
    if (!buf) return null;
    const { events } = readNewFrames(buf);
    let meta = null;
    for (const ev of events) {
      if (ev.type === "session" && !meta) {
        meta = {
          sid: ev.id,
          depth: typeof ev.delegationDepth === "number" ? ev.delegationDepth : 0,
          title: "",
        };
      }
      if (ev.type === "session/title" && meta && !meta.title) {
        meta.title = (ev.data && ev.data.title) || "";
      }
      if (meta && meta.title) break;
    }
    return meta;
  }

  function baseline() {
    for (const f of listSessionFiles(root)) {
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      const meta = readHeadMeta(f);
      tails.set(f, {
        offset: st.size,
        sid: meta ? meta.sid : null,
        depth: meta ? meta.depth : 0,
        title: meta ? meta.title : "",
        started: !!(meta && meta.sid),
      });
    }
  }

  function readRange(file, from, to) {
    try {
      const len = to - from;
      if (len <= 0) return null;
      const buf = Buffer.alloc(len);
      const fd = openSync(file, "r");
      readSync(fd, buf, 0, len, from);
      closeSync(fd);
      return buf;
    } catch {
      return null;
    }
  }

  function tick() {
    for (const file of listSessionFiles(root)) {
      let tail = tails.get(file);
      if (!tail) {
        tail = { offset: 0, sid: null, depth: 0, title: "", started: false };
        tails.set(file, tail);
      }
      let st;
      try {
        st = statSync(file);
      } catch {
        tails.delete(file);
        continue;
      }
      if (st.size <= tail.offset) continue;

      const buf = readRange(file, tail.offset, st.size);
      if (!buf) continue;

      const { events, consumed } = readNewFrames(buf);
      tail.offset += consumed;
      if (!events.length) continue;

      for (const ev of events) {
        if (ev.type === "session") {
          const isNew = !tail.started;
          tail.sid = ev.id;
          tail.depth = typeof ev.delegationDepth === "number" ? ev.delegationDepth : 0;
          tail.started = true;
          if (isNew) {
            emit({
              k: "agent",
              t: ev.createdAt || Date.now(),
              sid: ev.id,
              depth: tail.depth,
              cwd: ev.cwd || "",
              title: "",
            });
            continue;
          }
        }
        if (ev.type === "session/title") {
          tail.title = (ev.data && ev.data.title) || "";
          emit({ k: "title", t: ev.time || Date.now(), sid: tail.sid, title: tail.title });
          continue;
        }
        const s = summarize(ev);
        if (s) emit({ ...s, sid: tail.sid, depth: tail.depth });
      }
    }
  }

  baseline();
  return { tick, baseline, size: () => tails.size };
}


// ── 会话广播 ─────────────────────────────────────────────────────────
/**
 * 把一条公告写进**每个** workspace 的记忆库。
 *
 * 为什么不直接往会话发消息：只有 agent 还在运行的会话才能接收，
 * agent 一释放，往日志里写 user/message 也不会触发处理。
 * 写进记忆库则是所有会话 memory_search 都能搜到，跨会话跨 workspace 都生效。
 */
function broadcastToMemory(title, text, tags) {
  const dir = join(homedir(), ".dsh", "memory");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".db"));
  } catch (e) {
    return { ok: false, wrote: 0, total: 0, error: "读不到 memory 目录" };
  }
  if (!files.length) return { ok: false, wrote: 0, total: 0, error: "memory 目录里没有库" };

  const now = Date.now();
  const errors = [];
  let wrote = 0;

  for (const f of files) {
    let db = null;
    try {
      db = new DatabaseSync(join(dir, f));
      db.exec("PRAGMA journal_mode = WAL");
      db.prepare(
        `INSERT INTO entries (kind, project, title, body, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("note", "@broadcast", title, text, tags, now, now);
      wrote++;
    } catch (e) {
      errors.push(f + ": " + String(e && e.message ? e.message : e));
    } finally {
      try {
        if (db) db.close();
      } catch {
        /* ignore */
      }
    }
  }

  return { ok: wrote > 0, wrote, total: files.length, errors, at: now };
}

/** 读广播历史。每个库里都有副本，读第一个够了。 */
function listBroadcasts(limit = 50) {
  const dir = join(homedir(), ".dsh", "memory");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".db"));
  } catch {
    return [];
  }
  if (!files.length) return [];

  let db = null;
  try {
    db = new DatabaseSync(join(dir, files[0]), { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, title, body, tags, created_at FROM entries
         WHERE project = '@broadcast' AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      tags: r.tags,
      at: r.created_at,
    }));
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        resolve(null);
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function apply(ctx, config) {
  const cfg = {
    sessionsRoot: config.sessionsRoot || "",
    maxSessions: config.maxSessions ?? 200,
    cacheMs: config.cacheMs ?? 15000,
  };
  setTimeout(() => {
    try {
      buildSnapshot(cfg);
    } catch { /* ignore warmup failure */ }
  }, 1500).unref();

  const LOCAL = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

  function guard(req, res) {
    const addr = String((req.socket && req.socket.remoteAddress) || "");
    if (!LOCAL.includes(addr)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "loopback only" }));
      return false;
    }
    return true;
  }

  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents.json",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const data = buildSnapshot(cfg);
        const isLite = String(req.url || "").includes("lite=1");
        const out = isLite
          ? {
              ...data,
              sessions: data.sessions.map(({ activity: _a, workItems: _w, ...rest }) => rest),
            }
          : data;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const htmlPath = new URL("./ui.html", import.meta.url);
        const html = readFileSync(htmlPath, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("ui.html 读取失败: " + String(e && e.message ? e.message : e));
      }
    },
  });

  // ── SSE 实时推流 ──────────────────────────────────────────────────
  // 前端 EventSource 订阅这里，拿到 tool / step / turn / agent 事件后局部更新，
  // 不用反复拉 1.8 MB 的历史快照。
  const sseClients = new Set();

  function broadcast(ev) {
    if (!sseClients.size) return;
    let payload;
    try {
      payload = `event: ${ev.k}\ndata: ${JSON.stringify(ev)}\n\n`;
    } catch {
      return;
    }
    for (const r of Array.from(sseClients)) {
      try {
        r.write(payload);
      } catch {
        sseClients.delete(r);
      }
    }
  }

  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents/stream",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": "*",
      });
      res.write("retry: 3000\n\n");
      res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      sseClients.add(res);

      const hb = setInterval(() => {
        try {
          res.write(`: hb ${Date.now()}\n\n`);
        } catch {
          /* 前端已断开 */
        }
      }, 20000);
      hb.unref?.();

      const cleanup = () => {
        clearInterval(hb);
        sseClients.delete(res);
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
    },
  });

  // tailer：800ms 检查一次增量
  const tailRoot = cfg.sessionsRoot || join(homedir(), ".dsh", "sessions");
  const tailer = createTailer(tailRoot, broadcast);
  const tailTimer = setInterval(() => {
    try {
      tailer.tick();
    } catch {
      /* 单个坏文件不影响整体 */
    }
  }, 800);
  tailTimer.unref?.();

  // ── 会话广播 ──
  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents/broadcast",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const send = (code, obj) => {
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET") {
        send(200, { ok: true, items: listBroadcasts(80) });
        return;
      }
      if (req.method !== "POST") {
        send(405, { ok: false, error: "只支持 GET / POST" });
        return;
      }

      const body = await readJsonBody(req);
      if (!body) {
        send(400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }
      const title = String(body.title || "").trim().slice(0, 120);
      const text = String(body.text || "").trim().slice(0, 8000);
      if (!text) {
        send(400, { ok: false, error: "广播内容不能为空" });
        return;
      }
      const tags = "broadcast,announcement" + (body.tags ? "," + String(body.tags).slice(0, 80) : "");
      const r = broadcastToMemory(title || "广播 " + new Date().toLocaleString("zh-CN"), text, tags);
      send(r.ok ? 200 : 500, r);
    },
  });

  // 缓存失效入口：改了会话想立刻看到新数据时用
  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents/refresh",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      cache = { at: 0, data: null };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, refreshed: true }));
    },
  });

  // ── client 插件自检 ──
  // client bundle 有 max-age=31536000 immutable，从服务端文件根本看不出浏览器加载了哪一版。
  // 配套的 client 插件在关键节点打 beacon 过来，这里存一整条链路，能看出卡在哪一步。
  let clientAlive = null;
  const clientTrace = [];
  const TRACE_MAX = 60;

  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents/client-alive",
    handler: async (req, res) => {
      const q = String(req.url || "").split("?")[1] || "";
      const params = new URLSearchParams(q);
      const step = params.get("id") || "";
      const now = Date.now();
      clientAlive = { at: now, id: step, ua: String(req.headers["user-agent"] || "").slice(0, 80) };
      clientTrace.push({ t: now, step });
      if (clientTrace.length > TRACE_MAX) clientTrace.shift();
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/private/agents/client-status",
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const steps = clientTrace.map((e) => e.step);
      const failed = steps.filter((s) => s.includes("FAIL"));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify(
          {
            loaded: !!clientAlive,
            lastSeen: clientAlive,
            trace: clientTrace.slice(-30),
            failedSteps: failed,
            now: Date.now(),
            hint: !clientAlive
              ? "client 插件从未执行：检查挂载/包安装/浏览器是否加载 bundle"
              : failed.length
                ? "有步骤抛错，看 failedSteps"
                : steps.includes("slot-corner-ok")
                  ? "全部注册成功：tab 类型 + 正文 + chip 标题 + header 按钮，且会尝试自动打开一次面板"
                  : "模块执行了但没走完注册，看 trace 停在哪一步",
          },
          null,
          1,
        ),
      );
    },
  });
}

export { Config, apply, inject, name };
