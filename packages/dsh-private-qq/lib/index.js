import { QqBridge } from './bridge.mjs'

export const name = 'private-qq'
export const inject = []

export function apply(ctx, rawConfig = {}) {
  const bridge = new QqBridge(ctx, rawConfig)

  // Listen to live DSH session events to forward QQ-originated replies
  ctx.on('session/event', (session, event) => {
    bridge.handleSessionEvent(session, event)
  })

  // Optional approval race hook (active when approval policy != never)
  ctx.on(
    'approval/request',
    async (req, next) => {
      try {
        return await bridge.answerApprovalRequest(req, next)
      } catch (err) {
        ctx.logger?.('private-qq')?.warn?.('approval hook error, falling back:', err?.message || err)
        return next()
      }
    },
    { prepend: true }
  )

  // Register proactive `send_qq` tool via ctx.inject + ctx.effect (HMR safe)
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (!tools || typeof tools.register !== 'function') return

    const register = () => {
      const dispose = tools.register({
        name: 'send_qq',
        description:
          'Send a text message, image, or local file to a QQ user via the local NapCat OneBot v11 bridge. Defaults to the QQ user bound to this session or the configured owner.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text message to send to QQ.',
            },
            file_path: {
              type: 'string',
              description: 'Absolute path of an existing local image or file to send.',
            },
            as_file: {
              type: 'boolean',
              description: 'When true, upload image files as file attachments instead of inline images.',
            },
            user_id: {
              type: 'string',
              description: 'Optional QQ user id override. Omit to use bound user or default owner.',
            },
            task_id: {
              type: 'string',
              description: 'Optional task ledger id to associate with the sent QQ message for quote-reply tracking.',
            },
            urgent: {
              type: 'boolean',
              description: 'When true, bypass nighttime quiet window (00:30-08:30).',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          return bridge.handleSendQqTool(exec?.agent?.id ?? '', args)
        },
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }

    if (typeof toolsCtx.effect === 'function') {
      toolsCtx.effect(register)
    } else {
      register()
    }
  })

  bridge.start()

  return () => {
    bridge.stop()
  }
}
