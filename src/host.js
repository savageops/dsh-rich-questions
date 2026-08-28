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
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { computePath, draftCompleteness, resolveSurveyArgument, validateAnswers, validateSpec } from './survey-engine.js'
import { createDraftStore } from './draft-store.js'

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
 * Machine-local plugin home (draft manifest, settled records):
 * $DSH_RICH_QUESTIONS_HOME or ~/.dsh/rich-questions. Override env for
 * profile-pinned installs; default is deliberately profile-agnostic so
 * records survive profile switches.
 */
function pluginHome() {
  return process.env.DSH_RICH_QUESTIONS_HOME ?? join(homedir(), '.dsh', 'rich-questions')
}

/**
 * Per-call draft store. Draft files live in the session workspace
 * (git-visible) when the session exposes a cwd; otherwise they fall back
 * machine-local. All state is on disk, so per-call construction is stateless.
 */
function draftStoreFor(exec, structureQuestionCap) {
  const workspaceRoot = exec.agent?.session?.header?.cwd
  return createDraftStore({
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    profileRoot: pluginHome(),
    structureQuestionCap,
  })
}

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
Depth bar: a rich survey earns its place. For real expectation/alignment/scoping work, default to 10-30 questions — the 4-question threshold is the entry condition, not the target. Branch wherever one answer changes what matters next: any survey over 6 questions should carry at least 2-3 real branch points (option-level next routing to different question ranges), converging later where paths rejoin. Every question with options carries AT LEAST 5 (keys a-e, aim 5-8) — genuinely distinct stances a reader could disagree with, never filler; the free-text input row is separate and not counted. Give every option that involves judgment a real insight (what great looks like / tradeoff / (today)); use diagrams for architecture or flow choices; ship quick templates (3-6) whenever the user might already know their destination. A flat 4-question spec with no branching is a miss — if the topic genuinely needs only 1-3 flat questions, use ask_user_question instead.
Reader-first doctrine (owner-mandated; applies to EVERY survey you author and to every reroll/push rewrite): write for the deciding user — plain-spoken, direct, zero fluff. Never assume the reader knows what you are referring to: spell out the obvious, define every term on first use, and anchor each question to the reader's situation and what their answer changes. Self-contained prompts (hard rule): every question must make sense standing alone to a reader who missed the conversation — no naked concept name-drops. If a prompt names a mechanism (a grace period, fencing, a cache layer), the same prompt defines it in a clause, says where in the reader's setup it applies, and what the answer changes. Violation: "How long does the grace period last?" Compliant: "When two sessions can write the same state, the older one gets fenced (its writes start being rejected) but keeps write access briefly — the grace period — so an in-flight command can finish. How long should that window be? Too short discards work mid-command; too long brings back two-writer confusion." Put longer backstory in detail (markdown) — never shrink the question into vagueness. Be specific and insightful — the strongest available form of specificity per claim: a number, a concrete example, or a named comparison; never a floating adjective. Obvious, not oblivious. Hard requirements: full structure always — an orienting intro (what this is, why now, what happens with the answers, roughly how long), header grouping, and a description line on every option; every insight on every judgment option carries what-great-looks-like + the tradeoff + (today) + one concrete handle; banned: vague-abstraction options (every option takes a position a reader could disagree with), one-sided selling insights, and judgment options without insights; quick templates ship on nearly every survey, as named stances ("Vercel-grade polish + DX", never "Option A").
Authoring contract: {survey: {title?, intro? (markdown first page), entry (first question id), questions: {qid: {prompt, header? (grouping), detail? (markdown context), multiSelect?, allowCustom? (default true), skippable? (default true), options: [{key (arbitrary string, single letters a-z recommended, more for multi-select, "other" for free-text), label, description? (one sentence), insight? (markdown ~6 lines: what great looks like / tradeoff / (today) state), diagram? (optional compact Mermaid, few nodes — opened via the branch icon beside "?", panel does not scroll, keep it small), sources? (links or citations), recommended? (put first), next? (question id(s) that follow this option; null = branch ends; omit = fall back to question-level next)}], next? (question-level default: used on skip / free-text / options without their own next)}}}, quick? (up to 6 one-click templates, keys a-f not just a-d: [{key, label, description?, insight?, diagram?, recommended?, answers: {qid: {selected?: [key,...], custom?}}}]. The user sees these next to "Start" instead of answering question by question; picking one applies its answers verbatim and submits immediately, so each template's answers must be coherent and cover the questions its implied branch reaches — e.g. a positioning template like "the Vercel/Railway highest standard" decides a whole stance for the user)}}. Rules: entry required and must exist; every next target must exist; references and cycles are rejected at submit; unreachable questions are never asked. First-try checklist (the five most-rejected specs): (1) every id named in any next (question- or option-level) must exist in questions — re-check every next target after trimming or renaming questions, dangling references are the #1 rejection; (2) question-level next may be an id, an id list, or null (= no follow-up), never required; (3) the branch graph must be acyclic; (4) option keys unique per question; (5) a quick template's answers may name only questions its own selections actually reach, using option keys that exist on that question — multiple keys, or keys combined with custom text, only on multiSelect questions. Validation errors name the exact offending spot and, for dangling references, the nearest defined id and the id roster — one retry fixes it. Each option's insight should embed engineering judgment (what great looks like / tradeoff / (today) state). The result carries path (order actually asked), answers ({id, selected: [{key,label}], custom?}), skipped; store Q&A verbatim as numbered QA records and derive follow-ups from them. Next to "Start" the user can also press Quick/Reroll/Push/Discuss — all four return normally (not errors): quick = the user picks one of the quick templates, arrives as a normal answered result, no extra handling needed; reroll/push/discuss return those outcomes with an instruction field: reroll = rewrite the same topic in cleaner, better-spoken prose and call again; push = do DEEP web research first (minimum 12 competitors, open-source repos, .refs/ curated research) then expand and deepen the survey with evidence-grounded insights and call again; discuss = talk it through in chat first, do not immediately re-call.
Builder for big researched surveys (use INSTEAD of one giant ask_survey payload): survey_draft_set op=begin locks a full-frame skeleton (entry, ids, at least 5 option keys per option-bearing question — labels/prompts may be TODO: stubs — branch wiring validated on the spot); research (codebase, web, 9-12 competitors, docs) interleaved with survey_draft_set op=patch — at most 3 questions per call, prose only (prompt/header/detail/options label+description+insight+sources; branch wiring belongs to op=structure, allowed while the draft is under the question cap, each use bumps the revision); survey_draft_get returns the required-field checklist (per option: label, description, insight, at least 1 source are REQUIRED — get lists every gap); survey_draft_launch refuses anything still TODO:, then starts the wizard — reroll/push/discuss reopen the draft for editing instead of a from-scratch rebuild. Drafts persist as files (.dsh/survey-drafts/<slug>.json in the workspace; old drafts remain as reference), one active draft per conversation, a tracker-style card shows progress in the GUI, nothing ever expires, and every settled survey is recorded.`

const ANNOUNCEMENT_ZH = `本机已安装 dsh-rich-questions 插件（富问题/问卷系统）：它把 ask_user_question 扩展为可分支的 ask_survey。需要向用户收集结构化意见/预期/验收状态且满足任一条件时用 ask_survey：≥4 个问题的问卷、超过 10 题的大问卷、问题间有分支（前题答案决定后题）、选项需要超过一句的解释（hover 洞察、来源、tradeoff）。1-3 个简单确认/单选题仍用 ask_user_question。
语言规则：问卷全部用户可见内容（title、intro、prompt、选项 label/description/insight、quick 模板文案）一律使用用户当前聊天所用的语言——英文对话写英文，中文对话写中文，其他语言同理。整份问卷保持同一语言，不要混用；选项 key 无论如何都用短 ASCII 字母（a、b、c…）。
深度基准：富问卷要对得起它的形态。真正的预期对齐/验收/范围调研默认 10-30 题——「≥4 题」只是入场门槛，不是目标。凡是「一个答案会改变后面该问什么」的地方都要分支：超过 6 题的问卷至少要有 2-3 个真实分支点（选项级 next 路由到不同的题目段），路径后面可以再汇合。凡带选项的问题至少 5 个选项（键 a–e，目标 5-8 个）——必须是真正有立场差异、读者可以反对的选项，绝不凑数；自由文本输入行单独存在，不计入选项数。涉及判断的选项都要有真正的 insight（什么是好 / tradeoff / (today) 现状）；架构或流程类选项配 diagram；用户可能已知道自己想要什么时，配 3-6 个 quick 模板。扁平无分支的 4 题问卷就是失误——如果确实只需要 1-3 个简单问题，直接用 ask_user_question。
读者优先准则（owner 强制；适用于你编写的每一份问卷，以及每次 reroll/push 重写）：为正在做决定的用户而写——平实、直接、零废话。绝不假设读者知道你在指什么：把显而易见的说出来、首次出现的术语给定义、每个问题都锚定到读者的处境与「这个答案会改变什么」。问题自包含（硬性规则）：每个问题必须让没跟上对话的读者也能独立看懂——禁止裸概念。prompt 里出现的机制（宽限期、fencing、缓存层等）必须在同一句里给出定义、说明它在读者环境里的位置、以及这个答案会改变什么。反例：「宽限期应该多长？」；正例：「当两个会话都能写同一状态时，旧会话会被 fence（写入开始被拒绝），但会短暂保留写权限（宽限期）让进行中的命令跑完——这个窗口应该多长？太短会中途丢弃工作，太长会回到双写混乱。」较长的背景放 detail（markdown），绝不把问题压缩成模糊。具体而有洞见——每个论断用可用的最强具体形式：数字、实例或具名对比，绝不悬空形容词。Obvious，not oblivious（把话说明显，而不是想当然）。硬性要求：结构永远完整——导语页交代（这是什么、为什么现在问、答案会怎样使用、大约多长）、header 分组、每个选项必有 description 一行；每个判断型选项的 insight 必含 what-great-looks-like + tradeoff + (today) + 一个具体抓手；禁止：空泛抽象选项（每个选项都要有读者可以反对的立场）、单边推销式 insight、无 insight 的判断选项；几乎所有问卷都配 quick 模板，且模板是具名立场（「Vercel 级打磨 + DX」，绝不用「方案一」）。
ask_survey 编写契约：参数 {survey: {title?, intro?(markdown 首屏), entry(首个问题 id), questions: {qid: {prompt, header?(分组), detail?(markdown 上下文), multiSelect?, allowCustom?(默认 true), skippable?(默认 true), options: [{key(任意字符串，建议单字母 a–z，多选可更多，需含 other 时用 key "other"), label, description?(一句话), insight?(markdown ~6 行：what great looks like / tradeoff / (today) 现状), diagram?(可选，紧凑 Mermaid 图，节点要少——用户点击「?」旁的分支图标展开，面板不滚动，图必须小到能整个塞进去), sources?(链接或引用), recommended?(推荐项放第一个), next?(选它后跟随的问题 id 或 id 数组；null=该分支结束；省略=用题目级 next)}], next?(题目级默认跟随：跳过/自由文本/选项未声明 next 时使用)}}, quick?(最多 6 个「一键模板」，键用 a–f 而非仅 a–d：[{key, label, description?, insight?, diagram?, recommended?, answers: {qid: {selected?:[key,...], custom?}}}]。用户在首屏点「快速」后看到这最多 6 个模板而不逐题作答；选中一个即用其 answers 直接套满全部题目并提交，因此每个模板的 answers 要连贯自洽、覆盖它所隐含分支触达的题目——例如"对标 Vercel/Railway 的最高标准"这类定位型模板，替用户把一整套倾向性答案都决定好)}}。规则：entry 必填且必须存在；所有 next 指向的问题必须存在；引用与环会在提交时被拒绝；未被分支到达的问题不会被问。首试自检（校验最常见的五种拒稿）：① 任何 next（题目级或选项级）指向的 id 必须存在于 questions——删题/改题名后务必逐个复查 next 目标，悬空引用是第一大拒稿原因；② 题目级 next 可以是 id、id 数组或 null（=无后续，等同省略），永远非必填；③ 分支图必须无环；④ 选项 key 每题唯一；⑤ quick 模板的 answers 只能引用其自身选择实际可达的题目、且 selected 必须是该题存在的选项 key——多个 key 或 key+custom 组合仅限 multiSelect 题。校验错误会精确指出出错位置，悬空引用还会给出最接近的已有 id 与全部 id 清单，一次重试即可修复。每个选项的 insight 应内嵌工程判断（什么是好、tradeoff、(today) 现状）。作答结果含 path（实际问到的问题顺序）、answers（每题 {id, selected:[{key,label}], custom?}）、skipped；请把 Q&A 逐字存为编号 QA 记录并据此推导后续条目。用户在问卷首屏「开始」按钮旁还可点「快速/重掷/深挖/讨论」——四者都会让 ask_survey 正常返回（非报错）：快速由用户直接从 quick 模板中选 1 个提交，走的是普通 answered 结果，你无需额外处理；reroll/push/discuss 的 outcome 分别为 reroll/push/discuss 并附 instruction 字段：reroll=同主题用更简洁地道的表达（跟随用户语言）重写后重新调用；push=先做深度网络调研（最少 12 个竞品/同类实现、GitHub 开源仓库、.refs/ 目录已有研究）再据此扩展加深问卷后重新调用——洞察必须引用具体证据；discuss=先在对话里讨论，不要立刻重新调用。
大型调研问卷请用构建器（而不是一次性巨型 ask_survey）：survey_draft_set op=begin 锁骨架（entry、题目 id、每题 ≥5 个选项 key——label/prompt 可为 TODO: 占位——分支结构即时校验）；随后边调研（代码库/网络/9-12 竞品/文档）边用 op=patch 补内容（每次 ≤3 题，仅文字字段：prompt/header/detail/选项 label+description+insight+sources；分支改动走 op=structure，题数上限内允许，每次 revision+1）；survey_draft_get 返回必填项清单（每选项 label/description/insight/≥1 source 均必填，get 会列出全部缺口）；survey_draft_launch 拒绝任何 TODO: 残留，通过后启动向导——reroll/push/discuss 会把草稿转为可编辑状态而非推倒重来。草稿持久化为文件（工作区 .dsh/survey-drafts/<slug>.json，旧草稿留作参考），每会话一个活跃草稿，tracker 式卡片展示进度，永不过期，每份结束的问卷都会留档。`

/** Locale-selected announcement: shipping both halves cost every session
 *  (including subagent children) ~4k tokens for a translation it never reads. */
export const ANNOUNCEMENT = (() => {
  const locale = process.env.LANG ?? process.env.LC_ALL ?? ''
  return /^zh/i.test(locale) ? ANNOUNCEMENT_ZH : ANNOUNCEMENT_EN
})()

/**
 * Instruction text returned (not thrown) for the three intro-page pre-flight
 * actions offered next to "Start". Each resolves the tool call normally so
 * the model reads it as the next step, not a failure.
 */
const PREFLIGHT_INSTRUCTIONS = {
  reroll: 'The user hit "Reroll" before starting: they want the same survey topic, branching intent, and structure, rewritten from scratch under the reader-first doctrine — same bones, obvious flesh: define every term on first use, add concrete examples and named comparisons, shorten sentences, anchor each question to the user\'s situation and what their answer changes, plain-spoken and direct (in the language the user is chatting in). No jargon, no filler, no floating adjectives. Call ask_survey again with the rewritten spec; do not ask the user anything first.',
  push: 'The user hit "Push" before starting: they want the survey pushed deeper — both deeper AND broader, grounded in RESEARCH, not intuition. Before calling ask_survey again, you MUST do ALL of the following: (1) AGGRESSIVE web research — search for competitors and comparable products solving this exact problem; find and study a MINIMUM of 12 competitors or comparable implementations. For each, capture: what they do differently, their architecture/approach, their key tradeoff, and what they got right that we have not. (2) Research OPEN-SOURCE repositories doing similar things — search GitHub and code hosting for projects in this space; read their READMEs, issue trackers, and design docs for real patterns and lessons learned. (3) Read the workspace .refs/ directory if it exists — it contains curated research references; use them and note what additional research is still needed. (4) Pull in any additional local context that sharpens the questions. Then expand and sharpen the survey: more thorough questions and options, insights grounded in SPECIFIC evidence from what you found (numbers, named comparisons, real patterns from the 12+ competitors), and new branch dimensions where they add precision — all while keeping full reader-first structure. Your survey options should read like they were written by someone who has studied the entire competitive landscape, not someone guessing. Call ask_survey again with the expanded, better-informed spec; do not ask the user anything first.',
  discuss: 'The user hit "Discuss" before starting: they do not want the form yet. Do not call ask_survey again immediately. Instead open a normal conversational discussion in chat about the survey\'s subject — ask clarifying questions, share your thinking — and only propose calling ask_survey again once the discussion converges on a clear direction.',
  superseded: 'A newer ask_survey call from the same session superseded this survey before the user answered it. Treat this call as cancelled: continue with whatever the newer survey returns; do not re-issue this one unless the user asks.',
  stale: 'This survey expired unanswered after 30 minutes and was cancelled. If the questions still matter, re-issue ask_survey (ideally fewer or sharper questions); otherwise continue without it.',
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
  // No TTL sweeper by operator rule: a pending survey waits indefinitely —
  // the only settle paths are the user's own actions (answer / cancel /
  // preflight) or turn abort. Nothing expires on a timer.
  #pending = new Map()
  #subscribers = new Set()

  /** Block until the user answers or cancels (or the turn aborts). */
  ask({ sessionId, spec, signal }) {
    if (signal?.aborted === true) return Promise.reject(new SurveyError('ask_survey was aborted before the user answered', 'SURVEY_ABORTED'))
    return new Promise((resolve, reject) => {
      const surveyId = randomUUID()
      const entry = { surveyId, sessionId, spec, createdAt: Date.now(), resolve, reject, onAbort: undefined, banked: new Map() }
      if (signal !== undefined) {
        entry.onAbort = () => this.settle(surveyId, { outcome: 'cancelled' })
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      // One pending survey per session (review P1): the client store keys by
      // sessionId, so a second concurrent ask would strand the first forever.
      // The newest intent wins; the superseded call settles with a distinct
      // outcome the model can act on.
      for (const prior of this.#pending.values()) {
        if (prior.sessionId === sessionId) this.settle(prior.surveyId, { outcome: 'superseded' })
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
      // Banked answers ride the snapshot so a refreshed/other browser
      // restores them as locked drafts (host is the authority for banked).
      ...(entry.banked.size > 0 ? { banked: this.#bankedSnapshot(entry) } : {}),
    }))
  }

  #bankedSnapshot(entry) {
    return [...entry.banked.values()].map((answer) => ({ id: answer.id, selected: answer.selected, ...(answer.custom !== undefined ? { custom: answer.custom } : {}) }))
  }

  /**
   * Write-ahead bank (wizard-style per-step commit): validate answers-so-far
   * and store them on the pending entry WITHOUT settling the tool call. The
   * user keeps walking; a refresh or another browser rehydrates banked
   * answers from state()/hello as locked. The final `answer` is unchanged —
   * it still carries the full set (banked included).
   */
  bank({ surveyId, answers }) {
    const entry = this.#pending.get(surveyId)
    if (entry === undefined) return { ok: false, error: 'not-pending' }
    const check = validateAnswers(entry.spec, answers)
    if (!check.ok) return { ok: false, error: check.errors.join('; ') }
    for (const answer of check.answers) entry.banked.set(answer.id, answer)
    this.#emit({ type: 'survey/banked', surveyId, sessionId: entry.sessionId, banked: this.#bankedSnapshot(entry) })
    return { ok: true, banked: entry.banked.size }
  }

  answer({ surveyId, answers }) {
    const entry = this.#pending.get(surveyId)
    if (entry === undefined) return { ok: false, error: 'not-pending' }
    const check = validateAnswers(entry.spec, answers)
    if (!check.ok) return { ok: false, error: check.errors.join('; ') }
    const answersById = new Map(check.answers.map((answer) => [answer.id, { selected: answer.selected, custom: answer.custom }]))
    // Banked answers are a lock, not a suggestion (review P2): a submission
    // that omits or changes a banked answer is rejected, not silently applied.
    for (const [id, banked] of entry.banked) {
      const submitted = answersById.get(id)
      const same = submitted !== undefined
        && JSON.stringify(submitted.selected ?? []) === JSON.stringify(banked.selected ?? [])
        && (submitted.custom ?? undefined) === (banked.custom ?? undefined)
      if (same === false) return { ok: false, error: `answer for "${id}" conflicts with its banked (locked) answer — banked answers cannot be changed` }
    }
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
    this.persistSettled(entry, result)
    this.#emit({ type: 'survey/resolved', surveyId, sessionId: entry.sessionId, ...result })
    // Every non-cancel outcome resolves the tool call with an actionable
    // result the model reads and acts on next turn; only an explicit cancel
    // aborts the tool call as an error.
    if (result.outcome === 'cancelled') entry.reject(new SurveyError('the user cancelled the survey', 'SURVEY_CANCELLED'))
    else entry.resolve(result)
    return { ok: true, ...result }
  }

  /**
   * Operator rule: nothing ends silently. Every settle persists a full
   * record (spec + banked answers + outcome + answers/path when present)
   * machine-locally, tracker-style, so any ended survey is recoverable.
   * Best-effort by design — a persistence failure must never block the
   * settle itself; only the record is lost.
   */
  persistSettled(entry, result) {
    try {
      const dir = join(pluginHome(), 'surveys')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${entry.surveyId}.json`), JSON.stringify({
        v: 1,
        surveyId: entry.surveyId,
        sessionId: entry.sessionId,
        outcome: result.outcome,
        settledAt: Date.now(),
        ...(entry.spec?.title !== undefined ? { title: entry.spec.title } : {}),
        ...(entry.banked.size > 0 ? { banked: this.#bankedSnapshot(entry) } : {}),
        ...(Array.isArray(result.answers) ? { answers: result.answers } : {}),
        ...(Array.isArray(result.path) ? { path: result.path } : {}),
        spec: entry.spec,
      }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort record: settle proceeds, only the record is lost */ }
  }

  /** Push a builder-draft frame to SSE subscribers (draft-card hydration). */
  emitDraft(frame) {
    this.#emit({ type: 'draft/updated', ...frame })
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

/** The three routes: state (GET), action (POST), events (SSE). draftsSummary feeds builder-card hydration. */
function makeRoutes(service, draftsSummary) {
  const state = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!guard(req, res)) return
      writeJson(res, 200, { surveys: service.state(), drafts: await draftsSummary() })
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
        // Write-ahead bank: commit answers-so-far without ending the survey.
        bank: () => service.bank({ surveyId, answers: body.answers }),
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
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      if (!guard(req, res)) return
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const push = (frame) => { try { res.write(`data: ${JSON.stringify(frame)}\n\n`) } catch { /* connection gone; close handler cleans up */ } }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignore */ } }, HEARTBEAT_MS)
      const close = () => { clearInterval(heartbeat); unsubscribe() }
      req.once('close', close)
      res.once('close', close)
      push({ type: 'hello', surveys: service.state(), drafts: await draftsSummary() })
    },
  }
  return [state, action, events]
}

/**
 * Human interaction is valid only for the exact live runtime root (same
 * boundary the built-in userQuestions seam enforces).
 */
function requireLiveRootAgent(ctx, exec) {
  const agent = exec.agent
  if (agent === undefined) throw new SurveyError('survey interaction requires a session-owned agent', 'SURVEY_NO_AGENT')
  const agents = ctx.agents
  if (agents === undefined || agents.get(agent.id) !== agent) throw new SurveyError('survey interaction requires the exact live calling agent', 'SURVEY_CALLER_NOT_LIVE')
  if (!agents.roots().includes(agent)) throw new SurveyError('survey interaction is unavailable while the calling agent is owned by another live agent; include the unresolved survey in the child agent\'s final result', 'SURVEY_DELEGATED_CALLER')
  return agent
}

/** Shape an answered survey result for the model: labels resolved, answered/skipped split. */
function shapeAnswered(spec, result) {
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
        ...(answer.justifications !== undefined ? { justifications: answer.justifications } : {}),
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
      prompt: { type: 'string', description: 'The question to display. MUST be self-contained: define any term it uses, say where in the reader\'s setup it applies, and what the answer changes — a reader who missed the conversation understands it standing alone; no naked concept name-drops (never "How long does the grace period last?" — define the grace period and where it lives in the same prompt).' },
      header: { type: 'string', description: 'Optional section label rendered above the question (grouping large surveys).' },
      detail: { type: 'string', description: 'Optional markdown context rendered under the question text. Use it for backstory that would bloat the prompt — never as a substitute for an anchored, self-contained prompt.' },
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
    description: 'Ask the user a rich branching survey/questionnaire: up to 150 questions, arbitrary option keys, per-option hover insights with sources, multi-select, free-text answers, and per-option branching (each option declares which questions follow it). Use for structured expectation/acceptance/alignment questionnaires, anything with more than ~3 questions, or any question set where the answer to one question determines which questions come next. For 1-3 simple confirmation/choice questions use ask_user_question instead. The survey pauses until the user completes it in the Web GUI; the result carries the ordered path actually asked, every answer (keys + labels), and the skipped list. LANGUAGE: author all user-facing survey content (title, intro, prompts, option labels/descriptions/insights, quick-template copy) in the language the user is currently chatting in — English conversation → English, 中文 → 中文, any other language → that language; one language consistently across the whole survey, with option keys kept as short ASCII letters regardless. DEPTH: for real expectation/alignment/scoping work default to 10-30 questions (the 4-question threshold is the entry condition, not the target), with at least 2-3 genuine branch points in any survey over 6 questions, AT LEAST 5 options per option-bearing question (keys a-e, aim 5-8, genuinely distinct stances — the free-text row is separate), insights on every judgment-bearing option, and quick templates whenever the user might already know their destination — a flat 4-question spec is a miss; if only 1-3 flat questions are truly needed, use ask_user_question instead. READER-FIRST DOCTRINE (mandatory for all survey content and every reroll/push rewrite): write for the deciding user, plain-spoken and direct; never assume the reader knows what you are referring to — spell out the obvious, define every term on first use, anchor each question to the reader\'s situation and what their answer changes; every question prompt is SELF-CONTAINED: define terms where they are used, say where they apply and what the answer changes — no naked concept name-drops (a prompt like "How long does the grace period last?" is a violation; define the mechanism in the same prompt), with longer backstory going into detail; strongest-available specificity per claim (a number, a concrete example, or a named comparison — never a floating adjective); full structure always (orienting intro: what/why/what-happens-with-answers/how long; header grouping; a description line on every option); every judgment option\'s insight carries what-great-looks-like + the tradeoff + (today) + one concrete handle; banned: vague-abstraction options, one-sided selling insights, judgment options without insights; ship quick templates as named stances on nearly every survey. FIRST-TRY CHECKLIST — the failures validation rejects most often: (1) every id named in any `next` (question- or option-level) must be a key of `survey.questions`; after trimming or renaming questions, re-check every next target — a dangling reference is the #1 rejected spec. (2) Question-level `next` may be an id, an id list, or null (= no follow-up); it is never required. (3) The branch graph must be acyclic. (4) Option keys are unique per question. (5) Each `quick` template\'s `answers` may name only questions its own selections actually reach, using option keys that exist on that question; multiple keys, or keys combined with custom text, are only valid on multiSelect questions. Validation errors name the exact offending spot and, for dangling references, suggest the nearest defined id and list the id roster — fix and re-issue in one retry. If a call errors with "survey must be an object", your own arguments JSON was cut off or malformed before this tool received it (the harness forwards bad tool-call JSON as text, so the "survey" field never arrived); the error text from this tool tells you exactly what was wrong — re-send a SMALLER payload (trim prompt/insight/description strings and options, drop the quick templates) or split the survey into two consecutive calls; never resend the identical payload.',
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
                justifications: { type: 'object', description: 'Present when the user justified choices: option key -> why text (the user typed WHY they chose that option; treat it as their stated intent when deriving follow-ups).' },
              },
            },
          },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // Human interaction is only valid for the exact live runtime root
      // (requireLiveRootAgent enforces the same boundary as the built-in
      // userQuestions seam).
      const agent = requireLiveRootAgent(ctx, exec)

      // The harness parses tool-call arguments leniently: valid JSON arrives
      // as an object, malformed JSON arrives as the raw text, empty as {}.
      // Recover whatever shape survived and give a precise diagnostic when
      // the payload was truncated, so a model with a small output budget can
      // shrink and retry instead of circling on an opaque rejection.
      const resolvedArgs = resolveSurveyArgument(args)
      if (!resolvedArgs.ok) throw new SurveyError(`invalid survey argument: ${resolvedArgs.error}`, 'SURVEY_BAD_SPEC')
      const check = validateSpec(resolvedArgs.args.survey, LIMITS)
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
      return shapeAnswered(spec, result)
    },
  }
}

/**
 * The builder lifecycle tools over the persistent draft store: get (checklist
 * read), set (begin / patch / structure / discard), launch (completeness gate
 * then the wizard, with reopen-on-reroll). Every successful op emits a
 * draft/updated SSE frame so the client draft card stays live.
 */
function draftToolDefinitions(ctx, service, structureQuestionCap) {
  const frameFor = (draft, completeness, file) => ({
    conversationId: draft.conversationId,
    slug: draft.slug,
    title: draft.title,
    status: draft.status,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    ready: completeness.ready,
    progress: completeness.totals,
    ...(file !== undefined ? { file } : {}),
  })
  const summarize = (op, result) => ({
    ...(op !== undefined ? { op } : {}),
    slug: result.draft.slug,
    title: result.draft.title,
    status: result.draft.status,
    revision: result.draft.revision,
    active: true,
    file: result.file,
    completeness: {
      ready: result.completeness.ready,
      totals: result.completeness.totals,
      incomplete: result.completeness.perQuestion.filter((entry) => entry.missing !== undefined),
    },
    ...(result.ignored !== undefined ? { ignored: result.ignored } : {}),
  })
  const setTool = {
    name: 'survey_draft_set',
    description: 'Builder write. op=begin: lock a skeleton {title, survey:{entry, questions}} — ids, >=5 option keys per option-bearing question (labels/prompts may be "TODO:" stubs), branch wiring; validated on the spot; the draft title becomes the survey title unless survey.title is set. op=patch: flesh out at most 3 questions per call with prose only (prompt/header/detail/multiSelect/allowCustom/skippable/options label+description+insight+sources — option "next" fields are structural and ignored), and/or set draft-level fields: intro (markdown first page) and quick (the up-to-6 one-click templates, authored LAST over finished questions — validated immediately incl. the two-way coverage rule). op=structure: replace the whole graph (allowed while under the question cap; bumps revision). op=discard: retire the active draft (file remains as reference). Drafts are persistent files; one active draft per conversation; old drafts remain.',
    parameters: {
      type: 'object',
      required: ['op'],
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['begin', 'patch', 'structure', 'discard'], description: 'Lifecycle operation.' },
        title: { type: 'string', description: 'op=begin: survey title; seeds the draft slug and defaults the survey title.' },
        survey: { type: 'object', description: 'op=begin/structure: the survey skeleton {title?, intro?, entry, questions} — same shape ask_survey takes; prompts/labels may be "TODO:" stubs, structure must validate.' },
        slug: { type: 'string', description: 'op=patch/structure/discard: target draft; omit to use the conversation active draft.' },
        questions: { type: 'object', description: 'op=patch: map of question id -> content patch {prompt?, header?, detail?, multiSelect?, allowCustom?, skippable?, options?} (options replaced wholesale when present).' },
        intro: { type: 'string', description: 'op=patch: set the survey intro (markdown first page).' },
        quick: { type: 'array', maxItems: 6, items: { type: 'object' }, description: 'op=patch: replace the quick templates — same shape as ask_survey quick [{key, label, description?, insight?, recommended?, answers: {qid: {selected}}}]. Author them last, over finished questions.' },
      },
    },
    async execute(args, exec) {
      const agent = requireLiveRootAgent(ctx, exec)
      const store = draftStoreFor(exec, structureQuestionCap)
      const conversationId = agent.id
      const resolveSlug = async () => {
        if (typeof args.slug === 'string' && args.slug !== '') return args.slug
        const active = await store.get({ conversationId })
        if (!active.ok) throw new SurveyError(`survey_draft_set ${args.op} failed: ${active.error}`, 'SURVEY_DRAFT_MISSING')
        return active.draft.slug
      }
      let outcome
      if (args.op === 'begin') {
        if (typeof args.survey !== 'object' || args.survey === null) throw new SurveyError('survey_draft_set op=begin requires survey {entry, questions}', 'SURVEY_DRAFT_BAD_OP')
        outcome = await store.begin({ conversationId, title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title : 'Draft survey', survey: args.survey })
      } else if (args.op === 'patch') {
        const slug = await resolveSlug()
        outcome = await store.patch({ slug, questions: args.questions, intro: args.intro, quick: args.quick })
      } else if (args.op === 'structure') {
        const slug = await resolveSlug()
        if (typeof args.survey !== 'object' || args.survey === null) throw new SurveyError('survey_draft_set op=structure requires survey {entry, questions}', 'SURVEY_DRAFT_BAD_OP')
        outcome = await store.structure({ slug, survey: args.survey })
      } else if (args.op === 'discard') {
        const slug = await resolveSlug()
        outcome = await store.discard(slug)
        service.emitDraft({ conversationId, slug, status: 'discarded', updatedAt: Date.now() })
        return { op: 'discard', slug, status: 'discarded' }
      } else {
        throw new SurveyError(`survey_draft_set received unknown op "${String(args.op)}"`, 'SURVEY_DRAFT_BAD_OP')
      }
      if (!outcome.ok) throw new SurveyError(`survey_draft_set ${args.op} failed: ${outcome.error}`, 'SURVEY_DRAFT_BAD_OP')
      service.emitDraft(frameFor(outcome.draft, outcome.completeness, outcome.file))
      return summarize(args.op, outcome)
    },
  }

  const getTool = {
    name: 'survey_draft_get',
    description: 'Builder read: the draft (by slug, else the conversation active draft) with the required-field checklist — every option needs label, description, insight, and at least 1 source; every question needs a non-TODO prompt. Lists exactly what is missing before survey_draft_launch will pass.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Draft slug; omit for the conversation active draft.' },
      },
    },
    async execute(args, exec) {
      const agent = requireLiveRootAgent(ctx, exec)
      const store = draftStoreFor(exec, structureQuestionCap)
      const got = await store.get({ ...(typeof args.slug === 'string' && args.slug !== '' ? { slug: args.slug } : {}), conversationId: agent.id })
      if (!got.ok) throw new SurveyError(`survey_draft_get failed: ${got.error}`, 'SURVEY_DRAFT_MISSING')
      return {
        slug: got.draft.slug,
        title: got.draft.title,
        status: got.draft.status,
        revision: got.draft.revision,
        active: got.active === true,
        file: got.file,
        completeness: {
          ready: got.completeness.ready,
          totals: got.completeness.totals,
          incomplete: got.completeness.perQuestion.filter((entry) => entry.missing !== undefined),
        },
      }
    },
  }

  const launchTool = {
    name: 'survey_draft_launch',
    description: 'Launch the finished draft as the live wizard: validates structure, refuses any TODO: stub or missing required field (the checklist from survey_draft_get), then starts the wizard in the composer seat exactly like ask_survey. On reroll/push/discuss the draft is reopened for editing instead of discarded.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Draft slug; omit for the conversation active draft.' },
      },
    },
    async execute(args, exec) {
      const agent = requireLiveRootAgent(ctx, exec)
      const store = draftStoreFor(exec, structureQuestionCap)
      const got = await store.get({ ...(typeof args.slug === 'string' && args.slug !== '' ? { slug: args.slug } : {}), conversationId: agent.id })
      if (!got.ok) throw new SurveyError(`survey_draft_launch failed: ${got.error}`, 'SURVEY_DRAFT_MISSING')
      const { draft, completeness, file } = got
      const struct = validateSpec(draft.survey)
      if (!struct.ok) throw new SurveyError(`survey_draft_launch blocked — fix the structure first (op=structure): ${struct.errors.join('; ')}`, 'SURVEY_DRAFT_BAD_SPEC')
      if (!completeness.ready) {
        const incomplete = completeness.perQuestion.filter((entry) => entry.missing !== undefined).map((entry) => `- ${entry.id}: ${entry.missing.join(', ')}`)
        throw new SurveyError(`survey_draft_launch blocked — required fields still missing. Fix them with survey_draft_set op=patch, then relaunch:\n${incomplete.join('\n')}`, 'SURVEY_DRAFT_INCOMPLETE')
      }
      const spec = struct.spec
      await store.markLaunched(draft.slug)
      service.emitDraft(frameFor({ ...draft, status: 'launched' }, completeness, file))
      const result = await service.ask({ sessionId: agent.id, spec, signal: exec.signal })
      if (result.outcome === 'answered') return { ...shapeAnswered(spec, result), draft: draft.slug }
      // Pre-flight redirects reopen the draft: the research investment
      // survives the user's first reaction (operator rule).
      await store.reopen(draft.slug)
      service.emitDraft(frameFor({ ...draft, status: 'reopened' }, completeness, file))
      return {
        outcome: result.outcome,
        instruction: PREFLIGHT_INSTRUCTIONS[result.outcome],
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        draft: draft.slug,
        draftReopened: true,
      }
    },
  }

  return [setTool, getTool, launchTool]
}

export function apply(ctx, config = {}) {
  const service = new SurveyHostService()
  const structureQuestionCap = Number.isFinite(config?.structureQuestionCap) ? config.structureQuestionCap : 40
  // Manifest-only store for route/card hydration (draft files themselves are
  // resolved per-tool against the calling session's workspace).
  const manifestStore = createDraftStore({ profileRoot: pluginHome(), structureQuestionCap })
  const draftsSummary = async () => (await manifestStore.list()).manifest

  ctx.effect(() => {
    const disposers = makeRoutes(service, draftsSummary).map((route) => ctx.webServer.register(route))
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
  for (const definition of draftToolDefinitions(ctx, service, structureQuestionCap)) ctx.tools.register(definition)
}
