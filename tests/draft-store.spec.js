/**
 * Tests for the builder draft store: begin/patch/structure lifecycle against
 * temp directories, the required-field checklist flow, the soft structure
 * cap, one-active-draft-per-conversation, and old-drafts-remain semantics.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore, slugifyTitle } from '../src/draft-store.js'

const fiveKeys = ['a', 'b', 'c', 'd', 'e']
const skeleton = () => ({
  entry: 'q1',
  questions: {
    q1: { options: fiveKeys.map((key) => ({ key })) },
  },
})
const fleshed = () => ({
  prompt: 'Pick a branch?',
  options: fiveKeys.map((key) => ({
    key,
    label: `Option ${key}`,
    description: 'One sentence.',
    insight: 'What great looks like.',
    sources: ['some/file.ts'],
  })),
})

async function freshStore(overrides = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rq-ws-'))
  const profileRoot = await mkdtemp(join(tmpdir(), 'rq-prof-'))
  return { store: createDraftStore({ workspaceRoot, profileRoot, ...overrides }), workspaceRoot, profileRoot }
}

test('slugifyTitle kebab-cases and falls back', () => {
  assert.equal(slugifyTitle('Question Builder — design lock!'), 'question-builder-design-lock')
  assert.equal(slugifyTitle('   '), 'draft')
})

test('begin creates a stubbed draft, marks it active, and reports an unready checklist', async () => {
  const { store } = await freshStore()
  const begun = await store.begin({ conversationId: 'conv-1', title: 'API Deprecation Survey', survey: skeleton() })
  assert.equal(begun.ok, true)
  assert.equal(begun.draft.slug, 'api-deprecation-survey')
  assert.equal(begun.draft.status, 'building')
  assert.equal(begun.draft.survey.questions.q1.prompt, 'TODO: prompt for q1')
  assert.equal(begun.completeness.ready, false)
  assert.ok(begun.completeness.perQuestion[0].missing.includes('options[0].insight'))
  const got = await store.get({ conversationId: 'conv-1' })
  assert.equal(got.draft.slug, 'api-deprecation-survey')
  assert.equal(got.active, true)
  const list = await store.list()
  const entry = list.manifest.drafts['api-deprecation-survey']
  assert.equal(entry.ready, false)
  assert.deepEqual(entry.progress, { questions: 1, complete: 0, missingFields: 21 })
  assert.equal(entry.revision, 0)
})

test('begin slug collisions get numeric suffixes and old drafts remain', async () => {
  const { store } = await freshStore()
  await store.begin({ conversationId: 'conv-1', title: 'Same Topic', survey: skeleton() })
  const second = await store.begin({ conversationId: 'conv-1', title: 'Same Topic', survey: skeleton() })
  assert.equal(second.draft.slug, 'same-topic-2')
  const list = await store.list()
  assert.deepEqual(Object.keys(list.manifest.drafts).sort(), ['same-topic', 'same-topic-2'])
  assert.equal(list.manifest.activeByConversation['conv-1'], 'same-topic-2')
  const old = await store.get({ slug: 'same-topic' })
  assert.equal(old.ok, true)
})

test('begin adopts a fresh slug when the manifest lost a draft file (no clobber)', async () => {
  const { store, profileRoot } = await freshStore()
  await store.begin({ conversationId: 'conv-1', title: 'Same Topic', survey: skeleton() })
  // Manifest loss (corrupt/home switch): the file remains, the manifest forgets.
  const { rm } = await import('node:fs/promises')
  await rm(join(profileRoot, 'rich-questions', 'drafts', 'index.json'), { force: true })
  const second = await store.begin({ conversationId: 'conv-2', title: 'Same Topic', survey: skeleton() })
  assert.equal(second.draft.slug, 'same-topic-2', 'an existing draft file must never be clobbered by a fresh manifest')
  const first = await store.get({ slug: 'same-topic' })
  assert.equal(first.ok, true, 'the original draft file must survive')
})

test('ops on a missing draft file fail with a draft-facing error, not ENOENT', async () => {
  const { store } = await freshStore()
  const launched = await store.markLaunched('missing-slug')
  assert.equal(launched.ok, false)
  assert.match(launched.error, /could not be read/)
  const discarded = await store.discard('missing-slug')
  assert.equal(discarded.ok, false)
  assert.match(discarded.error, /could not be read/)
  const patched = await store.patch({ slug: 'missing-slug', questions: { q1: { prompt: 'x' } } })
  assert.match(patched.error, /could not be read/)
  const structured = await store.structure({ slug: 'missing-slug', survey: skeleton() })
  assert.match(structured.error, /could not be read/)
})

test('patch completes content, refuses >3 questions, ADDS new ids, and wires next targets', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const patched = await store.patch({ slug: draft.slug, questions: { q1: fleshed() } })
  assert.equal(patched.ok, true)
  assert.equal(patched.completeness.ready, true)
  assert.equal(patched.draft.survey.questions.q1.prompt, 'Pick a branch?')

  const tooMany = await store.patch({ slug: draft.slug, questions: { a: {}, b: {}, c: {}, d: {} } })
  assert.match(tooMany.error, /at most 3 per call/)

  // NEW ids land as draft-grade adds (TODO stubs allowed) — incremental
  // growth instead of a whole-structure resend.
  const added = await store.patch({ slug: draft.slug, questions: { q9: { prompt: 'Fresh?', options: fiveKeys.map((key) => ({ key, label: `L${key}` })) } } })
  assert.equal(added.ok, true)
  assert.deepEqual(added.added, ['q9'])
  assert.equal(added.draft.survey.questions.q9.prompt, 'Fresh?')
  assert.equal(added.draft.revision, 0, 'adds never bump the structure revision')

  // Branch wiring is patchable: question-level and option-level .next land
  // (id, array of ids, or null = branch ends).
  const wired = await store.patch({ slug: draft.slug, questions: { q1: { next: 'q9', options: fiveKeys.map((key) => ({ key, next: key === 'a' ? 'q9' : null })) } } })
  assert.equal(wired.ok, true)
  assert.equal(wired.draft.survey.questions.q1.next, 'q9')
  assert.equal(wired.draft.survey.questions.q1.options[0].next, 'q9')
  assert.equal(wired.draft.survey.questions.q1.options[1].next, null)
  assert.equal(wired.ignored, undefined, 'next wiring is applied, never ignored')

  // A dangling target refuses the WHOLE patch and changes nothing on disk.
  const dangling = await store.patch({ slug: draft.slug, questions: { q1: { next: 'ghost' } } })
  assert.equal(dangling.ok, false)
  assert.match(dangling.error, /invalid draft structure/)
  const stored = await store.get({ slug: draft.slug })
  assert.equal(stored.draft.survey.questions.q1.next, 'q9', 'a refused patch must not write')

  // A malformed next shape gets the patch-facing message.
  const badShape = await store.patch({ slug: draft.slug, questions: { q1: { next: 7 } } })
  assert.equal(badShape.ok, false)
  assert.match(badShape.error, /q1\.next must be a question id/)
})

test('patch adds respect the structure cap', async () => {
  const { store } = await freshStore({ structureQuestionCap: 2 })
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const refused = await store.patch({ slug: draft.slug, questions: { q2: { options: fiveKeys.map((key) => ({ key })) } } })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /cap is 2/)
})

test('structure default cap fits the Push math: a 45-question graph lands (21 doubled)', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const questions = { q1: fleshed() }
  for (let n = 2; n <= 45; n += 1) {
    questions[`q${n}`] = { prompt: `Q${n}?`, options: fiveKeys.map((key) => ({ key, label: `L${key}` })) }
  }
  const big = await store.structure({ slug: draft.slug, survey: { entry: 'q1', questions } })
  assert.equal(big.ok, true, `45-question structure must land under the default cap: ${big.error ?? ''}`)
  assert.equal(Object.keys(big.draft.survey.questions).length, 45)
})

test('keyed option patches join by key regardless of order — labels never scramble', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const fleshed = await store.patch({ slug: draft.slug, questions: { q1: { prompt: 'Pick?', options: fiveKeys.map((key) => ({ key, label: `L${key}`, description: `why ${key}`, sources: ['old/ref'] })) } } })
  assert.equal(fleshed.ok, true)

  // Sent in REVERSED order: under index-merge this used to land 'e' fields on 'a'.
  const reversed = [...fiveKeys].reverse()
  const merged = await store.patch({ slug: draft.slug, questions: { q1: { options: reversed.map((key) => ({ key, next: key === 'a' ? null : undefined })) } } })
  assert.equal(merged.ok, true)
  const options = merged.draft.survey.questions.q1.options
  for (const option of options) {
    assert.equal(option.label, `L${option.key}`, `label scrambled on key ${option.key}`)
    assert.equal(option.description, `why ${option.key}`, `description scrambled on key ${option.key}`)
  }
  assert.equal(options[0].next, null, 'the next landed on the wrong option')
  assert.equal(options[4].next, undefined, 'next leaked onto an option that sent none')
})

test('a keyed patch with a new key appends instead of refusing', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const grown = await store.patch({ slug: draft.slug, questions: { q1: { options: [{ key: 'f', label: 'New stance', description: 'fresh' }] } } })
  assert.equal(grown.ok, true, grown.error ?? '')
  const options = grown.draft.survey.questions.q1.options
  assert.equal(options.length, 6)
  assert.equal(options.at(-1).key, 'f')
  assert.equal(options.at(-1).label, 'New stance')
})

test('option patches merge per-field: a sources-only patch keeps the prose', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const fleshed = await store.patch({ slug: draft.slug, questions: { q1: { prompt: 'Pick?', options: fiveKeys.map((key) => ({ key, label: `L${key}`, description: `why ${key}`, insight: '**Promise** p. **Price** c. **Present** t.', sources: ['old/ref'] })) } } })
  assert.equal(fleshed.ok, true)

  const merged = await store.patch({ slug: draft.slug, questions: { q1: { options: fiveKeys.map((key) => ({ key, sources: ['new/ref'] })) } } })
  assert.equal(merged.ok, true)
  for (const [index, option] of merged.draft.survey.questions.q1.options.entries()) {
    assert.equal(option.description, `why ${option.key}`, `description was wiped by the sources-only patch at index ${index}`)
    assert.match(option.insight, /Promise/)
    assert.deepEqual(option.sources, ['new/ref'], 'the new sources must land')
    assert.equal(option.label, `L${option.key}`, 'labels survive untouched')
  }

  // A longer patch list grows the array; new entries start from their own content.
  const grown = await store.patch({ slug: draft.slug, questions: { q1: { options: [...fiveKeys.map((key) => ({ key })), { key: 'f', label: 'New option', description: 'fresh' }] } } })
  assert.equal(grown.ok, true)
  assert.equal(grown.draft.survey.questions.q1.options.length, 6)
  assert.equal(grown.draft.survey.questions.q1.options[5].description, 'fresh')
  assert.equal(grown.draft.survey.questions.q1.options[0].description, 'why a', 'existing entries keep their prose when the patch list grows')

  // A SHORTER patch list keeps the untouched tail — no silent truncation.
  const tailKept = await store.patch({ slug: draft.slug, questions: { q1: { options: [{ key: 'a', sources: ['final/ref'] }] } } })
  assert.equal(tailKept.ok, true)
  const after = tailKept.draft.survey.questions.q1.options
  assert.equal(after.length, 6, 'a one-option patch must not truncate the option list')
  assert.deepEqual(after[0].sources, ['final/ref'])
  assert.equal(after[0].description, 'why a')
  assert.equal(after[5].description, 'fresh', 'the untouched tail survives intact')
})

test('structure replaces the graph and bumps the revision; the cap freezes it', async () => {
  const { store } = await freshStore({ structureQuestionCap: 3 })
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const bigger = await store.structure({
    slug: draft.slug,
    survey: {
      entry: 'q1',
      questions: {
        q1: fleshed(),
        q2: { prompt: 'Follow-up?', options: fiveKeys.map((key) => ({ key, label: `L${key}` })) },
      },
    },
  })
  assert.equal(bigger.ok, true)
  assert.equal(bigger.draft.revision, 1)
  assert.equal(Object.keys(bigger.draft.survey.questions).length, 2)

  const frozen = await store.structure({
    slug: draft.slug,
    survey: {
      entry: 'q1',
      questions: {
        q1: fleshed(),
        q2: { prompt: 'F2?', options: fiveKeys.map((key) => ({ key, label: `L${key}` })) },
        q3: { prompt: 'F3?', options: fiveKeys.map((key) => ({ key, label: `L${key}` })) },
      },
    },
  })
  assert.equal(frozen.ok, false)
  assert.match(frozen.error, /the cap is 3/)
  const stillPatched = await store.patch({ slug: draft.slug, questions: { q1: fleshed() } })
  assert.equal(stillPatched.ok, true, 'content patches continue under the freeze')
})

test('structure rejects an invalid graph with the draft-facing error', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  const broken = await store.structure({ slug: draft.slug, survey: { entry: 'q1', questions: { q1: { options: [{ key: 'a' }] } } } })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /invalid draft structure/)
})

test('discard clears the active pointer but keeps the file as reference; reopen restores it', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  await store.discard(draft.slug)
  const after = await store.get({ conversationId: 'conv-1' })
  assert.equal(after.ok, false)
  const reference = await store.get({ slug: draft.slug })
  assert.equal(reference.draft.status, 'discarded')

  await store.reopen(draft.slug)
  const reopened = await store.get({ conversationId: 'conv-1' })
  assert.equal(reopened.draft.status, 'reopened')
  assert.equal(reopened.active, true)
})

test('markLaunched records status without touching the active pointer', async () => {
  const { store } = await freshStore()
  const { draft } = await store.begin({ conversationId: 'conv-1', title: 'T', survey: skeleton() })
  await store.markLaunched(draft.slug)
  const got = await store.get({ slug: draft.slug })
  assert.equal(got.draft.status, 'launched')
  const list = await store.list()
  assert.equal(list.manifest.activeByConversation['conv-1'], draft.slug)
})

test('begin tolerates null-valued optional fields (dogfood: intro: null)', async () => {
  const { store } = await freshStore()
  const survey = {
    entry: 'q1',
    title: 'Null Fields',
    intro: null,
    questions: { q1: { header: null, prompt: null, options: fiveKeys.map((key) => ({ key, description: null, insight: null, sources: null })) } },
  }
  const begun = await store.begin({ conversationId: 'conv-1', title: 'Null Fields', survey })
  assert.equal(begun.ok, true, `begin rejected null-valued fields: ${begun.error ?? ''}`)
  assert.equal(begun.draft.survey.intro, undefined, 'null intro must be stripped, not kept')
  assert.equal(begun.draft.survey.questions.q1.header, undefined)
  assert.equal(begun.draft.survey.questions.q1.options[0].description, undefined)
})
