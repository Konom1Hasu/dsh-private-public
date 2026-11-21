#!/usr/bin/env node
/**
 * scan-sessions.mjs -- grep dsh session archives without touching dsh.
 *
 * Session files are `session.v4.jsonl.zstd` (one per session dir). This reads
 * them with node's built-in zstd, filters lines by regex, and prints matches
 * with a small context window. Nothing is written to disk.
 *
 * Usage:
 *   node scan-sessions.mjs --pattern "qq|onebot|napcat"
 *   node scan-sessions.mjs --pattern "qq" --root "C:\\Users\\X\\.dsh\\sessions\\--C-Users-KonomiHasu--"
 *   node scan-sessions.mjs --pattern "qq" --maxFiles 5 --wide
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

const args = (() => {
  const a = process.argv.slice(2);
  const o = {
    pattern: '',
    root: 'C:\\Users\\KonomiHasu\\.dsh\\sessions\\--C-Users-KonomiHasu--',
    maxFiles: 0,
    perFile: 6,
    width: 220,
    wide: false,
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--pattern') o.pattern = a[++i];
    else if (a[i] === '--root') o.root = a[++i];
    else if (a[i] === '--maxFiles') o.maxFiles = Number(a[++i]);
    else if (a[i] === '--perFile') o.perFile = Number(a[++i]);
    else if (a[i] === '--wide') o.wide = true;
  }
  if (o.wide) o.width = 900;
  return o;
})();

if (!args.pattern) {
  console.error('need --pattern <regex>');
  process.exit(2);
}

const re = new RegExp(args.pattern, 'i');

/**
 * dsh writes `session.v4.jsonl.zstd` as a CONCATENATION of independent zstd
 * frames (one per append). Both zstdDecompressSync and the stream decoder stop
 * after the first frame, so a naive read returns only the ~200-byte session
 * header and every keyword search comes back empty. Split on the frame magic
 * and decode each piece separately.
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function zstdDecompressFrames(raw) {
  const starts = [];
  let cursor = 0;
  for (;;) {
    const p = raw.indexOf(ZSTD_MAGIC, cursor);
    if (p < 0) break;
    starts.push(p);
    cursor = p + 4;
  }
  if (starts.length === 0) throw new Error('no zstd frame magic found');

  const parts = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : raw.length;
    const frame = raw.subarray(begin, end);
    try {
      parts.push(zstdDecompressSync(frame));
    } catch {
      // A truncated tail or a magic that appeared inside compressed data.
      // Skipping is correct: the surrounding frames still decode.
    }
  }
  if (parts.length === 0) throw new Error('no frame decoded');
  return Buffer.concat(parts).toString('utf8');
}

/** Collect session.v4.jsonl.zstd under root, newest first. */
function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith('.zstd')) {
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {}
      out.push({ path: p, mtime, size: statSync(p).size });
    }
  }
  return out;
}

const files = collect(args.root).sort((a, b) => b.mtime - a.mtime);
const picked = args.maxFiles > 0 ? files.slice(0, args.maxFiles) : files;

console.log(`root: ${args.root}`);
console.log(`files: ${files.length} (scanning ${picked.length})`);
console.log(`pattern: ${args.pattern}`);
console.log('');

let totalHits = 0;

for (const f of picked) {
  let text;
  try {
    const raw = readFileSync(f.path);
    text = zstdDecompressFrames(raw);
  } catch (e) {
    console.log(`[skip] ${f.path}: ${e.message}`);
    continue;
  }

  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push(i);
  }
  if (hits.length === 0) continue;

  const rel = f.path.replace(args.root, '');
  console.log(`=== ${rel}  (${(f.size / 1024).toFixed(1)} KB, ${lines.length} lines, ${hits.length} hits) ===`);
  totalHits += hits.length;

  for (const idx of hits.slice(0, args.perFile)) {
    const line = lines[idx];
    // Show a window around the match so the surrounding JSON keys stay readable.
    const m = line.search(re);
    const start = Math.max(0, m - Math.floor(args.width / 4));
    const snippet = line.slice(start, start + args.width).replace(/\\n/g, ' ');
    console.log(`  L${idx}: ...${snippet}...`);
  }
  if (hits.length > args.perFile) console.log(`  ... ${hits.length - args.perFile} more in this file`);
  console.log('');
}

console.log(`total hits: ${totalHits}`);
