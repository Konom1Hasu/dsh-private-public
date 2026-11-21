import { randomUUID } from 'node:crypto'

/**
 * DSH live session adapter modeled on dsh-wechat/dist/dsh/sessions.js.
 * Zero hard dependencies on @deepseek-ai/* internals; resolves services via ctx.get(...).
 */

export function mintSessionId() {
  return `session-${randomUUID()}`
}

export function sessionIdFrom(session) {
  if (!session || typeof session !== 'object') return ''
  return (
    session.id ||
    session.header?.id ||
    session.session?.header?.id ||
    session.session?.id ||
    ''
  )
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}

export function createUserMessage({ content, source = { kind: 'user' } }) {
  const cloned = structuredClone({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
  return deepFreeze(cloned)
}

function modelSelectionFromProjection(value) {
  if (!value || typeof value !== 'object') return undefined
  const pick = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return undefined
    if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return undefined
    return {
      provider: candidate.provider,
      model: candidate.model,
      ...(typeof candidate.reasoningEffort === 'string'
        ? { reasoningEffort: candidate.reasoningEffort }
        : {}),
    }
  }
  return pick(value.next) ?? pick(value.lastUsed)
}

export class DshSessionManager {
  constructor(ctx, store, opts = {}) {
    this.ctx = ctx
    this.store = store
    this.defaultCwd = opts.defaultCwd || process.cwd()
    this.logger = opts.logger || console
    this.pendingEnsure = new Map()
  }

  _agents() {
    return this.ctx.get('agents')
  }

  async _attachWorkspace(sessionId, cwd) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return
    try {
      let ws = registry.resolveByPath ? await registry.resolveByPath(cwd) : null
      if (!ws && registry.create) {
        ws = await registry.create(cwd)
      }
      if (ws && typeof ws.attachSession === 'function') {
        await ws.attachSession(sessionId)
      }
    } catch (err) {
      this.logger.warn?.('[private-qq] attachSession warning:', err?.message || err)
    }
  }

  async _setupAgent(agentCtx, live) {
    const presets = agentCtx.get?.('agentPresets') || this.ctx.get('agentPresets')
    if (presets && typeof presets.mount === 'function') {
      const presetId = live?.session?.header?.agentPreset || presets.defaultId
      await presets.mount(agentCtx, presetId)
    }

    const defaultModel = agentCtx.get?.('agentDefaultModel') || this.ctx.get('agentDefaultModel')
    const projections = agentCtx.get?.('sessionProjections') || this.ctx.get('sessionProjections')

    const currentSelection = () => {
      const session = live?.session
      if (session && projections) {
        try {
          const projected = modelSelectionFromProjection(
            projections.snapshot(session)?.values?.modelSelection
          )
          if (projected?.provider && projected.model) return projected
        } catch {
          // fall through
        }
      }
      const logged = live?.session?.requestHeader?.()?.config
      if (logged?.provider && logged.model) {
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
        }
      }
      return defaultModel?.currentSelection?.()
    }

    let assembledSelection
    agentCtx.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = currentSelection()
      const assembled = await next()
      assembledSelection = selected
      if (!selected?.provider || !selected.model) return assembled
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selected.provider,
          model: selected.model,
        },
      }
    })

    agentCtx.on?.('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selected = assembledSelection ?? currentSelection()
      if (!selected?.provider || !selected.model) return resolved
      const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort }),
      }
    })
  }

  /**
   * Ensure a live DSH agent for `chatKey`, serialized per chatKey to prevent duplicate sessions.
   */
  ensure(chatKey, { cwd = this.defaultCwd, forceNew = false } = {}) {
    const prev = this.pendingEnsure.get(chatKey) || Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this._ensureInner(chatKey, { cwd, forceNew }))
    this.pendingEnsure.set(chatKey, next)
    const cleanup = () => {
      if (this.pendingEnsure.get(chatKey) === next) {
        this.pendingEnsure.delete(chatKey)
      }
    }
    next.then(cleanup, cleanup)
    return next
  }

  async _ensureInner(chatKey, { cwd, forceNew }) {
    const agents = this._agents()
    if (!agents) {
      throw new Error('DSH agents service not ready')
    }

    const existing = !forceNew ? this.store.getSession(chatKey) : null
    if (existing?.session_id) {
      const live = agents.get ? agents.get(existing.session_id) : null
      if (live) {
        return { agent: live.agent || live, sessionId: existing.session_id, created: false }
      }
      if (typeof agents.resume === 'function') {
        try {
          const resumed = await agents.resume({
            resumeSessionId: existing.session_id,
            setup: (agentCtx, agent) => this._setupAgent(agentCtx, agent),
          })
          const agent = resumed?.agent || resumed
          if (agent) {
            await this._attachWorkspace(existing.session_id, existing.cwd || cwd)
            return { agent, sessionId: existing.session_id, created: false }
          }
        } catch (err) {
          this.logger.warn?.(
            `[private-qq] resume ${existing.session_id} failed, creating new:`,
            err?.message || err
          )
        }
      }
    }

    const sessionId = mintSessionId()
    const presets = this.ctx.get('agentPresets')
    const agentPreset = presets?.defaultId
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        ...(agentPreset ? { agentPreset } : {}),
      },
      setup: (agentCtx, agent) => this._setupAgent(agentCtx, agent),
    })

    const agent = handle?.agent || handle
    await this._attachWorkspace(sessionId, cwd)
    this.store.saveSession(chatKey, sessionId, cwd)
    return { agent, sessionId, created: true }
  }

  /**
   * Inject a user turn into the live DSH agent.
   * Calls `onCreated(msg.id)` BEFORE followup/steer so synchronous events see the id.
   */
  sendTurn(agent, text, { busyMode = 'steer', onCreated } = {}) {
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (typeof onCreated === 'function') onCreated(msg.id)
    if (agent.status === 'running' && busyMode === 'steer' && typeof agent.steer === 'function') {
      agent.steer(msg)
    } else if (typeof agent.followup === 'function') {
      agent.followup(msg)
    } else {
      throw new Error('DSH agent has neither followup nor steer')
    }
    return msg.id
  }
}
