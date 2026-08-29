/**
 * Ad-hoc host drive: boots the plugin through apply() with a stub cordis
 * context, runs the builder tools end-to-end (begin -> SSE frame -> patch ->
 * get -> launch blocked on required fields -> structure -> discard), and
 * collects the /events SSE frames the routes would stream to the browser.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
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
assert.equal(defs.length, 5, `expected 5 tools, got ${defs.map((d) => d.name).join(', ')}`)
for (const definition of defs) {
  assert.equal(definition.output?.schema?.type, 'object', `${definition.name} must declare an object output schema`)
  assert.equal(typeof definition.output?.render, 'function', `${definition.name} must declare an output renderer`)
}

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

// --- Full dogfood loop on the completed 'Drive Test' draft: quick templates
// authored last, launch, the user answers through the action route, the
// settled record lands on disk, then a reroll reopens the draft.
const quicked = await byName.get('survey_draft_set').execute({
  op: 'patch',
  slug: 'drive-test',
  intro: '## Intro page',
  quick: [{ key: 'a', label: 'Ship it', answers: { q1: { selected: ['a'] } } }],
}, exec)
assert.equal(quicked.slug, 'drive-test')
const draftFile = JSON.parse(await readFile(join(workspaceRoot, '.dsh', 'survey-drafts', 'drive-test.json'), 'utf8'))
assert.equal(draftFile.survey.intro, '## Intro page')
assert.equal(draftFile.survey.quick.length, 1)
assert.equal(draftFile.survey.title, 'Drive Test', 'begin must default the survey title from the draft title')

const actionRoute = routes.find((route) => route.path.endsWith('/action'))
const callAction = async (body) => {
  let json
  const res = { writeHead() {}, end(chunk) { json = JSON.parse(String(chunk)) }, ...fakePeer }
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    ...fakePeer,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  await actionRoute.handler(req, res)
  return json
}

const surveyIdFromFrames = () => {
  const chunk = [...frames].reverse().find((entry) => entry.includes('"survey/requested"'))
  if (chunk === undefined) return undefined
  return JSON.parse(chunk.replace(/^data: /, '').trim()).surveyId
}

const settle = async (predicate, timeoutMs = 1500) => {
  // Poll rather than microtask-flush: the tool chain does real fs I/O before
  // the SSE frame lands, and setImmediate does not wait for pending I/O.
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const launchPromise = byName.get('survey_draft_launch').execute({ slug: 'drive-test' }, exec)
launchPromise.catch((error) => console.error('launch rejected:', error instanceof Error ? `${error.code}: ${error.message.slice(0, 200)}` : error))
const surveyId = await settle(surveyIdFromFrames)
assert.notEqual(surveyId, undefined, 'launch did not emit survey/requested')
const answeredAction = await callAction({ kind: 'answer', surveyId, answers: [{ id: 'q1', selected: ['a'] }] })
assert.equal(answeredAction.ok, true, `answer action failed: ${JSON.stringify(answeredAction)}`)
const answered = await launchPromise
assert.equal(answered.outcome, 'answered')
assert.deepEqual(answered.path, ['q1'])
assert.equal(answered.draft, 'drive-test')
assert.equal(answered.title, 'Drive Test', 'draft title should flow into the launched survey title')

const record = JSON.parse(await readFile(join(process.env.DSH_RICH_QUESTIONS_HOME, 'surveys', `${surveyId}.json`), 'utf8'))
assert.equal(record.outcome, 'answered')
assert.equal(record.title, 'Drive Test')
assert.ok(Array.isArray(record.answers) && record.answers.length === 1, 'settled record lacks the answers')

// Memory: the records reader finds the settled survey whole (prompt +
// labels + nothing injected anywhere — read-only by design).
const recs = await byName.get('survey_records').execute({ query: 'drive' }, exec)
assert.equal(recs.count, 1)
assert.equal(recs.records[0].title, 'Drive Test')
assert.equal(recs.records[0].answers[0].prompt, 'Pick?')
assert.equal(recs.records[0].answers[0].selected[0], 'La')
const recsAll = await byName.get('survey_records').execute({}, exec)
assert.ok(recsAll.count >= 1, 'unqueried read lists recent records')

// Reroll loop: relaunch, the user rerolls, the draft reopens.
const relaunchPromise = byName.get('survey_draft_launch').execute({ slug: 'drive-test' }, exec)
relaunchPromise.catch((error) => console.error('relaunch rejected:', error instanceof Error ? `${error.code}: ${error.message.slice(0, 200)}` : error))
const surveyId2 = await settle(() => {
  const latest = surveyIdFromFrames()
  return latest !== undefined && latest !== surveyId ? latest : undefined
})
assert.notEqual(surveyId2, undefined)
assert.notEqual(surveyId2, surveyId, 'relaunch must create a fresh pending survey')
const rerollAction = await callAction({ kind: 'reroll', surveyId: surveyId2 })
assert.equal(rerollAction.ok, true)
const rerolled = await relaunchPromise
assert.equal(rerolled.outcome, 'reroll')
assert.equal(rerolled.draftReopened, true)
assert.match(rerolled.instruction, /Reroll/)
const manifest = JSON.parse(await readFile(join(process.env.DSH_RICH_QUESTIONS_HOME, 'rich-questions', 'drafts', 'index.json'), 'utf8'))
assert.equal(manifest.drafts['drive-test'].status, 'reopened', 'reroll must reopen the draft in the manifest')
assert.ok(frames.some((chunk) => chunk.includes('"status":"reopened"')), 'reopen did not emit its frame')

console.log('host drive OK: 5 tools, begin/patch/get/launch-gate/structure/discard, quick+intro authoring, answer + settled record, records reader, reroll + reopen, SSE frames observed')
for (const fn of closeHandlers) fn() // drain the heartbeat so the test process exits
