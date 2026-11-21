#!/usr/bin/env node
/**
 * analyze-qq-log.mjs -- 从审计日志里找"为什么会被风控"的证据。
 *
 * 风控看的是行为模式，不是内容对错。所以这里统计的是：
 *   · 主动发起比例（机器人特征最强）
 *   · 发送间隔的规律性（固定间隔 = 机器）
 *   · 重复内容（复读 = 机器）
 *   · 撤回/错字重发（异常行为）
 *   · 超长/超短/空消息（异常格式）
 *
 * 用法：node analyze-qq-log.mjs [日期 yyyy-mm-dd]
 */

import fs from 'node:fs';
import path from 'node:path';

const LOGDIR = 'C:\\Users\\KonomiHasu\\Desktop\\微信QQ接入\\logs';
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const file = path.join(LOGDIR, `${date}.jsonl`);

if (!fs.existsSync(file)) {
  console.log(`没有日志文件: ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const l of lines) {
  try { events.push(JSON.parse(l)); } catch { /* skip */ }
}

const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

console.log(`日期: ${date}  事件总数: ${events.length}`);
console.log('事件类型分布:');
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(18)} ${v}`);
}
console.log('');

const sent = events.filter((e) => e.type === 'sent');
const recv = events.filter((e) => e.type === 'recv');

// ---- 1. 主动 vs 被动 ----
// 收到消息后 N 秒内发出的算"回应"，否则算主动发起
const recvTimes = recv.map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
let proactiveCount = 0;
const proactiveSamples = [];
for (const s of sent) {
  const t = Date.parse(s.ts);
  const replied = recvTimes.some((rt) => rt <= t && t - rt < 120_000);
  if (!replied) {
    proactiveCount++;
    if (proactiveSamples.length < 5) proactiveSamples.push(s);
  }
}
console.log(`发送: ${sent.length}   接收: ${recv.length}`);
console.log(`其中「非回应」消息（疑似主动发起）: ${proactiveCount} 条`);
if (proactiveSamples.length) {
  console.log('  样例:');
  for (const s of proactiveSamples) {
    console.log(`    ${s.ts}  ${String(s.text || '').slice(0, 50)}`);
  }
}
console.log('');

// ---- 2. 时间分布 ----
const hourHist = {};
for (const s of sent) {
  const h = new Date(s.ts).getHours();
  hourHist[h] = (hourHist[h] || 0) + 1;
}
console.log('发送小时分布:');
const hours = Object.keys(hourHist).map(Number).sort((a, b) => a - b);
console.log('  ' + hours.map((h) => `${h}时:${hourHist[h]}`).join('  '));

// 夜间活动是重要风控信号
const night = sent.filter((s) => {
  const h = new Date(s.ts).getHours();
  return h >= 1 && h < 6;
});
console.log(`  凌晨 1-6 点发送: ${night.length} 条 ${night.length ? '<-- 风控高风险时段' : ''}`);
console.log('');

// ---- 3. 重复内容 ----
const textCount = {};
for (const s of sent) {
  const t = String(s.text || '').trim();
  if (t) textCount[t] = (textCount[t] || 0) + 1;
}
const dup = Object.entries(textCount).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log(`重复文本: ${dup.length} 种`);
for (const [t, n] of dup.slice(0, 6)) {
  console.log(`  x${n}  ${t.slice(0, 60)}`);
}
console.log('');

// ---- 4. 长度异常 ----
const lens = sent.map((s) => String(s.text || '').length);
if (lens.length) {
  const avg = (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1);
  const empty = lens.filter((n) => n === 0).length;
  const long = lens.filter((n) => n > 200).length;
  console.log(`消息长度: 平均 ${avg}, 空消息 ${empty} 条, 超长(>200字) ${long} 条`);
  console.log('');
}

// ---- 5. 发送间隔规律性 ----
const times = sent.map((s) => Date.parse(s.ts)).sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < times.length; i++) {
  const g = (times[i] - times[i - 1]) / 1000;
  if (g > 0 && g < 600) gaps.push(g);
}
if (gaps.length > 3) {
  const avgGap = (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1);
  const variance = gaps.reduce((a, g) => a + (g - avgGap) ** 2, 0) / gaps.length;
  const sd = Math.sqrt(variance).toFixed(1);
  console.log(`发送间隔: 平均 ${avgGap}s, 标准差 ${sd}s`);
  console.log(`  ${Number(sd) < 3 ? '<-- 间隔过于规律，机器人特征明显' : '间隔有随机性，正常'}`);
  console.log('');
}

// ---- 6. 异常事件 ----
const abnormal = events.filter((e) =>
  ['send-fail', 'blocked', 'skip', 'recall', 'typo'].includes(e.type)
);
console.log(`异常事件（发送失败/拦截/撤回等）: ${abnormal.length} 条`);
for (const e of abnormal.slice(0, 8)) {
  console.log(`  ${e.ts} ${e.type} ${JSON.stringify(e).slice(0, 120)}`);
}
