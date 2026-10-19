// dshx-session-delete — host half.
//
// DSH has no session deletion anywhere in its stack: session logs are append
// only, and the product's single removal concept is archiving, which merely
// hides a row from Workspace navigation while the log stays on disk. This
// plugin supplies the missing primitive as one endpoint so the patched sidebar
// menu has something to call.
//
//   POST /dshx-session-delete/delete   {"sessionId": "session-<uuid>"}
//
// Deletion is permanent — there is no trash. That was a deliberate choice; the
// caller is expected to have confirmed with the user first.
//
// The endpoint deliberately does NOT touch Workspace navigation. `workspace.json`
// belongs to the live `workspaceController`, and writing it behind that service's
// back would be overwritten by its next flush. The client archives through the
// official Remote method first, then calls this to erase the bytes.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dshx-session-delete'

/** The webserver carrier must exist before routes can be registered. */
export const inject = ['webServer']

/** Route path of the delete endpoint. */
const ROUTE = '/dshx-session-delete/delete'

/** Session ids are uuids; anchoring the shape also fences path traversal. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Refuse a body larger than this; the payload is one short id. */
const MAX_BODY_BYTES = 4096

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** The harness reads DSH_HOME first and falls back to ~/.dsh. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return path.join(os.homedir(), '.dsh')
}

/**
 * Normalise either wire form to the bare uuid the log directory is named after.
 * Navigation speaks `session-<uuid>`; the on-disk layout uses `<uuid>`.
 * @param sessionId - id as sent by the client.
 * @returns the lowercase uuid, or null when the id is not a session id.
 */
function bareId(sessionId) {
  if (typeof sessionId !== 'string') return null
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return UUID.test(bare) ? bare.toLowerCase() : null
}

/**
 * On-disk names a session may be stored under. Older harness builds named the
 * log directory (and projection cache file) after the bare uuid; newer builds
 * use the full `session-<uuid>` id. Both layouts coexist in one home.
 * @param bare - bare session uuid.
 */
function storageNames(bare) {
  return [bare, 'session-' + bare]
}

/**
 * Locate every log directory for the session by scanning the workspace buckets.
 *
 * Deriving the bucket name from the workspace path would duplicate the
 * harness's own key derivation; a scan cannot drift from it.
 * @param home - resolved dsh home directory.
 * @param bare - bare session uuid.
 * @returns absolute directory paths (empty when the session has no log).
 */
async function findSessionDirs(home, bare) {
  const root = path.join(home, 'sessions')
  let buckets
  try {
    buckets = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    for (const name of storageNames(bare)) {
      const candidate = path.join(root, bucket.name, name)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) found.push(candidate)
      } catch {
        // This bucket simply does not hold the session under this name.
      }
    }
  }
  return found
}

/** Ceiling on waiting for a cancelled agent to reach quiescence. */
const QUIESCE_TIMEOUT_MS = 5000

/**
 * Force a live agent to stop before its log is erased.
 *
 * `live` only means the id is resident in `ctx.sessions`, so the session you are
 * currently looking at counts; refusing those would block the common case. The
 * agent is instead cancelled with the `disposed` cause, which clears queued and
 * steering work and parks any later waking input rather than re-running it.
 *
 * Only documented agent methods are used. Unwinding the agent's own Cordis scope
 * from outside would end the write path more definitively, but that is not an
 * operation the harness offers to plugins, and a half-unwound agent would be a
 * worse failure than a resident idle one.
 *
 * @param ctx - host context carrying the agent registry.
 * @param sessionId - id in `session-<uuid>` form.
 * @returns what was found and how far the stop got.
 */
async function forceStop(ctx, sessionId) {
  // Two different registries, and a session can sit in the first without ever
  // reaching the second: `ctx.sessions` holds the resident session — which is
  // what the harness reports as `live` — while `ctx.agents` holds only sessions
  // that actually have a driving agent.
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined

  if (session === undefined && agent === undefined) return { wasLive: false, stopped: false }

  const result = { wasLive: true, stopped: true, hadAgent: agent !== undefined, cancelled: false }

  if (agent !== undefined) {
    try {
      agent.cancel({ kind: 'disposed' })
      result.cancelled = true
    } catch (error) {
      result.stopped = false
      result.note = '取消失败：' + describeError(error)
    }

    // A cancelled turn unwinds asynchronously; deleting before it settles is
    // the race this wait exists to avoid. A timeout still proceeds — the caller
    // asked for a forced delete, and a stuck agent must not veto it.
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, QUIESCE_TIMEOUT_MS)),
      ])
      result.quiesced = true
    } catch {
      // A rejected wait is not a reason to keep the log.
    }
  }

  // Flush before removing: a buffered write landing afterwards would recreate
  // the directory that is about to be deleted.
  try {
    const target = agent?.session ?? session
    if (target !== undefined && typeof sessions?.flush === 'function') {
      await sessions.flush(target)
      result.flushed = true
    }
  } catch {
    // Unflushed bytes are about to be deleted anyway.
  }

  return result
}

/**
 * Tell connected browsers the session is gone.
 *
 * The sidebar list only drops a row on the forwarded `api-session/removed`
 * event, which the harness emits from `session/disposed`. An erased session
 * never gets there: a cold one was never live, and a live one stays resident
 * because a plugin cannot dispose another owner's agent. Without this the row
 * stays in the browser's session list — and since the client archived it
 * first, it keeps showing under 「显示已归档」 until the host restarts, which
 * reads exactly like "delete only archives".
 * @param ctx - host context.
 * @param sessionId - id in `session-<uuid>` form.
 * @returns whether the event was emitted.
 */
function announceRemoved(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
    return true
  } catch (error) {
    ctx.logger?.('dshx-session-delete')?.warn?.('api-session/removed emit failed: %s', describeError(error))
    return false
  }
}

/** Collect the request body with a hard ceiling. */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Mount the delete endpoint.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }

      if ((req.method ?? 'GET') !== 'POST') {
        json(405, { error: 'method not allowed' })
        return
      }

      try {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch (error) {
          json(400, { error: '请求体不是合法 JSON：' + describeError(error) })
          return
        }

        const wireId = payload?.sessionId
        const bare = bareId(wireId)
        if (bare === null) {
          json(400, { error: '缺少或非法的 sessionId' })
          return
        }
        const sessionId = typeof wireId === 'string' && wireId.startsWith('session-') ? wireId : 'session-' + bare

        // A running session is terminated rather than refused: the caller has
        // already confirmed a permanent delete, so a live agent is an obstacle
        // to clear, not a reason to stop.
        const stop = await forceStop(ctx, sessionId)

        const home = dshHome()
        const dirs = await findSessionDirs(home, bare)
        const removed = []

        for (const dir of dirs) {
          await fs.rm(dir, { recursive: true, force: true })
          removed.push(dir)
        }

        // Best effort: the per-session projection cache is a derived artefact,
        // and a failure to drop it must not fail a completed deletion.
        for (const name of storageNames(bare)) {
          const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', name + '.json')
          try {
            await fs.stat(cacheFile)
            await fs.rm(cacheFile, { force: true })
            removed.push(cacheFile)
          } catch {
            // Either there was no cache row, or it survived: both leave a derived
            // artefact pointing at a log that no longer exists, which is harmless.
          }
        }

        // No log on disk is a failure, not a silent success: returning 200 here
        // made the client believe a merely archived session had been erased.
        // A resident session that was never flushed is the one legitimate
        // no-log case.
        if (dirs.length === 0 && !stop.wasLive) {
          // Nothing exists on disk or in memory, so any row a browser still
          // shows is a ghost; drop it even though this call erased nothing.
          announceRemoved(ctx, sessionId)
          json(404, { error: '磁盘上找不到该对话的记录（' + sessionId + '），未删除任何文件' })
          return
        }

        const announced = announceRemoved(ctx, sessionId)

        ctx.logger?.('dshx-session-delete')?.info?.(
          'deleted session %s (live=%s, %d paths)', sessionId, String(stop.wasLive), removed.length)
        json(200, { ok: true, sessionId, hadLog: dirs.length > 0, removed, terminated: stop, announced })
      } catch (error) {
        json(500, { error: describeError(error) })
      }
    },
  }), 'dshx-session-delete-route')
}
