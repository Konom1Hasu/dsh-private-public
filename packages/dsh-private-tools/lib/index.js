import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "node:child_process";
import {
  fileTriageTool,
  archivePeekTool,
  sqliteQueryTool,
  dshHealthTool,
} from "./tools.mjs";
import { buildWebSearchTool } from "./websearch.mjs";

/**
 * @yg/dsh-private-tools
 *
 * 只放「高频、原子、schema 便宜」的能力。其余一律用 skill。
 *
 * 为什么只做一个工具：工具定义每轮请求都整份发给模型，是固定开销。
 * skill 不读就不占 token。所以门槛是「每天都用且一句话说不清」。
 *
 * @module @yg/dsh-private-tools
 */

const name = "private-tools";
const inject = ["tools"];

const Config = z.object({
  /** 单次命令超时。netstat 全量列出在大机器上可能慢。 */
  timeoutMs: z.number().default(15000),
  /** 输出上限（字符），防止把整张进程表塞进上下文。 */
  maxOutputChars: z.number().default(4000),
});

/**
 * 跑一条 PowerShell 命令，返回 trimmed 输出。
 * 用 powershell.exe 而不是 pwsh：这台机器上 powershell 一定存在。
 */
function ps(command, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || "").trim(),
          err: String(stderr || (err && err.message) || "").trim(),
        });
      },
    );
  });
}

/** 查端口占用：先精确查，查不到回退 netstat（IPv6 绑定 / TIME_WAIT 会漏）。 */
async function portOwner(port, timeoutMs) {
  const cmd = `
$port = ${Number(port)}
$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$owner = 0
if ($c) { $owner = [int]$c.OwningProcess }
else {
  $line = netstat -ano | Select-String ":$port\\s+.*LISTENING" | Select-Object -First 1
  if ($line) { $owner = [int](($line.Line -split '\\s+') | Where-Object { $_ })[-1] }
}
if ($owner -eq 0) { "NO_LISTENER" }
else {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
  "PID=$owner"
  "NAME=$($p.Name)"
  "START=$($p.CreationDate)"
  "CMD=$($p.CommandLine)"
}
`.trim();
  return ps(cmd, timeoutMs);
}

/** 按名字找进程（宽松匹配，带内存和启动时间）。 */
async function findProcess(pattern, timeoutMs) {
  const safe = String(pattern).replace(/['"`]/g, "");
  const cmd = `
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*${safe}*" } |
  Sort-Object WorkingSetSize -Descending |
  Select-Object -First 15 |
  ForEach-Object {
    $mb = [math]::Round($_.WorkingSetSize / 1MB, 1)
    "pid={0}  {1}  {2}MB  {3}" -f $_.ProcessId, $_.Name, $mb, $_.CreationDate
  }
`.trim();
  return ps(cmd, timeoutMs);
}

/** 列出监听端口（按端口排序，带进程名）。 */
async function listListen(timeoutMs) {
  const cmd = `
$rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
if (-not $rows) {
  netstat -ano | Select-String "LISTENING" | ForEach-Object {
    $p = ($_.Line -split '\\s+') | Where-Object { $_ }
    $p[1] + "  pid=" + $p[-1]
  }
} else {
  $rows | Sort-Object LocalPort | ForEach-Object {
    $proc = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    "{0,-6} {1,-18} pid={2} {3}" -f $_.LocalPort, $_.LocalAddress, $_.OwningProcess, $proc
  }
}
`.trim();
  return ps(cmd, timeoutMs);
}

/**
 * 挂载本工具集。
 * @param ctx - 带 tools 注册表的上下文
 * @param config - 超时与输出上限
 */
function apply(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: "sys_query",
      description:
        "查询本机系统状态，不依赖会话工作目录。三种 kind：" +
        "port（谁占了某个端口，含完整命令行）、" +
        "process（按名字模糊匹配进程，最多 15 条）、" +
        "listen（当前所有监听端口）。" +
        "用于「端口被占了」「某进程在不在」「谁在监听这个端口」这类问题。",
      parameters: {
        kind: {
          type: "string",
          required: true,
          enum: ["port", "process", "listen"],
          description: "查询类型",
        },
        target: {
          type: "string",
          description: "kind=port 时填端口号；kind=process 时填进程名片段；kind=listen 时忽略",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", required: true },
            found: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const timeout = config.timeoutMs;
        let r;

        if (args.kind === "port") {
          if (!args.target) throw new Error("kind=port 需要 target（端口号）");
          const port = Number(args.target);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`端口号非法: ${args.target}`);
          }
          r = await portOwner(port, timeout);
          if (r.out === "NO_LISTENER") {
            return { kind: "port", found: false, text: `端口 ${port} 无人监听` };
          }
        } else if (args.kind === "process") {
          if (!args.target) throw new Error("kind=process 需要 target（进程名片段）");
          r = await findProcess(args.target, timeout);
        } else if (args.kind === "listen") {
          r = await listListen(timeout);
        } else {
          throw new Error(`不支持的 kind: ${args.kind}`);
        }

        const body = r.ok ? r.out : `命令失败: ${r.err}`;
        const text = body.length > config.maxOutputChars
          ? body.slice(0, config.maxOutputChars) + `\n…(截断，共 ${body.length} 字符)`
          : body;

        return {
          kind: args.kind,
          found: Boolean(body.trim()),
          text: text || "(无结果)",
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `sys_query ${args.kind}${args.target ? " " + args.target : ""}`,
        kind: "execute",
        rawInput: args.target || args.kind,
      }),
    }),
  );

  // 薄包装类 tool：逻辑在 dsh-private/skills/*/ 的脚本里，这里只做参数校验与截断。
  ctx.tools.register(fileTriageTool(config));
  ctx.tools.register(archivePeekTool(config));
  ctx.tools.register(sqliteQueryTool(config));
  ctx.tools.register(dshHealthTool(config));

  // 多源联网搜索（原生 web_search 走官方 API，余额不足就 402 全挂）
  ctx.tools.register(buildWebSearchTool(ctx));
}

export { Config, apply, inject, name };
