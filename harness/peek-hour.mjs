#!/usr/bin/env node
/** 看某个时刻发送的真实内容，判断是不是「AI 长文」特征。 */
import fs from 'node:fs';

const file = 'C:\\Users\\KonomiHasu\\Desktop\\微信QQ接入\\logs\\2026-11-11.jsonl';
const hour = Number(process.argv[2] ?? 17);

const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const sent = ev.filter((e) => e.type === 'sent' && new Date(e.ts).getHours() === hour);
console.log(`${hour} 时发送条数: ${sent.length}`);
console.log('');

const lens = sent.map((e) => String(e.text || '').length);
if (lens.length) {
  console.log(`长度: min=${Math.min(...lens)}  max=${Math.max(...lens)}  avg=${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0)}`);
  const buckets = { '0-20': 0, '21-50': 0, '51-100': 0, '101-200': 0, '200+': 0 };
  for (const n of lens) {
    if (n <= 20) buckets['0-20']++;
    else if (n <= 50) buckets['21-50']++;
    else if (n <= 100) buckets['51-100']++;
    else if (n <= 200) buckets['101-200']++;
    else buckets['200+']++;
  }
  console.log('长度分布: ' + Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join('  '));
  console.log('');
}

for (let i = 0; i < Math.min(8, sent.length); i++) {
  const t = String(sent[i].text || '').replace(/\s+/g, ' ');
  console.log(`[${i + 1}] ${String(t.length).padStart(4)}字  ${t.slice(0, 120)}`);
}
