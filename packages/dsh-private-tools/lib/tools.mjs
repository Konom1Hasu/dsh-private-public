import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "node:child_process";
import path from "node:path";

/**
 * 本文件的所有 tool 都是「薄包装」：真正的逻辑在 dsh-private/skills/ 下的脚本里，
 * 这里只负责参数校验、超时、输出截断、结构化返回。
 *
 * 为什么不在 tool 里重写一份：
 *   脚本已经在 skill 侧验证过，重写等于两份实现分叉。
 *   tool 只依赖脚本路径固定，不依赖 skill 是否挂载。
 */

const SKILLS = "C:\\Users\\KonomiHasu\\dsh-private\\skills";
const PY = "python";
const PS = "powershell.exe";

/** 跑外部命令，统一超时与输出捕获。 */
function run(file, args, timeoutMs, maxBuffer = 4 << 20) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer, windowsHide: true },
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

/** 统一的结果包装：截断 + 错误合并。 */
function pack(kind, r, maxChars) {
  const body = r.ok ? r.out : `执行失败: ${r.err}`;
  const truncated = body.length > maxChars
    ? body.slice(0, maxChars) + `\n…(截断，共 ${body.length} 字符)`
    : body;
  return { kind, found: Boolean(body.trim()), text: truncated || "(无结果)" };
}

const OUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", required: true },
    found: { type: "boolean", required: true },
    text: { type: "string", required: true },
  },
};

function makeOut(render) {
  return { schema: OUT_SCHEMA, render };
}

/** 文件类型判定 / PE 分析 / 字符串提取 */
export function fileTriageTool(config) {
  const py = path.join(SKILLS, "binary-triage", "triage.py");
  return defineTool({
    name: "file_triage",
    description:
      "判断一个文件到底是什么，不需要打开。三种 kind：" +
      "file（魔数识别：PE/ELF/zip/文本/图片…）、" +
      "pe（PE 节表、架构、是否 .NET、是否加壳、各节熵）、" +
      "strings（提取可读字符串，可带关键词过滤）。" +
      "用于「这是什么文件」「这个 exe 干什么的」「里面有哪些 URL/路径」。",
    parameters: {
      kind: {
        type: "string",
        required: true,
        enum: ["file", "pe", "strings"],
        description: "分析类型",
      },
      target: {
        type: "string",
        required: true,
        description: "目标文件路径",
      },
      grep: {
        type: "string",
        description: "kind=strings 时的过滤正则（可选）",
      },
    },
    output: makeOut((_a, v) => [{ type: "text", text: v.text }]),
    async execute(args) {
      const argv = [py, args.kind, args.target];
      if (args.kind === "strings") {
        argv.push("--min", "6", "--limit", "60");
        if (args.grep) argv.push("--grep", args.grep);
      }
      const r = await run(PY, argv, config.timeoutMs);
      return pack(args.kind, r, config.maxOutputChars);
    },
    presentCall: (a) => ({
      card: "generic",
      title: `file_triage ${a.kind}`,
      kind: "read",
      rawInput: a.target,
    }),
  });
}

/** 归档检视：列内容 / 包内查找 / 汇总 */
export function archivePeekTool(config) {
  const py = path.join(SKILLS, "archive-ops", "archive.py");
  return defineTool({
    name: "archive_peek",
    description:
      "不落地解压，直接查看压缩包内容。支持 zip/apk/jar/whl/nupkg/epub/tar/gz/bz2/xz。" +
      "三种 kind：list（列条目，带大小与压缩比）、find（在包内按文件名找）、info（汇总统计）。" +
      "用于「这个包里有什么」「apk 里有没有某个配置」。需要真正解压时用 pwsh 调同一个脚本的 extract。",
    parameters: {
      kind: {
        type: "string",
        required: true,
        enum: ["list", "find", "info"],
        description: "操作类型",
      },
      target: {
        type: "string",
        required: true,
        description: "归档文件路径",
      },
      needle: {
        type: "string",
        description: "kind=find 时的文件名字片段",
      },
      limit: {
        type: "number",
        description: "list 最多显示多少条（默认 40）",
      },
    },
    output: makeOut((_a, v) => [{ type: "text", text: v.text }]),
    async execute(args) {
      const argv = [py, args.kind, args.target];
      if (args.kind === "find") {
        if (!args.needle) throw new Error("kind=find 需要 needle");
        argv.push(args.needle);
      }
      if (args.kind === "list") argv.push("--limit", String(args.limit || 40));
      const r = await run(PY, argv, config.timeoutMs);
      return pack(args.kind, r, config.maxOutputChars);
    },
    presentCall: (a) => ({
      card: "generic",
      title: `archive_peek ${a.kind}`,
      kind: "read",
      rawInput: a.target,
    }),
  });
}

/** SQLite 只读查询 */
export function sqliteQueryTool(config) {
  const py = path.join(SKILLS, "sqlite-ops", "sqlite_ops.py");
  return defineTool({
    name: "sqlite_query",
    description:
      "只读查询一个 SQLite 库文件。三种 kind：" +
      "tables（所有表 + 行数 + 是否 FTS）、" +
      "schema（某张表的建表语句和索引）、" +
      "query（执行只读 SELECT，最多返回 50 行）。" +
      "库以只读模式打开，不会写坏正在被程序使用的库。",
    parameters: {
      kind: {
        type: "string",
        required: true,
        enum: ["tables", "schema", "query"],
        description: "操作类型",
      },
      db: {
        type: "string",
        required: true,
        description: "库文件路径",
      },
      sql: {
        type: "string",
        description: "kind=schema 时填表名；kind=query 时填 SELECT 语句",
      },
    },
    output: makeOut((_a, v) => [{ type: "text", text: v.text }]),
    async execute(args) {
      const argv = [py, args.kind, args.db];
      if (args.kind === "schema") {
        if (!args.sql) throw new Error("kind=schema 需要 sql 参数填表名");
        argv.push(args.sql);
      }
      if (args.kind === "query") {
        if (!args.sql) throw new Error("kind=query 需要 sql 参数填 SELECT");
        if (!/^\s*(select|pragma|explain)\b/i.test(args.sql)) {
          throw new Error("只允许 SELECT / PRAGMA / EXPLAIN，本工具不开写操作");
        }
        argv.push(args.sql);
      }
      const r = await run(PY, argv, config.timeoutMs);
      return pack(args.kind, r, config.maxOutputChars);
    },
    presentCall: (a) => ({
      card: "generic",
      title: `sqlite_query ${a.kind}`,
      kind: "read",
      rawInput: a.db,
    }),
  });
}

/** dsh 自身健康检查 */
export function dshHealthTool(config) {
  const js = path.join(SKILLS, "dsh-forensics", "forensics.mjs");
  return defineTool({
    name: "dsh_health",
    description:
      "检查一个 dsh profile 的配置健康度：bundles 列表、依赖数、patch 是否存在、" +
      "home patch 是否在（存在会覆盖所有 profile）。排查「dsh 配置是不是被改坏了」时先跑这个。" +
      "不启动 dsh、不调模型，纯读文件。",
    parameters: {
      profile: {
        type: "string",
        description: "profile 名，默认 web",
      },
    },
    output: makeOut((_a, v) => [{ type: "text", text: v.text }]),
    async execute(args) {
      const r = await run(
        process.execPath,
        [js, "health", "--profile", args.profile || "web"],
        config.timeoutMs,
      );
      return pack("health", r, config.maxOutputChars);
    },
    presentCall: (a) => ({
      card: "generic",
      title: `dsh_health ${a.profile || "web"}`,
      kind: "other",
      rawInput: a.profile || "web",
    }),
  });
}
