// Offline verification for dshx-session-delete against a synthetic DSH home.
// Run with: node verify.mjs — builds a temporary DSH_HOME and a stub ctx, then
// drives the real HTTP handlers. No host and no real data are touched.
// Covers: cascade delete, both log-directory spellings, projection-cache rows,
// stray backups, attachment reference accounting, dry-run GC, 404/400/405, pruning.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-del-verify-'))
process.env.DSH_HOME = HOME

const plugin = await import(new URL('./index.js', import.meta.url).href)

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const PARENT = uuid(1)
const CHILD = uuid(2)
const GRAND = uuid(3)
const SIBLING = uuid(4)
const OTHER = uuid(5)
const DEAD_ARCHIVE = uuid(6)
const LIVE_BLANK = uuid(7)
const DEAD_ARCHIVE2 = uuid(8)

const onlyParent = 'a'.repeat(64)
const shared = 'b'.repeat(64)
const unreferenced = 'c'.repeat(64)
const freshOnlyParent = 'd'.repeat(64)

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** A log = header frame + one body frame per line (mirrors the real backend). */
function writeLog(dir, header, bodies = []) {
  fs.mkdirSync(dir, { recursive: true })
  const parts = [frame(JSON.stringify(header) + '\n')]
  for (const body of bodies) parts.push(frame(JSON.stringify(body) + '\n'))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(parts))
}

const bucket = path.join(HOME, 'sessions', '--F-ds--')
const direct = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: 'F:\\ds', ...extra })
const body = (digest) => ({
  type: 'user/message', seq: 1, time: 2,
  data: { content: [{ type: 'image', attachmentId: 'sha256:' + digest }] },
})

writeLog(path.join(bucket, PARENT), direct(PARENT), [body(onlyParent), body(shared), body(freshOnlyParent)])
writeLog(path.join(bucket, CHILD), direct(CHILD, { origin: 'subagent', parentSession: 'session-' + PARENT, delegationDepth: 1 }))
writeLog(path.join(bucket, GRAND), direct(GRAND, { origin: 'subagent', parentSession: 'session-' + CHILD, delegationDepth: 2 }))
writeLog(path.join(bucket, SIBLING), direct(SIBLING, { origin: 'subagent', parentSession: 'session-' + OTHER, delegationDepth: 1 }))
writeLog(path.join(bucket, OTHER), direct(OTHER), [body(shared)])

// Old-layout (bare uuid) directory for the child too: both spellings must go.
const legacyBucket = path.join(HOME, 'sessions', '--C-Users-legacy--')
writeLog(path.join(legacyBucket, 'session-' + CHILD), direct(CHILD, { origin: 'subagent', parentSession: 'session-' + PARENT }))

// Stray whole-conversation backups: one for us, one for somebody else.
const stray = path.join(HOME, 'sessions', 'session-' + PARENT.slice(0, 8) + '.v4.jsonl.zstd.bak-prompt-edit')
fs.writeFileSync(stray, 'backup')
const foreignStray = path.join(HOME, 'sessions', 'session-' + OTHER.slice(0, 8) + '.v4.jsonl.zstd.bak-prompt-edit')
fs.writeFileSync(foreignStray, 'backup')

// Projection cache rows, both id spellings.
const cacheDir = path.join(HOME, 'storages', 'session_projcache', 'sessions')
fs.mkdirSync(cacheDir, { recursive: true })
for (const name of ['session-' + PARENT, CHILD]) {
  fs.writeFileSync(path.join(cacheDir, name + '.json'), JSON.stringify({ version: 7, record: {} }))
}
// A row whose log is long gone: pre-existing residue the prune must retire.
const STALE_CACHE = uuid(9)
const staleRow = path.join(cacheDir, 'session-' + STALE_CACHE + '.json')
fs.writeFileSync(staleRow, JSON.stringify({ version: 7, record: { title: 'gone' } }))

// Attachment objects: old-only-parent, shared, unreferenced, fresh-only-parent.
const objects = path.join(HOME, 'attachments', 'v1', 'objects')
function putObject(digest, ageMs, bytes = 'x') {
  const dir = path.join(objects, digest.slice(0, 2))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, digest)
  fs.writeFileSync(file, bytes.repeat(64))
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(file, when, when)
  }
  return file
}
const oldOnlyParent = putObject(onlyParent, 48 * 3600 * 1000)
const sharedFile = putObject(shared, 48 * 3600 * 1000)
const unreferencedFile = putObject(unreferenced, 48 * 3600 * 1000)
const freshFile = putObject(freshOnlyParent, 0)

// Derived request-image cache.
const variants = path.join(HOME, 'cache', 'attachments', 'request-images', 'aa')
fs.mkdirSync(variants, { recursive: true })
fs.writeFileSync(path.join(variants, 'variant'), 'v')

// --- fake host -------------------------------------------------------------
const handlers = new Map()
const calls = { unarchived: [], detached: [], emitted: [] }
const workspace = {
  sessionIds: ['session-' + PARENT, 'session-' + OTHER],
  async detachSession(id) { calls.detached.push(id) },
}
// Archive set: one id whose log is gone, one live-but-never-written blank
// conversation (must be spared), and the conversation being deleted.
const archiveSet = ['session-' + DEAD_ARCHIVE, 'session-' + LIVE_BLANK, 'session-' + PARENT]
const residentBlank = 'session-' + LIVE_BLANK
const sessionsStub = {
  get(id) { return id === residentBlank ? { id } : undefined },
  async flush() {},
}
const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register({ path: route, handler }) { handlers.set(route, handler); return () => {} } },
  get(name) {
    if (name === 'workspaceRegistry') {
      return {
        list: () => [workspace],
        archivedSessionIds: archiveSet,
        async unarchiveSession(id) {
          calls.unarchived.push(id)
          const at = archiveSet.indexOf(id)
          if (at !== -1) archiveSet.splice(at, 1)
        },
      }
    }
    if (name === 'sessions') return sessionsStub
    return undefined
  },
  emit(type, id) { calls.emitted.push(type + ':' + id) },
  logger: () => ({ info() {}, warn() {} }),
}
plugin.apply(ctx)

async function post(route, payload) {
  const handler = handlers.get(route)
  assert.ok(handler, 'route mounted: ' + route)
  const req = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) },
  }
  const res = {
    status: 0, body: undefined,
    writeHead(status) { this.status = status },
    end(text) { this.body = JSON.parse(text) },
  }
  await handler(req, res)
  return res
}

const exists = (target) => fs.existsSync(target)

// --- case 1: cascade + cleanup --------------------------------------------
const response = await post('/dshx-session-delete/delete', { sessionId: 'session-' + PARENT })
print('delete status', response.status)
assert.equal(response.status, 200, JSON.stringify(response.body))
const out = response.body

assert.equal(exists(path.join(bucket, PARENT)), false, 'parent log dir removed')
assert.equal(exists(path.join(bucket, CHILD)), false, 'child log dir removed')
assert.equal(exists(path.join(bucket, GRAND)), false, 'grandchild log dir removed')
assert.equal(exists(path.join(legacyBucket, 'session-' + CHILD)), false, 'legacy-spelling child dir removed')
assert.equal(exists(path.join(bucket, SIBLING)), true, 'sibling subagent of another parent survives')
assert.equal(exists(path.join(bucket, OTHER)), true, 'unrelated conversation survives')
assert.deepEqual(out.children.sort(), [CHILD, GRAND].sort(), 'children reported')
assert.equal(exists(path.join(cacheDir, 'session-' + PARENT + '.json')), false, 'parent cache row removed')
assert.equal(exists(path.join(cacheDir, CHILD + '.json')), false, 'child cache row removed')
assert.equal(exists(stray), false, 'stray backup removed')
assert.equal(exists(foreignStray), true, 'foreign stray backup untouched')
assert.deepEqual(out.verified.remaining, [], 'nothing remained')
assert.ok(out.registry.unarchived.includes('session-' + CHILD), 'child id dropped from archive set')
assert.ok(calls.detached.includes('session-' + PARENT), 'parent detached from workspace')
assert.ok(calls.emitted.includes('api-session/removed:session-' + GRAND), 'grandchild announced')

// Archive-set hygiene: the dead id retires, the live blank one is spared.
assert.ok(out.pruned.dropped.includes('session-' + DEAD_ARCHIVE), 'dead archive id dropped')
assert.equal(out.pruned.dropped.includes(residentBlank), false, 'live blank conversation keeps its archive id')
assert.equal(archiveSet.includes(residentBlank), true, 'live blank id still archived')
assert.equal(archiveSet.includes('session-' + PARENT), false, 'deleted conversation id gone from archive set')
assert.equal(exists(staleRow), false, 'orphan projection-cache row retired')
assert.ok(out.pruned.droppedCacheRows.some((row) => row.endsWith('session-' + STALE_CACHE + '.json')), 'orphan row reported')

// Attachments: only-parent old object goes, shared / fresh / unrelated survive.
assert.equal(exists(oldOnlyParent), false, 'orphaned attachment object collected')
assert.equal(exists(sharedFile), true, 'attachment shared with a surviving log kept')
assert.equal(exists(freshFile), true, 'fresh attachment inside the grace window kept')
assert.equal(exists(unreferencedFile), true, 'unrelated orphan not claimed by a targeted sweep')
assert.equal(exists(path.join(variants, 'variant')), false, 'derived request-image cache cleared')
assert.deepEqual(out.attachments.deleted, [onlyParent])
print('attachments', out.attachments)

// --- case 2: dry-run collector sees the global orphan, deletes nothing ------
const dry = await post('/dshx-session-delete/attachments/gc', { dryRun: true })
assert.equal(dry.status, 200)
assert.deepEqual(dry.body.deleted.sort(), [unreferenced].sort())
assert.equal(exists(unreferencedFile), true, 'dry run must not delete')
print('dry run', { scanned: dry.body.scanned, deleted: dry.body.deleted })

// --- case 3: real collector -------------------------------------------------
const real = await post('/dshx-session-delete/attachments/gc', { dryRun: false })
assert.equal(real.status, 200)
assert.deepEqual(real.body.deleted.sort(), [unreferenced].sort())
assert.equal(exists(unreferencedFile), false, 'real run collected the orphan')
assert.equal(exists(sharedFile), true, 'referenced object still kept')

// --- case 4: unknown id -> 404, nothing deleted -----------------------------
const missing = await post('/dshx-session-delete/delete', { sessionId: 'session-' + uuid(99) })
assert.equal(missing.status, 404)
print('missing status', missing.status)

// --- case 5: bad id -> 400 --------------------------------------------------
const bad = await post('/dshx-session-delete/delete', { sessionId: '../../etc' })
assert.equal(bad.status, 400)

// --- case 5b: prune route, dry run then real --------------------------------
archiveSet.push('session-' + DEAD_ARCHIVE2)
const pruneDry = await post('/dshx-session-delete/prune', { dryRun: true })
assert.equal(pruneDry.status, 200)
assert.ok(pruneDry.body.dead.includes('session-' + DEAD_ARCHIVE2), 'prune sees the dead id')
assert.equal(pruneDry.body.dropped.length, 0, 'dry run drops nothing')
assert.equal(archiveSet.includes('session-' + DEAD_ARCHIVE2), true)
const pruneReal = await post('/dshx-session-delete/prune', { dryRun: false })
assert.deepEqual(pruneReal.body.dropped, ['session-' + DEAD_ARCHIVE2])
assert.equal(archiveSet.includes('session-' + DEAD_ARCHIVE2), false, 'real prune dropped it')
assert.ok(pruneReal.body.live.includes(residentBlank), 'blank live conversation reported as spared')
print('prune', { dead: pruneReal.body.dead.length, dropped: pruneReal.body.dropped.length, live: pruneReal.body.live })

// --- case 6: method gate ----------------------------------------------------
const getHandler = handlers.get('/dshx-session-delete/delete')
const getRes = { status: 0, body: undefined, writeHead(s) { this.status = s }, end(t) { this.body = JSON.parse(t) } }
await getHandler({ method: 'GET' }, getRes)
assert.equal(getRes.status, 405)

print('OK', { home: HOME })
fs.rmSync(HOME, { recursive: true, force: true })

function print(label, value) {
  console.log('•', label, JSON.stringify(value))
}
