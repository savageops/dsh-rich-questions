/**
 * dsh-rich-questions — pure survey engine (branch graph + validation).
 *
 * ZERO dependencies and no I/O: this file is imported by the host half
 * (src/host.js) and inlined, verbatim, into the browser bundle
 * (src/client.bundle.js, region "survey-engine"). The host computes the
 * authoritative answer path from the same function the client navigates
 * with, so a claimed answer is re-derivable server-side. Keep both copies in
 * sync when changing either.
 *
 * Model: a survey is a static, cycle-free directed graph of question nodes.
 * The user walks it live: the questions actually presented are exactly the
 * nodes reachable from `entry` under the answers given so far (computePath).
 * Unreachable nodes are never asked and never answered.
 */

/** Normalise a `next` value (string | string[] | null | undefined) to an id list. */
export function normalizeNext(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry !== '');
  return [];
}

/**
 * Compute the ordered question path for the current answers.
 *
 * @param {object} spec - validated survey spec ({ entry, questions }).
 * @param {Map<string, {selected: string[], custom?: string, skipped?: boolean}>} [answers]
 *   Current answers keyed by question id. A question counts as "answered
 *   with a selection" only when `skipped` is falsy and `selected` is
 *   non-empty; a custom-only, skipped, or absent answer follows the
 *   question-level `next` instead of any option edge.
 * @returns {string[]} Ordered question ids the user is asked.
 *
 * Edge semantics:
 *  - Single-select: follow the selected option's `next`.
 *  - Multi-select: follow every selected option's `next`, in option order,
 *    depth-first per option (an option's branch is fully walked before the
 *    next option's).
 *  - An option with its own `next: null` ends its branch (contributes
 *    nothing); an option without `next` falls through to the question-level
 *    `next`; a skipped/custom-only question uses the question-level `next`.
 *  - A node already on the path is never revisited (defensive; validateSpec
 *    rejects cycles up front).
 */
export function computePath(spec, answers = new Map()) {
  const nodes = spec.questions
  const path = []
  const seen = new Set()

  const expand = (id) => {
    if (typeof id !== 'string' || Object.hasOwn(nodes, id) === false || seen.has(id)) return
    seen.add(id)
    path.push(id)
    const node = nodes[id]
    const answer = answers.get(id)
    const nexts = []
    const push = (list) => {
      for (const entry of list) nexts.push(entry)
    }
    if (answer !== undefined && answer.skipped !== true && answer.selected.length > 0) {
      for (const option of node.options ?? []) {
        if (!answer.selected.includes(option.key)) continue
        if (Object.hasOwn(option, 'next')) {
          if (option.next !== null) push(normalizeNext(option.next))
        } else {
          push(normalizeNext(node.next))
        }
      }
    } else {
      push(normalizeNext(node.next))
    }
    for (const next of nexts) expand(next)
  }

  expand(spec.entry)
  return path
}

/**
 * Static validation of a model-authored survey spec.
 * @param {unknown} raw - the `survey` argument.
 * @param {{maxQuestions?: number, maxOptions?: number, maxInsight?: number, maxLabel?: number, maxDescription?: number, maxSources?: number, maxSource?: number, maxDiagram?: number, maxQuick?: number}} [limits]
 * @returns {{ok: true, spec: object} | {ok: false, errors: string[]}}
 */
export function validateSpec(raw, limits = {}) {
  const maxQuestions = limits.maxQuestions ?? 150
  const maxOptions = limits.maxOptions ?? 40
  const maxInsight = limits.maxInsight ?? 1500
  const maxLabel = limits.maxLabel ?? 200
  const maxDescription = limits.maxDescription ?? 400
  const maxPrompt = limits.maxPrompt ?? 4000
  const maxDetail = limits.maxDetail ?? 8000
  const maxIntro = limits.maxIntro ?? 8000
  const maxTitle = limits.maxTitle ?? 300
  const maxSources = limits.maxSources ?? 8
  const maxSource = limits.maxSource ?? 500
  const maxDiagram = limits.maxDiagram ?? 1200
  const maxQuick = limits.maxQuick ?? 6
  const errors = []
  const fail = (message) => errors.push(message)
  /** Shared by regular options and quick templates: sources array shape. */
  const checkSources = (where, sources) => {
    if (typeof sources === 'string') { fail(`${where}.sources must be an array of strings`); return }
    if (typeof sources === 'undefined' || !Array.isArray(sources)) return
    if (sources.length > maxSources) fail(`${where} has ${sources.length} sources (limit ${maxSources})`)
    for (const source of sources) {
      if (typeof source !== 'string' || source.trim() === '') fail(`${where}.sources entries must be non-empty strings`)
      else if (source.length > maxSource) fail(`${where} has a source over ${maxSource} characters`)
    }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'an array' : raw === null ? 'null' : `a ${typeof raw}`
    return { ok: false, errors: [`survey must be an object — got ${got}`] }
  }

  const { title, intro, entry, questions } = raw
  if (typeof title === 'string' && title.trim() === '') fail('survey.title must be non-blank when present')
  if (typeof title !== 'undefined' && typeof title !== 'string') fail('survey.title must be a string')
  if (typeof title === 'string' && title.length > maxTitle) fail(`survey.title exceeds ${maxTitle} characters`)
  if (typeof intro !== 'undefined' && typeof intro !== 'string') fail('survey.intro must be a string')
  if (typeof intro === 'string' && intro.length > maxIntro) fail(`survey.intro exceeds ${maxIntro} characters`)
  if (typeof entry !== 'string' || entry.trim() === '') fail('survey.entry must be a non-empty question id')
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    return { ok: false, errors: errors.concat(['survey.questions must be an object map of question id -> node']) }
  }

  const ids = Object.keys(questions)
  if (ids.length === 0) fail('survey.questions must contain at least one question')
  if (ids.length > maxQuestions) fail(`survey.questions has ${ids.length} questions (limit ${maxQuestions})`)
  if (ids.includes(entry) === false) fail(`survey.entry "${entry}" names no question`)

  for (const id of ids) {
    const node = questions[id]
    const where = `questions.${id}`
    if (typeof id !== 'string' || id.trim() === '') { fail('question ids must be non-empty strings'); continue }
    if (typeof node !== 'object' || node === null) { fail(`${where} must be an object`); continue }
    if (typeof node.prompt !== 'string' || node.prompt.trim() === '') fail(`${where}.prompt must be a non-empty string`)
    else if (node.prompt.length > maxPrompt) fail(`${where}.prompt exceeds ${maxPrompt} characters`)
    if (typeof node.detail === 'string' && node.detail.length > maxDetail) fail(`${where}.detail exceeds ${maxDetail} characters`)
    if (typeof node.header !== 'undefined' && typeof node.header !== 'string') fail(`${where}.header must be a string`)
    if (typeof node.detail !== 'undefined' && typeof node.detail !== 'string') fail(`${where}.detail must be a string (markdown)`)
    if (typeof node.multiSelect !== 'undefined' && typeof node.multiSelect !== 'boolean') fail(`${where}.multiSelect must be a boolean`)
    if (typeof node.allowCustom !== 'undefined' && typeof node.allowCustom !== 'boolean') fail(`${where}.allowCustom must be a boolean`)
    if (typeof node.skippable !== 'undefined' && typeof node.skippable !== 'boolean') fail(`${where}.skippable must be a boolean`)
    // `next: null` at question level is accepted as "no follow-up" (same as
    // omitting it) — a natural authoring pattern, not an error.
    if (typeof node.next !== 'undefined' && node.next !== null && typeof node.next !== 'string' && !Array.isArray(node.next)) fail(`${where}.next must be a question id, an id list, or null (= no follow-up)`)

    const keys = new Set()
    if (typeof node.options !== 'undefined') {
      if (!Array.isArray(node.options)) fail(`${where}.options must be an array`)
      else {
        if (node.options.length > maxOptions) fail(`${where} has ${node.options.length} options (limit ${maxOptions})`)
        if (node.options.length < 5) fail(`${where} has ${node.options.length} options — minimum 5 (keys a-e; the free-text input row is separate and not counted). If a question genuinely has fewer stances, fold it into another question; never pad with filler options.`)
        node.options.forEach((option, index) => {
          const oWhere = `${where}.options[${index}]`
          if (typeof option !== 'object' || option === null) { fail(`${oWhere} must be an object`); return }
          if (typeof option.key !== 'string' || option.key.trim() === '') fail(`${oWhere}.key must be a non-empty string`)
          if (typeof option.label !== 'string' || option.label.trim() === '') fail(`${oWhere}.label must be a non-empty string`)
          if (option.label.length > maxLabel) fail(`${oWhere}.label exceeds ${maxLabel} characters`)
          if (typeof option.description === 'string' && option.description.length > maxDescription) fail(`${oWhere}.description exceeds ${maxDescription} characters`)
          if (typeof option.insight === 'string' && option.insight.length > maxInsight) fail(`${oWhere}.insight exceeds ${maxInsight} characters (~6 lines)`)
          if (typeof option.diagram === 'string' && option.diagram.length > maxDiagram) fail(`${oWhere}.diagram exceeds ${maxDiagram} characters (keep it small — no scrolling)`)
          if (typeof option.recommended !== 'undefined' && typeof option.recommended !== 'boolean') fail(`${oWhere}.recommended must be a boolean`)
          checkSources(oWhere, option.sources)
          if (typeof option.key === 'string' && option.key !== '') {
            if (keys.has(option.key)) fail(`${where} has duplicate option key "${option.key}"`)
            keys.add(option.key)
          }
        })
      }
    }
  }

  // Quick templates: up to maxQuick whole-survey answer bundles. Each names
  // a subset (or all) of `questions` and, for each, the option keys/custom
  // text that template implies — validated the same way a submitted answer
  // batch is (see validateAnswers), just embedded in the spec instead of
  // arriving over the wire.
  if (typeof raw.quick !== 'undefined') {
    if (!Array.isArray(raw.quick)) fail('survey.quick must be an array')
    else {
      if (raw.quick.length > maxQuick) fail(`survey.quick has ${raw.quick.length} entries (limit ${maxQuick})`)
      const quickKeys = new Set()
      raw.quick.forEach((quickOption, index) => {
        const qWhere = `quick[${index}]`
        if (typeof quickOption !== 'object' || quickOption === null) { fail(`${qWhere} must be an object`); return }
        if (typeof quickOption.key !== 'string' || quickOption.key.trim() === '') fail(`${qWhere}.key must be a non-empty string`)
        else if (quickKeys.has(quickOption.key)) fail(`survey.quick has duplicate key "${quickOption.key}"`)
        else quickKeys.add(quickOption.key)
        if (typeof quickOption.label !== 'string' || quickOption.label.trim() === '') fail(`${qWhere}.label must be a non-empty string`)
        else if (quickOption.label.length > maxLabel) fail(`${qWhere}.label exceeds ${maxLabel} characters`)
        if (typeof quickOption.description === 'string' && quickOption.description.length > maxDescription) fail(`${qWhere}.description exceeds ${maxDescription} characters`)
        if (typeof quickOption.insight === 'string' && quickOption.insight.length > maxInsight) fail(`${qWhere}.insight exceeds ${maxInsight} characters (~6 lines)`)
        if (typeof quickOption.diagram === 'string' && quickOption.diagram.length > maxDiagram) fail(`${qWhere}.diagram exceeds ${maxDiagram} characters (keep it small — no scrolling)`)
        if (typeof quickOption.recommended !== 'undefined' && typeof quickOption.recommended !== 'boolean') fail(`${qWhere}.recommended must be a boolean`)
        checkSources(qWhere, quickOption.sources)
        if (typeof quickOption.answers !== 'object' || quickOption.answers === null || Array.isArray(quickOption.answers)) { fail(`${qWhere}.answers must be an object map of question id -> answer`); return }
        const quickAnswersById = new Map()
        for (const [questionId, answer] of Object.entries(quickOption.answers)) {
          const aWhere = `${qWhere}.answers.${questionId}`
          const node = questions[questionId]
          if (node === undefined) { fail(`${aWhere} names no question`); continue }
          if (typeof answer !== 'object' || answer === null) { fail(`${aWhere} must be an object`); continue }
          if (typeof answer.selected !== 'undefined') {
            if (!Array.isArray(answer.selected) || !answer.selected.every((key) => typeof key === 'string')) fail(`${aWhere}.selected must be an array of option keys`)
            else {
              const optionKeys = new Set((typeof node === 'object' && node !== null ? node.options ?? [] : []).map((option) => option.key))
              for (const key of answer.selected) if (!optionKeys.has(key)) fail(`${aWhere}.selected key "${key}" is not an option of "${questionId}"`)
            }
          }
          quickAnswersById.set(questionId, { selected: Array.isArray(answer?.selected) ? answer.selected : [], ...(typeof answer?.custom === 'string' && answer.custom.trim() !== '' ? { custom: answer.custom } : {}) })
          if (typeof answer.custom !== 'undefined' && typeof answer.custom !== 'string') fail(`${aWhere}.custom must be a string`)
          // Submit-time rules enforced early, so a bad template dies here at
          // authoring time instead of at user-click time.
          const selectedKeys = Array.isArray(answer.selected) ? answer.selected : []
          const customText = typeof answer.custom === 'string' ? answer.custom.trim() : ''
          if (node.multiSelect !== true) {
            if (selectedKeys.length > 1) fail(`${aWhere} selects ${selectedKeys.length} options on single-select question "${questionId}" — at most one`)
            if (selectedKeys.length > 0 && customText !== '') fail(`${aWhere} combines options with custom text on single-select question "${questionId}" — use one or the other`)
          }
        }
        // Coverage rule (both ways): every question the template's implied
        // branch reaches must carry an answer — otherwise the "no further
        // questions asked" promise silently submits those as skipped.
        if (errors.length === 0) {
          const path = computePath({ entry, questions }, quickAnswersById)
          for (const id of path) {
            if (quickAnswersById.has(id) === false) fail(`${qWhere} does not answer "${id}", which its implied branch reaches — a quick template must cover every question it reaches`)
          }
        }
        // A template may only answer questions its own selections actually
        // reach — anything else would be rejected at submit time anyway.
        const quickAnswers = new Map()
        for (const [questionId, answer] of Object.entries(quickOption.answers)) quickAnswers.set(questionId, {
          selected: Array.isArray(answer?.selected) ? answer.selected : [],
          custom: typeof answer?.custom === 'string' ? answer.custom : '',
        })
        const reachable = computePath({ entry, questions }, quickAnswers)
        const reachableSet = new Set(reachable)
        if (reachableSet.size === 0) {
          fail(`${qWhere}.answers must include the entry question "${entry}" (with the option keys that start the branch) — without it no question is reachable and every answer in this template is dead weight`)
        }
        for (const questionId of Object.keys(quickOption.answers)) {
          if (!reachableSet.has(questionId)) fail(`${qWhere}.answers includes "${questionId}" which this template's own selections never reach — its branch reaches only: ${reachable.length > 0 ? reachable.join(', ') : '(nothing)'}. Remove it, or change the selected keys so the branch passes through "${questionId}"`)
        }
      })
    }
  }

  // Referential integrity: every `next` (question- or option-level) must name
  // an existing question id (or be null = branch end). Dangling references
  // get a self-repairing message: the nearest defined id and the id roster,
  // so the model fixes it in exactly one retry.
  const editDistance = (a, b) => {
    if (Math.abs(a.length - b.length) > 2) return 3
    const rows = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i += 1) rows[i][0] = i
    for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
    for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1)
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    return rows[a.length][b.length]
  }
  const refError = (where, ref) => {
    let nearest
    for (const id of ids) {
      const distance = editDistance(id, ref)
      if (distance <= 2 && (nearest === undefined || distance < nearest.distance)) nearest = { id, distance }
    }
    const roster = ids.slice(0, 15).join(', ') + (ids.length > 15 ? `, …(+${ids.length - 15} more)` : '')
    fail(`${where} next "${ref}" names no question${nearest !== undefined ? ` (did you mean "${nearest.id}"?)` : ''}. Defined ids: ${roster}. Add the missing question to the map, or fix the reference.`)
  }
  for (const id of ids) {
    const node = questions[id]
    if (typeof node !== 'object' || node === null) continue
    for (const ref of normalizeNext(node.next)) if (Object.hasOwn(questions, ref) === false) refError(`questions.${id}`, ref)
    for (let index = 0; index < (node.options ?? []).length; index += 1) {
      const option = node.options[index]
      if (typeof option !== 'object' || option === null) continue
      if (Object.hasOwn(option, 'next') && option.next !== null) {
        for (const ref of normalizeNext(option.next)) if (Object.hasOwn(questions, ref) === false) refError(`questions.${id}.options[${index}]`, ref)
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // Cycle detection over the full edge graph (worst case: every option edge).
  const adjacency = new Map()
  for (const id of ids) {
    const node = questions[id]
    const targets = new Set(normalizeNext(node.next))
    for (const option of node.options ?? []) {
      if (Object.hasOwn(option, 'next') && option.next !== null) {
        for (const ref of normalizeNext(option.next)) targets.add(ref)
      }
    }
    adjacency.set(id, [...targets])
  }
  const white = new Set(ids)
  const gray = new Set()
  const visit = (id) => {
    white.delete(id)
    gray.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (white.has(next)) { if (visit(next) === true) return true }
      else if (gray.has(next)) return true
    }
    gray.delete(id)
    return false
  }
  for (const id of ids) if (white.has(id) && visit(id) === true) return { ok: false, errors: ['survey graph contains a cycle (a question can follow itself through option branches)'] }

  return { ok: true, spec: repairedSpec({ title, intro, entry, questions, quick: raw.quick }) }
}

/**
 * Repair literal escape sequences in prose. Some writer/tool boundaries
 * deliver "\n" as TWO characters (backslash + n) instead of a real newline —
 * measured on this deployment across sessions and writers: the survey intro
 * and every option insight arrived flattened into one bold-clause run-on
 * ("poorly formatted, no structure") even though the authored markdown had
 * paragraph breaks. A literal \n in survey prose is never intentional, so
 * block prose (intro, prompt, detail, insight) gets the sequences converted
 * to real newlines; one-line fields (labels, descriptions) get them
 * collapsed to spaces so nothing injects line breaks into single-line
 * rendering. Ids, keys, next wiring, and diagrams are untouched.
 *
 * Path safety: a lone escape converts only when the character AFTER it is
 * not a letter or digit — corrupted prose is followed by markdown structure
 * or whitespace (`\n\n**B:**`, `\n- item`, end of text), while a Windows
 * path segment (`E:\notes`, `src\runner`) puts a letter right after the
 * backslash. The `\r\n` and `\n\n` PAIRS convert unconditionally: no real
 * path shape contains backslash-escape pairs adjacent (and the pair's
 * second member is followed by the next paragraph's letter, which the lone
 * lookahead would otherwise shield).
 */
const PROSE_ESCAPE = /\\r\\n|\\n\\n|\\n(?![A-Za-z0-9])|\\r(?![A-Za-z0-9])/g
export function repairEscapedNewlines(text) {
  if (typeof text !== 'string' || text.includes('\\') === false) return text
  // Per-pair replacement preserves the newline COUNT: a literal \n\n must
  // become a real paragraph break (two newlines), not a soft break.
  return text.replace(PROSE_ESCAPE, (match) => (match === '\\r\\n' ? '\n' : match === '\\n\\n' ? '\n\n' : '\n'))
}

/** One-line variant: repair the escapes, then never carry a newline forward. */
function repairOneLine(text) {
  return repairEscapedNewlines(text).replace(/\r?\n/g, ' ')
}

/** The validated spec with prose fields escape-repaired (see repairEscapedNewlines). */
function repairedSpec({ title, intro, entry, questions, quick }) {
  const repairedQuestions = {}
  for (const [id, node] of Object.entries(questions)) {
    if (node === null || typeof node !== 'object') { repairedQuestions[id] = node; continue }
    repairedQuestions[id] = {
      ...node,
      ...(typeof node.prompt === 'string' ? { prompt: repairEscapedNewlines(node.prompt) } : {}),
      ...(typeof node.detail === 'string' ? { detail: repairEscapedNewlines(node.detail) } : {}),
      ...(typeof node.header === 'string' ? { header: repairOneLine(node.header) } : {}),
      ...(Array.isArray(node.options) ? {
        options: node.options.map((option) => {
          if (option === null || typeof option !== 'object') return option
          return {
            ...option,
            ...(typeof option.label === 'string' ? { label: repairOneLine(option.label) } : {}),
            ...(typeof option.description === 'string' ? { description: repairOneLine(option.description) } : {}),
            ...(typeof option.insight === 'string' ? { insight: repairEscapedNewlines(option.insight) } : {}),
          }
        }),
      } : {}),
    }
  }
  const repairedQuick = Array.isArray(quick)
    ? quick.map((template) => {
      if (template === null || typeof template !== 'object') return template
      return {
        ...template,
        ...(typeof template.label === 'string' ? { label: repairOneLine(template.label) } : {}),
        ...(typeof template.description === 'string' ? { description: repairOneLine(template.description) } : {}),
        ...(typeof template.insight === 'string' ? { insight: repairEscapedNewlines(template.insight) } : {}),
      }
    })
    : quick
  return {
    ...(title !== undefined ? { title } : {}),
    ...(intro !== undefined ? { intro: repairEscapedNewlines(intro) } : {}),
    entry,
    questions: repairedQuestions,
    ...(repairedQuick !== undefined ? { quick: repairedQuick } : {}),
  }
}

/** A draft stub: blank, absent, or the explicit `TODO:` marker begin() writes. */
export function isStub(value) {
  return typeof value !== 'string' || value.trim() === '' || value.trimStart().startsWith('TODO')
}

/**
 * Required-field completeness for a builder draft, per the operator's
 * "make things required so it's obvious" rule: every question prompt and
 * every option's label / description / insight / sources must be present
 * and non-stub before launch. Structural rules (graph integrity, min-5
 * options, size caps) stay in validateSpec; this report is the checklist
 * survey_draft_get surfaces and survey_draft_launch enforces.
 *
 * @param {object} spec - draft survey spec ({ entry, questions }).
 * @returns {{ready: boolean, totals: {questions: number, complete: number, missingFields: number}, perQuestion: Array<{id: string, missing?: string[]}>}}
 */
export function draftCompleteness(spec) {
  const perQuestion = []
  let questionsTotal = 0
  let questionsDone = 0
  let missingTotal = 0
  for (const [id, node] of Object.entries(spec?.questions ?? {})) {
    questionsTotal += 1
    const missing = []
    if (isStub(node?.prompt)) missing.push('prompt')
    const options = Array.isArray(node?.options) ? node.options : []
    if (options.length === 0) missing.push('options: none declared')
    options.forEach((option, index) => {
      const where = `options[${index}].`
      if (isStub(option?.label)) missing.push(`${where}label`)
      if (isStub(option?.description)) missing.push(`${where}description`)
      if (isStub(option?.insight)) missing.push(`${where}insight`)
      const sources = Array.isArray(option?.sources) ? option.sources.filter((source) => typeof source === 'string' && source.trim() !== '') : []
      if (sources.length === 0) missing.push(`${where}sources`)
    })
    if (missing.length === 0) questionsDone += 1
    missingTotal += missing.length
    perQuestion.push(missing.length > 0 ? { id, missing } : { id })
  }
  return {
    ready: questionsTotal > 0 && questionsDone === questionsTotal,
    totals: { questions: questionsTotal, complete: questionsDone, missingFields: missingTotal },
    perQuestion,
  }
}

/**
 * Grounding gaps for a builder draft — the operator's grounding bar. Per
 * question: every option must cite at least one source, and (unless
 * skipComparison, the 'internal' escape for surveys with no competitors)
 * at least one option must cite a comparison target that points where it
 * lives — a file path or URL. A citation is a non-blank string; path/URL
 * detection is mechanical (a path separator or ://).
 *
 * @param {object} spec - draft survey spec ({ entry, questions }).
 * @param {{skipComparison?: boolean}} [options]
 * @returns {{ready: boolean, perQuestion: Array<{id: string, missing?: string[]}>}}
 */
export function groundingGaps(spec, { skipComparison = false } = {}) {
  const perQuestion = []
  for (const [id, node] of Object.entries(spec?.questions ?? {})) {
    const missing = []
    const options = Array.isArray(node?.options) ? node.options : []
    let comparison = false
    options.forEach((option, index) => {
      const sources = Array.isArray(option?.sources) ? option.sources.filter((source) => typeof source === 'string' && source.trim() !== '') : []
      if (sources.length === 0) missing.push(`options[${index}].sources`)
      if (!comparison && sources.some((source) => /[\\/]/.test(source) || /:\/\//.test(source))) comparison = true
    })
    if (!skipComparison && options.length > 0 && !comparison) missing.push('comparison: no option cites a file path or URL — name where the comparison target lives')
    if (missing.length > 0) perQuestion.push({ id, missing })
    else perQuestion.push({ id })
  }
  return { ready: perQuestion.every((entry) => entry.missing === undefined), perQuestion }
}

/**
 * Recover the survey spec from a possibly-degraded tool-call payload.
 *
 * The harness parses model tool-call arguments leniently: valid JSON arrives
 * as a parsed object, malformed JSON arrives as the raw text string, and an
 * empty payload arrives as {}. Models with small output budgets frequently
 * truncate a large ask_survey payload mid-JSON — so a string here is usually
 * a cut-off survey rather than a stringified one. Parse what can be parsed
 * and otherwise say precisely that, so the model can shrink and retry
 * instead of circling on the same opaque rejection.
 *
 * @param {unknown} args - the tool-call arguments object (or its degraded forms).
 * @returns {{ok: true, args: object} | {ok: false, error: string}}
 */
export function resolveSurveyArgument(args) {
  let payload = args
  if (typeof payload === 'string') {
    const parsed = tryParseJson(payload, 'The ask_survey arguments arrived as raw text')
    if (!parsed.ok) return { ok: false, error: parsed.error }
    payload = parsed.value
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    const got = payload === null ? 'null' : Array.isArray(payload) ? 'an array' : `a ${typeof payload}`
    return { ok: false, error: `the ask_survey arguments must be a JSON object, got ${got} — the emitted payload was likely truncated mid-JSON. Re-send a SMALLER survey: trim prompt/insight/description strings, drop the quick templates, or split the survey into two consecutive calls. Never resend the identical payload.` }
  }
  const survey = payload.survey
  if (survey === undefined || survey === null) {
    return { ok: false, error: 'ask_survey received no "survey" field — the model-side arguments were empty, malformed, or truncated before delivery (the harness forwards bad tool-call JSON as text and empty payloads as {}), so nothing could be validated. Re-send a SMALLER payload — trim prompt/insight/description strings and options, drop the quick templates — or split the survey into two consecutive calls. Never resend the identical payload.' }
  }
  if (typeof survey === 'string') {
    const parsed = tryParseJson(survey, 'The "survey" field arrived as a JSON text string')
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      return { ok: false, error: `the "survey" text parsed but is not a JSON object — got ${Array.isArray(parsed.value) ? 'an array' : `a ${typeof parsed.value}`}; re-send the survey as a proper object` }
    }
    return { ok: true, args: { ...payload, survey: parsed.value } }
  }
  if (typeof survey !== 'object' || Array.isArray(survey)) {
    return { ok: false, error: `"survey" must be an object — got ${Array.isArray(survey) ? 'an array' : `a ${typeof survey}`}` }
  }
  return { ok: true, args: payload }
}

/** JSON.parse with the syntax error translated into a truncation-aware diagnostic. */
function tryParseJson(text, where) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `${where}, but the text failed to parse as JSON (${message}) — the signature of a payload cut off by the model's output-token limit. Re-send a SMALLER survey: trim prompt/insight/description strings and options, drop the quick templates, or split the survey into two consecutive calls.`,
    }
  }
}

/**
 * Validate one submitted answer batch against the spec (host-side, mirrors
 * the built-in matchesQuestions semantics): ids must exist, keys must belong
 * to that question's options, single-select answers carry at most one key and
 * never combine keys with custom text, and custom text must be non-blank.
 *
 * @param {object} spec - validated spec.
 * @param {Array<{id: string, selected: string[], custom?: string}>} answers
 * @returns {{ok: true, answers: Array<{id: string, selected: string[], custom?: string}>} | {ok: false, errors: string[]}}
 */
export function validateAnswers(spec, answers) {
  const errors = []
  if (!Array.isArray(answers)) return { ok: false, errors: ['answers must be an array'] }
  const seen = new Set()
  const clean = []
  for (const answer of answers) {
    if (typeof answer !== 'object' || answer === null) { errors.push('answers entries must be objects'); continue }
    const { id, selected, custom } = answer
    if (typeof id !== 'string' || Object.hasOwn(spec.questions, id) === false) { errors.push(`answers id "${String(id)}" names no question`); continue }
    if (seen.has(id)) { errors.push(`answers repeat question "${id}"`); continue }
    seen.add(id)
    if (!Array.isArray(selected) || !selected.every((key) => typeof key === 'string')) { errors.push(`answers for "${id}": selected must be an array of option keys`); continue }
    if (new Set(selected).size !== selected.length) { errors.push(`answers for "${id}" repeat an option key`); continue }
    const node = spec.questions[id]
    const keys = new Set((node.options ?? []).map((option) => option.key))
    for (const key of selected) if (!keys.has(key)) errors.push(`answers for "${id}": key "${key}" is not an option`)
    const trimmed = typeof custom === 'string' ? custom.trim() : ''
    if (typeof custom !== 'undefined' && typeof custom !== 'string') { errors.push(`answers for "${id}": custom must be a string`); continue }
    if (node.multiSelect !== true) {
      if (selected.length > 1) errors.push(`answers for "${id}" selects ${selected.length} options on a single-select question`)
      if (trimmed !== '' && selected.length > 0) errors.push(`answers for "${id}" combines options with custom text on a single-select question`)
    }
    // Justifications: the user's why for chosen options. Object keyed by
    // option key; keys must be among the selected options, values non-empty
    // strings <= 500 chars; empty strings are dropped, not errors.
    let justifications
    if (answer.justifications !== undefined) {
      if (typeof answer.justifications !== 'object' || answer.justifications === null || Array.isArray(answer.justifications)) {
        errors.push(`answers for "${id}": justifications must be an object of option key -> why text`)
      } else {
        const kept = {}
        for (const [key, why] of Object.entries(answer.justifications)) {
          if (!selected.includes(key)) { errors.push(`answers for "${id}": justification names key "${key}" which is not a selected option`); continue }
          if (typeof why !== 'string') { errors.push(`answers for "${id}": justification for "${key}" must be a string`); continue }
          if (why.trim() === '') continue // whitespace-only: drop silently, never bounce the batch
          if (why.length > 500) { errors.push(`answers for "${id}": justification for "${key}" exceeds 500 characters`); continue }
          kept[key] = why.trim()
        }
        if (Object.keys(kept).length > 0) justifications = kept
      }
    }
    clean.push({ id, selected, ...(trimmed === '' ? {} : { custom: trimmed }), ...(justifications !== undefined ? { justifications } : {}) })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, answers: clean }
}
