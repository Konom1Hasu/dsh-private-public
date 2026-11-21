import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { QqStore } from './store.mjs'
import { NoiseFilter } from './noise.mjs'
import { InboundDebouncer } from './debounce.mjs'
import { OneBotClient } from './onebot.mjs'
import { DshSessionManager, sessionIdFrom } from './dsh-sessions.mjs'
import { planOutbound, isQuietWindow, nextMorningTimestamp } from './outbound.mjs'

/**
 * Core QQ <-> DSH bridge:
 * - Strict owner/group whitelist & self_id echo prevention
 * - SQLite WAL inbound dedup + persistent outbox retry + msg_links quote tracking
 * - 2s sliding debounce (immediate flush on image/file/reply/slash)
 * - Captures final assistant reply per turn via session/event (turn -> highest step)
 * - Registers `send_qq` tool & optional approval/request race hook
 */
export class QqBridge {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = normalizeConfig(config)
    this.logger = ctx.logger ? ctx.logger('private-qq') : console

    const dataDir = this.config.dataDir
    fs.mkdirSync(dataDir, { recursive: true })
    this.downloadsDir = path.join(dataDir, 'downloads')
    this.outboxDir = path.join(dataDir, 'outbox')

    this.store = new QqStore(path.join(dataDir, 'qq-bridge.db'))
    this.noise = new NoiseFilter()
    this.sessions = new DshSessionManager(ctx, this.store, {
      defaultCwd: this.config.defaultCwd,
      logger: this.logger,
    })

    this.debouncer = new InboundDebouncer({
      debounceMs: this.config.debounceMs,
      maxWaitMs: this.config.maxWaitMs,
      onFlush: (chatKey, msg) => this._handleFlushedInbound(chatKey, msg),
    })

    this.onebot = new OneBotClient({
      wsUrl: this.config.wsUrl,
      accessToken: this.config.accessToken,
      downloadsDir: this.downloadsDir,
      maxDownloadBytes: this.config.maxDownloadBytes,
      onMessage: (msg) => this._handleRawInbound(msg),
      onStateChange: (connected) => {
        if (connected) {
          this._drainOutbox().catch((err) => {
            this.logger.warn?.('[private-qq] drainOutbox on connect error:', err?.message || err)
          })
        }
      },
      logger: this.logger,
    })

    // sessionId -> chat_key cache (avoids synchronous SQLite lookup on every session/event)
    this.sessionChatCache = new Map()
    // sessionId -> Set of recent event seqs (sliding 256)
    this.seenSeq = new Map()
    // sessionId -> Map<turn, { maxStep: number, text: string, hasToolUse: boolean }>
    this.turnBuffers = new Map()
    // sessionId -> Set of qq-originated user message ids
    this.qqUserMsgIds = new Map()
    // sessionId -> boolean (true if the currently active turn was triggered by QQ)
    this.activeQqSession = new Map()
    // Approval waiters: qqMsgId -> { resolve, timer, chatKey }
    this.approvalWaiters = new Map()
    // Rate limit timestamps for proactive send_qq tool
    this.toolSendWindow = []

    this.stopped = false
    this.draining = false
    this.outboxTimer = null
    this.sweepTimer = null
  }

  start() {
    this.stopped = false
    if (!this.config.ownerIds.length && this.config.privateWhitelistOnly) {
      this.logger.warn?.('[private-qq] ownerIds is empty while privateWhitelistOnly=true; all private messages will be ignored until ownerIds is configured.')
    }
    this.onebot.start()
    this.outboxTimer = setInterval(() => {
      this._drainOutbox().catch((err) => {
        this.logger.warn?.('[private-qq] drainOutbox tick error:', err?.message || err)
      })
    }, 3000)
    this.sweepTimer = setInterval(() => {
      try {
        this.noise.sweep()
        this.store.pruneOldDedup()
        this.store.pruneOldRecords()
        this._pruneOldOutboxFiles()
      } catch (err) {
        this.logger.warn?.('[private-qq] sweep error:', err?.message || err)
      }
    }, 10 * 60_000)
  }

  stop() {
    this.stopped = true
    if (this.outboxTimer) clearInterval(this.outboxTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.debouncer.dispose()
    for (const w of this.approvalWaiters.values()) {
      clearTimeout(w.timer)
      w.resolve(null)
    }
    this.approvalWaiters.clear()
    this.onebot.stop()
    this.store.close()
  }

  _chatKey(chatType, chatId) {
    return `${chatType}:${chatId}`
  }

  _parseChatKey(chatKey) {
    const idx = String(chatKey).indexOf(':')
    if (idx < 0) return { chatType: 'private', chatId: String(chatKey) }
    return { chatType: chatKey.slice(0, idx), chatId: chatKey.slice(idx + 1) }
  }

  _isOwner(senderId) {
    return this.config.ownerIds.includes(String(senderId))
  }

  _isAllowedInbound(msg) {
    if (msg.selfId && String(msg.senderId) === String(msg.selfId)) return false
    if (msg.chatType === 'private') {
      if (this.config.privateWhitelistOnly) {
        return this._isOwner(msg.senderId)
      }
      return true
    }
    if (!this.config.allowGroups) return false
    if (this.config.groupWhitelist.length && !this.config.groupWhitelist.includes(String(msg.chatId))) {
      return false
    }
    if (this.config.replyOnlyWhenAddressed && !msg.addressed) return false
    return true
  }

  _handleRawInbound(msg) {
    if (!this._isAllowedInbound(msg)) return

    const chatKey = this._chatKey(msg.chatType, msg.chatId)
    if (!this.store.markInboundIfNew(msg.rawId, chatKey)) {
      return // duplicate OneBot delivery
    }

    const isOwnerPrivate = msg.chatType === 'private' && this._isOwner(msg.senderId)

    // Check if this is a reply to a pending approval card
    if (isOwnerPrivate && msg.replyMsgId && this.approvalWaiters.has(msg.replyMsgId)) {
      const decision = parseApprovalReply(msg.text)
      if (decision) {
        const waiter = this.approvalWaiters.get(msg.replyMsgId)
        this.approvalWaiters.delete(msg.replyMsgId)
        clearTimeout(waiter.timer)
        waiter.resolve(decision)
        return
      }
    }

    const noiseRes = this.noise.check(msg, this.config.noise, { isOwnerPrivate })
    if (noiseRes.noise) {
      this.logger.debug?.(`[private-qq] dropped noise (${noiseRes.why}) from ${chatKey}`)
      return
    }

    this.debouncer.push(chatKey, msg)
  }

  async _handleFlushedInbound(chatKey, msg) {
    const trimmed = String(msg.text || '').trim()

    // Built-in lightweight slash commands for QQ control
    if (trimmed === '/new' || trimmed === '/reset') {
      try {
        await this.sessions.ensure(chatKey, { forceNew: true })
        await this._enqueueItems(msg.chatType, msg.chatId, [
          { kind: 'text', text: '好嘞，刚给你开了一间全新的会话房间喵~ (=^･ω･^=)', delayMs: 0 },
        ])
      } catch (err) {
        await this._enqueueItems(msg.chatType, msg.chatId, [
          { kind: 'text', text: `开新会话卡壳了喵：${err?.message || err}`, delayMs: 0 },
        ])
      }
      return
    }

    if (trimmed === '/status') {
      const sess = this.store.getSession(chatKey)
      const statusText = [
        `OneBot：${this.onebot.connected ? '在线' : '断线重连中'}`,
        `当前会话：${sess?.session_id || '（尚未建立）'}`,
        `工作目录：${sess?.cwd || this.config.defaultCwd}`,
      ].join('\n')
      await this._enqueueItems(msg.chatType, msg.chatId, [{ kind: 'text', text: statusText, delayMs: 0 }])
      return
    }

    const promptText = this._formatPromptForDsh(chatKey, msg)

    let ensured
    try {
      ensured = await this.sessions.ensure(chatKey)
    } catch (err) {
      this.logger.warn?.('[private-qq] ensure session failed:', err?.message || err)
      await this._enqueueItems(msg.chatType, msg.chatId, [
        { kind: 'text', text: '主脑这边刚晃了一下还没接上，稍等几秒再发我喵 (>_<)', delayMs: 0 },
      ])
      return
    }

    const { agent, sessionId } = ensured
    this.sessionChatCache.set(sessionId, chatKey)
    let idSet = this.qqUserMsgIds.get(sessionId)
    if (!idSet) {
      idSet = new Set()
      this.qqUserMsgIds.set(sessionId, idSet)
    }

    this.activeQqSession.set(sessionId, true)
    try {
      this.sessions.sendTurn(agent, promptText, {
        busyMode: this.config.busyMode,
        onCreated: (msgId) => {
          idSet.add(msgId)
          if (idSet.size > 100) {
            const first = idSet.values().next().value
            idSet.delete(first)
          }
        },
      })
    } catch (err) {
      this.logger.warn?.('[private-qq] sendTurn failed:', err?.message || err)
      await this._enqueueItems(msg.chatType, msg.chatId, [
        { kind: 'text', text: '消息递进去的时候打滑了喵，再戳我一下试试 (>_<)', delayMs: 0 },
      ])
    }
  }

  _formatPromptForDsh(chatKey, msg) {
    const parts = []
    const modeHint =
      msg.chatType === 'group'
        ? `[QQ 群聊 ${msg.chatId} · ${msg.senderName}(${msg.senderId})]`
        : `[QQ 私聊 · ${msg.senderName}(${msg.senderId})]`
    parts.push(modeHint)
    parts.push(
      '（渠道提示：这条消息来自 QQ。闲聊就用简短口语猫娘风格回复；如果是正事/排查/方案汇报，就按正常结构化猫娘汇报来，不要输出 schemaJson 卡片。）'
    )

    if (msg.replyMsgId) {
      const link = this.store.getMsgLink(msg.replyMsgId)
      if (link?.task_id) {
        parts.push(`[引用关联任务 task_id=${link.task_id} (${link.msg_type})]`)
      }
      if (msg.replySummary) {
        parts.push(`[引用原消息：${msg.replySummary}]`)
      } else if (link?.summary) {
        parts.push(`[引用原消息：${link.summary}]`)
      }
    }

    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        if (att.kind === 'image' && att.path) {
          parts.push(`[附带图片，已下载到本地，可用 read_image 查看：${att.path}]`)
        } else if (att.kind === 'file' && att.path) {
          parts.push(`[附带文件，已下载到本地：${att.path} (${att.name || ''})]`)
        } else if (att.error) {
          parts.push(`[附件 ${att.kind} 下载失败：${att.error}]`)
        } else {
          parts.push(`[附带 ${att.kind}：${att.name || ''}]`)
        }
      }
    }

    if (msg.text) {
      parts.push(msg.text)
    }

    return parts.join('\n')
  }

  handleSessionEvent(session, event) {
    if (this.stopped) return
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'turn/end') return

    const sessionId = sessionIdFrom(session)
    if (!sessionId) return

    let chatKey = this.sessionChatCache.get(sessionId)
    if (chatKey === undefined) {
      const row = this.store.findChatBySessionId(sessionId)
      chatKey = row ? row.chat_key : null
      this.sessionChatCache.set(sessionId, chatKey)
    }
    if (!chatKey) return

    // Deduplicate (sessionId, seq)
    if (typeof event.seq === 'number') {
      let seen = this.seenSeq.get(sessionId)
      if (!seen) {
        seen = new Set()
        this.seenSeq.set(sessionId, seen)
      }
      if (seen.has(event.seq)) return
      seen.add(event.seq)
      if (seen.size > 256) {
        const first = seen.values().next().value
        seen.delete(first)
      }
    }

    const data = event.data || {}

    if (type === 'user/message') {
      // DSH user/message payload is UserMessage directly ({ id, role, content, source })
      const msgId = typeof data.id === 'string' ? data.id : data.message?.id
      const idSet = this.qqUserMsgIds.get(sessionId)
      if (msgId && idSet && idSet.has(msgId)) {
        this.activeQqSession.set(sessionId, true)
      } else if (msgId && !this.config.mirrorGuiTurns) {
        this.activeQqSession.set(sessionId, false)
      }
      return
    }

    if (!this.activeQqSession.get(sessionId)) return

    if (type === 'assistant/message') {
      const turn = Number(data.turn ?? 0)
      const step = Number(data.step ?? 0)
      const blocks = Array.isArray(data.message?.content) ? data.message.content : []
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
      const hasToolUse = blocks.some((b) => b && (b.type === 'tool-call' || b.type === 'tool_use'))

      if (!text) return
      let turns = this.turnBuffers.get(sessionId)
      if (!turns) {
        turns = new Map()
        this.turnBuffers.set(sessionId, turns)
      }
      const prev = turns.get(turn)
      if (!prev || step >= prev.maxStep) {
        turns.set(turn, { maxStep: step, text, hasToolUse })
      }
      return
    }

    if (type === 'turn/end') {
      const turn = Number(data.turn ?? 0)
      const turns = this.turnBuffers.get(sessionId)
      const entry = turns?.get(turn)
      if (turns) turns.delete(turn)
      const { chatType, chatId } = this._parseChatKey(chatKey)
      if (!entry || !entry.text) {
        if (data.reason?.kind === 'error') {
          const errMsg = data.reason?.error?.message || '未知错误'
          this._enqueueItems(chatType, chatId, [
            { kind: 'text', text: `刚刚脑子卡壳报错了喵 (>_<)：${String(errMsg).slice(0, 180)}`, delayMs: 0 },
          ]).catch((err) => {
            this.logger.warn?.('[private-qq] enqueue error notice failed:', err?.message || err)
          })
        }
        return
      }

      const items = planOutbound(entry.text, {
        maxBubbles: this.config.maxBubbles,
        chunkLimit: this.config.chunkLimit,
        fileThreshold: this.config.fileThreshold,
        outboxDir: this.outboxDir,
      })
      this._enqueueItems(chatType, chatId, items).catch((err) => {
        this.logger.warn?.('[private-qq] enqueue reply error:', err?.message || err)
      })
    }
  }

  /**
   * Proactive tool handler for `send_qq`.
   */
  async handleSendQqTool(agentId, args = {}) {
    const now = Date.now()
    this.toolSendWindow = this.toolSendWindow.filter((t) => now - t < 60_000)
    if (this.toolSendWindow.length >= this.config.toolRateLimitPerMin) {
      return {
        ok: false,
        message: 'Rate limit reached for send_qq this minute; stop pushing and wait.',
      }
    }

    let chatKey = null
    let boundCwd = null
    if (args.user_id) {
      const targetId = String(args.user_id)
      if (!this._isOwner(targetId)) {
        return { ok: false, message: `Refused: user_id ${targetId} is not in configured ownerIds.` }
      }
      chatKey = this._chatKey('private', targetId)
      boundCwd = this.store.getSession(chatKey)?.cwd || null
    } else if (agentId) {
      const row = this.store.findChatBySessionId(agentId)
      if (row) {
        chatKey = row.chat_key
        boundCwd = row.cwd || null
      }
    }
    if (!chatKey && this.config.ownerIds.length) {
      chatKey = this._chatKey('private', this.config.ownerIds[0])
      boundCwd = this.store.getSession(chatKey)?.cwd || null
    }
    if (!chatKey) {
      return { ok: false, message: 'No QQ target configured or bound to this session.' }
    }

    const { chatType, chatId } = this._parseChatKey(chatKey)

    // Quiet window check for non-urgent proactive pushes
    const urgent = Boolean(args.urgent)
    const deferUntil =
      !urgent && this.config.quietWindowEnabled && isQuietWindow()
        ? nextMorningTimestamp()
        : 0

    const items = []
    if (args.text) {
      const planned = planOutbound(String(args.text), {
        maxBubbles: this.config.maxBubbles,
        chunkLimit: this.config.chunkLimit,
        fileThreshold: this.config.fileThreshold,
        outboxDir: this.outboxDir,
      })
      items.push(...planned)
    }

    if (args.file_path) {
      const guard = this._guardOutgoingFile(String(args.file_path), agentId, boundCwd)
      if (!guard.ok) {
        return { ok: false, message: guard.error }
      }
      const resolved = guard.path
      const ext = path.extname(resolved).toLowerCase()
      const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
      items.push({
        kind: isImg && !args.as_file ? 'image' : 'file',
        filePath: resolved,
        name: path.basename(resolved),
        delayMs: items.length ? 500 : 0,
      })
    }

    if (!items.length) {
      return { ok: false, message: 'Provide at least text or file_path.' }
    }

    this.toolSendWindow.push(now)
    await this._enqueueItems(chatType, chatId, items, {
      deliverAt: deferUntil,
      taskId: args.task_id || null,
      msgType: args.msg_type || 'push',
    })

    return {
      ok: true,
      message: deferUntil
        ? `Queued for morning digest after quiet window (${new Date(deferUntil).toLocaleTimeString()}).`
        : `Queued ${items.length} item(s) to ${chatKey}.`,
    }
  }

  /**
   * Optional approval/request hook: races QQ reply against GUI approval.
   */
  async answerApprovalRequest(req, next) {
    if (!this.onebot.connected || req?.signal?.aborted) {
      return next()
    }
    const sid = req?.agent?.session?.header?.id || req?.agent?.session?.id || req?.agent?.id || ''
    const row = sid ? this.store.findChatBySessionId(sid) : null
    if (!row) return next()

    const { chatType, chatId } = this._parseChatKey(row.chat_key)
    const toolLabel = req.toolName || '高风险操作审批'
    const reasonText = req.displayReason || req.reason || ''
    const summary = (reasonText ? `${toolLabel} — ${reasonText}` : toolLabel).slice(0, 240)
    const prompt = `【需要拍板】${summary}\n直接引用本条回复「准 / y」通过，或「拒 / n」拒绝。`

    let sentMsgId = null
    try {
      const res =
        chatType === 'group'
          ? await this.onebot.sendGroupText(chatId, prompt)
          : await this.onebot.sendPrivateText(chatId, prompt)
      sentMsgId = res?.message_id ? String(res.message_id) : null
    } catch {
      return next()
    }
    if (!sentMsgId) return next()

    this.store.saveMsgLink(sentMsgId, {
      chatKey: row.chat_key,
      taskId: null,
      msgType: 'approval',
      summary,
    })

    const guiPromise = Promise.resolve().then(() => next())
    const qqPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(sentMsgId)
        resolve(null)
      }, 120_000)
      this.approvalWaiters.set(sentMsgId, {
        chatKey: row.chat_key,
        timer,
        resolve,
      })
    })

    const winner = await Promise.race([
      guiPromise.then((outcome) => ({ source: 'gui', outcome })),
      qqPromise.then((outcome) => (outcome ? { source: 'qq', outcome } : guiPromise.then((o) => ({ source: 'gui', outcome: o })))),
    ])

    // Prevent unhandled rejection from loser
    guiPromise.catch(() => {})
    const pending = this.approvalWaiters.get(sentMsgId)
    if (pending) {
      clearTimeout(pending.timer)
      this.approvalWaiters.delete(sentMsgId)
    }

    return winner.outcome
  }

  async _enqueueItems(chatType, chatId, items, meta = {}) {
    if (this.stopped || !items.length) return
    const baseTime = meta.deliverAt || Date.now()
    let offset = 0
    const batch = items.map((item) => {
      offset += Number(item.delayMs || 0)
      return {
        chatType,
        chatId,
        kind: item.kind,
        payload: {
          text: item.text,
          filePath: item.filePath,
          name: item.name,
          taskId: meta.taskId || null,
          msgType: meta.msgType || 'chat',
        },
        deliverAt: baseTime + offset,
      }
    })
    this.store.enqueueOutboxBatch(batch)
    if (!meta.deliverAt) {
      this._drainOutbox().catch((err) => {
        this.logger.warn?.('[private-qq] drainOutbox error:', err?.message || err)
      })
    }
  }

  async _drainOutbox() {
    if (this.stopped || this.draining || !this.onebot.connected) return
    this.draining = true
    try {
      let due = []
      try {
        due = this.store.listDueOutbox(10, Date.now())
      } catch (err) {
        if (!this.stopped) this.logger.warn?.('[private-qq] listDueOutbox error:', err?.message || err)
        return
      }
      for (const row of due) {
        if (this.stopped || !this.onebot.connected) break
        try {
          let res = null
          if (row.kind === 'text') {
            res =
              row.chat_type === 'group'
                ? await this.onebot.sendGroupText(row.chat_id, row.payload.text)
                : await this.onebot.sendPrivateText(row.chat_id, row.payload.text)
          } else if (row.kind === 'image') {
            res = await this.onebot.sendImage(row.chat_type, row.chat_id, row.payload.filePath)
          } else if (row.kind === 'file') {
            res = await this.onebot.sendFile(row.chat_type, row.chat_id, row.payload.filePath, row.payload.name)
          }
          if (this.stopped) break
          this.store.markOutboxSent(row.id)
          if (res?.message_id) {
            this.store.saveMsgLink(String(res.message_id), {
              chatKey: this._chatKey(row.chat_type, row.chat_id),
              taskId: row.payload.taskId || null,
              msgType: row.payload.msgType || 'chat',
              summary: row.payload.text || row.payload.name || '',
            })
          }
        } catch (err) {
          if (this.stopped) break
          const retries = Number(row.retries || 0) + 1
          try {
            if (retries >= 5) {
              this.store.markOutboxFailed(row.id, retries, err?.message || err)
            } else {
              const backoff = Math.min(60_000, 3000 * Math.pow(2, retries - 1))
              this.store.markOutboxRetry(row.id, retries, Date.now() + backoff, err?.message || err)
            }
          } catch {
            // DB may have closed concurrently
          }
        }
      }
    } finally {
      this.draining = false
    }
  }

  _guardOutgoingFile(rawPath, agentId, boundCwd) {
    let realTarget
    try {
      realTarget = fs.realpathSync(path.resolve(rawPath))
    } catch {
      return { ok: false, error: `File not found: ${rawPath}` }
    }

    let stat
    try {
      stat = fs.statSync(realTarget)
    } catch {
      return { ok: false, error: `Cannot stat file: ${rawPath}` }
    }
    if (!stat.isFile()) {
      return { ok: false, error: 'Refused: path is not a regular file.' }
    }
    if (stat.size > this.config.maxOutgoingFileBytes) {
      return {
        ok: false,
        error: `File exceeds size limit (${this.config.maxOutgoingFileBytes} bytes).`,
      }
    }

    if (this.config.allowAnyFilePath) {
      return { ok: true, path: realTarget }
    }

    const allowedRoots = []
    if (boundCwd) allowedRoots.push(boundCwd)
    if (this.config.defaultCwd) allowedRoots.push(this.config.defaultCwd)
    if (this.config.dataDir) allowedRoots.push(this.config.dataDir)
    const agents = this.ctx.get?.('agents')
    const live = agentId && agents?.get ? agents.get(agentId) : null
    const liveCwd = live?.session?.header?.cwd || live?.agent?.session?.header?.cwd
    if (liveCwd) allowedRoots.push(liveCwd)

    const inside = allowedRoots.some((root) => {
      try {
        const realRoot = fs.realpathSync(path.resolve(root))
        const rel = path.relative(realRoot, realTarget)
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
      } catch {
        return false
      }
    })

    if (!inside) {
      return {
        ok: false,
        error: 'Refused: file must reside inside the session workspace or qq-bridge dataDir.',
      }
    }
    return { ok: true, path: realTarget }
  }

  _pruneOldOutboxFiles(maxAgeMs = 7 * 24 * 3600_000) {
    if (!fs.existsSync(this.outboxDir)) return
    const cutoff = Date.now() - maxAgeMs
    for (const name of fs.readdirSync(this.outboxDir)) {
      const full = path.join(this.outboxDir, name)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full)
      } catch {
        // ignore
      }
    }
  }
}

function parseApprovalReply(text) {
  const t = String(text || '').trim().toLowerCase()
  if (/^(y|yes|ok|1|准|通过|同意|允许|好|行)$/.test(t)) return 'allowed-once'
  if (/^(n|no|0|拒|拒绝|否|不行|算了)$/.test(t)) return 'rejected'
  return null
}

function normalizeConfig(raw = {}) {
  const home = os.homedir()
  return {
    wsUrl: raw.wsUrl || 'ws://127.0.0.1:3001',
    accessToken: raw.accessToken || '',
    ownerIds: Array.isArray(raw.ownerIds) ? raw.ownerIds.map(String) : [],
    privateWhitelistOnly: raw.privateWhitelistOnly !== false,
    allowGroups: Boolean(raw.allowGroups),
    groupWhitelist: Array.isArray(raw.groupWhitelist) ? raw.groupWhitelist.map(String) : [],
    replyOnlyWhenAddressed: raw.replyOnlyWhenAddressed !== false,
    defaultCwd: raw.defaultCwd || path.join(home, '.dsh'),
    dataDir: raw.dataDir || path.join(home, '.dsh', 'qq-bridge'),
    debounceMs: Number(raw.debounceMs ?? 2000),
    maxWaitMs: Number(raw.maxWaitMs ?? 8000),
    maxBubbles: Number(raw.maxBubbles ?? 3),
    chunkLimit: Number(raw.chunkLimit ?? 1400),
    fileThreshold: Number(raw.fileThreshold ?? 2200),
    busyMode: raw.busyMode || 'steer',
    mirrorGuiTurns: Boolean(raw.mirrorGuiTurns),
    quietWindowEnabled: raw.quietWindowEnabled !== false,
    toolRateLimitPerMin: Number(raw.toolRateLimitPerMin ?? 12),
    maxDownloadBytes: Number(raw.maxDownloadBytes ?? 12 * 1024 * 1024),
    maxOutgoingFileBytes: Number(raw.maxOutgoingFileBytes ?? 20 * 1024 * 1024),
    allowAnyFilePath: Boolean(raw.allowAnyFilePath),
    noise: raw.noise || { enabled: true },
  }
}
