/**
 * Ad-hoc host drive: boots the plugin through apply() with a stub cordis
 * context, runs the builder tools end-to-end (begin -> SSE frame -> patch ->
 * get -> launch blocked on required fields -> structure -> discard), and
 * collects the /events SSE frames the routes would stream to the browser.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host.js'

process.env.DSH_RICH_QUESTIONS_HOME = join(await mkdtemp(join(tmpdir(), 'rq-home-')))
const workspaceRoot = await mkdtemp(join(tmpdir(), 'rq-ws-'))

const defs = []
const routes = []
const agent = { id: 'conv-1', session: { header: { cwd: workspaceRoot } } }
const ctx = {
  effect(fn) { fn(); return () => {} },
  systemPrompt: { section() {} },
  tools: { register(def) { defs.push(def) } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  agents: { get: (id) => (id === 'conv-1' ? agent : undefined), roots: () => [agent] },
}
apply(ctx, {})
const byName = new Map(defs.map((def) => [def.name, def]))
assert.equal(defs.length, 4, `expected 4 tools, got ${defs.map((d) => d.name).join(', ')}`)

// Subscribe to the events route with a fake SSE response to collect frames.
// The route keeps a heartbeat interval until 'close' fires; collect those
// handlers and fire them at the end so the test process drains.
const frames = []
const closeHandlers = []
const fakePeer = { once(event, fn) { if (event === 'close') closeHandlers.push(fn) } }
const eventsRoute = routes.find((route) => route.path.endsWith('/events'))
await eventsRoute.handler(
  { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'same-origin' }, ...fakePeer },
  { writeHead() {}, write(chunk) { frames.push(String(chunk)) }, ...fakePeer, end() {} },
)

const exec = { agent, signal: new AbortController().signal }
const fiveKeys = ['a', 'b', 'c', 'd', 'e']

const begun = await byName.get('survey_draft_set').execute({ op: 'begin', title: 'Drive Test', survey: { entry: 'q1', questions: { q1: { options: fiveKeys.map((key) => ({ key })) } } } }, exec)
assert.equal(begun.slug, 'drive-test')
assert.equal(begun.completeness.ready, false)
assert.ok(frames.some((chunk) => chunk.includes('draft/updated') && chunk.includes('drive-test')), 'begin did not emit a draft frame')

const patched = await byName.get('survey_draft_set').execute({ op: 'patch', questions: { q1: { prompt: 'Pick?', options: fiveKeys.map((key) => ({ key, label: `L${key}`, description: 'd', insight: 'i', sources: ['s'] })) } } }, exec)
assert.equal(patched.completeness.ready, true)
assert.equal(patched.revision, 0)

const got = await byName.get('survey_draft_get').execute({}, exec)
assert.equal(got.slug, 'drive-test')
assert.equal(got.completeness.incomplete.length, 0)

// Launch on a fresh draft with gaps must refuse with the grouped checklist.
await byName.get('survey_draft_set').execute({ op: 'begin', title: 'Gapped', survey: { entry: 'q1', questions: { q1: { options: fiveKeys.map((key) => ({ key })) } } } }, exec)
await assert.rejects(
  () => byName.get('survey_draft_launch').execute({}, exec),
  (error) => error.code === 'SURVEY_DRAFT_INCOMPLETE' && /options\[0\]/.test(error.message),
  'launch must refuse a gapped draft with the checklist',
)

const structured = await byName.get('survey_draft_set').execute({ op: 'structure', survey: { entry: 'q1', questions: { q1: { prompt: 'P?', options: fiveKeys.map((key) => ({ key, label: `L${key}`, description: 'd', insight: 'i', sources: ['s'] })) } } } }, exec)
assert.equal(structured.revision, 1)

const discarded = await byName.get('survey_draft_set').execute({ op: 'discard' }, exec)
assert.equal(discarded.status, 'discarded')
assert.ok(frames.some((chunk) => chunk.includes('"status":"discarded"')), 'discard did not emit its frame')

console.log('host drive OK: 4 tools, begin/patch/get/launch-gate/structure/discard, SSE frames observed')
for (const fn of closeHandlers) fn() // drain the heartbeat so the test process exits
