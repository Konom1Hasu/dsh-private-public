/*
 * 工作台台面渲染。
 *
 * 原则：只显示手里真有数据的东西。没数据的卡就明说"还没接"，不放假数据。
 * 我见过的假仪表盘都是这么死的：看着满，其实全在骗自己。
 */

const $ = (id) => document.getElementById(id);

function setDot(el, state) {
  el.className = "dot" + (state ? " " + state : "");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function timeStr(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

/* ── 待办 ─────────────────────────────────────────────────── */
async function renderTasks() {
  const body = $("todo-body");
  try {
    const r = await fetch("/private/tasks.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const { counts, tasks, stalls } = j;

    const live = counts.in_progress > 0;
    const blocked = counts.blocked > 0;
    setDot($("todo-dot"), blocked ? "warn" : live ? "live" : "");
    $("todo-count").textContent =
      `${counts.pending} 待办` +
      (counts.in_progress ? ` · ${counts.in_progress} 在做` : "") +
      (counts.blocked ? ` · ${counts.blocked} 阻塞` : "");
    $("todo-foot").textContent = stalls && stalls.length
      ? `${stalls.length} 条执行超时没动静`
      : "任务账本";

    if (!tasks.length) {
      body.innerHTML = `<div class="empty">没有未完成任务。<br><b>在空台上放点什么</b>——待办是唯一能让这张台子“派活”的东西。</div>`;
      return;
    }

    body.innerHTML = tasks
      .map((t) => {
        const cls = t.status === "blocked" ? "is-block" : t.status === "in_progress" ? "is-live" : "";
        const meta = [];
        if (t.status === "pending") meta.push("待办");
        if (t.status === "in_progress") meta.push("在做");
        if (t.status === "blocked") {
          const who = t.blocked_by === "human" ? "你标的" : t.blocked_by === "system" ? "系统探测" : "模型报的";
          meta.push(`${t.blocked_kind} · ${who}`);
        }
        if (t.priority) meta.push("P" + t.priority);
        const run = (t.runs || []).find((x) => x.status === "running");
        if (run) meta.push("在跑 " + (run.agent_id || run.session_id || "?"));
        const q = t.status === "blocked" && t.blocked_question
          ? `<div class="row-q">${esc(t.blocked_question)}</div>`
          : "";
        return `<div class="row ${cls}">
          <div class="row-title">${esc(t.title)}</div>
          ${meta.length ? `<div class="row-meta">${esc(meta.join(" · "))}</div>` : ""}
          ${q}
        </div>`;
      })
      .join("");
  } catch (e) {
    setDot($("todo-dot"), "err");
    $("todo-foot").textContent = "任务账本读不到";
    body.innerHTML = `<div class="empty">/private/tasks.json 读不到：${esc(e.message)}<br><b>插件可能没加载</b>。</div>`;
  }
}

/* ── 编队 ─────────────────────────────────────────────────── */
async function renderFleet() {
  const body = $("fleet-body");
  try {
    const r = await fetch("/private/agents.json?lite=1", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const sessions = j.sessions || [];
    const subs = sessions.filter((s) => (s.depth || 0) > 0);

    setDot($("fleet-dot"), subs.length ? "live" : "");
    $("fleet-count").textContent = `${subs.length} 子 / ${sessions.length} 会话`;

    if (!subs.length) {
      body.innerHTML = `<div class="empty">当前没有在跑的子代理。<br>派了活儿会出现在这里。</div>`;
      return;
    }

    // 只看最近的几个，编队卡是窄栏，塞不下全部
    const recent = subs.slice(0, 8);
    body.innerHTML = recent
      .map((s) => {
        const title = s.title || s.displayTitle || s.id || "(无标题)";
        const meta = [];
        if (s.msgCount) meta.push(s.msgCount + " 条消息");
        if (s.toolCalls) meta.push(s.toolCalls + " 次工具");
        return `<div class="row is-live">
          <div class="row-title">${esc(String(title).slice(0, 40))}</div>
          ${meta.length ? `<div class="row-meta">${esc(meta.join(" · "))}</div>` : ""}
        </div>`;
      })
      .join("") + (subs.length > recent.length ? `<div class="row-meta">还有 ${subs.length - recent.length} 个未显示</div>` : "");
  } catch (e) {
    setDot($("fleet-dot"), "err");
    body.innerHTML = `<div class="empty">/private/agents.json 读不到：${esc(e.message)}</div>`;
  }
}

/* ── 广播 ─────────────────────────────────────────────────── */
async function renderCast() {
  const body = $("cast-body");
  try {
    const r = await fetch("/private/agents/broadcast", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.items || [];
    setDot($("cast-dot"), list.length ? "live" : "");
    $("cast-count").textContent = list.length ? `${list.length} 条` : "";
    if (!list.length) {
      body.innerHTML = `<div class="empty">没有广播。<br>任务完成、报错、余额告警会进这里。</div>`;
      return;
    }
    body.innerHTML =
      `<div class="cast-list">` +
      list.slice(0, 12).map((b) => {
        const t = b.created_at || b.createdAt || b.at;
        return `<div class="cast-row">
          <span class="cast-time">${esc(timeStr(t))}</span>
          <span class="cast-text">${esc(String(b.title || b.text || "").slice(0, 120))}</span>
        </div>`;
      }).join("") +
      `</div>`;
  } catch (e) {
    setDot($("cast-dot"), "err");
    body.innerHTML = `<div class="empty">广播读不到：${esc(e.message)}</div>`;
  }
}

/* ── 当前会话 ─────────────────────────────────────────────── */
function renderChatMeta() {
  // 会话 id 从宿主 URL 上拿不到（iframe 内），先从 referrer 试
  const m = (document.referrer || "").match(/session[\/=]([0-9a-f-]{8,})/i);
  if (m) $("chat-sid").textContent = m[1].slice(0, 8);
  $("chat-meta").textContent = "";
  $("chat-foot").textContent = "消息流待接";
}

function refresh() {
  renderTasks();
  renderFleet();
  renderCast();
}

renderChatMeta();
refresh();
setInterval(refresh, 5000);
