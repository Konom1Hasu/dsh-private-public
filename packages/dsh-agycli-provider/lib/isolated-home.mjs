// 隔离 HOME（<AGY_ISOLATED_HOME>）幂等播种 —— 教程 §3.2 / checklist A3 + A4。
//
// 契约：
//   - 幂等：内容没变就不落盘（先读后比），重复调用不产生写盘与 mtime 抖动。
//   - 原子：任何写盘都走同目录 tmp + rename，避免 agy 读到半截文件。
//   - 零凭据：全程不读写任何 OAuth Token / 系统凭据库（教程红线）。
//   - 零依赖：只用 node:fs / node:path。
import fs from 'node:fs'
import path from 'node:path'

// ---- 模板（与真机 <AGY_ISOLATED_HOME> 逐字节对齐） ----

// 教程 §3.2(1)：严禁 tools: []，严禁 inheritMcp: false，description 不能漏。
export const DSH_BRIDGE_AGENT_MD = [
  '---',
  'name: dsh_bridge',
  'description: Minimal bridge agent for DSH.',
  'mainAgent: true',
  'subagent: false',
  'excludeDefaultComponents: true',
  'inheritMcp: true',
  'skills: []',
  'rules: []',
  'agents: []',
  'plugins: []',
  '---',
  'Minimal bridge agent for DSH.',
  '',
].join('\n')

// 教程 §3.2：兼容 agy 1.5.9 的插件形态
export const DSH_BRIDGE_PLUGIN_JSON = JSON.stringify({ name: 'dsh_bridge' }, null, 2) + '\n'

// 教程 §3.2(3)：900K 枚举解锁大窗口
export const SETTINGS_JSON = JSON.stringify(
  { contextWindow: '900K', toolPermission: 'request-review', agentMode: '' },
  null,
  2,
) + '\n'

// 教程 §3.2(3)：跳过首次启动交互引导
export const ONBOARDING_JSON = JSON.stringify(
  {
    consumerOnboardingComplete: true,
    enterpriseOnboardingComplete: false,
    onboardingComplete: true,
  },
  null,
  2,
) + '\n'

// 教程 §3.2(3)：默认 CLI 工程
export const DEFAULT_CLI_PROJECT_JSON = JSON.stringify(
  { id: 'default-cli-project', name: 'CLI Project', projectResources: {} },
  null,
  2,
) + '\n'

// 教程 §3.2(2)：异步读 stdin + 4s 超时 fail-closed，仅放行 mcp_dsh_ 前缀。
export const GATE_TOOLS_CJS = `#!/usr/bin/env node
let settled = false, buf = "";
const timer = setTimeout(() => finish({ decision: "deny", reason: "Hook timed out waiting for stdin" }), 4000);
if (timer.unref) timer.unref();
function finish(result) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { process.stdout.write(JSON.stringify(result) + "\\n"); } catch {}
  process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buf += chunk; });
process.stdin.on("end", () => {
  try {
    const data = buf.trim() ? JSON.parse(buf) : {};
    const name = data?.toolCall?.name || data?.tool_name || data?.toolName || data?.name || "";
    if (typeof name === "string" && name.startsWith("mcp_dsh_")) finish({ decision: "allow" });
    else finish({ decision: "deny", reason: "Built-in tool disabled by DSH bridge" });
  } catch (err) { finish({ decision: "deny", reason: "Hook parse error: " + (err && err.message) }); }
});
process.stdin.on("error", (err) => finish({ decision: "deny", reason: "Hook stdin error: " + (err && err.message) }));
process.stdin.resume();
`

// 教程 §3.2(2)：顶层必须是具名规则组，写成 { hooks: ... } 会静默失效。
export function buildHooksJson(home) {
  const gate = path.resolve(home, 'config/hooks/gate-tools.cjs').replace(/\\/g, '/')
  return JSON.stringify(
    {
      'gate-tools': {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: `node "${gate}"`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n'
}

// ---- 目录树 ----

export const ISOLATED_DIRS = [
  'config',
  'config/agents',
  'config/hooks',
  'config/plugins',
  'config/plugins/dsh_bridge',
  'config/plugins/dsh_bridge/agents',
  'config/projects',
  'antigravity-cli',
  'antigravity-cli/cache',
  'antigravity-cli/conversations',
  'agy',
  'agy/cache',
  'agy/conversations',
]

// ---- 原子写盘 ----

/**
 * 同目录 tmp + rename 原子替换。失败时清理 tmp，绝不残留半截文件。
 * @returns {string} 实际落盘路径
 */
export function writeFileAtomicSync(file, content) {
  const dir = path.dirname(file)
  const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = path.join(dir, `.${path.basename(file)}.${suffix}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
    return file
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

/** 内容一致就跳过；否则原子写。返回 'written' | 'unchanged'。 */
export function writeIfChangedSync(file, content) {
  try {
    const cur = fs.readFileSync(file, 'utf8')
    if (cur === content) return 'unchanged'
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // 读不动（权限/占位符/被锁）就当作需要重写
    }
  }
  writeFileAtomicSync(file, content)
  return 'written'
}

// ---- 主入口 ----

/**
 * 幂等播种 <AGY_ISOLATED_HOME>。拉起 agy 之前调用。
 * @param {string} home 隔离 home 的绝对路径
 * @param {{dryDir?: boolean}} [opts]
 * @returns {{home: string, createdDirs: string[], written: string[], unchanged: string[]}}
 */
export function ensureIsolatedGeminiDir(home, opts = {}) {
  if (typeof home !== 'string' || !home.trim()) {
    throw new TypeError('ensureIsolatedGeminiDir 需要非空 home 路径')
  }
  const root = path.resolve(home)

  const createdDirs = []
  for (const rel of ISOLATED_DIRS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) createdDirs.push(rel)
    fs.mkdirSync(abs, { recursive: true })
  }

  const hooksJson = buildHooksJson(root)
  const agentMd = DSH_BRIDGE_AGENT_MD

  // 双路径落盘确保 agy 1.5.6 ~ 1.5.9+ 全兼容；双向同步的配置两边同字节。
  const plan = [
    ['config/agents/dsh_bridge.md', agentMd],
    ['config/plugins/dsh_bridge/agents/dsh_bridge.md', agentMd],
    ['config/plugins/dsh_bridge/plugin.json', DSH_BRIDGE_PLUGIN_JSON],
    ['config/hooks.json', hooksJson],
    ['antigravity-cli/hooks.json', hooksJson],
    ['config/hooks/gate-tools.cjs', GATE_TOOLS_CJS],
    ['antigravity-cli/settings.json', SETTINGS_JSON],
    ['agy/settings.json', SETTINGS_JSON],
    ['antigravity-cli/cache/onboarding.json', ONBOARDING_JSON],
    ['agy/cache/onboarding.json', ONBOARDING_JSON],
    ['config/projects/default-cli-project.json', DEFAULT_CLI_PROJECT_JSON],
  ]

  const written = []
  const unchanged = []
  for (const [rel, content] of plan) {
    const status = writeIfChangedSync(path.join(root, rel), content)
    if (status === 'written') written.push(rel)
    else unchanged.push(rel)
  }

  return { home: root, createdDirs, written, unchanged }
}

export default ensureIsolatedGeminiDir
