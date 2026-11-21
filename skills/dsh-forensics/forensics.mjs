#!/usr/bin/env node
/**
 * forensics.mjs -- dsh 自身取证。
 *
 * 三条命令：
 *   sessions  解压并检索会话记录（多 frame zstd 是这里的核心难点）
 *   logs      扫 dsh 日志找错误
 *   dumpdiff  对比两份 --dump-config
 *   health    给定 profile 的配置健康快照
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const HOME = os.homedir();
const DSH = path.join(HOME, '.dsh');

/** 多 frame zstd：node 的解码器只处理第一个 frame，必须按 magic 切开。 */
function unzstdAll(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let cur = 0;
  for (;;) {
    const p = buf.indexOf(MAGIC, cur);
    if (p < 0) break;
    starts.push(p);
    cur = p + 4;
  }
  if (starts.length === 0) throw new Error('no zstd frame magic');
  const parts = [];
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i];
    const b = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(a, b))); } catch { /* 截断尾部 */ }
  }
  if (!parts.length) throw new Error('no frame decoded');
  return Buffer.concat(parts).toString('utf8');
}

function walk(dir, out = []) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.zstd')) out.push(p);
  }
  return out;
}

const argv = process.argv.slice(2);
const cmd = argv[0] || '';
const opt = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}

function cmdSessions() {
  const root = path.join(DSH, 'sessions');
  const all = walk(root).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const files = opt.workspace
    ? all.filter((f) => f.includes(opt.workspace.replace(/[:\\/]/g, '-')))
    : all;
  const max = Number(opt.max || 5);
  const kw = opt.keyword ? new RegExp(opt.keyword, 'i') : null;

  console.log(`sessions root: ${root}`);
  console.log(`files: ${files.length}, scanning newest ${Math.min(max, files.length)}`);
  if (kw) console.log(`keyword: ${opt.keyword}`);
  console.log('');

  let hits = 0;
  for (const f of files.slice(0, max)) {
    let text;
    try { text = unzstdAll(fs.readFileSync(f)); } catch (e) { console.log(`[skip] ${path.basename(f)}: ${e.message}`); continue; }
    const lines = text.split('\n').filter(Boolean);
    if (!kw) {
      console.log(`=== ${path.basename(path.dirname(f))} (${lines.length} lines) ===`);
      console.log('  ' + (lines[0] || '').slice(0, 200));
      continue;
    }
    const matched = lines.filter((l) => kw.test(l));
    if (!matched.length) continue;
    hits += matched.length;
    console.log(`=== ${path.basename(path.dirname(f))} — ${matched.length} hits ===`);
    for (const l of matched.slice(0, 3)) console.log('  ' + l.slice(0, 220).replace(/\\n/g, ' '));
    console.log('');
  }
  if (kw) console.log(`total hits: ${hits}`);
}

function cmdLogs() {
  const dir = path.join(DSH, 'logs');
  if (!fs.existsSync(dir)) { console.log('no logs dir'); return; }
  const pat = opt.pattern ? new RegExp(opt.pattern, 'i') : /error|fail|exception/i;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.log')).map((n) => path.join(dir, n));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  console.log(`logs: ${files.length} files, pattern: ${pat}`);
  let n = 0;
  for (const f of files.slice(0, Number(opt.max || 6))) {
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split('\n').filter((l) => pat.test(l));
    if (!lines.length) continue;
    console.log(`\n=== ${path.basename(f)} — ${lines.length} ===`);
    for (const l of lines.slice(0, 5)) { console.log('  ' + l.slice(0, 240)); n++; }
  }
  if (!n) console.log('no match');
}

function readPairs(file) {
  const out = new Map();
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split('\n');
  let id = null;
  const dump = [];
  for (const l of lines) {
    const m = l.match(/^-\s+id:\s*(\S+)/);
    if (m) id = m[1];
    if (id && /^\s+\S/.test(l)) dump.push([id, l.trim()]);
  }
  for (const [k, v] of dump) {
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(v);
  }
  return out;
}

function cmdDumpDiff() {
  const [a, b] = argv.slice(1).filter((x) => !x.startsWith('--'));
  if (!a || !b) { console.log('usage: dumpdiff <before.yml> <after.yml>'); return; }
  const A = readPairs(a), B = readPairs(b);
  let diff = 0;
  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const sa = (A.get(k) || []).join('|');
    const sb = (B.get(k) || []).join('|');
    if (sa !== sb) {
      diff++;
      console.log(`### ${k}`);
      if (!A.has(k)) console.log('  + only in after');
      else if (!B.has(k)) console.log('  - only in before');
      else {
        const la = A.get(k), lb = B.get(k);
        for (let i = 0; i < Math.max(la.length, lb.length); i++) {
          if (la[i] !== lb[i]) { console.log(`  before: ${String(la[i]).slice(0, 110)}`); console.log(`  after : ${String(lb[i]).slice(0, 110)}`); }
        }
      }
      console.log('');
    }
  }
  console.log(`changed blocks: ${diff}`);
}

function cmdHealth() {
  const profile = opt.profile || 'web';
  const dir = path.join(DSH, 'profiles', profile);
  console.log(`profile: ${profile}`);
  console.log(`dir    : ${dir}  exists=${fs.existsSync(dir)}`);
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const bundles = j.dsh?.profile?.bundles || [];
      console.log(`bundles: ${bundles.length} -> ${bundles.join(', ')}`);
      const deps = Object.keys(j.dependencies || {});
      console.log(`deps   : ${deps.length} -> ${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ' …' : ''}`);
    } catch (e) { console.log(`package.json 解析失败: ${e.message}  <-- 常见原因：文件带 BOM`); }
  } else console.log('package.json 缺失');
  const patch = path.join(dir, 'cordis.patch.yml');
  console.log(`patch  : exists=${fs.existsSync(patch)} ${fs.existsSync(patch) ? fs.statSync(patch).size + ' bytes' : ''}`);
  const homePatch = path.join(DSH, 'cordis.patch.yml');
  console.log(`home   : exists=${fs.existsSync(homePatch)}  <-- 存在则覆盖所有 profile`);
}

switch (cmd) {
  case 'sessions': cmdSessions(); break;
  case 'logs': cmdLogs(); break;
  case 'dumpdiff': cmdDumpDiff(); break;
  case 'health': cmdHealth(); break;
  default:
    console.log('usage: node forensics.mjs <sessions|logs|dumpdiff|health> [options]');
    console.log('  sessions --keyword X --max 5 --workspace C:\\\\path');
    console.log('  logs --pattern "regex" --max 6');
    console.log('  dumpdiff before.yml after.yml');
    console.log('  health --profile web');
}
