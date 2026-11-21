/**
 * @yg/dsh-client-ui-workbench — host 侧
 *
 * 只做一件事：把台面页面和它的脚本喂给浏览器。
 * 数据都走已有端点（/private/tasks.json、/private/agents.json、
 * /private/agents/broadcast），这里不重复造接口。
 *
 * @module @yg/dsh-client-ui-workbench
 */
import z from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = "@yg/dsh-client-ui-workbench";
const inject = ["webServer"];

const here = dirname(fileURLToPath(import.meta.url));

export const Config = z.object({
  /** 页面轮询间隔由前端固定 5s，这里只留一个开关方便排查 */
  enabled: z.boolean().default(true),
});

export function apply(ctx, config) {
  if (!config.enabled) return;

  let html = null;
  let script = null;

  function load(file) {
    return readFileSync(join(here, file), "utf8");
  }

  function send(res, type, body) {
    res.setHeader("content-type", type + "; charset=utf-8");
    // 台面要跟着数据变，不能让浏览器缓存住
    res.setHeader("cache-control", "no-store");
    res.end(body);
  }

  ctx.webServer.register({
    kind: "exact",
    path: "/private/workbench",
    handler: async (req, res) => {
      try {
        if (!html) html = load("ui.html");
        send(res, "text/html", html);
      } catch (e) {
        res.statusCode = 500;
        send(res, "text/plain", "workbench ui.html 读不到: " + String(e?.message || e));
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/private/workbench.js",
    handler: async (req, res) => {
      try {
        if (!script) script = load("workbench.js");
        send(res, "text/javascript", script);
      } catch (e) {
        res.statusCode = 500;
        send(res, "text/plain", "workbench.js 读不到: " + String(e?.message || e));
      }
    },
  });

  /**
   * 能力探针的落点。浏览器 require 不到什么模块，只有从那边能测出来，
   * 所以让它 POST 回来，这里存着供查询。
   */
  let lastProbe = null;
  ctx.webServer.register({
    kind: "exact",
    path: "/private/workbench/probe",
    handler: async (req, res) => {
      if (req.method === "GET" || req.method === "HEAD") {
        send(res, "application/json", JSON.stringify(lastProbe || { ok: false, note: "浏览器还没上报" }));
        return;
      }
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 20000) req.destroy();
      });
      req.on("end", () => {
        try {
          lastProbe = { ok: true, at: new Date().toISOString(), data: JSON.parse(raw || "{}") };
        } catch {
          lastProbe = { ok: false, note: "上报内容不是 JSON", raw: raw.slice(0, 500) };
        }
        send(res, "application/json", JSON.stringify({ ok: true }));
      });
    },
  });
}

export { name, inject };
