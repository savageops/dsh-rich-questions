/**
 * dsh-rich-questions — builder draft store.
 *
 * Draft files live at <workspace>/.dsh/survey-drafts/<slug>.json —
 * git-visible, one file per survey, old drafts remain on disk as reference.
 * A machine-local manifest at <profileRoot>/rich-questions/drafts/index.json
 * tracks statuses and the ONE active draft per conversation (operator rule),
 * and survives restarts. Pure node:fs with injectable roots so the store is
 * unit-testable against temp directories. All writes are atomic-enough for
 * single-writer tool use: write-then-rename is unnecessary because only the
 * host process writes, one op at a time (tools are exclusive).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { draftCompleteness, validateSpec } from './survey-engine.js'

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
export function createDraftStore({ workspaceRoot, profileRoot, structureQuestionCap = 40 }) {
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
    } catch { /* absent or corrupt manifest: start fresh (draft files remain on disk) */ }
    return { v: 1, activeByConversation: {}, drafts: {} }
  }

  async function writeManifest(manifest) {
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  async function readDraft(slug) {
    const parsed = JSON.parse(await readFile(join(draftsDir, `${slug}.json`), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== DRAFT_SCHEMA_VERSION) throw new Error(`draft "${slug}" has an unreadable format`)
    return parsed
  }

  async function writeDraft(draft) {
    await mkdir(draftsDir, { recursive: true })
    await writeFile(join(draftsDir, `${draft.slug}.json`), JSON.stringify(draft, null, 2) + '\n', 'utf8')
  }

  /** Structural validation with a draft-facing error prefix; stubs pass, structure must hold. */
  function checkStructure(survey) {
    const check = validateSpec(survey)
    if (!check.ok) return { ok: false, error: `invalid draft structure: ${check.errors.join('; ')}` }
    return { ok: true, spec: check.spec }
  }

  /** Auto-stub a skeleton so every question/option carries the required fields as TODO markers. */
  function stubIn(survey) {
    const questions = {}
    for (const [id, node] of Object.entries(survey.questions ?? {})) {
      questions[id] = {
        ...node,
        prompt: typeof node?.prompt === 'string' && node.prompt.trim() !== '' ? node.prompt : `TODO: prompt for ${id}`,
        ...(Array.isArray(node?.options)
          ? { options: node.options.map((option, index) => ({ ...option, label: typeof option?.label === 'string' && option.label.trim() !== '' ? option.label : `TODO: label ${index + 1}` })) }
          : {}),
      }
    }
    return { ...survey, questions }
  }

  return {
    /** Begin a draft: full-frame skeleton (ids, option keys+labels or stubs, branch wiring), validated structurally. */
    async begin({ conversationId, title, survey }) {
      // One title, one truth: the survey's own title defaults to the draft
      // title so the card and the launched wizard never disagree.
      const titled = { ...survey, ...(typeof survey?.title !== 'string' || survey.title.trim() === '' ? { title: String(title ?? 'Draft survey') } : {}) }
      const struct = checkStructure(stubIn(titled))
      if (!struct.ok) return struct
      const base = slugifyTitle(title)
      const manifest = await readManifest()
      let slug = base
      for (let n = 2; manifest.drafts[slug] !== undefined || slug === manifest.activeByConversation[conversationId]; n += 1) slug = `${base}-${n}`
      const now = Date.now()
      const draft = {
        v: DRAFT_SCHEMA_VERSION,
        slug,
        title: String(title ?? slug),
        status: 'building',
        conversationId,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        survey: struct.spec,
      }
      await writeDraft(draft)
      manifest.drafts[slug] = { status: draft.status, title: draft.title, conversationId, updatedAt: now, revision: 0, ready: draftCompleteness(draft.survey).ready, progress: draftCompleteness(draft.survey).totals }
      manifest.activeByConversation[conversationId] = slug
      await writeManifest(manifest)
      return { ok: true, draft, completeness: draftCompleteness(draft.survey), file: fileLabel(slug) }
    },

    /**
     * Content patch: merge up to 3 questions' prose fields (prompt, header,
     * detail, multiSelect, allowCustom, skippable, options content) and/or
     * draft-level fields — intro (markdown first page) and quick (the up-to-6
     * one-click templates, authored last over finished questions; the same
     * validateSpec run checks the two-way coverage rule immediately). Branch
     * wiring (`next`, question- or option-level) is structural and belongs to
     * the structure op — it is ignored here and reported.
     */
    async patch({ slug, questions, intro, quick }) {
      const entries = Object.entries(questions ?? {})
      if (entries.length === 0 && intro === undefined && quick === undefined) return { ok: false, error: 'patch carries nothing — provide questions, intro, and/or quick' }
      if (entries.length > 3) return { ok: false, error: `patch carries ${entries.length} questions — at most 3 per call (keep each payload small)` }
      if (intro !== undefined && typeof intro !== 'string') return { ok: false, error: 'intro must be a string (markdown first page)' }
      if (quick !== undefined && !Array.isArray(quick)) return { ok: false, error: 'quick must be an array of template objects (same shape as ask_survey quick)' }
      const draft = await readDraft(slug)
      const ignored = []
      for (const [id, patchNode] of entries) {
        const node = draft.survey.questions[id]
        if (node === undefined) return { ok: false, error: `patch names question "${id}" which does not exist in draft "${slug}" — add it via the structure op` }
        if (patchNode.next !== undefined) ignored.push(`${id}.next`)
        if (Array.isArray(patchNode.options)) {
          node.options = patchNode.options.map((option, index) => {
            if (option?.next !== undefined) ignored.push(`${id}.options[${index}].next`)
            const { next, ...content } = option
            return { ...content, label: typeof content?.label === 'string' && content.label.trim() !== '' ? content.label : node.options?.[index]?.label ?? `TODO: label ${index + 1}` }
          })
        }
        for (const field of ['prompt', 'header', 'detail']) {
          if (patchNode[field] !== undefined) node[field] = patchNode[field]
        }
        for (const field of ['multiSelect', 'allowCustom', 'skippable']) {
          if (patchNode[field] !== undefined) node[field] = patchNode[field]
        }
      }
      if (intro !== undefined) draft.survey.intro = intro
      if (quick !== undefined) draft.survey.quick = quick
      const struct = checkStructure(draft.survey)
      if (!struct.ok) return { ok: false, error: `${struct.error} (patch rolled back nothing: fix the reported fields and re-send)` }
      draft.survey = struct.spec
      draft.updatedAt = Date.now()
      await writeDraft(draft)
      const manifest = await readManifest()
      if (manifest.drafts[slug] !== undefined) {
        manifest.drafts[slug].updatedAt = draft.updatedAt
        manifest.drafts[slug].status = draft.status = 'building'
        manifest.drafts[slug].revision = draft.revision
        manifest.drafts[slug].ready = draftCompleteness(draft.survey).ready
        manifest.drafts[slug].progress = draftCompleteness(draft.survey).totals
        await writeManifest(manifest)
      }
      return { ok: true, draft, completeness: draftCompleteness(draft.survey), file: fileLabel(slug), ...(ignored.length > 0 ? { ignored } : {}) }
    },

    /**
     * Structural replace: the whole graph (ids, edges, options, entry).
     * Allowed only while the draft stays under the configurable question cap
     * (operator's soft-until-N rule); bumps the structure-revision counter.
     */
    async structure({ slug, survey }) {
      const struct = checkStructure(stubIn(survey ?? {}))
      if (!struct.ok) return struct
      const count = Object.keys(struct.spec.questions).length
      if (count >= structureQuestionCap) {
        return { ok: false, error: `draft "${slug}" is locked at ${count} questions (cap ${structureQuestionCap}): structure edits are frozen, content patches continue to work` }
      }
      const draft = await readDraft(slug)
      draft.survey = struct.spec
      draft.revision += 1
      draft.updatedAt = Date.now()
      draft.status = 'building'
      await writeDraft(draft)
      const manifest = await readManifest()
      if (manifest.drafts[slug] !== undefined) {
        manifest.drafts[slug].updatedAt = draft.updatedAt
        manifest.drafts[slug].status = draft.status
        manifest.drafts[slug].revision = draft.revision
        manifest.drafts[slug].ready = draftCompleteness(draft.survey).ready
        manifest.drafts[slug].progress = draftCompleteness(draft.survey).totals
        await writeManifest(manifest)
      }
      return { ok: true, draft, completeness: draftCompleteness(draft.survey), file: fileLabel(slug) }
    },

    /** Read one draft (by slug, else the conversation's active), with the required-field checklist. */
    async get({ slug, conversationId }) {
      const manifest = await readManifest()
      const target = slug ?? manifest.activeByConversation[conversationId]
      if (target === undefined) return { ok: false, error: 'no draft yet — begin one with survey_draft_set op=begin' }
      try {
        const draft = await readDraft(target)
        return { ok: true, draft, completeness: draftCompleteness(draft.survey), active: manifest.activeByConversation[conversationId] === draft.slug, file: fileLabel(draft.slug) }
      } catch (error) {
        return { ok: false, error: `draft "${target}" could not be read: ${error instanceof Error ? error.message : String(error)}` }
      }
    },

    /** Every draft known to the manifest (old ones remain as reference). */
    async list() {
      const manifest = await readManifest()
      return { ok: true, manifest }
    },

    async markLaunched(slug) {
      const draft = await readDraft(slug)
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
    },

    /** A rerolled launch reopens the draft for editing instead of forcing a from-scratch rebuild. */
    async reopen(slug) {
      const draft = await readDraft(slug)
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
    },

    async discard(slug) {
      const draft = await readDraft(slug)
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
    },
  }
}
