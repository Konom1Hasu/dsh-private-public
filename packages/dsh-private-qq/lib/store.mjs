import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * SQLite WAL store for QQ bridge durability:
 * - inbound_dedup: OneBot message_id deduplication
 * - sessions: chat_key -> DSH session_id & cwd mapping
 * - msg_links: qq_msg_id -> (task_id, msg_type, summary) for quote-reply correlation
 * - outbox: persistent outbound queue with retry & quiet-window deferral
 */
export class QqStore {
  constructor(dbPath) {
    this.dbPath = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS inbound_dedup (
        msg_id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        chat_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS msg_links (
        qq_msg_id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        task_id TEXT,
        msg_type TEXT NOT NULL,
        summary TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retries INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_pending
        ON outbox(status, next_retry_at);
    `)

    this.stmtInsertDedup = this.db.prepare(
      'INSERT OR IGNORE INTO inbound_dedup (msg_id, chat_key, received_at) VALUES (?, ?, ?)'
    )
    this.stmtPruneDedup = this.db.prepare(
      'DELETE FROM inbound_dedup WHERE received_at < ?'
    )
    this.stmtPruneLinks = this.db.prepare(
      'DELETE FROM msg_links WHERE created_at < ?'
    )
    this.stmtPruneOutbox = this.db.prepare(
      "DELETE FROM outbox WHERE status IN ('sent', 'failed') AND created_at < ?"
    )
    this.stmtGetSession = this.db.prepare(
      'SELECT chat_key, session_id, cwd, updated_at FROM sessions WHERE chat_key = ?'
    )
    this.stmtFindChatBySession = this.db.prepare(
      'SELECT chat_key, session_id, cwd, updated_at FROM sessions WHERE session_id = ? LIMIT 1'
    )
    this.stmtUpsertSession = this.db.prepare(`
      INSERT INTO sessions (chat_key, session_id, cwd, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_key) DO UPDATE SET
        session_id = excluded.session_id,
        cwd = excluded.cwd,
        updated_at = excluded.updated_at
    `)
    this.stmtUpsertLink = this.db.prepare(`
      INSERT INTO msg_links (qq_msg_id, chat_key, task_id, msg_type, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(qq_msg_id) DO UPDATE SET
        task_id = excluded.task_id,
        msg_type = excluded.msg_type,
        summary = excluded.summary
    `)
    this.stmtGetLink = this.db.prepare(
      'SELECT qq_msg_id, chat_key, task_id, msg_type, summary, created_at FROM msg_links WHERE qq_msg_id = ?'
    )
    this.stmtEnqueueOutbox = this.db.prepare(`
      INSERT INTO outbox (chat_type, chat_id, kind, payload, status, retries, next_retry_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    `)
    this.stmtDueOutbox = this.db.prepare(`
      SELECT id, chat_type, chat_id, kind, payload, retries, next_retry_at, created_at
      FROM outbox
      WHERE status = 'pending' AND next_retry_at <= ?
      ORDER BY id ASC
      LIMIT ?
    `)
    this.stmtMarkOutboxSent = this.db.prepare(
      "UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?"
    )
    this.stmtMarkOutboxRetry = this.db.prepare(
      "UPDATE outbox SET retries = ?, next_retry_at = ?, error = ? WHERE id = ?"
    )
    this.stmtMarkOutboxFailed = this.db.prepare(
      "UPDATE outbox SET status = 'failed', retries = ?, error = ? WHERE id = ?"
    )
  }

  /** Returns true if this message_id is new; false if already seen. */
  markInboundIfNew(msgId, chatKey, now = Date.now()) {
    if (!msgId) return true
    const res = this.stmtInsertDedup.run(String(msgId), String(chatKey), now)
    return Number(res.changes) > 0
  }

  pruneOldDedup(maxAgeMs = 7 * 24 * 3600_000, now = Date.now()) {
    this.stmtPruneDedup.run(now - maxAgeMs)
  }

  pruneOldRecords(maxAgeMs = 30 * 24 * 3600_000, now = Date.now()) {
    const cutoff = now - maxAgeMs
    this.stmtPruneLinks.run(cutoff)
    this.stmtPruneOutbox.run(cutoff)
  }

  enqueueOutboxBatch(entries, now = Date.now()) {
    if (!entries.length) return []
    const ids = []
    this.db.exec('BEGIN')
    try {
      for (const e of entries) {
        const res = this.stmtEnqueueOutbox.run(
          String(e.chatType),
          String(e.chatId),
          String(e.kind),
          JSON.stringify(e.payload),
          e.deliverAt || now,
          now
        )
        ids.push(Number(res.lastInsertRowid))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore rollback error
      }
      throw err
    }
    return ids
  }

  getSession(chatKey) {
    return this.stmtGetSession.get(String(chatKey)) || null
  }

  findChatBySessionId(sessionId) {
    return this.stmtFindChatBySession.get(String(sessionId)) || null
  }

  saveSession(chatKey, sessionId, cwd, now = Date.now()) {
    this.stmtUpsertSession.run(String(chatKey), String(sessionId), String(cwd), now)
  }

  saveMsgLink(qqMsgId, { chatKey, taskId = null, msgType = 'chat', summary = '' }, now = Date.now()) {
    if (!qqMsgId) return
    this.stmtUpsertLink.run(
      String(qqMsgId),
      String(chatKey),
      taskId ? String(taskId) : null,
      String(msgType),
      String(summary || '').slice(0, 300),
      now
    )
  }

  getMsgLink(qqMsgId) {
    if (!qqMsgId) return null
    return this.stmtGetLink.get(String(qqMsgId)) || null
  }

  enqueueOutbox({ chatType, chatId, kind, payload, deliverAt = 0 }, now = Date.now()) {
    const res = this.stmtEnqueueOutbox.run(
      String(chatType),
      String(chatId),
      String(kind),
      JSON.stringify(payload),
      deliverAt || now,
      now
    )
    return Number(res.lastInsertRowid)
  }

  listDueOutbox(limit = 20, now = Date.now()) {
    return this.stmtDueOutbox.all(now, limit).map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }))
  }

  markOutboxSent(id) {
    this.stmtMarkOutboxSent.run(id)
  }

  markOutboxRetry(id, retries, nextRetryAt, error) {
    this.stmtMarkOutboxRetry.run(retries, nextRetryAt, String(error || '').slice(0, 300), id)
  }

  markOutboxFailed(id, retries, error) {
    this.stmtMarkOutboxFailed.run(retries, String(error || '').slice(0, 300), id)
  }

  close() {
    try {
      this.db.close()
    } catch {
      // ignore close errors
    }
  }
}
