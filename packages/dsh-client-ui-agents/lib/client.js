/**
 * @yg/dsh-client-ui-agents — 右侧栏「Agent 编队」面板（浏览器侧）
 *
 * 注册四样东西：
 *   1. tab 类型（ctx.sidebarRightTabs）—— 它在 tab 系统里的身份
 *   2. 正文（slots: sidebar.right.pane.tab，key = 类型 id）
 *   3. chip 标题（slots: sidebar.right.pane.tab.title）
 *   4. 会话 header 角落按钮（conversation.session.header.corner）—— 常驻入口
 *
 * 正文用 iframe 加载 /private/agents —— 那份页面已经把编队拓扑、八段上下文条、
 * 泳道时间线、任务表画好了，直接复用比用 createElement 重写一遍更稳，也不会走样。
 */
window.__ModuleLoader__.load({
  id: "@yg/dsh-client-ui-agents",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let React = require("react");

    const TYPE_ID = "@yg/dsh-client-ui-agents";
    const KIND = "agent-fleet";
    const SRC = "/private/agents?embed=1";

    /**
     * 自检 beacon。client bundle 有一年 immutable 缓存，从服务端文件看不出浏览器
     * 跑的是哪一版，也看不出 apply 是否抛错。在关键节点打点，
     * host 侧 /private/agents/client-status 能看到整条链路停在哪。
     */
    function beacon(step) {
      try {
        fetch(
          "/private/agents/client-alive?id=" + encodeURIComponent(step),
          { cache: "no-store" },
        ).catch(() => {});
      } catch (e) {
        /* 没有 fetch 就算了 */
      }
    }

    beacon("module-loaded");

    /** 正文：满幅 iframe。 */
    function FleetBody(props) {
      let full = false;
      try {
        const info = props && props.useTabInfo ? props.useTabInfo() : null;
        const sidebar = info && info.sidebar;
        full = !!(sidebar && (sidebar.fullscreen || sidebar.expanded === false));
      } catch (e) {
        full = false;
      }
      return React.createElement("iframe", {
        key: full ? "full" : "dock",
        src: SRC,
        title: "Agent 编队",
        style: {
          width: "100%",
          height: "100%",
          border: "0",
          display: "block",
          background: "#080a10",
          colorScheme: "dark",
        },
      });
    }

    function FleetTitle() {
      return "Agent 编队";
    }

    /**
     * 会话 header 角落的常驻按钮。
     * 用文字 + 图标而不是纯图标——这个面板不是 dsh 原生功能，得让人一眼认出来。
     */
    function FleetButton() {
      const [hover, setHover] = React.useState(false);
      const open = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          if (ctx && ctx.sidebarRight && ctx.sidebarRight.openTab) {
            ctx.sidebarRight.openTab(KIND);
          }
        } catch (e) {
          // 没有活动会话时 openTab 会 throw，忽略即可
        }
      };
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: open,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: "打开 Agent 编队工作台",
          "aria-label": "Agent 编队",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            height: "26px",
            padding: "0 10px",
            marginLeft: "2px",
            borderRadius: "7px",
            border: "1px solid " + (hover ? "#7aa5ff" : "rgba(91,140,255,.55)"),
            background: hover
              ? "rgba(91,140,255,.32)"
              : "rgba(91,140,255,.16)",
            color: hover ? "#dbe7ff" : "#a8c2ff",
            fontSize: "11.5px",
            fontWeight: 600,
            lineHeight: 1,
            cursor: "pointer",
            transition: "all .14s ease",
            whiteSpace: "nowrap",
            flex: "none",
            boxShadow: hover ? "0 0 0 1px rgba(91,140,255,.45)" : "none",
          },
        },
        React.createElement("span", {
          style: { fontSize: "10px", color: hover ? "#7aa5ff" : "#6f9dff" },
        }, "◈"),
        "编队",
      );
    }

    /** tab 类型定义：kind 唯一、给一个引导入口。 */
    function fleetDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        priority: "extension",
        title: () => "Agent 编队",
        keepMounted: true,
        guide: [
          {
            id: "fleet",
            order: 5,
            title: () => "Agent 编队",
            description: () => "编队拓扑 · 上下文八段 · 泳道时间线 · 委派任务",
          },
        ],
      };
    }

    const inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    let ctx = null;

    /**
     * 页面卡（和「对话」「轨迹」同级）的通用 iframe 视图。
     *
     * 高度给两层保险：容器有高度时 100% 生效；容器无高度时 minHeight 兜底，
     * 避免 iframe 退化成内容高度、跟对话区挤在一起。
     */
    function makeView(title, src) {
      return function View() {
        return React.createElement(
          "div",
          {
            style: {
              width: "100%",
              height: "100%",
              minHeight: "480px",
              display: "flex",
              overflow: "hidden",
              background: "#080a10",
            },
          },
          React.createElement("iframe", {
            src,
            title,
            style: {
              flex: "1 1 auto",
              width: "100%",
              height: "100%",
              border: "0",
              display: "block",
              background: "#080a10",
              colorScheme: "dark",
            },
          }),
        );
      };
    }

    const FleetView = makeView("Agent 编队", "/private/agents?embed=1&view=1");
    const CioView = makeView("CIO 调度", "/private/agents?embed=1&mode=cio");
    const BoardView = makeView("画板", "/private/agents?embed=1&mode=board");
    const CastView = makeView("会话广播", "/private/agents?embed=1&mode=cast");

    /** 和「对话」「轨迹」同级的页面卡。order 排在 chat(0)/trajectory(10) 之后。 */
    const VIEWS = [
      { id: "yg-fleet", order: 20, label: "编队", comp: FleetView },
      { id: "yg-cio", order: 21, label: "调度", comp: CioView },
      { id: "yg-cast", order: 22, label: "广播", comp: CastView },
      { id: "yg-board", order: 23, label: "画板", comp: BoardView },
    ];

    // ══ 悬浮球 + 大悬浮窗 ══════════════════════════════════════════
    // 右侧栏太窄，塞不下这个面板。改成常驻右下角的球，点开是一块
    // 接近全屏的浮窗。用原生 DOM（不经过 React slot）——浮窗要盖在整个
    // 应用之上，zone 在哪个 slot 里都会被裁。
    const FAB_ID = "yg-agents-fab";
    const PANEL_ID = "yg-agents-panel";
    const STYLE_ID = "yg-agents-fab-style";

    const FAB_CSS = `
#${FAB_ID}{
  position:fixed; right:22px; bottom:86px; z-index:9998;
  width:52px; height:52px; border-radius:50%;
  display:grid; place-items:center;
  background:linear-gradient(145deg,#2a3f68,#16203a);
  border:1px solid rgba(91,140,255,.55);
  color:#9dbcff; font-size:19px; line-height:1;
  cursor:pointer; padding:0;
  box-shadow:0 8px 26px -8px #000, 0 0 0 1px rgba(91,140,255,.18);
  transition:transform .16s ease, border-color .16s ease, box-shadow .16s ease;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
}
#${FAB_ID}:hover{
  transform:scale(1.09); border-color:#7aa5ff;
  box-shadow:0 10px 30px -8px #000, 0 0 0 1px rgba(122,165,255,.5);
}
#${FAB_ID} .yg-fab-dot{
  position:absolute; top:9px; right:9px; width:7px; height:7px; border-radius:50%;
  background:#3ddc97; box-shadow:0 0 8px #3ddc97;
}
#${PANEL_ID}{
  position:fixed; z-index:9999;
  right:22px; bottom:150px;
  width:min(1240px, 93vw); height:min(820px, 84vh);
  display:flex; flex-direction:column;
  border-radius:14px; overflow:hidden;
  border:1px solid rgba(91,140,255,.38);
  background:#080a10;
  box-shadow:0 28px 80px -24px #000, 0 0 0 1px rgba(91,140,255,.12);
  animation:ygFabPop .18s cubic-bezier(.2,.9,.3,1.2);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
}
@keyframes ygFabPop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
#${PANEL_ID} .yg-p-head{
  flex:none; display:flex; align-items:center; gap:9px;
  height:42px; padding:0 10px 0 14px;
  background:linear-gradient(180deg,#121a2a,#0b1018);
  border-bottom:1px solid #1e2839;
  user-select:none;
}
#${PANEL_ID} .yg-p-head .yg-p-t{
  font-size:13px; font-weight:650; color:#e8eaf0; letter-spacing:.3px;
  display:flex; align-items:center; gap:7px;
}
#${PANEL_ID} .yg-p-head .yg-p-t i{
  font-style:normal; color:#5b8cff; font-size:12px;
}
#${PANEL_ID} .yg-p-head .yg-p-s{
  font-size:10.5px; color:#5a6880;
}
#${PANEL_ID} .yg-p-head .yg-p-sp{flex:1}
#${PANEL_ID} .yg-p-btn{
  width:26px; height:26px; border-radius:7px; padding:0;
  display:grid; place-items:center;
  background:transparent; border:1px solid transparent;
  color:#93a0b8; font-size:12px; cursor:pointer; transition:.14s;
  font-family:inherit;
}
#${PANEL_ID} .yg-p-btn:hover{background:rgba(255,255,255,.07); color:#e8eaf0}
#${PANEL_ID} .yg-p-body{flex:1; min-height:0; position:relative; background:#080a10}
#${PANEL_ID} iframe{
  width:100%; height:100%; border:0; display:block; background:#080a10;
  color-scheme:dark;
}
#${PANEL_ID}.yg-max{
  right:10px !important; bottom:10px !important;
  width:calc(100vw - 20px) !important; height:calc(100vh - 20px) !important;
  border-radius:10px;
}
`;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = FAB_CSS;
      document.head.appendChild(st);
    }

    function closePanel() {
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove();
      const fab = document.getElementById(FAB_ID);
      if (fab) fab.style.background = "linear-gradient(145deg,#2a3f68,#16203a)";
      document.removeEventListener("keydown", onKeydown, true);
    }

    function onKeydown(ev) {
      if (ev.key === "Escape" && document.getElementById(PANEL_ID)) {
        ev.stopPropagation();
        closePanel();
      }
    }

    function openPanel() {
      if (document.getElementById(PANEL_ID)) return;
      ensureStyle();
      const panel = document.createElement("div");
      panel.id = PANEL_ID;

      const head = document.createElement("div");
      head.className = "yg-p-head";

      const title = document.createElement("div");
      title.className = "yg-p-t";
      const ico = document.createElement("i");
      ico.textContent = "◈";
      title.appendChild(ico);
      title.appendChild(document.createTextNode("Agent 编队"));

      const sub = document.createElement("div");
      sub.className = "yg-p-s";
      sub.textContent = "编队拓扑 · 上下文八段 · 泳道 · 委派任务";

      const sp = document.createElement("div");
      sp.className = "yg-p-sp";

      const btnMax = document.createElement("button");
      btnMax.className = "yg-p-btn";
      btnMax.type = "button";
      btnMax.title = "最大化 / 还原";
      btnMax.textContent = "⤢";
      btnMax.onclick = () => panel.classList.toggle("yg-max");

      const btnReload = document.createElement("button");
      btnReload.className = "yg-p-btn";
      btnReload.type = "button";
      btnReload.title = "重新读取数据";
      btnReload.textContent = "⟳";
      btnReload.onclick = () => {
        const f = panel.querySelector("iframe");
        if (f) f.src = SRC + "&_r=" + Date.now();
      };

      const btnClose = document.createElement("button");
      btnClose.className = "yg-p-btn";
      btnClose.type = "button";
      btnClose.title = "关闭 (Esc)";
      btnClose.textContent = "✕";
      btnClose.onclick = closePanel;

      head.append(title, sub, sp, btnMax, btnReload, btnClose);

      const body = document.createElement("div");
      body.className = "yg-p-body";
      const frame = document.createElement("iframe");
      frame.src = SRC;
      frame.title = "Agent 编队";
      body.appendChild(frame);

      panel.append(head, body);
      document.body.appendChild(panel);
      document.addEventListener("keydown", onKeydown, true);
    }

    function togglePanel() {
      if (document.getElementById(PANEL_ID)) closePanel();
      else openPanel();
    }

    function mountFab() {
      if (!document.body) return;
      ensureStyle();
      let fab = document.getElementById(FAB_ID);
      if (!fab) {
        fab = document.createElement("button");
        fab.id = FAB_ID;
        fab.type = "button";
        fab.title = "Agent 编队";
        fab.setAttribute("aria-label", "Agent 编队");
        fab.appendChild(document.createTextNode("◈"));
        const dot = document.createElement("span");
        dot.className = "yg-fab-dot";
        fab.appendChild(dot);
        fab.onclick = togglePanel;
        document.body.appendChild(fab);
        beacon("fab-mounted");
      }
    }

    /** 保持浮球存在：SPA 路由切换 / React 重挂载有可能把 body 直接子元素清掉。 */
    function keepFab() {
      try {
        mountFab();
      } catch (e) {
        /* 忽略 */
      }
    }

    function apply(root) {
      ctx = root;
      beacon("apply-enter");

      try {
        ctx.effect(
          () => ctx.sidebarRightTabs.register(fleetDefinition()),
          "ui-agents: fleet tab type",
        );
        beacon("tab-type-ok");
      } catch (e) {
        beacon("tab-type-FAIL:" + (e && e.message ? e.message : e));
      }

      try {
        ctx.effect(
          () =>
            ctx.slots.inject("sidebar.right.pane.tab", () =>
              ctx.slots.register(
                { name: "sidebar.right.pane.tab", key: TYPE_ID },
                FleetBody,
              ),
            ),
          "ui-agents: fleet body",
        );
        beacon("slot-body-ok");
      } catch (e) {
        beacon("slot-body-FAIL:" + (e && e.message ? e.message : e));
      }

      try {
        ctx.effect(
          () =>
            ctx.slots.inject("sidebar.right.pane.tab.title", () =>
              ctx.slots.register(
                { name: "sidebar.right.pane.tab.title", key: TYPE_ID },
                FleetTitle,
              ),
            ),
          "ui-agents: fleet chip title",
        );
        beacon("slot-title-ok");
      } catch (e) {
        beacon("slot-title-FAIL:" + (e && e.message ? e.message : e));
      }

      // 常驻入口：会话 header 角落
      try {
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.session.header.corner", () =>
              ctx.slots.register(
                { name: "conversation.session.header.corner", id: "fleet-open" },
                FleetButton,
              ),
            ),
          "ui-agents: header corner button",
        );
        beacon("slot-corner-ok");
      } catch (e) {
        beacon("slot-corner-FAIL:" + (e && e.message ? e.message : e));
      }

      // 页面卡：和「对话」「轨迹」同级的主视图 tab
      for (const v of VIEWS) {
        try {
          ctx.effect(
            () =>
              ctx.slots.inject("conversation.view", () =>
                ctx.slots.register(
                  {
                    name: "conversation.view",
                    id: v.id,
                    order: v.order,
                    label: () => v.label,
                  },
                  v.comp,
                ),
              ),
            "ui-agents: conversation view " + v.id,
          );
          beacon("view-ok:" + v.id);
        } catch (e) {
          beacon("view-FAIL:" + v.id + ":" + (e && e.message ? e.message : e));
        }
      }

      // 自动打开一次：入口藏在 header 角落 + 引导页里，太隐蔽。
      // 只开一次（localStorage 记标记），之后靠按钮进。
      try {
        const KEY = "yg.agents.autoopened.v1";
        if (!localStorage.getItem(KEY)) {
          setTimeout(() => {
            try {
              ctx.sidebarRight.openTab(KIND);
              localStorage.setItem(KEY, "1");
              beacon("auto-open-ok");
            } catch (e) {
              // 没有活动会话时 openTab 会 throw；不记标记，下次进会话再试
              beacon("auto-open-skip:" + (e && e.message ? e.message : e));
            }
          }, 1500);
        }
      } catch (e) {
        /* 隐私模式没有 localStorage */
      }

      // 常驻悬浮球：主力入口
      try {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", keepFab, { once: true });
        } else {
          keepFab();
        }
        // SPA 重挂载后补挂
        if (!window.__ygAgentsFabTimer) {
          window.__ygAgentsFabTimer = setInterval(keepFab, 4000);
        }
      } catch (e) {
        beacon("fab-FAIL:" + (e && e.message ? e.message : e));
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
