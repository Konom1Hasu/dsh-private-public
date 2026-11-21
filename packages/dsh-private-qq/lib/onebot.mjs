import fs from 'node:fs'
import path from 'node:path'

/**
 * OneBot v11 WebSocket client adapted from Desktop/微信QQ接入/adapters/qq-onebot.mjs.
 * - Connects to NapCat WS server (default ws://127.0.0.1:3001) with optional accessToken
 * - Auto-reconnect with exponential backoff (3s -> 30s)
 * - Parses text, image, file, record, at, reply segments
 * - Downloads images/files locally (<= maxDownloadBytes) for Gemini read_image / file inspection
 * - Resolves reply segment via get_msg and preserves replyMsgId for task_id correlation
 */
export class OneBotClient {
  constructor(opts = {}) {
    this.wsUrl = opts.wsUrl || 'ws://127.0.0.1:3001'
    this.accessToken = opts.accessToken || ''
    this.downloadsDir = opts.downloadsDir
    this.maxDownloadBytes = Number(opts.maxDownloadBytes || 12 * 1024 * 1024)
    this.onMessage = opts.onMessage || (() => {})
    this.onStateChange = opts.onStateChange || (() => {})
    this.logger = opts.logger || console

    this.ws = null
    this.stopped = false
    this.reconnectTimer = null
    this.backoffMs = 3000
    this.pending = new Map()
    this.connected = false
    this.selfId = ''
  }

  start() {
    this.stopped = false
    this._connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('OneBot client stopped'))
    }
    this.pending.clear()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this._setConnected(false)
  }

  _setConnected(val) {
    if (this.connected !== val) {
      this.connected = val
      try {
        this.onStateChange(val)
      } catch {
        // ignore
      }
    }
  }

  _connect() {
    if (this.stopped) return
    const WS = globalThis.WebSocket
    if (!WS) {
      this.logger.warn?.('[private-qq] globalThis.WebSocket unavailable (requires Node 22+)')
      return
    }

    let url = this.wsUrl
    if (this.accessToken) {
      const sep = url.includes('?') ? '&' : '?'
      url = `${url}${sep}access_token=${encodeURIComponent(this.accessToken)}`
    }

    let ws
    try {
      ws = new WS(url)
    } catch (err) {
      this.logger.warn?.('[private-qq] WebSocket init error:', err?.message || err)
      this._scheduleReconnect()
      return
    }

    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.backoffMs = 3000
      this._setConnected(true)
      this.logger.info?.('[private-qq] OneBot connected:', this.wsUrl)
    })

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this._setConnected(false)
      if (!this.stopped) this._scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // close event handles reconnect
    })

    ws.addEventListener('message', (ev) => {
      this._handleRawMessage(ev.data).catch((err) => {
        this.logger.warn?.('[private-qq] inbound parse error:', err?.message || err)
      })
    })
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(30_000, Math.round(this.backoffMs * 1.5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect()
    }, delay)
  }

  call(action, params = {}, timeoutMs = 25_000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        return reject(new Error('OneBot WS not connected'))
      }
      const echo = `qq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo)
          reject(new Error(`OneBot timeout: ${action}`))
        }
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  async sendPrivateText(userId, text, replyToId = null) {
    const message = []
    if (replyToId) message.push({ type: 'reply', data: { id: String(replyToId) } })
    message.push({ type: 'text', data: { text: String(text) } })
    return this.call('send_private_msg', { user_id: Number(userId), message })
  }

  async sendGroupText(groupId, text, replyToId = null) {
    const message = []
    if (replyToId) message.push({ type: 'reply', data: { id: String(replyToId) } })
    message.push({ type: 'text', data: { text: String(text) } })
    return this.call('send_group_msg', { group_id: Number(groupId), message })
  }

  async sendImage(chatType, chatId, filePath) {
    const seg = [{ type: 'image', data: { file: 'file:///' + String(filePath).replace(/\\/g, '/') } }]
    if (chatType === 'group') {
      return this.call('send_group_msg', { group_id: Number(chatId), message: seg })
    }
    return this.call('send_private_msg', { user_id: Number(chatId), message: seg })
  }

  async sendFile(chatType, chatId, filePath, name) {
    const fileName = name || path.basename(filePath)
    if (chatType === 'group') {
      return this.call('upload_group_file', { group_id: Number(chatId), file: filePath, name: fileName })
    }
    return this.call('upload_private_file', { user_id: Number(chatId), file: filePath, name: fileName })
  }

  async _handleRawMessage(raw) {
    let p
    try {
      const str = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      p = JSON.parse(str)
    } catch {
      return
    }

    if (p.echo && this.pending.has(p.echo)) {
      const entry = this.pending.get(p.echo)
      this.pending.delete(p.echo)
      clearTimeout(entry.timer)
      if (p.status === 'ok' || p.retcode === 0) entry.resolve(p.data)
      else entry.reject(new Error(p.wording || p.message || `OneBot error ${p.retcode}`))
      return
    }

    if (p.self_id) this.selfId = String(p.self_id)
    if (p.post_type !== 'message') return

    const segs = Array.isArray(p.message) ? p.message : []
    const isGroup = p.message_type === 'group'
    const selfId = String(p.self_id || this.selfId || '')

    let text = segs
      .filter((s) => s.type === 'text')
      .map((s) => s.data?.text || '')
      .join('')
      .trim()

    const atMe = segs.some((s) => s.type === 'at' && String(s.data?.qq) === selfId)
    const replySeg = segs.find((s) => s.type === 'reply')
    const replyMsgId = replySeg?.data?.id ? String(replySeg.data.id) : null
    let replySummary = ''

    if (replyMsgId) {
      try {
        const orig = await this.call('get_msg', { message_id: Number(replyMsgId) || replyMsgId }, 6000)
        const origSegs = Array.isArray(orig?.message) ? orig.message : []
        const origText = origSegs
          .filter((s) => s.type === 'text')
          .map((s) => s.data?.text || '')
          .join('')
          .trim()
        const who = orig?.sender?.card || orig?.sender?.nickname || ''
        if (origText) {
          replySummary = `${who ? who + ': ' : ''}${origText.slice(0, 260)}`
        } else {
          const mediaSeg = origSegs.find((s) => ['image', 'file', 'record'].includes(s.type))
          if (mediaSeg) {
            replySummary = `[${mediaSeg.type === 'image' ? '图片' : '文件/语音'}]`
          }
        }
      } catch {
        // get_msg may fail for older/recalled messages; keep replyMsgId for local msg_links lookup
      }
    }

    const attachments = await this._collectAttachments(segs)
    const hasMedia = attachments.length > 0 || segs.some((s) => ['image', 'file', 'record'].includes(s.type))

    if (!text && !hasMedia && !replyMsgId) return

    this.onMessage({
      channel: 'qq',
      selfId,
      chatId: isGroup ? String(p.group_id) : String(p.user_id),
      chatType: isGroup ? 'group' : 'private',
      senderId: String(p.user_id),
      senderName: p.sender?.card || p.sender?.nickname || String(p.user_id),
      text,
      addressed: !isGroup || atMe || Boolean(replyMsgId),
      ts: (p.time || Math.floor(Date.now() / 1000)) * 1000,
      rawId: String(p.message_id || ''),
      replyMsgId,
      replySummary,
      attachments,
      hasMedia,
    })
  }

  async _collectAttachments(segs) {
    const out = []
    if (!this.downloadsDir) return out
    fs.mkdirSync(this.downloadsDir, { recursive: true })

    for (const seg of segs) {
      const t = seg.type
      const d = seg.data || {}
      try {
        if (t === 'image') {
          const url = d.url || d.file
          if (!url) continue
          const ext = path.extname(String(d.file || '')).slice(0, 8) || '.png'
          const name = safeFileName(d.file || `img_${Date.now()}${ext}`, `img${ext}`)
          const dest = path.join(this.downloadsDir, `${Date.now()}_${name}`)
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            const saved = await this._fetchToFile(url, dest)
            out.push({ kind: 'image', name, ...saved })
          } else if (d.path && fs.existsSync(d.path)) {
            out.push({ kind: 'image', name, path: d.path, bytes: fs.statSync(d.path).size })
          } else {
            out.push({ kind: 'image', name })
          }
        } else if (t === 'file') {
          const url = d.url || d.file
          const name = safeFileName(d.name || d.file, 'file.bin')
          const dest = path.join(this.downloadsDir, `${Date.now()}_${name}`)
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            const saved = await this._fetchToFile(url, dest)
            out.push({ kind: 'file', name, size: d.size, ...saved })
          } else if (d.path && fs.existsSync(d.path)) {
            out.push({ kind: 'file', name, path: d.path, bytes: fs.statSync(d.path).size })
          } else {
            out.push({ kind: 'file', name, size: d.size })
          }
        } else if (t === 'record') {
          out.push({ kind: 'voice', name: safeFileName(d.file, 'voice.amr'), path: d.path || d.file || '' })
        }
      } catch (err) {
        out.push({ kind: t, error: String(err?.message || err).slice(0, 120) })
      }
    }
    return out
  }

  async _fetchToFile(url, dest) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let wsStream = null
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const clHeader = res.headers.get('content-length')
      if (clHeader && Number(clHeader) > this.maxDownloadBytes) {
        controller.abort()
        throw new Error(`file too large (${clHeader} bytes)`)
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > this.maxDownloadBytes) {
          throw new Error(`file too large (${buf.length} bytes)`)
        }
        fs.writeFileSync(dest, buf)
        return { path: dest, bytes: buf.length }
      }

      wsStream = fs.createWriteStream(dest)
      const reader = res.body.getReader()
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > this.maxDownloadBytes) {
          controller.abort()
          throw new Error(`file too large (>${this.maxDownloadBytes} bytes)`)
        }
        if (!wsStream.write(value)) {
          await new Promise((resolve, reject) => {
            wsStream.once('drain', resolve)
            wsStream.once('error', reject)
          })
        }
      }
      await new Promise((resolve, reject) => {
        wsStream.end(() => resolve())
        wsStream.once('error', reject)
      })
      wsStream = null
      return { path: dest, bytes: total }
    } catch (err) {
      if (wsStream) {
        try {
          wsStream.destroy()
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
      } catch {
        // ignore
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

function safeFileName(name, fallback) {
  const cleaned = String(name || fallback || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 100)
  return cleaned || fallback || 'file'
}
