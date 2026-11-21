import fs from 'node:fs'
import path from 'node:path'

/**
 * Outbound formatter for QQ:
 * - Preserves structured work reports intact (never truncates long analysis;
 *   exports very long reports or large code blocks to a .md file for upload).
 * - Cleans markdown tables only at line edges (never touches `|` inside code/regex).
 * - Splits short casual chat replies into 1-3 natural bubbles with humanized pacing.
 */

export function sanitizeForQQ(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''

  // Strip stray HTML comments (e.g. internal anchors if ever leaked)
  text = text.replace(/<!--[\s\S]*?-->/g, '').trim()

  // Convert markdown links [label](<path>) or [label](url) cleanly: keep label for local file paths
  text = text.replace(/\[([^\]]+)\]\(<[^>]+>\)/g, '$1')

  // Only clean markdown table separator rows (|---|---|), leave inline pipes in code untouched
  const lines = text.split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) {
      continue
    }
    if (!inFence && /^\s*\|.+\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      out.push(cells.join(' · '))
      continue
    }
    out.push(line)
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function isStructuredReport(text) {
  if (!text) return false
  if (text.includes('```')) return true
  if (/^#{1,3}\s+/m.test(text)) return true
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length >= 6) return true
  if (text.length >= 260) return true
  return false
}

/**
 * Plan outbound delivery items:
 * - Very long text (> fileThreshold, default 1800 chars) -> short preview + .md file upload
 * - Structured report -> chunked cleanly without truncation (<= chunkLimit per message)
 * - Short casual chat -> 1 to maxBubbles (default 3) natural bubbles
 */
export function planOutbound(rawText, opts = {}) {
  const {
    maxBubbles = 3,
    chunkLimit = 1400,
    fileThreshold = 2200,
    outboxDir = '',
  } = opts

  const text = sanitizeForQQ(rawText)
  if (!text) return []

  // Very long report or big code output -> send concise summary + .md attachment
  if (outboxDir && text.length > fileThreshold) {
    try {
      fs.mkdirSync(outboxDir, { recursive: true })
      const filePath = path.join(outboxDir, `reply-${Date.now()}.md`)
      fs.writeFileSync(filePath, rawText, 'utf8')
      const preview = text.slice(0, 320).trim() + '\n……（完整内容太长啦，已打包成文件发给你）'
      return [
        { kind: 'text', text: preview, delayMs: 0 },
        { kind: 'file', filePath, name: path.basename(filePath), delayMs: 600 },
      ]
    } catch {
      // fall through to chunked text
    }
  }

  // Structured report: keep intact, split only at paragraph boundaries if exceeding chunkLimit
  if (isStructuredReport(text)) {
    const chunks = splitLongText(text, chunkLimit)
    return chunks.map((chunk, idx) => ({
      kind: 'text',
      text: chunk,
      delayMs: idx === 0 ? 0 : 900,
    }))
  }

  // Casual chat: split by blank lines or single newlines into up to maxBubbles bubbles
  const rawParts = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (rawParts.length <= 1 || maxBubbles <= 1) {
    return [{ kind: 'text', text, delayMs: 0 }]
  }

  // Merge excess parts into the last bubble so nothing is ever dropped
  const bubbles = []
  for (let i = 0; i < rawParts.length; i++) {
    if (bubbles.length < maxBubbles) {
      bubbles.push(rawParts[i])
    } else {
      bubbles[bubbles.length - 1] += '\n' + rawParts[i]
    }
  }

  return bubbles.map((b, idx) => ({
    kind: 'text',
    text: b,
    delayMs: idx === 0 ? 0 : Math.min(1800, Math.max(600, b.length * 35)),
  }))
}

export function splitLongText(text, limit = 1400) {
  if (text.length <= limit) return [text]
  const chunks = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.4) cut = remaining.lastIndexOf('\n', limit)
    if (cut < limit * 0.4) cut = limit
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/**
 * Check if current local time falls in nighttime quiet window (default 00:30 - 08:30).
 * Only applies to proactive/background pushes, NEVER to direct replies when user is chatting.
 */
export function isQuietWindow(now = new Date(), startMin = 30, endMin = 8 * 60 + 30) {
  const mins = now.getHours() * 60 + now.getMinutes()
  if (startMin <= endMin) {
    return mins >= startMin && mins < endMin
  }
  return mins >= startMin || mins < endMin
}

export function nextMorningTimestamp(now = new Date(), endMin = 8 * 60 + 30) {
  const d = new Date(now)
  const targetH = Math.floor(endMin / 60)
  const targetM = endMin % 60
  d.setHours(targetH, targetM, 0, 0)
  if (d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}
