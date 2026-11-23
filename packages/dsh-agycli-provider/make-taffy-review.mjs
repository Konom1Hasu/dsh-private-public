import fs from 'node:fs'
const src = 'C:/Users/KonomiHasu/.dsh/tools/ds-review.mjs'
const dst = 'C:/Users/KonomiHasu/.dsh/tools/ds-review-taffy.mjs'
let t = fs.readFileSync(src, 'utf8')
const before = t
t = t.replace(
  'const m = line.match(/^\\s*(DEEPSEEK_TAFFY_API_KEY|DEEPSEEK_API_KEY)\\s*:\\s*(.+?)\\s*$/);',
  'const m = line.match(/^\\s*(DEEPSEEK_TAFFY_API_KEY)\\s*:\\s*(.+?)\\s*$/);',
)
t = t.replace('if (m[1] === "DEEPSEEK_API_KEY") break;', 'break;')
if (t === before) throw new Error('没有替换成功，正则没匹配上')
fs.writeFileSync(dst, t, 'utf8') // 无 BOM
console.log('written', dst, fs.statSync(dst).size, 'bytes')
