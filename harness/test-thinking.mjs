#!/usr/bin/env node
/**
 * test-thinking.mjs -- 验证「关思考」是否导致幻觉与思维链丢失。
 *
 * 直接打 OpenAI 兼容端点（不经 ask.mjs），因为 ask.mjs 只回 content，
 * 会把 reasoning_content 整个丢掉，看不到真实形态。
 *
 * 用法：node test-thinking.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const confFile = path.join(os.homedir(), '.dsh', 'secrets', 'gemini-relay.json');
const conf = JSON.parse(fs.readFileSync(confFile, 'utf8'));
const base = (conf.base || '').replace(/\/+$/, '');
const key = conf.key || '';
const model = conf.model || 'gemini-3.8-flash-high';

const CASES = [
  {
    id: 'FACT',
    // 可验证的真实事实
    prompt: '2024年诺贝尔文学奖得主是谁？代表作是哪一部？只答两行，第一行人名，第二行书名。不确定就写「不确定」。',
    expect: ['韩江', '素食者'],
  },
  {
    id: 'FAKE',
    // 虚构书名，正确反应是拒绝编造
    prompt: '介绍一下《回声的几何》这本书：作者、出版年份、主要内容。若查无此书请直接说「查无此书」。',
    expect: ['查无此书', '不存在', '无法确认', '没有找到'],
  },
  {
    id: 'MATH',
    // 需要多步推理
    prompt: '一个数的3倍加7等于37，这个数是多少？只输出数字。',
    expect: ['10'],
  },
];

const CONFIGS = [
  { name: 'effort=none (当前主力)', reasoning_effort: 'none' },
  { name: 'effort=high + think512', reasoning_effort: 'high', thinking_budget: 512, thinking: { type: 'enabled', budget_tokens: 512 } },
  { name: 'effort=high + think2048', reasoning_effort: 'high', thinking_budget: 2048, thinking: { type: 'enabled', budget_tokens: 2048 } },
];

async function ask(prompt, cfg) {
  const body = {
    model,
    max_tokens: 800,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    reasoning_effort: cfg.reasoning_effort,
  };
  if (cfg.thinking) {
    body.thinking = cfg.thinking;
    body.thinking_budget = cfg.thinking_budget;
  }

  const t0 = Date.now();
  let res, raw;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    raw = await res.text();
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }

  const ms = Date.now() - t0;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: `non-json: ${raw.slice(0, 120)}`, ms };
  }
  if (!Array.isArray(j.choices) || j.choices.length === 0) {
    return { ok: false, error: `empty choices: ${raw.slice(0, 160)}`, ms };
  }
  const msg = j.choices[0].message || {};
  return {
    ok: true,
    ms,
    content: msg.content ?? '',
    reasoning: msg.reasoning_content ?? msg.reasoning ?? '',
    hasReasoningField: Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'),
    completionTokens: j.usage?.completion_tokens ?? 0,
  };
}

console.log(`endpoint: ${base}`);
console.log(`model:    ${model}`);
console.log('');

for (const cfg of CONFIGS) {
  console.log(`===== ${cfg.name} =====`);
  for (const c of CASES) {
    const r = await ask(c.prompt, cfg);
    if (!r.ok) {
      console.log(`  ${c.id.padEnd(5)} FAIL  ${r.error}`);
      continue;
    }
    const text = r.content.replace(/\s+/g, ' ').trim();
    const hit = c.expect.some((e) => text.includes(e));
    const tag = hit ? 'PASS' : 'HALLUCINATE?';
    console.log(
      `  ${c.id.padEnd(5)} ${tag.padEnd(13)} ${String(r.ms).padStart(5)}ms  ` +
      `正文${String(r.content.length).padStart(4)}字 思考${String(r.reasoning.length).padStart(4)}字 ` +
      `reasoning字段=${r.hasReasoningField}  ${text.slice(0, 90)}`,
    );
  }
  console.log('');
}
