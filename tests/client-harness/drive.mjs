/**
 * React+jsdom harness driving an actual client bundle through a real survey
 * spec: start page, one walked branch, quick screen, matched=null render
 * (the composer-killer class), and a poison spec that must be caught by the
 * SurveyBoundary error boundary instead of unmounting the composer.
 *
 * usage: node drive.mjs <client.bundle.js> <spec.json> [poison.json]
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const HARNESS = 'E:/Workspaces/01_Projects/01_Github/dsh-plugins/deepseek-harness'
const requireRoot = createRequire(HARNESS + '/package.json')
const requireWeb = createRequire(HARNESS + '/apps/web/package.json')
const { JSDOM } = requireRoot('jsdom')
const React = requireWeb('react')
const ReactDOMClient = requireWeb('react-dom/client')
const jsxRuntime = requireWeb('react/jsx-runtime')

const bundlePath = process.argv[2]
const specPath = process.argv[3]
const poisonPath = process.argv[4]
const SPEC = JSON.parse(readFileSync(specPath, 'utf8'))
const POISON = poisonPath ? JSON.parse(readFileSync(poisonPath, 'utf8')) : null
const LABEL = path.basename(bundlePath)

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:3080/conversation/x',
  pretendToBeVisual: true,
})

let pending = [{ surveyId: 'sv-1', sessionId: 'session-1', createdAt: Date.now(), spec: SPEC }]
let draftsManifest = null
global.window = dom.window
global.document = dom.window.document
global.localStorage = dom.window.localStorage
global.EventSource = class { constructor() { throw new Error('harness: no SSE') } }
global.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/state')) return { ok: true, json: async () => ({ surveys: pending, drafts: draftsManifest }) }
  if (target.includes('/action')) return { ok: true, json: async () => ({ ok: false, error: 'harness: action stubbed' }) }
  return { ok: false, json: async () => ({}) }
}

const errors = []
process.on('uncaughtException', (e) => errors.push(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => errors.push(`rejection: ${e?.message ?? String(e)}`))
dom.window.addEventListener('error', (e) => errors.push(`window: ${(e.error && e.error.stack) ? e.error.stack.split('\n').slice(0, 4).join(' | ') : e.message}`))

let captured = null
dom.window.__ModuleLoader__ = { load(mod) { captured = mod } }
vm.runInThisContext(readFileSync(bundlePath, 'utf8'), { filename: LABEL })

const primitives = new Proxy({}, {
  get(_target, name) {
    if (name === 'MarkdownText') return function MarkdownText(props) { return jsxRuntime.jsx('div', { 'data-md': '', children: String(props.text ?? '') }) }
    if (name === 'Tooltip') return function Tooltip(props) { return jsxRuntime.jsx('span', { 'data-tip': '1', children: props.children }) }
    return function rqIconStub() { return jsxRuntime.jsx('span', { 'data-icon': String(name) }) }
  },
})
const requireShim = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('harness: unexpected require ' + id)
}
const moduleExports = captured.factory(requireShim)

let registered = new Map()
let dicts = null
const ctx = {
  effect(fn) {
    try { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } }
    catch (e) { errors.push(`effect: ${e.message}`); return () => {} }
  },
  locale: { register(_ns, d) { dicts = d } },
  slots: {
    inject(_slot, run) { run() },
    register(def, Component) { registered.set(def.name, { def, Component }) },
  },
}
moduleExports.apply(ctx)
const composerEntry = registered.get('conversation.composer')
const dockEntry = registered.get('conversation.composer.dock')
if (composerEntry === undefined) { console.log(`[${LABEL}] FAIL: composer chain entry never registered`); process.exit(1) }
if (dockEntry === undefined) { console.log(`[${LABEL}] FAIL: composer dock entry never registered`); process.exit(1) }

document.dispatchEvent(new dom.window.Event('visibilitychange'))
await new Promise((r) => setTimeout(r, 120))
const matched = composerEntry.def.select({ session: { sessionId: 'session-1' } })
if (matched === null || matched === undefined) { console.log(`[${LABEL}] FAIL: store did not hydrate a pending survey`); process.exit(1) }
const en = dicts?.en ?? {}
const t = (k) => en[k] ?? k

const container = document.createElement('div')
document.body.appendChild(container)
const root = ReactDOMClient.createRoot(container)
root.render(React.createElement(composerEntry.Component, { matched, t }))
await new Promise((r) => setTimeout(r, 120))

const text = () => container.textContent ?? ''
const alive = () => (container.textContent ?? '').trim() !== '' && container.querySelectorAll('button').length > 0
const buttons = () => [...container.querySelectorAll('button')]
const findButton = (label) => buttons().find((b) => b.textContent === label)
const findRow = (needle) => [...container.querySelectorAll('.rq-line, button, [role="button"]')].find((el) => (el.textContent ?? '').includes(needle))

let failed = 0
const step = (name, fn) => {
  try { fn(); console.log(`[${LABEL}] PASS ${name}`) }
  catch (e) { failed += 1; console.log(`[${LABEL}] FAIL ${name}: ${e.message}`) }
}
const assert = (cond, msg) => { if (cond !== true) throw new Error(msg) }
const flush = () => new Promise((r) => setTimeout(r, 90))

step('start page: title + intro + quick entry', () => {
  assert(text().includes(SPEC.title), 'title missing')
  assert(text().includes('What this is'), 'intro missing')
  assert(findButton(t('action.quick')) !== undefined, 'quick button not found')
})

step('Start -> q1', () => {
  const btn = findButton(t('action.start')) ?? buttons().find((b) => /start/i.test(b.textContent ?? ''))
  assert(btn !== undefined, 'start button not found')
  btn.click()
})
await flush()
step('q1 renders prompt + 5 options', () => {
  assert(text().includes('drive the draft'), 'q1 prompt missing')
  assert(text().includes('Four lifecycle tools'), 'q1 option missing')
  assert(text().includes('Prompt-only convention'), 'q1 option e missing')
})

step('select option a', () => {
  const row = findRow('Four lifecycle tools')
  assert(row !== undefined, 'option row not found')
  row.click()
})
await flush()
step('next advances to q2', () => {
  const next = buttons().find((b) => /next/i.test(b.textContent ?? ''))
  assert(next !== undefined, `next button not found; buttons=[${buttons().map((b) => b.textContent).join('|')}]`)
  next.click()
})
await flush()
step('q2 renders after branch', () => {
  assert(text().includes('skeleton is the structure locked') || text().includes('Full frame'), 'q2 content missing')
  assert(alive(), 'container dead mid-walk')
})

step('insight expansion does not crash', () => {
  const info = buttons().find((b) => { const label = b.getAttribute('aria-label') ?? b.getAttribute('title') ?? ''; return /insight/i.test(label) })
  if (info) info.click()
  assert(alive(), 'container dead after insight expand')
})
await flush()

step('final state after walk: composer alive', () => assert(alive(), 'container dead at end'))

// Quick screen: back out to the intro (q2 -> q1 -> intro), then open it.
step('back navigation returns to intro', () => {
  const back = () => [...container.querySelectorAll('button')].find((b) => b.querySelector('[data-icon*="ChevronLeft"]') !== null)
  for (let i = 0; i < 3; i += 1) { const btn = back(); if (!btn) break; btn.click() }
})
await flush()
step('quick screen lists templates', () => {
  const quick = findButton(t('action.quick'))
  assert(quick !== undefined, 'quick button not reachable from intro')
  quick.click()
})
await flush()
step('quick template pick keeps composer alive', () => {
  assert(text().includes('Grounded & visible') || text().includes('Minimal file path'), `template list missing; text="${text().slice(0, 100)}"`)
  const row = findRow('Grounded & visible')
  if (row) row.click()
  assert(alive(), 'container dead after quick pick')
})
await flush()

step('matched=null renders empty, composer survives', () => {
  const before = errors.length
  root.render(React.createElement(composerEntry.Component, { matched: null, t }))
  return flush().then(() => {
    if (errors.length !== before) throw new Error(`runtime errors after null render: ${errors.slice(before).join(' ;; ').slice(0, 200)}`)
    assert(document.body.contains(container), 'container unmounted')
  })
})
await flush()

// Builder draft card: a dock row under the input, never a chain claimant.
// Regression (the "chat disappears" bug): the old bundle elected building
// drafts in the conversation.composer chain — hiding the composer fallback —
// and a dismissed card rendered null while still elected, leaving the whole
// composer seat empty.
pending.length = 0 // the survey settled; the chain seat must fall back
draftsManifest = {
  v: 1,
  activeByConversation: { 'session-1': 'builder-demo' },
  drafts: {
    'builder-demo': { status: 'building', title: 'Question Builder demo', conversationId: 'session-1', updatedAt: Date.now(), revision: 2, ready: false, progress: { questions: 12, complete: 4, missingFields: 23 } },
  },
}
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await flush()
step('building draft does NOT claim the composer chain', () => {
  const chainMatched = composerEntry.def.select({ session: { sessionId: 'session-1' } })
  assert(chainMatched === null, `chain elected a draft: ${JSON.stringify(chainMatched).slice(0, 80)}`)
})
// The dock row subscribes to the store itself: render once, then drive the
// store purely through hydration frames — no manual re-render.
const dockContainer = document.createElement('div')
document.body.appendChild(dockContainer)
const dockRoot = ReactDOMClient.createRoot(dockContainer)
dockRoot.render(React.createElement(dockEntry.Component, { sessionId: 'session-1', t }))
await flush()
const dockText = () => dockContainer.textContent ?? ''
const dockButtons = () => [...dockContainer.querySelectorAll('button')]
step('draft card renders as a dock row', () => {
  assert(dockText().includes('Question Builder demo'), 'draft title missing')
  assert(dockText().includes(t('draft.status.building')), 'status chip missing')
  assert(dockText().includes('4/12'), 'progress counts missing')
  assert(dockText().includes('23'), 'missing-fields count absent')
  assert(dockContainer.querySelector('.rq-draftCard') !== null, 'card element missing')
})
step('dismiss hides the dock row only', () => {
  const dismiss = dockButtons().find((b) => (b.getAttribute('aria-label') ?? '') === t('draft.dismiss'))
  assert(dismiss !== undefined, 'dismiss button missing')
  dismiss.click()
})
await flush()
step('card hidden after dismissal', () => assert(dockContainer.querySelector('.rq-draftCard') === null, 'card still rendered'))
step('chain seat still declines while the card is merely dismissed', () => {
  const chainMatched = composerEntry.def.select({ session: { sessionId: 'session-1' } })
  assert(chainMatched === null, 'chain elected after dismissal — the seat would empty out')
})
draftsManifest.drafts['builder-demo'].revision = 3
draftsManifest.drafts['builder-demo'].updatedAt = Date.now()
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await flush()
step('revision bump re-shows the card through the store subscription', () => {
  assert(dockContainer.querySelector('.rq-draftCard') !== null, 'card did not reappear after revision change')
})
step('no-draft session renders an empty dock row', () => {
  const before = errors.length
  dockRoot.render(React.createElement(dockEntry.Component, { sessionId: 'session-other', t }))
  return flush().then(() => {
    if (errors.length !== before) throw new Error(`errors after empty dock render: ${errors.slice(before).join(' ;; ').slice(0, 200)}`)
    assert(dockContainer.textContent === '' || !dockContainer.textContent.includes('Question Builder'), 'foreign draft leaked into the row')
    dockRoot.render(React.createElement(dockEntry.Component, { sessionId: 'session-1', t }))
  })
})
await flush()

// Scenario sweep: status transitions and coexistence around the dock row.
step('pending survey + building draft: chain elects the survey, dock keeps the card', () => {
  pending.push({ surveyId: 'sv-1', sessionId: 'session-1', createdAt: Date.now(), spec: SPEC })
  document.dispatchEvent(new dom.window.Event('visibilitychange'))
})
await flush()
step('coexistence: chain matched the survey', () => {
  const chainMatched = composerEntry.def.select({ session: { sessionId: 'session-1' } })
  assert(chainMatched !== null && chainMatched.surveyId === 'sv-1', `chain did not elect the survey: ${JSON.stringify(chainMatched).slice(0, 80)}`)
  assert(dockContainer.querySelector('.rq-draftCard') !== null, 'draft card vanished while a survey is pending')
  pending.length = 0
  document.dispatchEvent(new dom.window.Event('visibilitychange'))
})
await flush()
draftsManifest.drafts['builder-demo'].status = 'launched'
draftsManifest.drafts['builder-demo'].updatedAt = Date.now()
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await flush()
step('launched draft stops rendering the dock card', () => {
  assert(dockContainer.querySelector('.rq-draftCard') === null, 'card still rendered after launch — it must close into the wizard')
})
draftsManifest.drafts['builder-demo'].status = 'building'
draftsManifest.drafts['builder-demo'].revision = 4
draftsManifest.drafts['builder-demo'].updatedAt = Date.now()
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await flush()
step('reopened-for-editing draft shows the card again', () => {
  assert(dockContainer.querySelector('.rq-draftCard') !== null, 'card did not return after status change back to building')
})
draftsManifest.drafts['builder-demo'].status = 'discarded'
draftsManifest.drafts['builder-demo'].updatedAt = Date.now()
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await flush()
step('discarded draft drops the card entirely', () => {
  assert(dockContainer.querySelector('.rq-draftCard') === null, 'card rendered for a discarded draft')
})
step('cleared manifest leaves no stale card and raises no errors', () => {
  const before = errors.length
  draftsManifest = { v: 1, activeByConversation: {}, drafts: {} }
  document.dispatchEvent(new dom.window.Event('visibilitychange'))
  return flush().then(() => {
    if (errors.length !== before) throw new Error(`errors after manifest clear: ${errors.slice(before).join(' ;; ').slice(0, 200)}`)
    assert(dockContainer.querySelector('.rq-draftCard') === null, 'stale card after manifest clear')
  })
})
await flush()

if (POISON !== null) {
  step('poison: mount + start', () => {
    root.render(React.createElement(composerEntry.Component, {
      matched: { surveyId: 'sv-poison', sessionId: 'session-1', createdAt: Date.now(), spec: POISON },
      t,
    }))
    return flush().then(() => {
      const startBtn = buttons().find((b) => /start/i.test(b.textContent ?? ''))
      if (startBtn) startBtn.click()
    })
  })
  await flush()
  step('poison: boundary catches the crash with a visible card', () => {
    assert(text().includes(t('crash.title')) || text().includes('Survey render error') || text().includes('问卷渲染出错'), `crash card missing; text="${text().slice(0, 120)}"`)
    assert(document.body.contains(container), 'container unmounted by poison crash')
  })
  step('poison: Retry re-attempts without killing the composer', () => {
    const retry = buttons().find((b) => (b.textContent ?? '').includes(t('crash.retry')) || /retry/i.test(b.textContent ?? ''))
    if (retry) retry.click()
    assert(document.body.contains(container), 'container unmounted after retry')
  })
  await flush()
}

if (errors.length > 0) {
  failed += 1
  console.log(`[${LABEL}] RUNTIME ERRORS (${errors.length}):`)
  for (const e of errors.slice(0, 6)) console.log('  ' + e.slice(0, 300))
}
console.log(`[${LABEL}] ${failed === 0 && errors.length === 0 ? 'CLEAN' : 'PROBLEMS: ' + (failed + (errors.length ? 1 : 0))}`)
process.exit(failed === 0 && errors.length === 0 ? 0 : 1)
