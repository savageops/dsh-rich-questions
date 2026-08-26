/**
 * dsh-rich-questions — Host half.
 *
 * Owns the rich question system on the host plane:
 *  - the model-facing `ask_survey` tool (globally registered, visible to
 *    every agent preset — the flat `ask_user_question` stays for 1-3 simple
 *    questions; presets own that row and shadowing rules keep it untouched),
 *  - the pending survey registry (host-authoritative: closing the browser
 *    never loses a survey in flight — the tool keeps waiting),
 *  - the /api/rich-questions/{state,action,events} routes (loopback-fenced,
 *    task-board posture).
 *
 * The browser half (src/client.bundle.js) renders the wizard in the
 * conversation composer seat over this wire. Zero runtime dependencies: node
 * builtins only (local-plugin convention).
 */
import { randomUUID } from 'node:crypto'
import { computePath, validateAnswers, validateSpec } from './survey-engine.js'

const API_PREFIX = '/api/rich-questions'
const HEARTBEAT_MS = 15_000
const ACTION_LIMIT = 1_000_000
/** Size/shape limits for model-authored surveys. */
const LIMITS = {
  maxQuestions: 150,
  maxOptions: 40,
  maxInsight: 1500,
  maxLabel: 200,
  maxDescription: 400,
  maxSources: 8,
  maxSource: 500,
  maxDiagram: 1200,
  maxQuick: 6,
}

export const name = 'dsh-rich-questions'
export const inject = ['tools', 'webServer', 'agents', 'systemPrompt']

/**
 * Model-facing announcement: when to reach for ask_survey, the authoring
 * contract, and the answer shape. Kept tight — the tool description carries
 * the schema, this carries the judgment.
 */
/**
 * Model-facing announcement: when to reach for ask_survey, the authoring
 * contract, and the answer shape. Bilingual, cleanly split — the model reads
 * whichever half matches its conversation. Kept tight — the tool description
 * carries the schema, this carries the judgment.
 */
const ANNOUNCEMENT_EN = `dsh-rich-questions plugin installed (rich question/survey system): it extends ask_user_question into a branching ask_survey. Use ask_survey when collecting structured opinions/expectations/acceptance from the user and any of these hold: 4+ questions, a large questionnaire (10+), branching between questions (an earlier answer decides which questions follow), or options that need more than one sentence of explanation (hover insights, sources, tradeoffs). Keep ask_user_question for 1-3 simple confirmation/single-choice questions.
Language rule: author ALL user-facing survey content (title, intro, prompts, option labels/descriptions/insights, quick-template labels/insights) in the language the user is currently chatting in — an English conversation gets English content, 中文 gets 中文, any other language gets that language. Be consistent: one language across the whole survey. Option keys stay short ASCII letters (a, b, c...) regardless of language.
Authoring contract: {survey: {title?, intro? (markdown first page), entry (first question id), questions: {qid: {prompt, header? (grouping), detail? (markdown context), multiSelect?, allowCustom? (default true), skippable? (default true), options: [{key (arbitrary string, single letters a-z recommended, more for multi-select, "other" for free-text), label, description? (one sentence), insight? (markdown ~6 lines: what great looks like / tradeoff / (today) state), diagram? (optional compact Mermaid, few nodes — opened via the branch icon beside "?", panel does not scroll, keep it small), sources? (links or citations), recommended? (put first), next? (question id(s) that follow this option; null = branch ends; omit = fall back to question-level next)}], next? (question-level default: used on skip / free-text / options without their own next)}}}, quick? (up to 6 one-click templates, keys a-f not just a-d: [{key, label, description?, insight?, diagram?, recommended?, answers: {qid: {selected?: [key,...], custom?}}}]. The user sees these next to "Start" instead of answering question by question; picking one applies its answers verbatim and submits immediately, so each template's answers must be coherent and cover the questions its implied branch reaches — e.g. a positioning template like "the Vercel/Railway highest standard" decides a whole stance for the user)}}. Rules: entry required and must exist; every next target must exist; references and cycles are rejected at submit; unreachable questions are never asked. First-try checklist (the five most-rejected specs): (1) every id named in any next (question- or option-level) must exist in questions — re-check every next target after trimming or renaming questions, dangling references are the #1 rejection; (2) question-level next may be an id, an id list, or null (= no follow-up), never required; (3) the branch graph must be acyclic; (4) option keys unique per question; (5) a quick template's answers may name only questions its own selections actually reach, using option keys that exist on that question — multiple keys, or keys combined with custom text, only on multiSelect questions. Validation errors name the exact offending spot and, for dangling references, the nearest defined id and the id roster — one retry fixes it. Each option's insight should embed engineering judgment (what great looks like / tradeoff / (today) state). The result carries path (order actually asked), answers ({id, selected: [{key,label}], custom?}), skipped; store Q&A verbatim as numbered QA records and derive follow-ups from them. Next to "Start" the user can also press Quick/Reroll/Push/Discuss — all four return normally (not errors): quick = the user picks one of the quick templates, arrives as a normal answered result, no extra handling needed; reroll/push/discuss return those outcomes with an instruction field: reroll = rewrite the same topic in cleaner, better-spoken prose and call again; push = do proactive web research on competitors/methods first, then expand and deepen the survey and call again; discuss = talk it through in chat first, do not immediately re-call.`

const ANNOUNCEMENT_ZH = `本机已安装 dsh-rich-questions 插件（富问题/问卷系统）：它把 ask_user_question 扩展为可分支的 ask_survey。需要向用户收集结构化意见/预期/验收状态且满足任一条件时用 ask_survey：≥4 个问题的问卷、超过 10 题的大问卷、问题间有分支（前题答案决定后题）、选项需要超过一句的解释（hover 洞察、来源、tradeoff）。1-3 个简单确认/单选题仍用 ask_user_question。
语言规则：问卷全部用户可见内容（title、intro、prompt、选项 label/description/insight、quick 模板文案）一律使用用户当前聊天所用的语言——英文对话写英文，中文对话写中文，其他语言同理。整份问卷保持同一语言，不要混用；选项 key 无论如何都用短 ASCII 字母（a、b、c…）。
ask_survey 编写契约：参数 {survey: {title?, intro?(markdown 首屏), entry(首个问题 id), questions: {qid: {prompt, header?(分组), detail?(markdown 上下文), multiSelect?, allowCustom?(默认 true), skippable?(默认 true), options: [{key(任意字符串，建议单字母 a–z，多选可更多，需含 other 时用 key "other"), label, description?(一句话), insight?(markdown ~6 行：what great looks like / tradeoff / (today) 现状), diagram?(可选，紧凑 Mermaid 图，节点要少——用户点击「?」旁的分支图标展开，面板不滚动，图必须小到能整个塞进去), sources?(链接或引用), recommended?(推荐项放第一个), next?(选它后跟随的问题 id 或 id 数组；null=该分支结束；省略=用题目级 next)}], next?(题目级默认跟随：跳过/自由文本/选项未声明 next 时使用)}}, quick?(最多 6 个「一键模板」，键用 a–f 而非仅 a–d：[{key, label, description?, insight?, diagram?, recommended?, answers: {qid: {selected?:[key,...], custom?}}}]。用户在首屏点「快速」后看到这最多 6 个模板而不逐题作答；选中一个即用其 answers 直接套满全部题目并提交，因此每个模板的 answers 要连贯自洽、覆盖它所隐含分支触达的题目——例如"对标 Vercel/Railway 的最高标准"这类定位型模板，替用户把一整套倾向性答案都决定好)}}。规则：entry 必填且必须存在；所有 next 指向的问题必须存在；引用与环会在提交时被拒绝；未被分支到达的问题不会被问。首试自检（校验最常见的五种拒稿）：① 任何 next（题目级或选项级）指向的 id 必须存在于 questions——删题/改题名后务必逐个复查 next 目标，悬空引用是第一大拒稿原因；② 题目级 next 可以是 id、id 数组或 null（=无后续，等同省略），永远非必填；③ 分支图必须无环；④ 选项 key 每题唯一；⑤ quick 模板的 answers 只能引用其自身选择实际可达的题目、且 selected 必须是该题存在的选项 key——多个 key 或 key+custom 组合仅限 multiSelect 题。校验错误会精确指出出错位置，悬空引用还会给出最接近的已有 id 与全部 id 清单，一次重试即可修复。每个选项的 insight 应内嵌工程判断（什么是好、tradeoff、(today) 现状）。作答结果含 path（实际问到的问题顺序）、answers（每题 {id, selected:[{key,label}], custom?}）、skipped；请把 Q&A 逐字存为编号 QA 记录并据此推导后续条目。用户在问卷首屏「开始」按钮旁还可点「快速/重掷/深挖/讨论」——四者都会让 ask_survey 正常返回（非报错）：快速由用户直接从 quick 模板中选 1 个提交，走的是普通 answered 结果，你无需额外处理；reroll/push/discuss 的 outcome 分别为 reroll/push/discuss 并附 instruction 字段：reroll=同主题用更简洁地道的表达（跟随用户语言）重写后重新调用；push=先做竞品/方法论的主动网络调研再据此扩展加深问卷后重新调用；discuss=先在对话里讨论，不要立刻重新调用。`

export const ANNOUNCEMENT = `[dsh-rich-questions | EN]\n${ANNOUNCEMENT_EN}\n\n[dsh-rich-questions | 中文]\n${ANNOUNCEMENT_ZH}`

/**
 * Instruction text returned (not thrown) for the three intro-page pre-flight
 * actions offered next to "Start". Each resolves the tool call normally so
 * the model reads it as the next step, not a failure.
 */
const PREFLIGHT_INSTRUCTIONS = {
  reroll: 'The user hit "Reroll" before starting: they want the same survey topic and branching intent, rewritten from scratch in clean, simple, well-spoken, competent prose — in the language the user is chatting in — shorter prompts, no jargon or filler, tighter option labels and insights. Call ask_survey again with the rewritten spec; do not ask the user anything first.',
  push: 'The user hit "Push" before starting: they want the survey pushed deeper. Before calling ask_survey again, do aggressive web research on how competitors and comparable products/specs solve this problem to gather concrete methods, architecture, and intelligence, and pull in any additional local context that sharpens the questions. Then expand and sharpen the survey: more thorough questions and options, insights grounded in what you found, more branching where it adds precision. Call ask_survey again with the expanded, better-informed spec; do not ask the user anything first.',
  discuss: 'The user hit "Discuss" before starting: they do not want the form yet. Do not call ask_survey again immediately. Instead open a normal conversational discussion in chat about the survey\'s subject — ask clarifying questions, share your thinking — and only propose calling ask_survey again once the discussion converges on a clear direction.',
}

class SurveyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SurveyError'
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? undefined : JSON.parse(raw)
}

/**
 * Route fence (task-board posture): loopback socket + a browser same-origin
 * marker. This deployment admits the browser through a same-host nginx vhost
 * (work.clicloud.co edge), so the request always arrives loopback — a bare
 * non-browser curl is still refused by the marker.
 */
function guard(req, res) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const site = req.headers['sec-fetch-site']
  const browser = site === 'same-origin' || typeof req.headers.origin === 'string'
  if (!loopback || !browser) writeJson(res, 403, { ok: false, error: 'forbidden' })
  return loopback && browser
}

/**
 * Pending survey registry + SSE push. One entry per in-flight survey; the
 * tool's promise settles exactly once (settle deletes before resolving, so
 * the first claimant wins).
 */
class SurveyHostService {
  #pending = new Map()
  #subscribers = new Set()

  /** Block until the user answers or cancels (or the turn aborts). */
  ask({ sessionId, spec, signal }) {
    if (signal?.aborted === true) return Promise.reject(new SurveyError('ask_survey was aborted before the user answered', 'SURVEY_ABORTED'))
    return new Promise((resolve, reject) => {
      const surveyId = randomUUID()
      const entry = { surveyId, sessionId, spec, createdAt: Date.now(), resolve, reject, onAbort: undefined }
      if (signal !== undefined) {
        entry.onAbort = () => this.settle(surveyId, { outcome: 'cancelled' })
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.#pending.set(surveyId, entry)
      this.#emit({ type: 'survey/requested', surveyId, sessionId, createdAt: entry.createdAt, spec })
    })
  }

  /** Snapshot of every pending survey (state route + SSE hello hydration). */
  state() {
    return [...this.#pending.values()].map((entry) => ({
      surveyId: entry.surveyId,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      spec: entry.spec,
    }))
  }

  answer({ surveyId, answers }) {
    const entry = this.#pending.get(surveyId)
    if (entry === undefined) return { ok: false, error: 'not-pending' }
    const check = validateAnswers(entry.spec, answers)
    if (!check.ok) return { ok: false, error: check.errors.join('; ') }
    const answersById = new Map(check.answers.map((answer) => [answer.id, { selected: answer.selected, custom: answer.custom }]))
    const path = computePath(entry.spec, answersById)
    const reached = new Set(path)
    for (const answer of check.answers) if (!reached.has(answer.id)) return { ok: false, error: `answers include "${answer.id}" which the branch path does not reach` }
    return this.settle(surveyId, { outcome: 'answered', answers: check.answers, path })
  }

  cancel({ surveyId }) {
    return this.settle(surveyId, { outcome: 'cancelled' })
  }

  /** Pre-flight redirects offered next to the intro "Start" button — see makeRoutes. */
  reroll({ surveyId }) {
    return this.settle(surveyId, { outcome: 'reroll' })
  }

  push({ surveyId }) {
    return this.settle(surveyId, { outcome: 'push' })
  }

  discuss({ surveyId }) {
    return this.settle(surveyId, { outcome: 'discuss' })
  }

  settle(surveyId, result) {
    const entry = this.#pending.get(surveyId)
    if (entry === undefined) return { ok: false, error: 'not-pending' }
    this.#pending.delete(surveyId)
    if (entry.onAbort !== undefined) entry.signal?.removeEventListener('abort', entry.onAbort)
    this.#emit({ type: 'survey/resolved', surveyId, sessionId: entry.sessionId, ...result })
    // Every non-cancel outcome resolves the tool call with an actionable
    // result the model reads and acts on next turn; only an explicit cancel
    // aborts the tool call as an error.
    if (result.outcome === 'cancelled') entry.reject(new SurveyError('the user cancelled the survey', 'SURVEY_CANCELLED'))
    else entry.resolve(result)
    return { ok: true, ...result }
  }

  subscribe(fn) {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }

  #emit(frame) {
    for (const fn of [...this.#subscribers]) {
      try { fn(frame) } catch { /* one dead connection must not kill the broadcast */ }
    }
  }

  dispose() {
    for (const entry of this.#pending.values()) {
      if (entry.onAbort !== undefined) entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(new SurveyError('the rich-questions host service was disposed', 'SURVEY_ABORTED'))
    }
    this.#pending.clear()
    this.#subscribers.clear()
  }
}

/** The three routes: state (GET), action (POST), events (SSE). */
function makeRoutes(service) {
  const state = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!guard(req, res)) return
      writeJson(res, 200, { surveys: service.state() })
    },
  }
  const action = {
    kind: 'exact',
    path: `${API_PREFIX}/action`,
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { writeJson(res, 415, { ok: false, error: 'json-required' }); return }
      let body
      try { body = await readJsonBody(req, ACTION_LIMIT) } catch (error) {
        writeJson(res, error?.message === 'body-too-large' ? 413 : 400, { ok: false, error: error?.message ?? 'bad-request' })
        return
      }
      if (typeof body !== 'object' || body === null || typeof body.surveyId !== 'string') { writeJson(res, 400, { ok: false, error: 'invalid-action' }); return }
      const { kind, surveyId } = body
      const handlers = {
        answer: () => service.answer({ surveyId, answers: body.answers }),
        cancel: () => service.cancel({ surveyId }),
        // Pre-flight redirects, offered only on the intro page next to
        // "Start": reroll asks for a clearer rewrite, push asks for deeper
        // research-backed expansion, discuss defers the form to a chat
        // conversation. All three resolve the tool call (not an error) with
        // an instruction the model reads and acts on.
        reroll: () => service.reroll({ surveyId }),
        push: () => service.push({ surveyId }),
        discuss: () => service.discuss({ surveyId }),
      }
      const result = handlers[kind]?.()
      if (result === undefined) { writeJson(res, 400, { ok: false, error: 'unknown-action' }); return }
      writeJson(res, result.ok ? 200 : 400, result)
    },
  }
  const events = {
    kind: 'exact',
    path: `${API_PREFIX}/events`,
    handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      if (!guard(req, res)) return
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const push = (frame) => { try { res.write(`data: ${JSON.stringify(frame)}\n\n`) } catch { /* connection gone; close handler cleans up */ } }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignore */ } }, HEARTBEAT_MS)
      const close = () => { clearInterval(heartbeat); unsubscribe() }
      req.once('close', close)
      res.once('close', close)
      push({ type: 'hello', surveys: service.state() })
    },
  }
  return [state, action, events]
}

/** The model-facing tool definition (JSON-schema subset of dsh-tools). */
function surveyToolDefinition(ctx, service) {
  const optionSchema = {
    type: 'object',
    required: ['key', 'label'],
    additionalProperties: false,
    properties: {
      key: { type: 'string', description: 'Stable option key echoed in the answer. Use short letters/digits (a, b, c, ...; more for multi-select); "other" is the conventional free-text key.' },
      label: { type: 'string', description: 'Short user-facing option label.' },
      description: { type: 'string', description: 'One sentence shown under the label (always visible).' },
      insight: { type: 'string', description: 'Markdown revealed on hover (~6 lines): what great looks like, the tradeoff, "(today)" current state, caveats.' },
      diagram: { type: 'string', description: 'Optional compact Mermaid diagram (flowchart/graph, a handful of nodes) shown when the user clicks the branch icon next to the insight "?" instead of the text insight. Keep it small — the panel does not scroll, so the whole diagram must fit.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'References or links surfaced in the hover insight.' },
      recommended: { type: 'boolean', description: 'Mark this option as the recommendation (badge); list it first.' },
      next: {
        oneOf: [
          { type: 'string', description: 'Question id asked after choosing this option.' },
          { type: 'array', items: { type: 'string' }, description: 'Question ids asked in sequence after choosing this option.' },
          { type: 'null', description: 'Choosing this option ends the survey.' },
        ],
        description: 'Branching: which question(s) follow when this option is chosen. Omit to fall back to the question-level next.',
      },
    },
  }
  const quickAnswerSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      selected: { type: 'array', items: { type: 'string' }, description: 'Option keys this quick template selects for this question.' },
      custom: { type: 'string', description: 'Free-text answer this quick template supplies for this question.' },
    },
  }
  const quickOptionSchema = {
    type: 'object',
    required: ['key', 'label', 'answers'],
    additionalProperties: false,
    properties: {
      key: { type: 'string', description: 'Stable quick-template key. Use a-f (up to 6 templates), not just a-d.' },
      label: { type: 'string', description: 'Short label for the template, e.g. "Ship like Vercel/Railway: polish + DX first".' },
      description: { type: 'string', description: 'One sentence shown under the label (always visible).' },
      insight: { type: 'string', description: 'Markdown revealed via the "?" button (~6 lines): who this template is for, what it optimizes for, the tradeoff.' },
      diagram: { type: 'string', description: 'Optional compact Mermaid diagram (kept small, no scrolling) visualizing the resulting decision path, shown via the branch icon.' },
      sources: { type: 'array', items: { type: 'string' } },
      recommended: { type: 'boolean', description: 'Mark this template as the recommendation (badge); list it first.' },
      answers: {
        type: 'object',
        additionalProperties: quickAnswerSchema,
        description: 'Map of question id -> answer for this template. Must be internally consistent and cover every question the implied branch reaches — picking this template applies these answers verbatim and submits immediately, with no further questions asked.',
      },
    },
  }
  const questionSchema = {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: 'The question to display.' },
      header: { type: 'string', description: 'Optional section label rendered above the question (grouping large surveys).' },
      detail: { type: 'string', description: 'Optional markdown context rendered under the question text.' },
      multiSelect: { type: 'boolean', description: 'Whether several options may be selected. Default false.' },
      allowCustom: { type: 'boolean', description: 'Whether a free-text answer box is offered. Default true.' },
      skippable: { type: 'boolean', description: 'Whether the user may skip this question. Default true.' },
      options: { type: 'array', description: 'The choices offered. If you recommend one, mark it recommended and put it first.', items: optionSchema },
      next: {
        oneOf: [
          { type: 'string', description: 'Default follow-up question id.' },
          { type: 'array', items: { type: 'string' }, description: 'Default follow-up question ids in sequence.' },
          { type: 'null', description: 'No follow-up: the survey ends after this question.' },
        ],
        description: 'Question-level follow-up: used when the user skips, answers free-text, or selects an option that declares no next of its own. null = no follow-up (same as omitting).',
      },
    },
  }
  return {
    name: 'ask_survey',
    description: 'Ask the user a rich branching survey/questionnaire: up to 150 questions, arbitrary option keys, per-option hover insights with sources, multi-select, free-text answers, and per-option branching (each option declares which questions follow it). Use for structured expectation/acceptance/alignment questionnaires, anything with more than ~3 questions, or any question set where the answer to one question determines which questions come next. For 1-3 simple confirmation/choice questions use ask_user_question instead. The survey pauses until the user completes it in the Web GUI; the result carries the ordered path actually asked, every answer (keys + labels), and the skipped list. LANGUAGE: author all user-facing survey content (title, intro, prompts, option labels/descriptions/insights, quick-template copy) in the language the user is currently chatting in — English conversation → English, 中文 → 中文, any other language → that language; one language consistently across the whole survey, with option keys kept as short ASCII letters regardless. FIRST-TRY CHECKLIST — the failures validation rejects most often: (1) every id named in any `next` (question- or option-level) must be a key of `survey.questions`; after trimming or renaming questions, re-check every next target — a dangling reference is the #1 rejected spec. (2) Question-level `next` may be an id, an id list, or null (= no follow-up); it is never required. (3) The branch graph must be acyclic. (4) Option keys are unique per question. (5) Each `quick` template\'s `answers` may name only questions its own selections actually reach, using option keys that exist on that question; multiple keys, or keys combined with custom text, are only valid on multiSelect questions. Validation errors name the exact offending spot and, for dangling references, suggest the nearest defined id and list the id roster — fix and re-issue in one retry.',
    parameters: {
      type: 'object',
      required: ['survey'],
      additionalProperties: false,
      properties: {
        survey: {
          type: 'object',
          required: ['entry', 'questions'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Short survey title shown in the card header.' },
            intro: { type: 'string', description: 'Optional markdown preamble shown as the first page before the first question.' },
            entry: { type: 'string', description: 'Id of the first question to ask.' },
            questions: {
              type: 'object',
              additionalProperties: true,
              description: 'Object map of question id -> question node (the node shape is the documented "question" object: prompt, header?, detail?, multiSelect?, allowCustom?, skippable?, options?, next?).',
            },
            quick: {
              type: 'array',
              maxItems: 6,
              items: quickOptionSchema,
              description: 'Up to 6 whole-survey answer templates ("owner decisions") offered as a one-click shortcut next to "Start" — e.g. "optimize like Vercel/Railway: polish + DX first" vs. "optimize like a lean internal tool: ship fast, minimal surface". Picking one applies its full answers map and submits immediately, skipping the question-by-question walk. Use keys a-f.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['outcome'],
        properties: {
          outcome: { type: 'string', enum: ['answered', 'reroll', 'push', 'discuss'], description: '"answered" carries path/answers/skipped. "reroll"/"push"/"discuss" are pre-flight redirects picked next to "Start" before any question was answered — each carries an instruction telling you what to do next.' },
          title: { type: 'string' },
          instruction: { type: 'string', description: 'Present only for "reroll"/"push"/"discuss": what the user wants instead of proceeding, and what to do about it.' },
          path: { type: 'array', items: { type: 'string' }, description: 'Question ids actually asked, in order (outcome "answered" only).' },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string' }, label: { type: 'string' } } } },
                custom: { type: 'string' },
              },
            },
          },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // Human interaction is only valid for the exact live runtime root (same
      // boundary the built-in userQuestions seam enforces).
      const agent = exec.agent
      if (agent === undefined) throw new SurveyError('survey interaction requires a session-owned agent', 'SURVEY_NO_AGENT')
      const agents = ctx.agents
      if (agents === undefined || agents.get(agent.id) !== agent) throw new SurveyError('survey interaction requires the exact live calling agent', 'SURVEY_CALLER_NOT_LIVE')
      if (!agents.roots().includes(agent)) throw new SurveyError('survey interaction is unavailable while the calling agent is owned by another live agent; include the unresolved survey in the child agent\'s final result', 'SURVEY_DELEGATED_CALLER')

      const check = validateSpec(args.survey, LIMITS)
      if (!check.ok) throw new SurveyError(`invalid survey spec: ${check.errors.join('; ')}`, 'SURVEY_BAD_SPEC')
      const spec = check.spec

      const result = await service.ask({ sessionId: agent.id, spec, signal: exec.signal })

      // Pre-flight redirect (reroll/push/discuss): the user never answered
      // any question, they picked one of the buttons next to "Start". Hand
      // the model its instruction; nothing to shape.
      if (result.outcome !== 'answered') {
        return { outcome: result.outcome, ...(spec.title !== undefined ? { title: spec.title } : {}), instruction: PREFLIGHT_INSTRUCTIONS[result.outcome] }
      }

      // Shape the result for the model: labels resolved, answered/skipped split.
      const path = result.path
      const answersById = new Map(result.answers.map((answer) => [answer.id, answer]))
      const answered = []
      const skipped = []
      for (const id of path) {
        const answer = answersById.get(id)
        const node = spec.questions[id]
        if (answer !== undefined && (answer.selected.length > 0 || answer.custom !== undefined)) {
          answered.push({
            id,
            selected: answer.selected.map((key) => ({ key, label: (node.options ?? []).find((option) => option.key === key)?.label ?? key })),
            ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
          })
        } else {
          skipped.push(id)
        }
      }
      return {
        outcome: 'answered',
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        path,
        answers: answered,
        skipped,
      }
    },
  }
}

export function apply(ctx) {
  const service = new SurveyHostService()

  ctx.effect(() => {
    const disposers = makeRoutes(service).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
      service.dispose()
    }
  }, 'rich-questions: pending survey service and routes')

  ctx.systemPrompt.section({
    name: 'plugin:rich-questions',
    order: 200,
    text: ANNOUNCEMENT,
  })
  ctx.tools.register(surveyToolDefinition(ctx, service))
}
