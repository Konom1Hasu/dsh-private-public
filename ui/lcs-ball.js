// LCS Stats Ball — 自包含悬浮球（TUI 风格）
// 注入到 dsh-web-frontend/dist/index.html，不依赖 client 插件和重启。
// 数据源：/private/stats（loopback 免 token）
// 算法：复刻 dsh-TUI src/components/screens/StatusMetrics
(function () {
  "use strict";
  var VER = "v3-inline";
  if (window.__LCS_STATS_BALL__) return;
  window.__LCS_STATS_BALL__ = VER;

  var BALL = "lcs-ball", PANEL = "lcs-pnl";
  var CAP = 400000;

  // TUI 的五段：key / 色 / 标签（顺序即 bar 顺序）
  var SEGS = [
    { k: "system",    c: "#22305F", n: "系统" },
    { k: "prompt",    c: "#2B3D78", n: "提问" },
    { k: "assistant", c: "#344A92", n: "回答" },
    { k: "thinking",  c: "#4D6BFE", n: "思考" },
    { k: "tools",     c: "#5A7CFF", n: "工具" }
  ];

  function fmtK(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtDur(ms) {
    ms = Number(ms) || 0;
    if (ms <= 0) return "0s";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    var m = Math.floor(s / 60);
    return m + "m " + Math.round(s - m * 60) + "s";
  }
  // 压力：<80 正常 / ≥80 警告 / ≥95 错误
  function pressure(p) { return p >= 95 ? "err" : (p >= 80 ? "warn" : "ok"); }
  // 速度：≥50 绿 / ≥20 黄 / <20 红
  function speedColor(t) { return t >= 50 ? "#82b89d" : (t >= 20 ? "#d8b270" : "#da8a93"); }

  // 最大余数法：整数和精确等于 total
  function attribute(w, total) {
    var out = {}, sum = 0, i;
    for (i = 0; i < SEGS.length; i++) sum += (w[SEGS[i].k] || 0);
    if (total <= 0 || sum <= 0) { for (i = 0; i < SEGS.length; i++) out[SEGS[i].k] = 0; return out; }
    var raw = [], floors = [], acc = 0;
    for (i = 0; i < SEGS.length; i++) {
      var v = ((w[SEGS[i].k] || 0) / sum) * total;
      raw.push(v); floors.push(Math.floor(v)); acc += Math.floor(v);
    }
    var rest = total - acc;
    var order = raw.map(function (v, j) { return { j: j, f: v - Math.floor(v) }; })
      .sort(function (a, b) { return b.f - a.f; });
    for (var q = 0; q < order.length && rest > 0; q++) { floors[order[q].j]++; rest--; }
    for (i = 0; i < SEGS.length; i++) out[SEGS[i].k] = floors[i];
    return out;
  }

  function css() {
    if (document.querySelector('style[data-lcs-ball]')) return;
    var s = document.createElement("style");
    s.dataset.lcsBall = "1";
    s.textContent = [
      "#" + BALL + "{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 11px/1 ui-monospace,Consolas,monospace;cursor:grab;user-select:none;touch-action:none;color:#e8e6e0;background:radial-gradient(circle at 50% 32%,rgba(255,255,255,.12),rgba(255,255,255,0) 64%),conic-gradient(from -90deg,#7da1de 0deg,color-mix(in srgb,#7da1de 55%,#a855f7) var(--pd,0deg),transparent var(--pd,0deg) 360deg),var(--dsw-alias-bg-layer-1,#161a22);border:1px solid var(--dsw-alias-border-l1,#2c3444);box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 6px 18px -4px rgba(0,0,0,.5);transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s}",
      "#" + BALL + "::after{content:'';position:absolute;inset:6px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#161a22);opacity:.85;z-index:-1}",
      "#" + BALL + ":hover{transform:scale(1.07) translateY(-1px);box-shadow:0 1px 0 rgba(255,255,255,.09) inset,0 10px 28px -6px rgba(0,0,0,.6)}",
      "#" + BALL + ":active{transform:scale(.97);transition-duration:.08s}",
      "#" + BALL + "[data-drag]{cursor:grabbing;transform:scale(1.04);transition:none}",
      "#" + BALL + "[data-open]{border-color:#7da1de;box-shadow:0 0 0 3px rgba(125,161,222,.18),0 1px 0 rgba(255,255,255,.09) inset,0 10px 28px -6px rgba(0,0,0,.6)}",
      "#" + BALL + " b{font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,.55)}",

      "#" + PANEL + "{position:fixed;z-index:2147483001;width:274px;padding:14px 16px;border-radius:14px;font:12px/1.55 -apple-system,'Segoe UI',system-ui,sans-serif;color:var(--dsw-alias-label-primary,#e8e6e0);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c2330) 88%,transparent);backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#2c3444) 85%,transparent);box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 18px 50px -12px rgba(0,0,0,.62);visibility:hidden;opacity:0;transform:scale(.92) translateY(6px);transform-origin:bottom right;transition:opacity .16s,transform .24s cubic-bezier(.34,1.4,.64,1),visibility .16s;pointer-events:none}",
      "#" + PANEL + "[data-open]{visibility:visible;opacity:1;transform:scale(1) translateY(0);pointer-events:auto}",

      "#" + PANEL + " .h{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:10px}",
      "#" + PANEL + " .h i{font-style:normal;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;background:rgba(125,161,222,.2);color:#7da1de;margin-left:5px}",
      "#" + PANEL + " .h s{text-decoration:none;font-weight:400;font-size:11px;color:var(--dsw-alias-label-dimmed,#8d95a6)}",
      "#" + PANEL + " .sub{font-size:10px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-dimmed,#8d95a6);margin:11px 0 3px;padding-top:9px;border-top:1px solid rgba(128,128,128,.16)}",
      "#" + PANEL + " .sub:first-of-type{border-top:0;padding-top:0;margin-top:0}",
      "#" + PANEL + " .row{display:flex;justify-content:space-between;gap:8px;padding:1px 0}",
      "#" + PANEL + " .row s{text-decoration:none;color:var(--dsw-alias-label-secondary,#8d95a6)}",
      "#" + PANEL + " .row b{font-weight:500;font-variant-numeric:tabular-nums}",

      "#" + PANEL + " .cbar{display:flex;height:9px;border-radius:4px;overflow:hidden;margin:5px 0 4px;background:rgba(128,128,128,.2);box-shadow:0 0 0 1px rgba(128,128,128,.14) inset}",
      "#" + PANEL + " .cbar span{display:block;height:100%;width:0;transition:width .4s cubic-bezier(.4,0,.2,1)}",
      "#" + PANEL + " .cbar .free{flex:1;background:rgba(232,232,232,.16)}",
      "#" + PANEL + " .cbar[data-p=warn]{box-shadow:0 0 0 1px #d8b270 inset}",
      "#" + PANEL + " .cbar[data-p=err]{box-shadow:0 0 0 1px #da8a93 inset}",
      "#" + PANEL + " .cbar[data-p=warn] ~ .row .pct{color:#d8b270}",
      "#" + PANEL + " .cbar[data-p=err] ~ .row .pct{color:#da8a93}",

      "#" + PANEL + " .gauge{height:9px;border-radius:3px;background:rgba(128,128,128,.2);overflow:hidden;margin:5px 0 3px}",
      "#" + PANEL + " .gauge i{display:block;height:100%;width:0;transition:width .3s,background .3s}",
      "#" + PANEL + " .spark{width:100%;height:30px;display:block;margin-top:4px}",
      "#" + PANEL + " .spark polyline{fill:none;stroke:#7da1de;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}",
      "#" + PANEL + " .spark polygon{fill:#7da1de;opacity:.14}",
      "#" + PANEL + " .err{color:#da8a93}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function build() {
    var p = document.createElement("div");
    p.id = PANEL;
    p.innerHTML =
      '<div class="h"><span>用量<i>' + VER + '</i></span><s class="mdl">…</s></div>' +
      '<div class="sub">上下文</div>' +
      '<div class="cbar"><span data-k="system"></span><span data-k="prompt"></span><span data-k="assistant"></span><span data-k="thinking"></span><span data-k="tools"></span><span class="free"></span></div>' +
      '<div class="row"><s class="rd">—</s><b class="pct">—</b></div>' +
      '<div class="sub">速度<s class="tpsn" style="float:right;text-transform:none"></s></div>' +
      '<div class="gauge"><i></i></div>' +
      '<svg class="spark" viewBox="0 0 240 30" preserveAspectRatio="none"><polygon points=""></polygon><polyline points=""></polyline></svg>' +
      '<div class="sub">会话</div>' +
      '<div class="row"><s>轮 / 步</s><b class="ts">—</b></div>' +
      '<div class="row"><s>LLM / 工具</s><b class="tm">—</b></div>' +
      '<div class="row"><s>首 token</s><b class="tf">—</b></div>' +
      '<div class="row"><s>解码</s><b class="dec">—</b></div>';
    // 给五段上色
    for (var i = 0; i < SEGS.length; i++) {
      var el = p.querySelector('[data-k="' + SEGS[i].k + '"]');
      if (el) el.style.background = SEGS[i].c;
    }
    return p;
  }

  var trend = [];
  function pushTrend(v) {
    trend.push(Math.round(Number(v) || 0));
    if (trend.length > 24) trend = trend.slice(-24);
    return trend;
  }
  function drawSpark(svg, arr) {
    if (!svg || arr.length < 2) return;
    var line = svg.querySelector("polyline"), fill = svg.querySelector("polygon");
    if (!line || !fill) return;
    var W = 240, H = 30, max = Math.max.apply(null, arr.concat([1])), min = Math.min.apply(null, arr.concat([0]));
    var span = Math.max(max - min, 1), step = W / (arr.length - 1), pts = [];
    for (var i = 0; i < arr.length; i++) {
      pts.push((i * step).toFixed(1) + "," + (H - ((arr[i] - min) / span) * (H - 4) - 2).toFixed(1));
    }
    line.setAttribute("points", pts.join(" "));
    fill.setAttribute("points", "0," + H + " " + pts.join(" ") + " " + W + "," + H);
  }

  function refresh(panel, ball) {
    return fetch("/private/stats", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "unknown");
        var q = function (s) { return panel.querySelector(s); };

        q(".mdl").textContent = d.model || "?";

        // 五段 bar：breakdown → 权重 → 最大余数 → 宽度
        var bd = d.breakdown || { systemTokens: 0, toolsTokens: 0, messageTokens: 0 };
        var w = { system: bd.systemTokens || 0, prompt: bd.messageTokens || 0, assistant: 0, thinking: 0, tools: bd.toolsTokens || 0 };
        var used = d.contextTokens || 0;
        var attr = attribute(w, used);
        var sum = 0, i;
        for (i = 0; i < SEGS.length; i++) sum += attr[SEGS[i].k];
        var pct = Math.min(1, used / CAP);
        for (i = 0; i < SEGS.length; i++) {
          var s = SEGS[i];
          var el = q('[data-k="' + s.k + '"]');
          if (!el) continue;
          var share = sum > 0 ? attr[s.k] / sum : 0;
          el.style.width = (share * pct * 100).toFixed(2) + "%";
          el.title = s.n + " " + fmtK(attr[s.k]);
        }
        var cbar = q(".cbar");
        if (cbar) cbar.dataset.p = pressure(pct * 100);
        q(".rd").textContent = fmtK(used) + " / " + fmtK(CAP);
        q(".pct").textContent = (pct * 100).toFixed(1) + "%";

        // TPS
        var tps = Number(d.tps) || 0;
        var g = q(".gauge i");
        if (g) {
          g.style.width = Math.min(100, (tps / 120) * 100).toFixed(1) + "%";
          g.style.background = speedColor(tps);
        }
        var tn = q(".tpsn");
        if (tn) { tn.textContent = tps ? tps.toFixed(1) + " tok/s" : "—"; tn.style.color = tps ? speedColor(tps) : "inherit"; }
        drawSpark(q(".spark"), pushTrend(tps));

        // 会话
        q(".ts").textContent = (d.turns || 0) + " / " + (d.steps || 0);
        q(".tm").textContent = fmtDur(d.llmMs) + " / " + fmtDur(d.toolMs);
        q(".tf").textContent = d.ttftSteps > 0 ? fmtDur(d.ttftMs / d.ttftSteps) + "/步" : "—";
        q(".dec").textContent = fmtK(d.decodeTokens) + " / " + fmtDur(d.decodeMs);

        // 球：环形进度 + 数字
        var pd = (pct * 360).toFixed(1) + "deg";
        ball.style.setProperty("--pd", pd);
        var bnum = ball.querySelector("b");
        if (bnum) bnum.textContent = fmtK(used);

        return d;
      })
      .catch(function (e) {
        var q = function (s) { return panel.querySelector(s); };
        var m = q(".mdl"); if (m) m.textContent = "读取失败";
        var r = q(".rd"); if (r) { r.className = "rd err"; r.textContent = String(e.message || e); }
        return null;
      });
  }

  function mount() {
    if (!document.body || document.getElementById(BALL)) return;
    css();
    var panel = build();
    var ball = document.createElement("div");
    ball.id = BALL;
    ball.innerHTML = "<b>…</b>";
    document.body.appendChild(panel);
    document.body.appendChild(ball);

    var open = false, timer = null, drag = false, moved = false;
    var sx = 0, sy = 0, ox = 0, oy = 0;

    // 恢复位置
    try {
      var pos = JSON.parse(localStorage.getItem("lcs-ball-pos") || "null");
      if (pos && isFinite(pos.l) && isFinite(pos.t)) {
        ball.style.left = pos.l + "px"; ball.style.top = pos.t + "px";
        ball.style.right = "auto"; ball.style.bottom = "auto";
      }
    } catch (e) {}

    function place() {
      var r = ball.getBoundingClientRect(), pw = 274, gap = 10;
      var l = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw));
      panel.style.left = l + "px"; panel.style.right = "auto";
      panel.style.top = "auto";
      panel.style.bottom = (window.innerHeight - r.top + gap) + "px";
    }

    function setOpen(v) {
      open = v;
      if (v) { ball.setAttribute("data-open", "1"); panel.setAttribute("data-open", "1"); place(); refresh(panel, ball); timer = setInterval(function () { refresh(panel, ball); }, 5000); }
      else { ball.removeAttribute("data-open"); panel.removeAttribute("data-open"); if (timer) { clearInterval(timer); timer = null; } }
    }

    ball.addEventListener("pointerdown", function (e) {
      drag = true; moved = false; sx = e.clientX; sy = e.clientY;
      var r = ball.getBoundingClientRect(); ox = r.left; oy = r.top;
      ball.setAttribute("data-drag", "1");
      try { ball.setPointerCapture(e.pointerId); } catch (err) {}
    });
    window.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
      var nx = Math.max(4, Math.min(window.innerWidth - 56, ox + dx));
      var ny = Math.max(4, Math.min(window.innerHeight - 56, oy + dy));
      ball.style.left = nx + "px"; ball.style.top = ny + "px";
      ball.style.right = "auto"; ball.style.bottom = "auto";
      if (open) place();
    });
    window.addEventListener("pointerup", function () {
      if (!drag) return;
      drag = false; ball.removeAttribute("data-drag");
      if (moved) {
        try { var r = ball.getBoundingClientRect(); localStorage.setItem("lcs-ball-pos", JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top) })); } catch (e) {}
      }
    });
    ball.addEventListener("click", function () { if (moved) { moved = false; return; } setOpen(!open); });
    document.addEventListener("click", function (ev) {
      if (!open) return;
      if (ball.contains(ev.target) || panel.contains(ev.target)) return;
      setOpen(false);
    });
    window.addEventListener("resize", function () { if (open) place(); });

    refresh(panel, ball);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
  console.log("%c[LCS] stats ball " + VER + " loaded", "background:#7da1de;color:#161a22;padding:2px 6px;border-radius:3px;font-weight:600");
})();
