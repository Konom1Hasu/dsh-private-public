// 工具闸自测：三级 Schema 压缩（1,350B 单工具 / 54,000B 总包）+ 9,600B 回执硬收敛。
// 纯函数级验证，不起 HTTP 服务、不碰账号。
import {
  buildMcpToolBundle,
  buildCompensationSection,
  boundToolResult,
  compactBridgeTool,
  isReadLikeTool,
  wireToolBytes,
  wireToolsBytes,
  MAX_MCP_TOOLS_TOTAL_BYTES,
  MAX_TOOL_RESULT_BYTES,
  TOOL_PRE_COMPACT_BYTES,
  MAX_COMPENSATION_ENTRIES,
  MAX_COMPENSATION_CHARS,
} from './lib/mcp-bridge.mjs'

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`) }
}
const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

// ---- A. 单工具预压：超 1,350B 必须降级 ----
console.log('\n[A] 单工具 1,350B 预压')
{
  // 肥 Schema：15 个属性各带 200 字描述，Stage 0 约 3.7KB
  const properties = {}
  const required = []
  for (let k = 0; k < 15; k++) {
    const key = `field_${k}`
    properties[key] = { type: 'string', description: 'd'.repeat(200) }
    required.push(key)
  }
  const tool = {
    name: 'bloated',
    description: 'x'.repeat(300),
    inputSchema: { type: 'object', properties, required },
  }
  const bundle = buildMcpToolBundle([tool])
  const back = bundle.tools[0]
  check('A1 单工具超 1,350B 被降级', back.demoted === true && back.demoteStage >= 1, `stage=${back.demoteStage} bytes=${wireToolBytes(back)}`)
  check('A2 降级后单工具 <= 1,350B', wireToolBytes(back) <= TOOL_PRE_COMPACT_BYTES, String(wireToolBytes(back)))
  check('A3 原描述留在 fullDescription（供补偿段）', back.fullDescription.length === 300)

  const longDescOnly = {
    name: 'chatty',
    description: 'x'.repeat(3000),
    inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  }
  const chatty = buildMcpToolBundle([longDescOnly]).tools[0]
  check('A3b 超长主描述由 Stage 0 的 1,024 字上限消化，无需降级', chatty.demoteStage === 0 && wireToolBytes(chatty) <= TOOL_PRE_COMPACT_BYTES, `${chatty.demoteStage} / ${wireToolBytes(chatty)}`)

  const readTool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
  const s0 = compactBridgeTool(readTool, 0)
  check('A4 read 类 Stage 0 自动追加分页警示', s0.description.includes('offset/limit'), s0.description.slice(-40))
  const longRead = compactBridgeTool({ ...readTool, description: 'y'.repeat(5000) }, 0)
  check('A5 Stage 0 主描述 <= 1,024 字', longRead.description.length <= 1024, String(longRead.description.length))
  check('A6 Stage 0 截断后仍保住分页警示', longRead.description.includes('offset/limit'))

  const small = { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { s: { type: 'string' } } } }
  const smallBundle = buildMcpToolBundle([small])
  check('A7 小工具不降级', smallBundle.tools[0].demoted === false && smallBundle.tools[0].demoteStage === 0)
  check('A8 无降级时补偿段为空', smallBundle.systemPromptAppend === '')
}

// ---- B. 全包 54,000B 总预算闸 ----
console.log('\n[B] 54,000B 总包闸（20 个胖工具）')
function makeFatTool(i) {
  const properties = {}
  const required = []
  for (let k = 0; k < 40; k++) {
    const key = `p_${String(k).padStart(3, '0')}_${i}`
    properties[key] = {
      type: 'string',
      enum: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
      description: 'desc ' + 'y'.repeat(60),
    }
    required.push(key)
  }
  return {
    name: `fat_${String(i).padStart(2, '0')}`,
    description: 'z'.repeat(1500),
    inputSchema: { type: 'object', properties, required },
  }
}
const fat = Array.from({ length: 20 }, (_, i) => makeFatTool(i))
const fatBundle = buildMcpToolBundle(fat)
{
  check('B0 压缩前确实超 54,000B', wireToolsBytes(fat) > MAX_MCP_TOOLS_TOTAL_BYTES, String(wireToolsBytes(fat)))
  check('B1 压缩后总包 <= 54,000B', fatBundle.totalBytes <= MAX_MCP_TOOLS_TOTAL_BYTES, String(fatBundle.totalBytes))
  check('B2 总包字节按真实 UTF-8 计（与导出一致）', fatBundle.totalBytes === wireToolsBytes(fatBundle.tools), `${fatBundle.totalBytes} vs ${wireToolsBytes(fatBundle.tools)}`)
  check('B3 全包闸推到 Stage 3', fatBundle.tools.some((t) => t.demoteStage === 3))
  check('B4 不是一刀切（仍有工具留在 Stage 2）', fatBundle.tools.some((t) => t.demoteStage === 2 && t.demoted === true))
  check('B5 每个被压工具都留痕', fatBundle.tools.filter((t) => t.demoted).every((t) => t.demoteStage >= 2))
  check('B6 overBudget 标记为 false', fatBundle.overBudget === false)

  // 降级顺序：从大到小 —— 被推到 Stage 3 的工具字节数应 >= 仍留在 Stage 2 的（同构造下等价，只验集合非空）
  const stage3 = fatBundle.tools.filter((t) => t.demoteStage === 3)
  const stage2 = fatBundle.tools.filter((t) => t.demoteStage === 2)
  check('B7 Stage 3 数量少于 Stage 2（按需降级，不浪费）', stage3.length > 0 && stage3.length < stage2.length, `${stage3.length} / ${stage2.length}`)
}

// ---- C. 关键内置工具不被降级 ----
console.log('\n[C] dsh_await_result 免降级')
{
  const keyTool = {
    name: 'dsh_await_result',
    description: 'w'.repeat(3000),
    inputSchema: { type: 'object', properties: { call_id: { type: 'string' } }, required: ['call_id'] },
  }
  const bundle = buildMcpToolBundle([...fat, keyTool])
  const back = bundle.tools.find((t) => t.name === 'dsh_await_result')
  check('C0 混入后总包确实还超限', wireToolsBytes([...fat, keyTool]) > MAX_MCP_TOOLS_TOTAL_BYTES)
  check('C1 dsh_await_result 未被降级', back.demoted === false && back.demoteStage === 0, `stage=${back.demoteStage}`)
  check('C2 免降级工具仍受 Stage 0 描述上限约束', back.description.length <= 1024, String(back.description.length))
  check('C3 免降级工具 required 完整', JSON.stringify(back.inputSchema.required) === '["call_id"]')

  // mcp_dsh_ 前缀形态同样识别
  const prefixed = buildMcpToolBundle([...fat, { ...keyTool, name: 'mcp_dsh_dsh_await_result' }])
  const back2 = prefixed.tools.find((t) => t.name === 'dsh_await_result')
  check('C4 带 mcp_dsh_ 前缀也免降级', back2 && back2.demoteStage === 0)
}

// ---- D. Stage 2 / Stage 3 结构完整性 ----
console.log('\n[D] Stage 2 不删属性名与 required')
{
  const tool = {
    name: 'complex',
    description: 'd'.repeat(600),
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'aa' },
        b: { type: 'number', description: 'bb' },
        nested: { type: 'object', properties: { c: { type: 'string', description: 'cc' } }, required: ['c'] },
      },
      required: ['a', 'nested'],
    },
  }
  const c2 = compactBridgeTool(tool, 2)
  const props = c2.inputSchema.properties || {}
  check('D1 Stage 2 保留全部属性名', ['a', 'b', 'nested'].every((k) => k in props), Object.keys(props).join(','))
  check('D2 Stage 2 子属性描述全删', props.a.description === undefined && props.b.description === undefined)
  check('D3 Stage 2 嵌套属性名与类型仍在', props.nested?.properties?.c?.type === 'string')
  check('D4 Stage 2 嵌套子描述也删', props.nested?.properties?.c?.description === undefined)
  check('D5 Stage 2 顶层 required 原样', JSON.stringify(c2.inputSchema.required) === '["a","nested"]', JSON.stringify(c2.inputSchema.required))
  check('D6 Stage 2 嵌套 required 原样', JSON.stringify(props.nested?.required) === '["c"]')
  check('D7 Stage 2 主描述 <= 140 字', c2.description.length <= 140, String(c2.description.length))
  check('D8 压缩不污染入参', tool.description.length === 600 && tool.inputSchema.properties.a.description === 'aa')

  const s1 = compactBridgeTool({
    name: 'long-child',
    description: 'e'.repeat(600),
    inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'f'.repeat(300) } } },
  }, 1)
  check('D9 Stage 1 主描述 <= 220 字', s1.description.length <= 220)
  check('D10 Stage 1 子属性描述 <= 90 字', s1.inputSchema.properties.a.description.length <= 90)
  check('D11 Stage 1 参数结构完整保留', s1.inputSchema.properties.a.type === 'string')

  const c3 = compactBridgeTool(tool, 3)
  check('D12 Stage 3 只留顶层属性名 + 基础类型', c3.inputSchema.properties.a.type === 'string' && c3.inputSchema.properties.nested.properties === undefined)
  check('D13 Stage 3 required 保留', JSON.stringify(c3.inputSchema.required) === '["a","nested"]')
  check('D14 Stage 3 主描述 <= 48 字', c3.description.length <= 48, String(c3.description.length))
}

// ---- E. 补偿段 ----
console.log('\n[E] buildCompensationSection')
{
  const demoted = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, '0')}`,
    description: '已压缩',
    demoted: true,
    demoteStage: i % 2 === 0 ? 2 : 3,
    fullDescription: `完整说明 ${'F'.repeat(700)}`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  }))
  const section = buildCompensationSection(demoted)
  const bullets = section.split('\n').filter((l) => l.startsWith('- '))
  check('E1 标题行正确', section.split('\n')[0] === '## 被压缩 MCP 工具的完整说明', section.split('\n')[0])
  check('E2 最多 16 条', bullets.length === MAX_COMPENSATION_ENTRIES, String(bullets.length))
  check('E3 总长 <= 6,000 字符', section.length <= MAX_COMPENSATION_CHARS, String(section.length))
  check('E4 按压缩等级倒序（Stage 3 排最前）', bullets[0].includes('tool_01'), bullets[0].slice(0, 30))
  check('E5 带参数摘要', bullets[0].includes('必填 x'), bullets[0].slice(0, 40))
  check('E6 空输入返回空串', buildCompensationSection([]) === '')
  check('E7 无降级工具返回空串', buildCompensationSection([{ name: 'x', description: 'y', demoted: false, demoteStage: 0 }]) === '')
  const short = buildCompensationSection([demoted[0]])
  check('E8 单条时不砍说明（预算足够）', short.includes('完整说明'))
}

// ---- F. 回执硬收敛：非 read 类 70/30 ----
console.log('\n[F] boundToolResult（非 read 类）')
{
  const source = Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')} ${'x'.repeat(12)}`)
  const raw = source.join('\n')
  check('F0 输入确实超 9,600B', bytes(raw) > MAX_TOOL_RESULT_BYTES, String(bytes(raw)))
  const out = boundToolResult('shell', raw)
  const outLines = out.split('\n')
  check('F1 收敛到 <= 9,600 字节', bytes(out) <= MAX_TOOL_RESULT_BYTES, String(bytes(out)))
  check('F2 保留首行', outLines[0] === source[0])
  check('F3 保留末行', outLines[outLines.length - 1] === source[source.length - 1])
  const noticeIdx = outLines.findIndex((l) => l.startsWith('…（已省略'))
  check('F4 中间插入省略说明', noticeIdx > 0 && /已省略 \d+ 字节 \/ \d+ 行/.test(outLines[noticeIdx]), outLines[noticeIdx]?.slice(0, 50))
  const broken = outLines.filter((l, i) => i !== noticeIdx && l !== '' && !source.includes(l))
  check('F5 全部按完整行对齐（无半行）', broken.length === 0, broken[0]?.slice(0, 50))
  const headCount = noticeIdx
  const tailCount = outLines.length - noticeIdx - 1
  const ratio = headCount / (headCount + tailCount)
  check('F6 头 70% / 尾 30%', Math.abs(ratio - 0.7) <= 0.05, `${headCount}/${tailCount}=${ratio.toFixed(3)}`)
  const omittedMatch = /已省略 \d+ 字节 \/ (\d+) 行/.exec(outLines[noticeIdx] || '')
  check('F7 行数守恒（头 + 尾 + 省略 = 总行数）', omittedMatch && Number(omittedMatch[1]) === source.length - headCount - tailCount, `${omittedMatch?.[1]} vs ${source.length - headCount - tailCount}`)

  check('F8 未超限原样返回', boundToolResult('shell', 'ok') === 'ok')
  const oneLine = boundToolResult('shell', 'q'.repeat(30000))
  check('F9 单行超长也收敛且带省略说明', bytes(oneLine) <= MAX_TOOL_RESULT_BYTES && oneLine.includes('已省略'), String(bytes(oneLine)))
  const cjk = boundToolResult('shell', ('中文行内容测试\n').repeat(2000))
  check('F10 中文按字节收敛（不是字符数）', bytes(cjk) <= MAX_TOOL_RESULT_BYTES, String(bytes(cjk)))
}

// ---- G. 回执硬收敛：read 类保头 + 续读提示 ----
console.log('\n[G] boundToolResult（read 类）')
{
  const body = Array.from({ length: 500 }, (_, i) => `${i + 1}: ${'a'.repeat(20)}`)
  const raw = ['<content>', ...body, '</content>'].join('\n')
  const out = boundToolResult('read', raw)
  const outLines = out.split('\n')
  check('G1 收敛到 <= 9,600 字节', bytes(out) <= MAX_TOOL_RESULT_BYTES, String(bytes(out)))
  check('G2 <content> 信封头保留', outLines[0] === '<content>', outLines[0])
  check('G3 闭合标签在提示之前', outLines[outLines.length - 2] === '</content>', outLines[outLines.length - 2])
  const hint = outLines[outLines.length - 1]
  const m = /^显示第 1–(\d+) 行，请用 offset=(\d+) limit=(\d+) 继续分页读取$/.exec(hint)
  check('G4 续读提示格式正确', !!m, hint)
  check('G5 offset 恰好接续', m && Number(m[1]) + 1 === Number(m[2]), `1–${m?.[1]} / offset=${m?.[2]}`)
  check('G6 limit 等于已显示行数', m && Number(m[3]) === Number(m[1]), `limit=${m?.[3]}`)
  const shown = outLines.length - 3
  check('G7 实际显示行数与提示一致', m && Number(m[1]) === shown, `${shown} vs ${m?.[1]}`)
  check('G8 显示的是从头对齐的原始行', outLines[1] === body[0] && outLines[shown] === body[shown - 1], String(outLines[1]))

  check('G9 read 类识别', isReadLikeTool('read') && isReadLikeTool('view') && isReadLikeTool('mcp_dsh_read_file'))
  check('G10 非 read 类不误判', !isReadLikeTool('shell') && !isReadLikeTool('grep') && !isReadLikeTool('dsh_task'))
}

// ---- H. 附加边界（冷审挑出来的那几处）----
console.log('\n[H] 边界')
{
  const emoji = ('🙂行' + 'z'.repeat(20) + '\n').repeat(2000)
  const out = boundToolResult('shell', emoji)
  check('H1 代理对没被切断', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out) && !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out))
  check('H2 emoji 内容也收敛 <= 9,600B', bytes(out) <= MAX_TOOL_RESULT_BYTES, String(bytes(out)))

  const paged = [
    '<content offset="201" limit="50">',
    ...Array.from({ length: 400 }, (_, i) => `${201 + i}: ${'b'.repeat(30)}`),
    '</content>',
  ].join('\n')
  const readOut = boundToolResult('read', paged)
  const lastLine = readOut.split('\n').pop()
  check('H3 信封头带 offset 时续读行号从 201 接续', /^显示第 201–\d+ 行，请用 offset=\d+ limit=\d+ 继续分页读取$/.test(lastLine), lastLine)
  check('H4 续读 offset 与结束行吻合', (() => {
    const m = /显示第 201–(\d+) 行，请用 offset=(\d+)/.exec(lastLine)
    return !!m && Number(m[2]) === Number(m[1]) + 1
  })(), lastLine)

  const once = compactBridgeTool({ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }, 0)
  const twice = compactBridgeTool(once, 0)
  check('H5 read 分页警示幂等（重复压缩不叠两遍）', (twice.description.match(/offset\/limit/g) || []).length === 1, twice.description.slice(-60))

  const weird = {
    name: 'weird',
    description: 'has a function field',
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    helper: () => {},
  }
  let weirdOk = true
  try {
    const wb = buildMcpToolBundle([weird])
    weirdOk = wb.tools.length === 1 && wb.tools[0].name === 'weird'
  } catch {
    weirdOk = false
  }
  check('H6 含函数的工具不会炸整包构建', weirdOk)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
