/**
 * dsh-rich-questions — builder draft store.
 *
 * Draft files live at <workspace>/.dsh/survey-drafts/<slug>.json —
 * git-visible, one file per survey, old drafts remain on disk as reference.
 * A machine-local manifest at <profileRoot>/rich-questions/drafts/index.json
 * tracks statuses and the ONE active draft per conversation (operator rule),
 * and survives restarts. Pure node:fs with injectable roots so the store is
 * unit-testable against temp directories. Every op — reads included —
 * serializes through one in-process queue: the manifest is shared across
 * conversations, and interleaved read-modify-write cycles (two begins with
 * the same base title) would silently lose entries and clobber files.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { draftCompleteness, groundingGaps, validateSpec } from './survey-engine.js'

const DRAFT_SCHEMA_VERSION = 1

/** Slug from a title: lowercase kebab, digits kept, fallback 'draft'. */
export function slugifyTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug === '' ? 'draft' : slug
}

/**
 * @param {{workspaceRoot?: string, profileRoot: string, structureQuestionCap?: number}} roots
 *   workspaceRoot: session workspace when known — draft files land at
 *   <workspace>/.dsh/survey-drafts/ (git-visible). Omitted: files fall back
 *   machine-local under the profile root.
 * @returns {object} the draft store API (begin / patch / structure / get / list / markLaunched / reopen / discard).
 */
export function createDraftStore({ workspaceRoot, profileRoot, structureQuestionCap = 150 }) {
  const draftsDir = workspaceRoot !== undefined
    ? join(workspaceRoot, '.dsh', 'survey-drafts')
    : join(profileRoot, 'rich-questions', 'drafts', 'files')
  const manifestPath = join(profileRoot, 'rich-questions', 'drafts', 'index.json')

  /** Model-facing location label: repo-relative when workspace-backed, absolute otherwise. */
  const fileLabel = (slug) => (workspaceRoot !== undefined ? `.dsh/survey-drafts/${slug}.json` : join(draftsDir, `${slug}.json`))

  async function readManifest() {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.v === 1) {
        return { v: 1, activeByConversation: parsed.activeByConversation ?? {}, drafts: parsed.drafts ?? {} }
      }
    } catch { /* absent or corrupt manifest: start fresh (draft files remain on disk and still gate slug adoption) */ }
    return { v: 1, activeByConversation: {}, drafts: {} }
  }

  async function writeManifest(manifest) {
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  async function writeDraft(draft) {
    await mkdir(draftsDir, { recursive: true })
    await writeFile(join(draftsDir, `${draft.slug}.json`), JSON.stringify(draft, null, 2) + '\n', 'utf8')
  }

  /** Returns the parsed draft, or null when the file is missing or unreadable — callers turn that into a draft-facing error. */
  async function readDraft(slug) {
    try {
      const parsed = JSON.parse(await readFile(join(draftsDir, `${slug}.json`), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.v !== DRAFT_SCHEMA_VERSION) return null
      return parsed
    } catch { return null }
  }

  async function fileExists(path) {
    try { await stat(path); return true } catch { return false }
  }

  /** Structural validation with a draft-facing error prefix; stubs pass, structure must hold. */
  function checkStructure(survey) {
    const check = validateSpec(survey)
    if (!check.ok) return { ok: false, error: `invalid draft structure: ${check.errors.join('; ')}` }
    return { ok: true, spec: check.spec }
  }

  /** Auto-stub a skeleton so every question/option carries the required fields as TODO markers. */
  function stubIn(survey) {
    // Models pass null for optional fields constantly (dogfood finding):
    // strip nulls everywhere except `next`, where null means "branch ends".
    const clean = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([, value]) => value !== null))
    const cleanSurvey = clean(survey)
    const questions = {}
    for (const [id, node] of Object.entries(cleanSurvey.questions ?? {})) {
      questions[id] = {
        ...clean(node),
        prompt: typeof node?.prompt === 'string' && node.prompt.trim() !== '' ? node.prompt : `TODO: prompt for ${id}`,
        ...(Array.isArray(node?.options)
          ? { options: node.options.map((option, index) => ({ ...clean(option), label: typeof option?.label === 'string' && option.label.trim() !== '' ? option.label : `TODO: label ${index + 1}` })) }
          : {}),
      }
    }
    return { ...cleanSurvey, questions }
  }

  const beginOp = async ({ conversationId, title, survey, grounding }) => {
    // One title, one truth: the survey's own title defaults to the draft
    // title so the card and the launched wizard never disagree.
    const titled = { ...survey, ...(typeof survey?.title !== 'string' || survey.title.trim() === '' ? { title: String(title ?? 'Draft survey') } : {}) }
    const struct = checkStructure(stubIn(titled))
    if (!struct.ok) return struct
    // Grounding bar mode: 'internal' skips the comparison half (surveys
    // with no competitors); the source half always applies.
    const groundingMode = grounding === 'internal' ? 'internal' : 'standard'
    const base = slugifyTitle(title)
    const manifest = await readManifest()
    // Slug adoption must consult the manifest AND the files: a fresh or
    // corrupt manifest (home switch, cloned workspace) otherwise adopts a
    // slug whose draft file exists and overwrites its only copy.
    let slug = base
    for (let n = 2; manifest.drafts[slug] !== undefined || slug === manifest.activeByConversation[conversationId] || (await fileExists(join(draftsDir, `${slug}.json`))); n += 1) slug = `${base}-${n}`
    const now = Date.now()
    const completeness = draftCompleteness(struct.spec)
    const draft = {
      v: DRAFT_SCHEMA_VERSION,
      slug,
      title: String(title ?? slug),
      status: 'building',
      conversationId,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      grounding: groundingMode,
      survey: struct.spec,
    }
    await writeDraft(draft)
    manifest.drafts[slug] = { status: draft.status, title: draft.title, conversationId, updatedAt: now, revision: 0, ready: completeness.ready, progress: completeness.totals, grounding: groundingMode }
    manifest.activeByConversation[conversationId] = slug
    await writeManifest(manifest)
    return { ok: true, draft, completeness, active: true, file: fileLabel(slug) }
  }

  const patchOp = async ({ conversationId, slug, questions, intro, quick }) => {
    const entries = Object.entries(questions ?? {})
    if (entries.length === 0 && intro === undefined && quick === undefined) return { ok: false, error: 'patch carries nothing — provide questions, intro, and/or quick' }
    if (entries.length > 3) return { ok: false, error: `patch carries ${entries.length} questions — at most 3 per call, adds included (keep each payload small)` }
    if (intro !== undefined && typeof intro !== 'string') return { ok: false, error: 'intro must be a string (markdown first page)' }
    if (quick !== undefined && !Array.isArray(quick)) return { ok: false, error: 'quick must be an array of template objects (same shape as ask_survey quick)' }
    const draft = await readDraft(slug)
    if (draft === null) return { ok: false, error: `draft "${slug}" could not be read — it may have been deleted by hand` }
    // Branch wiring is patchable: .next accepts a question id, an array of
    // ids, or null (branch ends). Shape is checked here with a patch-facing
    // message; target existence is enforced by the structure validation that
    // runs before anything is written — a dangling id names itself there.
    const nextShapeError = (value, where) => {
      if (value === undefined || value === null || typeof value === 'string') return null
      if (Array.isArray(value) && value.every((id) => typeof id === 'string')) return null
      return `${where}.next must be a question id, an array of ids, or null (branch ends) — got ${JSON.stringify(value).slice(0, 60)}`
    }
    const ignored = []
    const added = []
    const nextErrors = []
    for (const [id, patchNode] of entries) {
      if (patchNode === null || typeof patchNode !== 'object') return { ok: false, error: `patch entry "${id}" must be an object` }
      // NEW ids are ADDS: the node lands draft-grade (TODO stubs allowed,
      // same leniency as begin) and then merges like any other question.
      // Completeness gates launch, not patch — grow the graph incrementally
      // instead of resending the whole structure.
      if (draft.survey.questions[id] === undefined) {
        draft.survey.questions[id] = stubIn({ questions: { [id]: patchNode } }).questions[id]
        added.push(id)
      }
      const node = draft.survey.questions[id]
      const nodeNextError = nextShapeError(patchNode.next, id)
      if (nodeNextError !== null) nextErrors.push(nodeNextError)
      if (patchNode.next !== undefined) node.next = patchNode.next
      if (Array.isArray(patchNode.options)) {
        // Per-field merge against the existing option at the same index,
        // over the LONGER of the two lists: an option patch carries only
        // what changes (e.g. insight), untouched tail options survive, and
        // wiping previously patched prose because it was omitted would
        // make the [research → patch] loop lose work on every iteration.
        // Reshaping the whole list (reorder, delete, renumber) belongs to
        // the structure op, which replaces wholesale by design. NOTE:
        // `sources` inside an option patch replaces the option's whole
        // list — send the complete list you want.
        const previous = node.options ?? []
        // Option patches join by KEY when both sides carry keys (identity,
        // not position — a patch authored in a different order can never
        // land its fields on the wrong option), falling back to index for
        // keyless patches. An unknown key is refused loudly: a silent
        // append would strand a patch option outside the validated graph.
        const keyedPrevious = new Map()
        for (const option of previous) {
          if (typeof option?.key === 'string' && option.key !== '') keyedPrevious.set(option.key, option)
        }
        const patchIsKeyed = patchNode.options.some((option) => typeof option?.key === 'string' && option.key !== '')
        if (patchIsKeyed && keyedPrevious.size === 0) {
          ignored.push(`${id}.options patch carries keys but the stored options have none — merged by index`)
        }
        const nextOptions = [...previous]
        const usedIndexes = new Set()
        for (let index = 0; index < patchNode.options.length; index += 1) {
          const option = patchNode.options[index]
          if (option === null || option === undefined || typeof option !== 'object') {
            ignored.push(`${id}.options[${index}] (non-object entry)`)
            continue
          }
          const optionWhere = typeof option.key === 'string' && option.key !== ''
            ? `${id}.options key "${option.key}"`
            : `${id}.options[${index}]`
          const optionNextError = nextShapeError(option.next, optionWhere)
          if (optionNextError !== null) nextErrors.push(optionNextError)
          let targetIndex = index
          if (patchIsKeyed && keyedPrevious.size > 0) {
            if (typeof option.key !== 'string' || option.key === '') {
              nextErrors.push(`${optionWhere}: keyed option patches require a key on every entry`)
              continue
            }
            const found = keyedPrevious.get(option.key)
            if (found === undefined) {
              // A new key GROWS the list (the documented append path) — an
              // unknown key is additive, never positional.
              targetIndex = nextOptions.length
            } else {
              targetIndex = previous.indexOf(found)
              if (usedIndexes.has(targetIndex)) {
                nextErrors.push(`${id}.options key "${option.key}" patches the same option twice`)
                continue
              }
            }
          }
          usedIndexes.add(targetIndex)
          const { next, ...content } = option
          const merged = { ...(previous[targetIndex] ?? {}), ...content }
          if (option.next !== undefined) merged.next = option.next
          nextOptions[targetIndex] = {
            ...merged,
            label: typeof merged.label === 'string' && merged.label.trim() !== ''
              ? merged.label
              : previous[targetIndex]?.label ?? `TODO: label ${targetIndex + 1}`,
          }
        }
        node.options = nextOptions
      }
      for (const field of ['prompt', 'header', 'detail']) {
        if (patchNode[field] !== undefined) node[field] = patchNode[field]
      }
      for (const field of ['multiSelect', 'allowCustom', 'skippable']) {
        if (patchNode[field] !== undefined) node[field] = patchNode[field]
      }
    }
    if (nextErrors.length > 0) return { ok: false, error: `patch refused: ${nextErrors.join('; ')}` }
    // Adds respect the structure cap: the graph grows only while under it.
    if (added.length > 0) {
      const total = Object.keys(draft.survey.questions).length
      if (total >= structureQuestionCap) {
        return { ok: false, error: `patch refused: adding ${added.join(', ')} would bring the graph to ${total} questions — the cap is ${structureQuestionCap}` }
      }
    }
    if (intro !== undefined) draft.survey.intro = intro
    if (quick !== undefined) draft.survey.quick = quick
    const struct = checkStructure(draft.survey)
    if (!struct.ok) return { ok: false, error: `${struct.error} (patch changed nothing on disk: fix the reported fields and re-send)` }
    draft.survey = struct.spec
    draft.updatedAt = Date.now()
    await writeDraft(draft)
    const manifest = await readManifest()
    const active = manifest.activeByConversation[draft.conversationId] === slug
    if (manifest.drafts[slug] !== undefined) {
      manifest.drafts[slug].updatedAt = draft.updatedAt
      manifest.drafts[slug].status = draft.status = 'building'
      manifest.drafts[slug].revision = draft.revision
      manifest.drafts[slug].ready = draftCompleteness(draft.survey).ready
      manifest.drafts[slug].progress = draftCompleteness(draft.survey).totals
      await writeManifest(manifest)
    }
    return {
      ok: true,
      draft,
      completeness: draftCompleteness(draft.survey),
      active,
      file: fileLabel(slug),
      ...(added.length > 0 ? { added } : {}),
      ...(ignored.length > 0 ? { ignored } : {}),
    }
  }

  const structureOp = async ({ conversationId, slug, survey }) => {
    const struct = checkStructure(stubIn(survey ?? {}))
    if (!struct.ok) return struct
    const count = Object.keys(struct.spec.questions).length
    if (count >= structureQuestionCap) {
      return { ok: false, error: `structure refused: the incoming graph has ${count} questions and the cap is ${structureQuestionCap} (whole-graph replacement works while the graph stays under the cap) — patch adds and content patches continue to work at any size` }
    }
    const draft = await readDraft(slug)
    if (draft === null) return { ok: false, error: `draft "${slug}" could not be read — it may have been deleted by hand` }
    // The title is durable truth: a reshape that omits it (typical — the
    // graph is what changed) keeps the draft's title instead of losing it.
    if (typeof struct.spec.title !== 'string' || struct.spec.title.trim() === '') {
      struct.spec.title = draft.title
    }
    draft.survey = struct.spec
    draft.revision += 1
    draft.updatedAt = Date.now()
    draft.status = 'building'
    await writeDraft(draft)
    const completeness = draftCompleteness(draft.survey)
    const manifest = await readManifest()
    const active = manifest.activeByConversation[draft.conversationId] === slug
    if (manifest.drafts[slug] !== undefined) {
      manifest.drafts[slug].updatedAt = draft.updatedAt
      manifest.drafts[slug].status = draft.status
      manifest.drafts[slug].revision = draft.revision
      manifest.drafts[slug].ready = completeness.ready
      manifest.drafts[slug].progress = completeness.totals
      await writeManifest(manifest)
    }
    return { ok: true, draft, completeness, active, file: fileLabel(slug) }
  }

  const getOp = async ({ conversationId, slug }) => {
    const manifest = await readManifest()
    const target = slug ?? manifest.activeByConversation[conversationId]
    if (target === undefined) return { ok: false, error: 'no draft yet — begin one with survey_draft_set op=begin' }
    const draft = await readDraft(target)
    if (draft === null) return { ok: false, error: `draft "${target}" could not be read — it may have been deleted by hand` }
    return {
      ok: true,
      draft,
      completeness: draftCompleteness(draft.survey),
      grounding: groundingGaps(draft.survey, { skipComparison: draft.grounding === 'internal' }),
      active: manifest.activeByConversation[conversationId] === draft.slug,
      file: fileLabel(draft.slug),
    }
  }

  const listOp = async () => ({ ok: true, manifest: await readManifest() })

  const markLaunchedOp = async (slug) => {
    const draft = await readDraft(slug)
    if (draft === null) return { ok: false, error: `draft "${slug}" could not be read` }
    draft.status = 'launched'
    draft.updatedAt = Date.now()
    await writeDraft(draft)
    const completeness = draftCompleteness(draft.survey)
    const manifest = await readManifest()
    if (manifest.drafts[slug] !== undefined) {
      manifest.drafts[slug].status = 'launched'
      manifest.drafts[slug].updatedAt = draft.updatedAt
      manifest.drafts[slug].revision = draft.revision
      manifest.drafts[slug].ready = completeness.ready
      manifest.drafts[slug].progress = completeness.totals
      await writeManifest(manifest)
    }
    return { ok: true }
  }

  const reopenOp = async (slug) => {
    const draft = await readDraft(slug)
    if (draft === null) return { ok: false, error: `draft "${slug}" could not be read` }
    draft.status = 'reopened'
    draft.updatedAt = Date.now()
    await writeDraft(draft)
    const completeness = draftCompleteness(draft.survey)
    const manifest = await readManifest()
    if (manifest.drafts[slug] !== undefined) {
      manifest.drafts[slug].status = 'reopened'
      manifest.drafts[slug].updatedAt = draft.updatedAt
      manifest.drafts[slug].revision = draft.revision
      manifest.drafts[slug].ready = completeness.ready
      manifest.drafts[slug].progress = completeness.totals
    }
    const conversationId = draft.conversationId
    if (conversationId !== undefined) {
      manifest.activeByConversation[conversationId] = slug
    }
    await writeManifest(manifest)
  }

  const discardOp = async (slug) => {
    const draft = await readDraft(slug)
    if (draft === null) return { ok: false, error: `draft "${slug}" could not be read` }
    draft.status = 'discarded'
    draft.updatedAt = Date.now()
    await writeDraft(draft)
    const manifest = await readManifest()
    if (manifest.drafts[slug] !== undefined) {
      manifest.drafts[slug].status = 'discarded'
      manifest.drafts[slug].updatedAt = draft.updatedAt
    }
    for (const [conversationId, active] of Object.entries(manifest.activeByConversation)) {
      if (active === slug) delete manifest.activeByConversation[conversationId]
    }
    await writeManifest(manifest)
    return { ok: true, slug }
  }

  // Every op serializes through one queue: the manifest is cross-conversation
  // shared state, and reads must not interleave with read-modify-write cycles.
  let opTail = Promise.resolve()
  const serialized = (fn) => {
    const run = opTail.then(fn, fn)
    opTail = run.then(() => undefined, () => undefined)
    return run
  }
  const op = (fn) => (args) => serialized(() => fn(args))

  return {
    begin: op(beginOp),
    patch: op(patchOp),
    structure: op(structureOp),
    get: op(getOp),
    list: op(listOp),
    markLaunched: op(markLaunchedOp),
    reopen: op(reopenOp),
    discard: op(discardOp),
  }
}
