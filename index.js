// dshx-session-delete — host half.
//
// DSH has no session deletion anywhere in its stack: session logs are append
// only, and the product's single removal concept is archiving, which merely
// hides a row from Workspace navigation while the log stays on disk. This
// plugin supplies the missing primitive.
//
//   POST /dshx-session-delete/delete            {"sessionId": "session-<uuid>"}
//   POST /dshx-session-delete/attachments/gc    {"dryRun": true, "graceMinutes": 60}
//   POST /dshx-session-delete/prune             {"dryRun": true}
//
// A conversation is not one file. What the harness keeps around for it:
//
//   * sessions/<bucket>/<id>/session.v*.jsonl.zstd  — the log (deleted here);
//   * sessions/<bucket>/<child>/…                   — subagent child sessions,
//     one flat log directory each, invisible in the sidebar (deleted with the
//     parent here, recursively);
//   * storages/session_projcache/sessions/<id>.json — title, first prompt and
//     turn outline checkpoint (deleted here);
//   * storages/workspace.json → archivedSessionIds / sessionIds — the id
//     itself (dropped here through the workspace service, after the files are
//     confirmed gone);
//   * attachments/v1/objects/<sha> — content-addressed image and file bytes,
//     deduplicated across conversations and never collected by the harness
//     (swept here once the last surviving reference is gone);
//   * cache/attachments/request-images — derived model-request variants of
//     those objects (cleared when object bytes were collected);
//   * plain `<sessions>/session-<id8>….bak-*` files — whole-conversation
//     backups other plugins leave beside the buckets (removed here).
//
// Deletion is permanent — there is no trash. That was a deliberate choice; the
// caller is expected to have confirmed with the user first.
//
// The endpoint deliberately writes no store file directly. `workspace.json`
// belongs to the live `workspaceRegistry`, and writing it behind that service's
// back would be overwritten by its next flush — the id is dropped by calling
// the service instead, and only after every artifact is verified gone so a
// failed delete stays archived (recoverable) rather than half-deleted.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Stable Cordis plugin name. */
export const name = 'dshx-session-delete'

/** The webserver carrier must exist before routes can be registered. */
export const inject = ['webServer']

/** Route path of the delete endpoint. */
const ROUTE = '/dshx-session-delete/delete'

/** Route path of the manual attachment collector. */
const GC_ROUTE = '/dshx-session-delete/attachments/gc'

/** Route path of the one-shot archive-set cleanup. */
const PRUNE_ROUTE = '/dshx-session-delete/prune'

/** Session ids are uuids; anchoring the shape also fences path traversal. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Refuse a body larger than this; the payload is one short id. */
const MAX_BODY_BYTES = 4096

/** Ceiling on waiting for a cancelled agent to reach quiescence. */
const QUIESCE_TIMEOUT_MS = 5000

/** How long a deleted artifact must stay gone before registry cleanup runs. */
const VERIFY_DELAY_MS = 1000

/** Delegation can nest (agent teams); bound the crawl defensively. */
const MAX_CASCADE_DEPTH = 8

/** An attachment younger than this may belong to a turn whose log row is still buffered. */
const ATTACHMENT_GRACE_MS = 60 * 60 * 1000

/** Zstandard frame magic, little endian as stored. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** A session header frame is small; probe this much before reading a whole log. */
const MAX_HEADER_PROBE_BYTES = 16384

/** Attachment references are stored as `sha256:<64 hex>` inside message blocks. */
const DIGEST_REF = /sha256:[a-f0-9]{64}/g

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
 * Offsets at which a Zstandard frame starts inside `buffer`.
 *
 * The persistence backend stores one checksummed frame per durable append, so a
 * log is a plain concatenation of independent frames and the header always
 * rides in the first one.
 * @param buffer - raw log bytes.
 * @returns frame start offsets.
 */
function frameStarts(buffer) {
  const starts = [0]
  for (let i = 4; i < buffer.length - 3; i++) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i)
      i += 3
    }
  }
  return starts
}

/** Whether this build of the host runtime exposes Zstandard decoding. */
function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * Decode one frame's bytes as UTF-8 text.
 * @param buffer - exactly one frame.
 * @returns the decoded text, or '' when the frame is torn or not Zstandard.
 */
function decodeFrame(buffer) {
  if (buffer.length === 0) return ''
  try {
    return zlib.zstdDecompressSync(buffer).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Decode every frame of a log. A torn final frame contributes nothing, which is
 * exactly what the harness's own reader does with a crashed tail.
 * @param buffer - raw log bytes.
 * @returns the concatenated decoded text.
 */
function decodeLogText(buffer) {
  if (!zstdAvailable()) return ''
  const starts = frameStarts(buffer)
  let text = ''
  for (let index = 0; index < starts.length; index++) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    text += decodeFrame(buffer.subarray(from, to))
  }
  return text
}

/**
 * The stored session header.
 * @param text - decoded log text.
 * @returns the parsed header event, or null when the log carries none.
 */
function parseHeader(text) {
  const newline = text.indexOf('\n')
  const line = newline === -1 ? text : text.slice(0, newline)
  if (line.length === 0) return null
  try {
    const event = JSON.parse(line)
    return event !== null && typeof event === 'object' && event.type === 'session' ? event : null
  } catch {
    return null
  }
}

/**
 * Read one log's header without decoding its body when the frame boundary is
 * visible inside a small prefix.
 * @param logPath - absolute log path.
 * @returns the header event, or null.
 */
async function readHeader(logPath) {
  if (!zstdAvailable()) return null
  let handle
  try {
    handle = await fs.open(logPath, 'r')
    const size = (await handle.stat()).size
    const probe = Math.min(size, MAX_HEADER_PROBE_BYTES)
    const head = Buffer.alloc(probe)
    await handle.read(head, 0, probe, 0)
    const starts = frameStarts(head)
    if (starts.length > 1 || probe === size) {
      const end = starts.length > 1 ? starts[1] : probe
      return parseHeader(decodeFrame(head.subarray(0, end)))
    }
    const whole = Buffer.alloc(size)
    await handle.read(whole, 0, size, 0)
    const all = frameStarts(whole)
    const end = all.length > 1 ? all[1] : size
    return parseHeader(decodeFrame(whole.subarray(0, end)))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
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

/**
 * Every log directory in the home, with its bare id and log path.
 * @param home - resolved dsh home directory.
 * @returns one entry per stored session.
 */
async function scanSessionLogs(home) {
  const root = path.join(home, 'sessions')
  let buckets
  try {
    buckets = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const entries = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    let dirs
    try {
      dirs = await fs.readdir(path.join(root, bucket.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue
      const id = bareId(entry.name)
      if (id === null) continue
      const dir = path.join(root, bucket.name, entry.name)
      let files
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      const log = files.find((file) => file.endsWith('.jsonl.zstd') || file.endsWith('.jsonl'))
      entries.push({ id, dir, logPath: log === undefined ? null : path.join(dir, log) })
    }
  }
  return entries
}

/**
 * The conversation and every subagent session it spawned, breadth first.
 *
 * Subagent sessions are flat siblings of their parent under the same bucket and
 * are never listed in the sidebar, so nothing else would ever remove them. A
 * child is claimed only when its header says `origin: "subagent"` — a seeded or
 * forked conversation keeps `origin` unset and is left alone.
 * @param home - resolved dsh home directory.
 * @param rootId - bare uuid of the conversation being deleted.
 * @returns the subtree in deletion order, root first.
 */
async function collectSubtree(home, rootId) {
  const entries = await scanSessionLogs(home)
  const childrenOf = new Map()
  for (const entry of entries) {
    if (entry.logPath === null) continue
    const header = await readHeader(entry.logPath)
    if (header === null || header.origin !== 'subagent') continue
    const parent = bareId(typeof header.parentSession === 'string' ? header.parentSession : '')
    if (parent === null || parent === entry.id) continue
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [entry.id])
    else bucket.push(entry.id)
  }

  const order = []
  const visited = new Set()
  let frontier = [rootId]
  for (let depth = 0; depth <= MAX_CASCADE_DEPTH && frontier.length > 0; depth++) {
    const next = []
    for (const id of frontier) {
      if (visited.has(id)) continue
      visited.add(id)
      order.push(id)
      for (const child of childrenOf.get(id) ?? []) if (!visited.has(child)) next.push(child)
    }
    frontier = next
  }
  return order
}

/**
 * Attachment digests referenced by the given logs.
 * @param logPaths - absolute log paths to read.
 * @returns the digests found, without the `sha256:` prefix.
 */
async function digestsInLogs(logPaths) {
  const digests = new Set()
  if (!zstdAvailable()) return digests
  for (const logPath of logPaths) {
    let buffer
    try {
      buffer = await fs.readFile(logPath)
    } catch {
      continue
    }
    for (const match of decodeLogText(buffer).matchAll(DIGEST_REF)) digests.add(match[0].slice(7))
  }
  return digests
}

/**
 * Attachment digests still referenced by any log that survives.
 * @param home - resolved dsh home directory.
 * @returns the referenced digests.
 */
async function referencedDigests(home) {
  const entries = await scanSessionLogs(home)
  const digests = new Set()
  if (!zstdAvailable()) return digests
  for (const entry of entries) {
    if (entry.logPath === null) continue
    let buffer
    try {
      buffer = await fs.readFile(entry.logPath)
    } catch {
      continue
    }
    for (const match of decodeLogText(buffer).matchAll(DIGEST_REF)) digests.add(match[0].slice(7))
  }
  return digests
}

/** Every stored attachment object under `attachments/v1/objects`. */
async function listAttachmentObjects(home) {
  const root = path.join(home, 'attachments', 'v1', 'objects')
  let prefixes
  try {
    prefixes = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const objects = []
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue
    let names
    try {
      names = await fs.readdir(path.join(root, prefix.name))
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name) || name.slice(0, 2) !== prefix.name) continue
      const full = path.join(root, prefix.name, name)
      try {
        const stat = await fs.stat(full)
        if (!stat.isFile()) continue
        objects.push({ sha: name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // Raced with another collector; nothing to report.
      }
    }
  }
  return objects
}

/**
 * Delete attachment objects whose last reference is gone.
 *
 * Content addressing means several conversations share one object, so this must
 * never delete by conversation: the surviving-reference scan decides. Objects
 * younger than `graceMs` are kept because a concurrent turn may still be
 * holding a reference that has not reached its log.
 * @param home - resolved dsh home directory.
 * @param options - candidate digest set, grace window, and dry-run switch.
 * @returns a summary suitable for the wire.
 */
async function sweepAttachments(home, options) {
  const { candidates, graceMs, dryRun } = options
  const now = Date.now()
  const summary = {
    scanned: 0, candidates: candidates === undefined ? 'all' : candidates.size,
    referenced: 0, keptRecent: 0, deleted: [], bytes: 0, dryRun,
    requestImagesCleared: false, errors: [],
  }
  const objects = await listAttachmentObjects(home)
  summary.scanned = objects.length
  if (objects.length === 0) return summary
  const referenced = await referencedDigests(home)
  for (const object of objects) {
    if (candidates !== undefined && !candidates.has(object.sha)) continue
    if (referenced.has(object.sha)) {
      summary.referenced++
      continue
    }
    if (now - object.mtimeMs < graceMs) {
      summary.keptRecent++
      continue
    }
    if (!dryRun) {
      try {
        await fs.rm(object.path, { force: true })
      } catch (error) {
        summary.errors.push({ path: object.path, error: describeError(error) })
        continue
      }
    }
    summary.deleted.push(object.sha)
    summary.bytes += object.bytes
  }
  // Derived model-request variants survive their source, so a collected object
  // leaves an unreachable copy behind. The whole variant cache is disposable
  // and re-encodes on demand.
  if (summary.deleted.length > 0 && !dryRun) {
    try {
      await fs.rm(path.join(home, 'cache', 'attachments', 'request-images'), { recursive: true, force: true })
      summary.requestImagesCleared = true
    } catch {
      // Regenerable; a failure here is not a deletion failure.
    }
  }
  return summary
}

/**
 * Whole-conversation backups some plugin leaves beside the buckets.
 *
 * They are named after the first eight hex characters of the session id, so
 * only files carrying a `.bak` marker and that prefix are claimed.
 * @param home - resolved dsh home directory.
 * @param bare - bare session uuid.
 * @returns absolute file paths.
 */
async function findStrayBackups(home, bare) {
  const root = path.join(home, 'sessions')
  const short = bare.slice(0, 8)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.includes('.bak')) continue
    if (!entry.name.startsWith('session-' + short) && !entry.name.startsWith(short)) continue
    found.push(path.join(root, entry.name))
  }
  return found
}

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
 * Erase every file-level artifact of one session id.
 * @param home - resolved dsh home directory.
 * @param bare - bare session uuid.
 * @returns the removed paths and the failures.
 */
async function eraseSessionFiles(home, bare) {
  const removed = []
  const failed = []

  for (const dir of await findSessionDirs(home, bare)) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      failed.push({ path: dir, error: describeError(error) })
    }
  }

  for (const name of storageNames(bare)) {
    const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', name + '.json')
    try {
      await fs.rm(cacheFile, { force: true })
      removed.push(cacheFile)
    } catch (error) {
      failed.push({ path: cacheFile, error: describeError(error) })
    }
  }

  for (const backup of await findStrayBackups(home, bare)) {
    try {
      await fs.rm(backup, { force: true })
      removed.push(backup)
    } catch (error) {
      failed.push({ path: backup, error: describeError(error) })
    }
  }

  return { removed, failed }
}

/** Whether a path is gone. */
async function gone(target) {
  try {
    await fs.stat(target)
    return false
  } catch {
    return true
  }
}

/**
 * Confirm every artifact is gone, then retry once after the write-behind window.
 *
 * A live session stays resident in the host, and its projection checkpoint is
 * written from a throttled queue; deleting the row can therefore be followed by
 * the host writing it again. Verified-then-rechecked beats trusting one `rm`.
 * @param home - resolved dsh home directory.
 * @param ids - bare uuids of the whole subtree.
 * @param removedPaths - paths the first pass reports as removed.
 * @returns what reappeared, what was removed on the retry, and what is left.
 */
async function verifyAndRetry(home, ids, removedPaths) {
  const result = { reappeared: [], retried: [], remaining: [] }
  await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS))

  const watch = [...removedPaths]
  for (const bare of ids) {
    for (const name of storageNames(bare)) {
      watch.push(path.join(home, 'storages', 'session_projcache', 'sessions', name + '.json'))
    }
  }

  for (const target of watch) {
    if (await gone(target)) continue
    result.reappeared.push(target)
    try {
      await fs.rm(target, { recursive: true, force: true })
      result.retried.push(target)
    } catch {
      result.remaining.push(target)
    }
  }
  if (result.retried.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS / 2))
    for (const target of result.retried) if (!(await gone(target))) result.remaining.push(target)
  }
  return result
}

/**
 * Drop the deleted ids from workspace navigation state through the live service.
 *
 * Archived ids are only ever added by the client's archive-first flow, so a
 * deleted conversation would otherwise keep an id in the global archive set
 * forever. Membership is dropped too. Both calls go through the registry's own
 * serialized write chain, so nothing races the controller's flush.
 * @param ctx - host context.
 * @param wireIds - ids in `session-<uuid>` form.
 * @returns what the service was asked to do.
 */
async function dropNavigationEntries(ctx, wireIds) {
  const result = { unarchived: [], detached: [], errors: [] }
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null) {
    result.errors.push('workspaceRegistry 不可用，已归档状态需宿主下次启动自检')
    return result
  }
  for (const wireId of wireIds) {
    try {
      if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(wireId)
      result.unarchived.push(wireId)
    } catch (error) {
      result.errors.push('取消归档失败 ' + wireId + '：' + describeError(error))
    }
  }
  if (typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      for (const wireId of wireIds) {
        try {
          if (typeof workspace?.sessionIds?.includes !== 'function') continue
          if (!workspace.sessionIds.includes(wireId)) continue
          if (typeof workspace.detachSession !== 'function') continue
          await workspace.detachSession(wireId)
          result.detached.push(wireId)
        } catch (error) {
          result.errors.push('摘除会话失败 ' + wireId + '：' + describeError(error))
        }
      }
    }
  }
  return result
}

/**
 * Which archived ids and projection-cache rows no longer have a session behind
 * them.
 *
 * The archive set is append-only in the product: the client archives before it
 * deletes, and nothing ever drops the id, so a deleted conversation leaves one
 * id in `workspace.json` forever. A cache row can outlive its log too — it is
 * written from a throttled queue, so an early build of this plugin (or any
 * deletion that skipped it) leaves a checkpoint carrying the title and first
 * prompt. An id with no log cannot be rendered by any list, so dropping it is
 * safe — but ids that are live (a created-but-unwritten blank conversation) are
 * reported separately and never touched.
 * @param ctx - host context.
 * @param home - resolved dsh home directory.
 * @returns the dead ids, the spared live ids, the orphan cache rows, and the total checked.
 */
async function planArchivePrune(ctx, home) {
  const registry = ctx.get('workspaceRegistry')
  const supported = registry !== undefined && registry !== null && Array.isArray(registry.archivedSessionIds)
  const archived = supported ? [...registry.archivedSessionIds].map(String) : []
  const onDisk = new Set((await scanSessionLogs(home)).map((entry) => entry.id))

  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
  let rows = []
  try {
    rows = await fs.readdir(cacheRoot, { withFileTypes: true })
  } catch {
    // No cache at all: nothing to retire.
  }
  const deadCacheRows = []
  for (const row of rows) {
    if (!row.isFile() || !row.name.endsWith('.json')) continue
    const bare = bareId(row.name.slice(0, -'.json'.length).replace(/^session-/, ''))
    if (bare === null) continue
    if (!onDisk.has(bare)) deadCacheRows.push(path.join(cacheRoot, row.name))
  }

  if (!supported) {
    return { supported: false, checked: 0, dead: [], live: [], deadCacheRows }
  }
  if (archived.length === 0) return { supported: true, checked: 0, dead: [], live: [], deadCacheRows }

  const sessions = ctx.get('sessions')
  const dead = []
  const live = []
  for (const wireId of archived) {
    const bare = bareId(wireId)
    if (bare === null) continue
    if (onDisk.has(bare)) continue
    const resident = typeof sessions?.get === 'function' ? sessions.get(wireId) !== undefined : false
    if (resident) live.push(wireId)
    else dead.push(wireId)
  }
  return { supported: true, checked: archived.length, dead, live, deadCacheRows }
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

/** Write one JSON response with no caching. */
function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * Mount the delete endpoint and the attachment collector.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        respond(res, 405, { error: 'method not allowed' })
        return
      }

      try {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch (error) {
          respond(res, 400, { error: '请求体不是合法 JSON：' + describeError(error) })
          return
        }

        const wireId = payload?.sessionId
        const bare = bareId(wireId)
        if (bare === null) {
          respond(res, 400, { error: '缺少或非法的 sessionId' })
          return
        }
        const sessionId = typeof wireId === 'string' && wireId.startsWith('session-') ? wireId : 'session-' + bare

        // A running session is terminated rather than refused: the caller has
        // already confirmed a permanent delete, so a live agent is an obstacle
        // to clear, not a reason to stop.
        const stop = await forceStop(ctx, sessionId)

        const home = dshHome()
        const dirs = await findSessionDirs(home, bare)

        // No log on disk is a failure, not a silent success: returning 200 here
        // made the client believe a merely archived session had been erased.
        // A resident session that was never flushed is the one legitimate
        // no-log case.
        if (dirs.length === 0 && !stop.wasLive) {
          // Nothing exists on disk or in memory, so any row a browser still
          // shows is a ghost; drop it even though this call erased nothing.
          announceRemoved(ctx, sessionId)
          respond(res, 404, { error: '磁盘上找不到该对话的记录（' + sessionId + '），未删除任何文件' })
          return
        }

        // Children first in the crawl, but the root is deleted with them: the
        // order inside the batch does not matter, only that none is missed.
        const subtree = await collectSubtree(home, bare)
        const children = subtree.filter((id) => id !== bare)

        for (const child of children) await forceStop(ctx, 'session-' + child)

        // Read attachment references before the logs holding them disappear.
        const logs = []
        for (const id of subtree) {
          for (const dir of await findSessionDirs(home, id)) {
            let files = []
            try {
              files = await fs.readdir(dir)
            } catch {
              continue
            }
            const log = files.find((file) => file.endsWith('.jsonl.zstd') || file.endsWith('.jsonl'))
            if (log !== undefined) logs.push(path.join(dir, log))
          }
        }
        const candidates = await digestsInLogs(logs)

        const removed = []
        const failed = []
        for (const id of subtree) {
          const result = await eraseSessionFiles(home, id)
          removed.push(...result.removed)
          failed.push(...result.failed)
        }

        const verified = await verifyAndRetry(home, subtree, removed)
        const clean = verified.remaining.length === 0 && failed.length === 0

        // Navigation state is only dropped once the bytes are confirmed gone; a
        // failed delete stays archived and recoverable.
        const registry = clean
          ? await dropNavigationEntries(ctx, subtree.map((id) => 'session-' + id))
          : { skipped: '删除未完全成功，保留归档状态以便找回' }

        // The archive set is append-only in the product, so every earlier delete
        // may still be holding an id for a conversation that no longer exists.
        const pruned = { checked: 0, dropped: [], droppedCacheRows: [], errors: [] }
        if (clean) {
          const plan = await planArchivePrune(ctx, home)
          pruned.checked = plan.checked
          const service = ctx.get('workspaceRegistry')
          for (const wireId of plan.dead) {
            try {
              await service.unarchiveSession(wireId)
              pruned.dropped.push(wireId)
            } catch (error) {
              pruned.errors.push('清理归档 id 失败 ' + wireId + '：' + describeError(error))
            }
          }
          for (const row of plan.deadCacheRows) {
            try {
              await fs.rm(row, { force: true })
              pruned.droppedCacheRows.push(row)
            } catch (error) {
              pruned.errors.push('清理残留缓存行失败 ' + row + '：' + describeError(error))
            }
          }
        }

        // The deleted conversation's own attachments are now candidates; the
        // surviving-reference scan inside refuses any object another
        // conversation still uses.
        const attachments = candidates.size === 0
          ? { scanned: 0, candidates: 0, deleted: [], bytes: 0 }
          : await sweepAttachments(home, { candidates, graceMs: ATTACHMENT_GRACE_MS, dryRun: false })

        let announced = false
        for (const id of subtree) announced = announceRemoved(ctx, 'session-' + id) || announced

        ctx.logger?.('dshx-session-delete')?.info?.(
          'deleted session %s (live=%s, sessions=%d, paths=%d, attachments=%d)',
          sessionId, String(stop.wasLive), subtree.length, removed.length, attachments.deleted.length)

        respond(res, 200, {
          ok: true,
          sessionId,
          hadLog: dirs.length > 0,
          removed,
          failed,
          terminated: stop,
          children,
          verified: {
            reappeared: verified.reappeared,
            retried: verified.retried,
            remaining: verified.remaining,
          },
          registry,
          pruned,
          attachments,
          announced,
        })
      } catch (error) {
        respond(res, 500, { error: describeError(error) })
      }
    },
  }), 'dshx-session-delete-route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: GC_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        let payload = {}
        try {
          const text = await readBody(req)
          if (text.trim().length > 0) payload = JSON.parse(text)
        } catch (error) {
          respond(res, 400, { error: '请求体不是合法 JSON：' + describeError(error) })
          return
        }
        const dryRun = payload?.dryRun !== false
        const graceMinutes = Number.isFinite(payload?.graceMinutes) ? Math.max(0, payload.graceMinutes) : 60
        const summary = await sweepAttachments(dshHome(), {
          candidates: undefined,
          graceMs: graceMinutes * 60 * 1000,
          dryRun,
        })
        respond(res, 200, { ok: true, ...summary })
      } catch (error) {
        respond(res, 500, { error: describeError(error) })
      }
    },
  }), 'dshx-session-delete-gc-route')

  // Retire archive-set ids whose conversation no longer exists. Dry run by
  // default: the caller decides when navigation state may be written.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PRUNE_ROUTE,
    handler: async (req, res) => {
      if ((req.method ?? 'GET') !== 'POST') {
        respond(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        let payload = {}
        try {
          const text = await readBody(req)
          if (text.trim().length > 0) payload = JSON.parse(text)
        } catch (error) {
          respond(res, 400, { error: '请求体不是合法 JSON：' + describeError(error) })
          return
        }
        const dryRun = payload?.dryRun !== false
        const plan = await planArchivePrune(ctx, dshHome())
        const dropped = []
        const droppedCacheRows = []
        const errors = []
        if (!dryRun) {
          if (plan.supported) {
            const service = ctx.get('workspaceRegistry')
            for (const wireId of plan.dead) {
              try {
                await service.unarchiveSession(wireId)
                dropped.push(wireId)
              } catch (error) {
                errors.push('清理归档 id 失败 ' + wireId + '：' + describeError(error))
              }
            }
          }
          for (const row of plan.deadCacheRows) {
            try {
              await fs.rm(row, { force: true })
              droppedCacheRows.push(row)
            } catch (error) {
              errors.push('清理残留缓存行失败 ' + row + '：' + describeError(error))
            }
          }
        }
        respond(res, 200, { ok: true, dryRun, ...plan, dropped, droppedCacheRows, errors })
      } catch (error) {
        respond(res, 500, { error: describeError(error) })
      }
    },
  }), 'dshx-session-delete-prune-route')
}

/** Internals exposed for the offline verification harness. */
export const internals = {
  bareId,
  identifyStorageNames: storageNames,
  frameStarts,
  decodeLogText,
  parseHeader,
  collectSubtree,
  digestsInLogs,
  referencedDigests,
  sweepAttachments,
  findStrayBackups,
  eraseSessionFiles,
  planArchivePrune,
}
