// DSH 工具定义 → MCP 参数 schema 的归一化自测。
// 真机踩到的坑：DSH 的 defineTool 用 `parameters: { file_path: { type, required: true } }`，
// 桥只认 inputSchema，于是每个工具都被当成「无参数」——模型要么漏 required 报 missing，
// 要么被 additional properties 拒掉。这份用例钉住归一化和 tools/list 的真实输出。
import { McpBridge, toolSchemaOf, buildMcpToolBundle } from './lib/mcp-bridge.mjs'

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`) }
}

// ---- 1. 纯函数：DSH 形状归一化 ----
const dshRead = {
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: {
    file_path: { type: 'string', required: true, description: 'Path to read' },
    offset: { type: 'number', description: 'first line' },
    limit: { type: 'number', description: 'max lines' },
  },
  output: { schema: { type: 'object', properties: { path: { type: 'string' } } } },
}
const norm = toolSchemaOf(dshRead)
check('parameters 被归一化成 type:object', norm.type === 'object', norm.type)
check('file_path 进了 properties', Boolean(norm.properties?.file_path), Object.keys(norm.properties ?? {}))
check('file_path 类型保留', norm.properties?.file_path?.type === 'string', norm.properties?.file_path)
check('required 从属性内提到顶层', JSON.stringify(norm.required) === JSON.stringify(['file_path']), norm.required)
check('属性内 required 已抹掉', norm.properties?.file_path?.required === undefined, norm.properties?.file_path)
check('可选参数没有进 required', !String(norm.required ?? []).includes('offset'), norm.required)
check('描述保留', norm.properties?.file_path?.description === 'Path to read', norm.properties?.file_path?.description)
check('output 不会混进 parameters', norm.properties?.output === undefined, Object.keys(norm.properties ?? {}))

// 标准 inputSchema 原样通过
const std = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
check('标准 inputSchema 原样返回', toolSchemaOf({ inputSchema: std }) === std)

// 缺参兜底
check('完全没参数定义时返回空 object', JSON.stringify(toolSchemaOf({ name: 'x' })) === '{"type":"object","properties":{}}')
check('非对象不入参', toolSchemaOf(null).type === 'object')

// ---- 2. buildMcpToolBundle：压缩闸也要看到真实参数 ----
const bundle = buildMcpToolBundle([dshRead])
const wired = bundle.tools[0]
check('bundle 里 file_path 还在', Boolean(wired.inputSchema.properties?.file_path), Object.keys(wired.inputSchema.properties ?? {}))
check('bundle 里 required 还在', JSON.stringify(wired.inputSchema.required) === JSON.stringify(['file_path']), wired.inputSchema.required)

// Stage 预压后仍要保留属性名
const fatDshTool = {
  name: 'fat',
  description: 'x'.repeat(4000),
  parameters: {
    file_path: { type: 'string', required: true, description: 'd'.repeat(300) },
    deep: { type: 'string', description: 'd'.repeat(300) },
  },
}
const fatBundle = buildMcpToolBundle([fatDshTool])
const fatWired = fatBundle.tools[0]
check('胖工具压过之后 file_path 属性名还在', Boolean(fatWired.inputSchema.properties?.file_path), Object.keys(fatWired.inputSchema.properties ?? {}))
check('胖工具压过之后 required 还在', JSON.stringify(fatWired.inputSchema.required) === JSON.stringify(['file_path']), fatWired.inputSchema.required)

// ---- 3. 真桥：tools/list 实际吐出来的 schema ----
const tools = [dshRead, { name: 'mcp_dsh_echo', description: 'echo', parameters: { s: { type: 'string', required: true } } }]
const bridge = new McpBridge({
  getTools: () => tools,
  callTool: async ({ name, arguments: a }) => ({ content: [{ type: 'text', text: `called ${name}: ${JSON.stringify(a)}` }] }),
  keepaliveMs: 500,
})
await bridge.start()

const rpc = async (method, params) => {
  const res = await fetch(bridge.urlBase + '/mcp/t1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  })
  const text = await res.text()
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse((line ? line.slice(6) : text).trim())
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05' })
check('initialize 正常', init.result?.serverInfo?.name === 'dsh-mcp-bridge', init)

const list = await rpc('tools/list', {})
const listTools = list.result?.tools ?? []
const readDecl = listTools.find((t) => t.name === 'read')
check('tools/list 里有 read', Boolean(readDecl), listTools.map((t) => t.name))
check('read 的 inputSchema.properties 里有 file_path', Boolean(readDecl?.inputSchema?.properties?.file_path), readDecl?.inputSchema)
check('read 的 required 含 file_path', JSON.stringify(readDecl?.inputSchema?.required) === JSON.stringify(['file_path']), readDecl?.inputSchema?.required)
check('read 的 properties 里没有 output/toolSummary 之类噪音',
  Object.keys(readDecl?.inputSchema?.properties ?? {}).sort().join(',') === 'file_path,limit,offset',
  Object.keys(readDecl?.inputSchema?.properties ?? {}))

const echoDecl = listTools.find((t) => t.name === 'echo')
check('带 mcp_dsh_ 前缀的工具报裸名', Boolean(echoDecl), listTools.map((t) => t.name))
check('echo 的 s 参数在', Boolean(echoDecl?.inputSchema?.properties?.s), echoDecl?.inputSchema)
check('await_result 仍挂在末尾', listTools[listTools.length - 1]?.name === 'dsh_await_result', listTools[listTools.length - 1]?.name)

await bridge.stop()

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
