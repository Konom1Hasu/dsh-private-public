window.__ModuleLoader__.load({
  id: "@yg/dsh-client-ui-private-settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let React = require("react");

    // ── 色板 ────────────────────────────────────────────────────────
    // dsh-TUI 的四套按 src/theme.ts 真实色值映射。
    // 层级：bg-base < bg-layer-2 < bg-layer-1（卡片）
    const PRESETS = {
      "默认": {},

      // 雾蓝深色：暖灰文字 + 柔和蓝强调
      "TUI 雾蓝": {
        "--dsw-alias-bg-base": "#161a22",
        "--dsw-alias-bg-layer-2": "#1c2330",
        "--dsw-alias-bg-layer-1": "#242b3a",
        "--dsw-alias-brand-primary": "#7da1de",
        "--dsw-alias-label-primary": "#e8e6e0",
        "--dsw-alias-label-secondary": "#8d95a6",
        "--dsw-alias-label-dimmed": "#5e6673",
        "--dsw-alias-border-l1": "#55606f",
        "--dsw-alias-border-l2": "#2c3444",
        "--dsw-alias-state-error-primary": "#da8a93",
        "--dsw-alias-state-success-primary": "#82b89d",
      },
      // 雾蓝浅色：白面板 + 墨色文字
      "TUI 雾蓝·浅": {
        "--dsw-alias-bg-base": "#f6f3ed",
        "--dsw-alias-bg-layer-2": "#eee5d2",
        "--dsw-alias-bg-layer-1": "#ffffff",
        "--dsw-alias-brand-primary": "#3f6cc4",
        "--dsw-alias-label-primary": "#343945",
        "--dsw-alias-label-secondary": "#8991a0",
        "--dsw-alias-label-dimmed": "#a6adba",
        "--dsw-alias-border-l1": "#abc2ec",
        "--dsw-alias-border-l2": "#e4d9e5",
        "--dsw-alias-state-error-primary": "#c24d5c",
        "--dsw-alias-state-success-primary": "#3e9468",
      },
      // 樱粉夜
      "TUI 樱粉": {
        "--dsw-alias-bg-base": "#1a1418",
        "--dsw-alias-bg-layer-2": "#241a20",
        "--dsw-alias-bg-layer-1": "#2e2229",
        "--dsw-alias-brand-primary": "#f27ba6",
        "--dsw-alias-label-primary": "#f0e4e9",
        "--dsw-alias-label-secondary": "#a8929c",
        "--dsw-alias-label-dimmed": "#77646d",
        "--dsw-alias-border-l1": "#6b4a56",
        "--dsw-alias-border-l2": "#3a2c33",
        "--dsw-alias-state-error-primary": "#e66a6a",
        "--dsw-alias-state-success-primary": "#8fc9a4",
      },
      // Claude 陶土橙
      "TUI Claude": {
        "--dsw-alias-bg-base": "#151412",
        "--dsw-alias-bg-layer-2": "#1b1a18",
        "--dsw-alias-bg-layer-1": "#24221f",
        "--dsw-alias-brand-primary": "#d77757",
        "--dsw-alias-label-primary": "#f4f1ea",
        "--dsw-alias-label-secondary": "#b8b2a8",
        "--dsw-alias-label-dimmed": "#817c74",
        "--dsw-alias-border-l1": "#4a453f",
        "--dsw-alias-border-l2": "#302d29",
        "--dsw-alias-state-error-primary": "#d96b5f",
        "--dsw-alias-state-success-primary": "#81966a",
      },

      "B站": {
        "--dsw-alias-bg-base": "#f6f7f8",
        "--dsw-alias-bg-layer-1": "#ffffff",
        "--dsw-alias-bg-layer-2": "#f1f2f3",
        "--dsw-alias-brand-primary": "#fb7299",
        "--dsw-alias-label-primary": "#18191c",
        "--dsw-alias-label-secondary": "#61666d",
        "--dsw-alias-label-dimmed": "#9499a0",
        "--dsw-alias-border-l1": "#e3e5e7",
        "--dsw-alias-border-l2": "#f1f2f3",
      },
      "GitHub 深色": {
        "--dsw-alias-bg-base": "#0d1117",
        "--dsw-alias-bg-layer-1": "#161b22",
        "--dsw-alias-bg-layer-2": "#21262d",
        "--dsw-alias-brand-primary": "#2f81f7",
        "--dsw-alias-label-primary": "#e6edf3",
        "--dsw-alias-label-secondary": "#8b949e",
        "--dsw-alias-label-dimmed": "#6e7681",
        "--dsw-alias-border-l1": "#30363d",
        "--dsw-alias-border-l2": "#21262d",
      },
      "Nord": {
        "--dsw-alias-bg-base": "#2e3440",
        "--dsw-alias-bg-layer-1": "#3b4252",
        "--dsw-alias-bg-layer-2": "#434c5e",
        "--dsw-alias-brand-primary": "#88c0d0",
        "--dsw-alias-label-primary": "#eceff4",
        "--dsw-alias-label-secondary": "#d8dee9",
        "--dsw-alias-label-dimmed": "#7b88a1",
        "--dsw-alias-border-l1": "#4c566a",
        "--dsw-alias-border-l2": "#434c5e",
      },
      "Solarized": {
        "--dsw-alias-bg-base": "#002b36",
        "--dsw-alias-bg-layer-1": "#073642",
        "--dsw-alias-bg-layer-2": "#0a4453",
        "--dsw-alias-brand-primary": "#268bd2",
        "--dsw-alias-label-primary": "#93a1a1",
        "--dsw-alias-label-secondary": "#839496",
        "--dsw-alias-label-dimmed": "#586e75",
        "--dsw-alias-border-l1": "#073642",
        "--dsw-alias-border-l2": "#0a4453",
      },
    };

    // ── 质感 ────────────────────────────────────────────────────────
    const TEXTURES = {
      "标准": {},
      "锐利": {
        "--dsw-radius-xs": "2px",
        "--dsw-radius-sm": "4px",
        "--dsw-radius-md": "6px",
        "--dsw-radius-lg": "8px",
        "--dsw-radius-xl": "10px",
        "--dsw-radius-panel": "12px",
        "--dsw-corner-shape": "round",
        "--dsw-shadow-lv1": "0 1px 2px 0 #0000000a",
        "--dsw-shadow-lv2": "0 1px 3px 0 #0000000a",
        "--dsw-shadow-lv3": "0 2px 8px 0 #00000012",
        "--dsw-elevation-panel": "0 1px 3px 0 #0000000a",
        "--dsw-elevation-soft": "0 2px 6px 0 #0000000d",
      },
      "柔和": {
        "--dsw-radius-xs": "6px",
        "--dsw-radius-sm": "10px",
        "--dsw-radius-md": "14px",
        "--dsw-radius-lg": "20px",
        "--dsw-radius-xl": "24px",
        "--dsw-radius-panel": "32px",
        "--dsw-corner-shape": "superellipse(1.6)",
        "--dsw-shadow-lv1": "0 2px 8px 0 #0000000d",
        "--dsw-shadow-lv2": "0 8px 24px 0 #0000000f",
        "--dsw-shadow-lv3": "0 16px 48px 0 #0000001a",
        "--dsw-elevation-panel": "0 6px 20px 0 #00000010",
        "--dsw-elevation-soft": "0 8px 28px 0 #00000012",
        "--dsw-mask-blur": "8px",
      },
      "扁平": {
        "--dsw-radius-xs": "2px",
        "--dsw-radius-sm": "4px",
        "--dsw-radius-md": "6px",
        "--dsw-radius-lg": "8px",
        "--dsw-radius-xl": "10px",
        "--dsw-radius-panel": "10px",
        "--dsw-corner-shape": "round",
        "--dsw-shadow-lv1": "none",
        "--dsw-shadow-lv2": "none",
        "--dsw-shadow-lv3": "none",
        "--dsw-elevation-panel": "0 0 0 1px var(--dsw-alias-border-l1)",
        "--dsw-elevation-soft": "0 0 0 1px var(--dsw-alias-border-l1)",
        "--dsw-mask-blur": "none",
      },
      // 终端质感：零圆角、零阴影、等宽字体 —— 对齐 dsh-TUI 的观感
      "终端": {
        "--dsw-radius-xs": "0px",
        "--dsw-radius-sm": "0px",
        "--dsw-radius-md": "0px",
        "--dsw-radius-lg": "0px",
        "--dsw-radius-xl": "0px",
        "--dsw-radius-panel": "0px",
        "--dsw-corner-shape": "round",
        "--dsw-shadow-lv1": "none",
        "--dsw-shadow-lv2": "none",
        "--dsw-shadow-lv3": "none",
        "--dsw-elevation-panel": "0 0 0 1px var(--dsw-alias-border-l1)",
        "--dsw-elevation-soft": "0 0 0 1px var(--dsw-alias-border-l1)",
        "--dsw-mask-blur": "none",
        "--dsh-font-family-text": '"Cascadia Code", "JetBrains Mono", "Sarasa Mono SC", Consolas, "Microsoft YaHei Mono", monospace',
        "--dsh-font-family-code": '"Cascadia Code", "JetBrains Mono", "Sarasa Mono SC", Consolas, monospace',
      },
    };

    const COLOR_KEY = "lcs-ui-preset";
    const TEXTURE_KEY = "lcs-ui-texture";

    const ALL_COLOR_VARS = new Set();
    for (const v of Object.values(PRESETS)) for (const k of Object.keys(v)) ALL_COLOR_VARS.add(k);
    const ALL_TEXTURE_VARS = new Set();
    for (const v of Object.values(TEXTURES)) for (const k of Object.keys(v)) ALL_TEXTURE_VARS.add(k);

    /** html + body 两处都要设：alias 变量定义在 body，字体/高亮在 :root。 */
    function targets() {
      return [document.documentElement, document.body].filter(Boolean);
    }

    /** 清掉某组变量的全部覆盖，再写入这一组的值。 */
    function paint(allVars, vars) {
      for (const t of targets()) for (const k of allVars) t.style.removeProperty(k);
      for (const t of targets()) for (const [k, v] of Object.entries(vars || {})) t.style.setProperty(k, v);
    }

    function readSaved(key, table) {
      try {
        const saved = localStorage.getItem(key);
        if (saved && Object.prototype.hasOwnProperty.call(table, saved)) return saved;
      } catch { /* ignore */ }
      return Object.keys(table)[0];
    }

    function applyColors(label) {
      paint(ALL_COLOR_VARS, PRESETS[label]);
      try { localStorage.setItem(COLOR_KEY, label); } catch { /* 隐私模式 */ }
    }

    function applyTexture(label) {
      paint(ALL_TEXTURE_VARS, TEXTURES[label]);
      try { localStorage.setItem(TEXTURE_KEY, label); } catch { /* 隐私模式 */ }
    }

    /** 启动恢复：body 可能还没解析出来，等 DOM 就绪。 */
    function restore() {
      const run = () => {
        paint(ALL_COLOR_VARS, PRESETS[readSaved(COLOR_KEY, PRESETS)]);
        paint(ALL_TEXTURE_VARS, TEXTURES[readSaved(TEXTURE_KEY, TEXTURES)]);
      };
      if (document.body) run();
      else document.addEventListener("DOMContentLoaded", run, { once: true });
    }
    restore();

    // ── 样式 ────────────────────────────────────────────────────────
    const rowStyle = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      padding: "12px 0",
      borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))",
    };
    const labelStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: "120px" };
    const titleStyle = { fontSize: "14px", color: "var(--dsw-alias-label-primary, inherit)" };
    const hintStyle = { fontSize: "12px", color: "var(--dsw-alias-label-dimmed, #888)" };
    const btnWrapStyle = { display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "flex-end" };

    function btnStyle(active) {
      return {
        padding: "5px 12px",
        fontSize: "13px",
        cursor: "pointer",
        borderRadius: "6px",
        border: "1px solid " + (active
          ? "var(--dsw-alias-brand-primary, #2f81f7)"
          : "var(--dsw-alias-border-l1, rgba(128,128,128,.35))"),
        background: active ? "var(--dsw-alias-brand-primary, #2f81f7)" : "transparent",
        color: active ? "#fff" : "var(--dsw-alias-label-secondary, inherit)",
      };
    }

    /** 通用的「一行按钮」组件。 */
    function makeRow(title, hint, key, table, onPick) {
      return function Row() {
        const [current, setCurrent] = React.useState(() => {
          try {
            const saved = localStorage.getItem(key);
            if (saved && Object.prototype.hasOwnProperty.call(table, saved)) return saved;
          } catch { /* ignore */ }
          return Object.keys(table)[0];
        });
        return React.createElement(
          "div",
          { style: rowStyle },
          React.createElement(
            "div",
            { style: labelStyle },
            React.createElement("div", { style: titleStyle }, title),
            React.createElement("div", { style: hintStyle }, hint)
          ),
          React.createElement(
            "div",
            { style: btnWrapStyle },
            Object.keys(table).map((label) =>
              React.createElement(
                "button",
                {
                  key: label,
                  type: "button",
                  style: btnStyle(current === label),
                  onClick: () => { onPick(label); setCurrent(label); },
                },
                label
              )
            )
          )
        );
      };
    }

    const ColorRow = makeRow("配色", "换个色调，立即生效", COLOR_KEY, PRESETS, applyColors);
    const TextureRow = makeRow("质感", "圆角与阴影的手感", TEXTURE_KEY, TEXTURES, applyTexture);

    // ── 人格行：数据来自 host 的 /private/persona ─────────────────────
    function PersonaRow() {
      const [state, setState] = React.useState({ loading: true, current: "", list: [], error: "" });

      const refresh = React.useCallback(async () => {
        try {
          const r = await fetch("/private/persona", {
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json();
          setState({ loading: false, current: j.current || "", list: j.list || [], error: "" });
        } catch (e) {
          setState({ loading: false, current: "", list: [], error: String((e && e.message) || e) });
        }
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      async function pick(name) {
        setState((s) => ({ ...s, error: "" }));
        try {
          const r = await fetch("/private/persona", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: name }),
          });
          if (!r.ok) throw new Error("HTTP " + r.status);
          await refresh();
        } catch (e) {
          setState((s) => ({ ...s, error: String((e && e.message) || e) }));
        }
      }

      let body;
      if (state.loading) {
        body = React.createElement("div", { style: hintStyle }, "读取中…");
      } else if (state.error) {
        body = React.createElement("div", { style: hintStyle }, "读取失败：" + state.error);
      } else if (!state.list.length) {
        body = React.createElement("div", { style: hintStyle }, "人格目录为空");
      } else {
        body = state.list.map((name) =>
          React.createElement(
            "button",
            {
              key: name,
              type: "button",
              style: btnStyle(state.current === name),
              onClick: () => pick(name),
            },
            name
          )
        );
      }

      return React.createElement(
        "div",
        { style: rowStyle },
        React.createElement(
          "div",
          { style: labelStyle },
          React.createElement("div", { style: titleStyle }, "人格"),
          React.createElement(
            "div",
            { style: hintStyle },
            state.current ? "当前：" + state.current : "切换说话方式，立即生效"
          )
        ),
        React.createElement("div", { style: btnWrapStyle }, body)
      );
    }

    // ── 插件入口 ────────────────────────────────────────────────────
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register({ name: "settings.general.item", id: "lcs-ui-color", order: 10 }, ColorRow)
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register({ name: "settings.general.item", id: "lcs-ui-texture", order: 11 }, TextureRow)
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register({ name: "settings.general.item", id: "lcs-persona", order: 12 }, PersonaRow)
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
