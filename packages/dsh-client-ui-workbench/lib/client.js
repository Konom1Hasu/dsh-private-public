/**
 * @yg/dsh-client-ui-workbench — 浏览器侧
 *
 * 注册一个「台面」页卡，和「对话」「轨迹」同级。
 * 正文用 iframe 加载 /private/workbench —— 那份页面自己管布局和轮询，
 * 这里只负责把它挂进 tab 系统。
 */
window.__ModuleLoader__.load({
  id: "@yg/dsh-client-ui-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let React = require("react");

    const VIEW_ID = "yg-workbench";
    const SRC = "/private/workbench";

    function WorkbenchView() {
      return React.createElement(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            minHeight: "520px",
            display: "flex",
            overflow: "hidden",
            // 和 ui.html 的纸底一致，避免 iframe 加载瞬间闪出别的颜色
            background: "#f2f2f4",
          },
        },
        React.createElement("iframe", {
          src: SRC,
          title: "工作台",
          style: {
            flex: "1 1 auto",
            width: "100%",
            height: "100%",
            border: "0",
            display: "block",
            background: "#f2f2f4",
          },
        }),
      );
    }

    const inject = ["slots"];

    /**
     * 能力探针：试 require 各种模块，把结果报回 host。
     *
     * 为什么要在浏览器里试：ModuleLoader 的 require 是动态解析的，
     * 从服务端源码看不出它到底给到了哪些模块。而"能不能 require 到
     * 组件库/工具库"直接决定重写 UI 时要手写多少东西 —— 这个必须实测，
     * 猜错了整个方案就得推翻。
     */
    function probe(require) {
      const specs = [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/cordis",
        "clsx",
        "lucide-react",
        "antd",
      ];
      const result = {};
      for (const s of specs) {
        try {
          const m = require(s);
          const keys = m ? Object.keys(m) : [];
          // primitives 是我们最可能直接复用的设计系统，把它的导出全带上
          result[s] = keys.length > 8 && s.indexOf("primitives") === -1
            ? keys.slice(0, 8).join(",") + ` …(+${keys.length - 8})`
            : keys.join(",") || "(空对象)";
        } catch (e) {
          result[s] = "ERR: " + (e && e.message ? e.message.slice(0, 60) : e);
        }
      }
      // 顺手看看 react 版本和有没有 createElement
      try {
        const R = require("react");
        result.__react = R && R.version ? "v" + R.version : "无 version";
        result.__createElement = typeof (R && R.createElement) === "function" ? "有" : "无";
        result.__hooks = R && R.useState ? "useState 有" : "useState 无";
      } catch (e) {
        result.__react = "require 失败";
      }
      try {
        fetch("/private/workbench/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(result),
        }).catch(() => {});
      } catch {
        /* 探针失败不影响页面 */
      }
      console.log("[workbench probe]", result);
    }

    function apply(ctx) {
      try {
        probe(require);
      } catch (e) {
        console.error("[ui-workbench] probe failed:", e);
      }
      try {
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.view", () =>
              ctx.slots.register(
                {
                  name: "conversation.view",
                  id: VIEW_ID,
                  // 排在 chat(0) / trajectory(10) 之后，也排在编队那组(20-23)之后
                  order: 15,
                  label: () => "台面",
                },
                WorkbenchView,
              ),
            ),
          "ui-workbench: conversation view",
        );
      } catch (e) {
        // 挂不上也别把整个客户端打崩，页卡没有而已
        console.error("[ui-workbench] register failed:", e);
      }
    }

    module.exports = {
      name: "@yg/dsh-client-ui-workbench",
      inject,
      apply,
    };
    return module.exports;
  },
});
