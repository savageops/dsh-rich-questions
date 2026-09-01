/**
 * dsh-rich-questions — client smoke test.
 *
 * Executes the REAL bundle through a __ModuleLoader__ shim (stub React whose
 * hooks are single-pass approximations), hydrates the store through the SSE
 * frame path, and proves the seat-release minimize contract:
 *
 *   pending survey        → composer select claims (matched)
 *   minimize              → select declines (null) — the fallback input returns
 *   reopener (dock entry)  → renders only while pending AND minimized
 *   resolve / new survey  → stale minimize flags never shadow a fresh claim
 *
 * Exists because unbound-identifier render bugs blank live surfaces while
 * every syntax check stays green.
 *
 * Run: node --test tests/client-smoke.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundleSource = readFileSync(
  fileURLToPath(new URL('../src/client.bundle.js', import.meta.url)), 'utf8')

/** Element-recording stubs; hooks are single-pass read-only approximations. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  Fragment: 'Fragment',
  Component: class ComponentStub { constructor(props) { this.props = props } render() { return null } },
}
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
}
const primitivesStub = new Proxy({}, {
  get: (target, name) => function Primitive(props) { return { primitive: String(name), props: props || {} } },
})

/**
 * Load the bundle with a sandboxed browser env. Returns
 * { mod, emit } — emit() feeds one SSE frame into the store.
 */
function loadClient() {
  let eventSource = null
  class EventSourceStub {
    constructor() { eventSource = this; this.onmessage = null; this.onerror = null }
    close() {}
  }
  const fakeHead = { appendChild: () => {} }
  const sandboxDocument = {
    addEventListener: () => {},
    querySelector: () => fakeHead,
    head: fakeHead,
    createElement: () => ({ textContent: '', setAttribute: () => {} }),
    body: fakeHead,
  }
  let loaded = null
  /** The window the bundle CAPTURES as its parameter — the test reads and
   * asserts against this same object, since load-time globals are restored
   * before component calls run. */
  const shimWindow = {
    setInterval: () => 0,
    localStorage: { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } },
    __ModuleLoader__: {
      load: (spec) => {
        const require = (name) => {
          if (name === 'react') return reactStub
          if (name === 'react/jsx-runtime') return jsxRuntimeStub
          if (String(name).startsWith('@deepseek-ai/dsh-client-ui-primitives')) return primitivesStub
          throw new Error('unexpected require: ' + name)
        }
        loaded = { id: spec.id, mod: spec.factory(require) }
        return loaded
      },
    },
  }
  new Function('window', 'document', 'EventSource', 'fetch', bundleSource)(
    shimWindow, sandboxDocument, EventSourceStub,
    async () => { throw new Error('network disabled in smoke test') })
  assert.ok(loaded, 'bundle registered itself')
  assert.equal(loaded.id, 'dsh-rich-questions')
  const emit = (frame) => {
    assert.ok(eventSource, 'store started an EventSource')
    eventSource.onmessage({ data: JSON.stringify(frame) })
  }
  return { mod: loaded.mod, emit, window: shimWindow }
}

/** apply() against a stub ctx, capturing slot registrations. */
function applySlots(mod) {
  const registrations = []
  const ctx = {
    effect: (fn) => { try { fn() } catch { /* env-guarded start is a no-op here */ } return () => {} },
    locale: { register: () => ({}) },
    slots: {
      inject: (name, factory) => {
        const first = factory()
        if (first && typeof first[Symbol.iterator] === 'function') {
          for (const reg of first) registrations.push({ name, ...reg.spec, component: reg.component })
        } else {
          registrations.push({ name, ...first.spec, component: first.component })
        }
      },
      register: (spec, component) => ({ spec, component }),
    },
  }
  mod.apply(ctx)
  return registrations
}

const SPEC = {
  title: 'Smoke survey',
  questions: [{ id: 'q1', type: 'single', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }],
}

test('bundle loads and registers composer + reopener dock entries', () => {
  const { mod } = loadClient()
  const regs = applySlots(mod)
  const composer = regs.find(r => r.name === 'conversation.composer')
  const dock = regs.find(r => r.name === 'conversation.composer.dock')
  assert.ok(composer && typeof composer.select === 'function', 'composer chain entry with select')
  assert.ok(dock && typeof dock.component === 'function', 'dock list entry')
  assert.deepEqual(dock.inject({ session: { sessionId: 's1' } }), { sessionId: 's1' }, 'dock inject derives sessionId from the InputZone owner')
})

test('minimize releases the composer seat and the reopener carries the way back', () => {
  const { mod, emit } = loadClient()
  const store = mod.__store
  const regs = applySlots(mod)
  const composer = regs.find(r => r.name === 'conversation.composer')
  const dock = regs.find(r => r.name === 'conversation.composer.dock')
  const owner = { session: { sessionId: 's1' } }

  emit({ type: 'survey/requested', sessionId: 's1', surveyId: 'sv1', spec: SPEC, createdAt: 1 })
  assert.equal(composer.select(owner)?.surveyId, 'sv1', 'pending survey claims the seat')
  assert.equal(dock.component({ sessionId: 's1', t: (k) => k }), null, 'reopener hidden while expanded')

  store.setMinimized('s1', true)
  assert.equal(composer.select(owner), null, 'minimized survey declines — fallback input returns')
  const t = (key) => ({ 'nav.reopen': 'Reopen the survey in progress' }[key] ?? key)
  const button = dock.component({ sessionId: 's1', t })
  assert.equal(button.props.className, 'rq-reopener', 'reopener button rendered while minimized')
  assert.match(button.props['aria-label'], /survey/i)

  // Clicking the button expands: the inline onClick flips the store flag.
  button.props.onClick()
  assert.equal(composer.select(owner)?.surveyId, 'sv1', 'reopener click re-claims the seat')
  assert.equal(composer.select(owner)?.surveyId, 'sv1', 'expand re-claims the seat')
  assert.equal(dock.component({ sessionId: 's1', t: (k) => k }), null, 'reopener hidden again')
})

test('resolution and fresh surveys clear stale minimize flags', () => {
  const { mod, emit } = loadClient()
  const store = mod.__store
  const regs = applySlots(mod)
  const composer = regs.find(r => r.name === 'conversation.composer')
  const owner = { session: { sessionId: 's1' } }

  emit({ type: 'survey/requested', sessionId: 's1', surveyId: 'sv1', spec: SPEC, createdAt: 1 })
  store.setMinimized('s1', true)
  emit({ type: 'survey/resolved', sessionId: 's1', surveyId: 'sv1' })
  assert.equal(composer.select(owner), null, 'no pending — nothing to claim')

  emit({ type: 'survey/requested', sessionId: 's1', surveyId: 'sv2', spec: SPEC, createdAt: 2 })
  assert.equal(composer.select(owner)?.surveyId, 'sv2', 'a NEW survey claims fresh — stale minimize never shadows it')
})

test('builder drafts blend into the composer: no seat claim, strip in input.dock', () => {
  const { mod, emit, window: shimWin } = loadClient()
  // loadDraftDismissal reads the bundle's captured window — the shim above.
  const regs = applySlots(mod)
  const composer = regs.find(r => r.name === 'conversation.composer')
  const inputDock = regs.find(r => r.name === 'conversation.input.dock')
  assert.ok(inputDock && typeof inputDock.component === 'function', 'input.dock entry registered')
  const owner = { session: { sessionId: 's1' } }

  emit({ type: 'draft/updated', slug: 'd1', conversationId: 's1', status: 'building', revision: 2, title: 'Onboarding', progress: { questions: 5, complete: 3, missingFields: 1 }, updatedAt: 1 })
  assert.equal(composer.select(owner), null, 'a draft never claims the composer seat')

  const strip = inputDock.component({ sessionId: 's1', t: (k) => k })
  assert.ok(strip, 'strip rendered while building')
  const tree = JSON.stringify(strip)
  assert.ok(tree.includes('Onboarding') && tree.includes('building'), 'title + status in strip')
  assert.ok(tree.includes('3/5'), 'progress counts in strip')

  // dismiss (X) removes the strip; a new builder revision brings it back
  const findX = (node) => {
    if (!node || typeof node !== 'object') return null
    if (node.props && node.props['aria-label'] === 'draft.dismiss') return node
    for (const child of [node.children, node.props && node.props.children].flat(4)) {
      const hit = findX(child)
      if (hit) return hit
    }
    return null
  }
  const x = findX(strip)
  assert.ok(x, 'dismiss button present')
  x.props.onClick()
  const after = inputDock.component({ sessionId: 's1', t: (k) => k })
  assert.equal(after, null, 'dismissed strip gone')
  assert.match(shimWin.localStorage.getItem('dsh-rich-questions/draft-dismiss/d1'), /revision/, 'dismissal persisted')

  emit({ type: 'draft/updated', slug: 'd1', conversationId: 's1', status: 'building', revision: 3, progress: { questions: 5, complete: 4, missingFields: 0 }, updatedAt: 2 })
  assert.ok(inputDock.component({ sessionId: 's1', t: (k) => k }), 'a new revision re-shows the strip')
})
