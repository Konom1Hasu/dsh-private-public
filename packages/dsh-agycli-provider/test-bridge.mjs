// McpBridge 自测：不依赖账号，纯协议层验证。
import { McpBridge } from './lib/mcp-bridge.mjs'

const tools = [
  {
    name: 'read',
    description: 'Read a file',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      $defs: {
        Limit: { type: 'integer', minimum: 1 },
      },
      properties: {
        path: { type: 'string', description: 'file path' },
        limit: { $ref: '#/$defs/Limit' },
        mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        opts: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
            { type: 'null' },
          ],
        },
      },
      required: ['path'],
    },
  },
  { name: 'mcp_dsh_echo', description: 'echo back', inputSchema: { type: 'object', properties: { s: { type: 'string' } } } },
]

const bridge = new McpBridge({
  getTools: () => tools,
  callTool: async ({ name, arguments: a }) => ({ content: [{ type: 'text', text: `called ${name}: ${JSON.stringify(a)}` }] }),
  keepaliveMs: 500,
})

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`) }
}

await bridge.start()
const base = bridge.urlBase
const tenant = 'tenant-a'
const url = `${base}/${tenant}`
const H = { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` }

async function rpc(method, params) {
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

console.log(`\n[bridge] ${url}\n`)

// 1 initialize
{
  const { status, json } = await rpc('initialize', { protocolVersion: '2024-11-05' })
  check('initialize 200', status === 200)
  check('protocolVersion 回显', json?.result?.protocolVersion === '2024-11-05')
  check('capabilities.tools 存在', !!json?.result?.capabilities?.tools)
  check('serverInfo 名称', json?.result?.serverInfo?.name === 'dsh-mcp-bridge')
}

// 2 tools/list
{
  const { json } = await rpc('tools/list', {})
  const list = json?.result?.tools ?? []
  // 租户自己的 2 个 + C4 内置接力工具（永久挂在末尾）
  check('tools/list 返回 2 + 内置 1 个', list.length === 3, `实际 ${list.length}`)
  check('裸名：read 无前缀', list.some((t) => t.name === 'read'))
  check('裸名：入站 mcp_dsh_ 前缀被剥', list.some((t) => t.name === 'echo'), JSON.stringify(list.map((t) => t.name)))
  check('内置 dsh_await_result 在末尾', list[list.length - 1]?.name === 'dsh_await_result', JSON.stringify(list.map((t) => t.name)))
  check('内置工具声明 call_id', list[list.length - 1]?.inputSchema?.required?.[0] === 'call_id')

  const read = list.find((t) => t.name === 'read')
  const sch = read?.inputSchema ?? {}
  check('剥掉 $schema', !('$schema' in sch))
  check('剥掉 $defs', !('$defs' in sch))
  check('$ref 已解引用为 integer', sch?.properties?.limit?.type === 'integer', JSON.stringify(sch?.properties?.limit))
  check('anyOf[null] 折叠为 nullable', sch?.properties?.mode?.nullable === true && sch?.properties?.mode?.type === 'string', JSON.stringify(sch?.properties?.mode))
  const opts = sch?.properties?.opts ?? {}
  check('多对象分支合并 properties', !!(opts.properties?.a && opts.properties?.b), JSON.stringify(opts))
  check('required 取交集（空交集不输出）', opts.required === undefined, JSON.stringify(opts.required))
  check('保留顶层 required', JSON.stringify(sch?.required) === '["path"]', JSON.stringify(sch?.required))
}

// 3 ping / 空列表
{
  const p = await rpc('ping', {})
  check('ping 返回 {}', p.status === 200 && JSON.stringify(p.json?.result) === '{}')
  const r1 = await rpc('resources/list', {})
  check('resources/list 空数组', Array.isArray(r1.json?.result?.resources) && r1.json.result.resources.length === 0)
  const r2 = await rpc('resources/templates/list', {})
  check('resources/templates/list 空数组', Array.isArray(r2.json?.result?.resourceTemplates))
  const r3 = await rpc('prompts/list', {})
  check('prompts/list 空数组', Array.isArray(r3.json?.result?.prompts))
}

// 4 未知方法
{
  const r = await rpc('no/such', {})
  check('未知方法回 -32601', r.json?.error?.code === -32601, JSON.stringify(r.json?.error))
}

// 5 通知（无 id）→ 202
{
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  check('通知返回 202', r.status === 202, String(r.status))
}

// 6 tools/call SSE
{
  const r = await fetch(url, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'mcp_dsh_echo', arguments: { s: 'hi' } } }),
  })
  check('tools/call content-type 是 SSE', (r.headers.get('content-type') || '').includes('text/event-stream'), r.headers.get('content-type'))
  const text = await r.text()
  check('SSE 首帧顶出', text.startsWith(':\n\n') || text.includes(':\n\n'))
  check('SSE 携带结果', text.includes('called echo') && text.includes('"id":7'), text.slice(0, 200))
}

// 7 路由与鉴权
{
  const bad = await fetch(`${base}/${tenant}`, { method: 'POST', headers: { ...H, authorization: 'Bearer wrong' }, body: '{}' })
  check('错误 Bearer 返回 401', bad.status === 401, String(bad.status))
  const badPath = await fetch(`http://127.0.0.1:${bridge.port}/nope`, { method: 'POST', headers: H, body: '{}' })
  check('错误路径返回 404', badPath.status === 404, String(badPath.status))
}

// 8 工具业务异常仍回 200 + isError
{
  const b2 = new McpBridge({ getTools: () => tools, callTool: async () => { throw new Error('boom') } })
  await b2.start()
  const r = await fetch(`${b2.urlBase}/t`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${b2.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'read', arguments: {} } }),
  })
  const t = await r.text()
  check('工具异常回 200', r.status === 200)
  check('工具异常带 isError', t.includes('"isError":true'))
  check('工具异常文案', t.includes('工具执行失败'))
  await b2.stop()
}

await bridge.stop()

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
