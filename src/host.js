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
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { computePath, draftCompleteness, groundingGaps, resolveSurveyArgument, validateAnswers, validateSpec } from './survey-engine.js'
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
 * Model-facing announcement: the authoring doctrine for rich surveys — the
 * loop, the bar, the feel, and the why. Layered placement: the tool
 * descriptions repeat the quality bar at authoring time, the preflight
 * instructions repeat it at reroll/push time, and an answered result carries
 * the handling contract; this section is the always-on home. Bilingual,
 * locale-selected below: a session reads one half only.
 */
const ANNOUNCEMENT_EN = [
  "dsh-rich-questions plugin — the rich survey system: ask_survey (direct) plus the draft builder (survey_draft_set / survey_draft_get / survey_draft_launch). This doctrine exists so every survey you issue is golden-standard: deeply researched, plainly spoken, worth the user’s full attention. The tool descriptions repeat the critical bar at the moment you author; this section carries the loop, the rules, and the why.",
  "WHEN — 4+ questions, or any branching (an answer decides what gets asked next), or options needing more than one sentence of explanation → ask_survey. 1-3 simple confirmations → ask_user_question. 10+ questions or research-backed work → the BUILDER loop, never one giant call: big surveys authored in a single payload are how shallow surveys happen.",
  "THE LOOP (commanded, research-first) — (1) RESEARCH: before locking any structure, study 9-12 comparable systems — competing tools, products, open-source repositories, internal precedents. Write it down or it did not happen: findings → .docs/research/, condensed digests → .docs/digest/, captured competitor UI/API traces → .docs/research/rips/, downloaded competitor source → .refs/. (2) BEGIN: survey_draft_set op=begin locks the skeleton (entry, question ids, ≥5 option keys per question; TODO stubs allowed). (3) ENRICH: loop [research → survey_draft_set op=patch, at most 3 questions per call] until survey_draft_get reports zero gaps; reshaping the structure goes through op=structure (bumps the revision). (4) VERIFY: survey_draft_get is the launch gate — the checklist must come back empty. (5) LAUNCH: survey_draft_launch; the wizard takes the composer seat and the tool waits with the user. (6) HONOR: see THE FEEL.",
  "THE BAR (every survey; no exceptions) — 1. Orienting intro: what this decides, why now, what happens with the answers, roughly how long. 2. Self-contained prompts: define every term where it is used, say where it applies and what the answer changes — a reader who missed the conversation must understand the question standing alone. 3. ≥5 stance-differentiated options per option-bearing question: positions a reader could actually defend — never filler, never “Option A”; the free-text row is an escape hatch, not an option. 4. Deep insight ROWS: every judgment option’s insight is 3-5 markdown list rows, one specific checkable point per row, each led by a content label (Pattern / Proven at / Breaks when / Here now / Evidence — labels vary with the content, never a fixed generic triple). Minimum per insight: one row names a real-world proven use (system/product/repo + outcome), one row states the tradeoff or break condition, one row gives the current-state handle (file path / number / record). A one-word-label row — 'Proven: X' with no who or where — is as shallow as a paragraph; depth lives in the specifics. 5. Branch-or-justify: if an answer should change what gets asked next, there MUST be a branch; a flat sequence where the answer obviously matters is a defect. 6. One language: every user-facing string in the user’s chat language (English chat → English survey, 中文对话 → 中文问卷); option keys stay short ASCII (a, b, c…). 7. Proportionality: tiny confirmations may be lighter (2-4 options, short prompts) — but self-contained prompts and honest options are the floor everywhere.",
  "THE FEEL (handling the human — this is why the tool earns trust) — MIRROR-BACK: the moment results return, open your next turn by restating the user’s stance in one line — “You chose X over Y because Z, so I will…”. Answers must feel heard before they are used. FOLLOW-THROUGH RECEIPT: when a decision lands, trace it to its answer (“Q3 → picked A → therefore…”); surveys that visibly change things get answered quickly next time. NO RE-ASKING: call survey_records (the settled-record reader) and check this session’s history before asking anything already answered — re-asking says nobody was listening. SOLICIT THE WHY: when an answer surprises you, ask for the reason (the wizard’s inline justify affordance, or chat) — a stated why is intent you can act on.",
  "AUTHORING CONTRACT — {survey: {title?, intro? (markdown first page), entry, questions: {qid: {prompt, header?, detail? (markdown backstory — never a substitute for an anchored prompt), multiSelect?, allowCustom? (default true), skippable? (default true), options: [{key (short ASCII; a, b, c…), label (a short stance, never “Option A”), description? (one sentence), insight? (3-5 deep ROWS: content-labeled points — a proven real-world use, the tradeoff or break condition, the current-state handle), diagram? (compact Mermaid via the branch icon; keep it small enough to fit), sources?, recommended? (badge; listed first), next? (id, id array, or null = branch ends; omitted = question-level next)}], next?}}, quick? (≤6 one-click templates: [{key a-f, label, description?, insight?, answers: {qid: {selected?, custom?}}}])}. Hard rules: entry must exist; every next target must exist — dangling references are the #1 rejection, recheck after every trim; the graph is acyclic; keys unique per question; quick answers may name only questions their selections reach, with option keys that exist (multi-key or key+custom only on multiSelect). Unreachable questions are never asked. Validation names the exact offending spot — one retry fixes it.",
  "RESULTS — outcome “answered” carries path (the order actually asked), answers (labels resolved, justifications attached), skipped. Store every Q&A verbatim as numbered records and derive follow-ups from them; the result’s handling field restates THE FEEL at the moment it matters.",
  "PREFLIGHT — next to Start the user may hit Reroll / Push / Discuss; each returns normally with an instruction field. Reroll: rewrite cleaner AND fix every bar gap — depth never shrinks. Push: write the research digest, study ≥12 systems, re-author at ≥2× depth, evidence-cited. Discuss: open a chat conversation first, no form. Small surveys may be re-issued with ask_survey directly; large ones re-enter THE LOOP at step 3 (ENRICH).",
].join("\n\n")

const ANNOUNCEMENT_ZH = [
  "dsh-rich-questions 插件——富问卷系统：ask_survey（直接发起）+ 问卷构建器（survey_draft_set / survey_draft_get / survey_draft_launch）。本守则的存在目的：让你发出的每份问卷都是金标准——研究扎实、语言干净、值得用户认真作答。工具描述会在你动笔那一刻重复关键底线；本节承载流程、规则与理由。",
  "何时用——≥4 题、或存在分支（某个答案决定接下来问什么）、或选项需要超过一句的解释 → ask_survey。1-3 个简单确认 → ask_user_question。≥10 题或需要研究支撑的问卷 → 一律走构建器循环，绝不用一次巨型调用：单次写完的大问卷正是浅问卷的来源。",
  "构建循环（强制，研究先行）——(1) 研究：锁定结构之前，先研究 9-12 个同类系统（竞品工具、产品、开源仓库、内部先例）。不落盘的研究等于没做：研究发现 → .docs/research/；精炼摘要 → .docs/digest/；抓取的竞品 UI/API 痕迹 → .docs/research/rips/；下载的竞品源码 → .refs/。(2) 起稿：survey_draft_set op=begin 锁骨架（entry、题目 id、每题 ≥5 个选项 key；允许 TODO 占位）。(3) 充实：循环〔研究 → survey_draft_set op=patch（每次 ≤3 题）〕直到 survey_draft_get 零缺口；改结构走 op=structure（revision+1）。(4) 校验：survey_draft_get 是发射闸门——清单必须清零。(5) 发射：survey_draft_launch；向导接管输入区，工具与用户一起等待。(6) 兑现：见「对人的分寸」。",
  "质量底线（每份问卷，无例外）——1. 导语定锚：这决定什么、为何是现在、答案怎么用、大约多久。2. 自包含题干：术语就地定义、说明适用位置与答案会改变什么——错过上下文的读者也能独立看懂。3. 每题 ≥5 个有立场差异的选项：读者真的可能选的立场——绝不凑数，绝不用「选项A」；自由文本行是逃生门，不算选项。4. 深度洞察行：每个判断型选项的 insight 排成 3-5 行（markdown 列表，一行一个具体可查证的观点，标签随内容而定：Pattern / Proven at / Breaks when / Here now / Evidence）。每条 insight 至少包含：一行给出真实世界的成功使用（系统/产品/仓库 + 结果）、一行讲清代价或失效条件、一行给出现状抓手（文件路径 / 数字 / 记录）。只有「Proven: X」一个词的行和整段文字一样浅——深度在具体细节里。5. 有分支或说明理由：某个答案理应改变后续提问时，必须有分支；答案明显重要却拍平成序列就是缺陷。6. 语言一致：所有用户可见文案用用户当前聊天语言（中文对话 → 中文问卷）；选项 key 一律短 ASCII（a、b、c…）。7. 比例原则：极小确认可以更轻（2-4 个选项、短题干）——但自包含题干与诚实选项是处处生效的底线。",
  "对人的分寸（这是工具赢得信任的原因）——镜子回应：结果一返回，下一轮第一句先复述用户立场（「你选了 X 而不是 Y，因为 Z，所以我会……」）。答案必须先被听见，再被使用。落实回执：每个决定落地时追溯到来源（「第3题 → 选了 A → 因此……」）；看得见改变的问卷，下次才会被认真填。不重复追问：先调用 survey_records（已归档问卷读取器）并查本会话历史，问过的绝不重问——重问等于没人听。追问理由：答案出乎意料时，追问为什么（向导内的理由输入，或在对话里问）——说出口的理由就是可执行的意图。",
  "编写契约—— {survey: {title?, intro?(markdown 首屏), entry, questions: {qid: {prompt, header?, detail?(markdown 背景——不能替代有锚点的题干), multiSelect?, allowCustom?(默认 true), skippable?(默认 true), options: [{key(短 ASCII；a、b、c…), label(一句立场，绝不用「选项A」), description?(一句话), insight?(3-5 行深度洞察：内容标签的观点——成功使用 / 代价 / 现状抓手), diagram?(紧凑 Mermaid，经分支图标展开；务必小), sources?, recommended?(徽章；放首位), next?(id、id 数组或 null=分支结束；省略=题目级 next)}], next?}}, quick?(≤6 个一键模板: [{key a-f, label, description?, insight?, answers: {qid: {selected?, custom?}}}])}。硬规则：entry 必须存在；所有 next 目标必须存在——悬空引用是第一大拒稿原因，删改后逐个复查；图必须无环；key 每题唯一；quick 的 answers 只能引用其选择实际可达的题目、且 key 必须存在（多 key / key+custom 仅限 multiSelect）。未被到达的题目不会被问。校验会指出确切位置——一次重试即可修复。",
  "结果处理——outcome「answered」含 path（实际提问顺序）、answers（label 已解析、理由已附）、skipped。把每条问答逐字存为编号记录并据此推导后续；结果里的 handling 字段会在最关键的时刻重申「对人的分寸」。",
  "预检重定向——Start 旁用户可点 重掷 / 深挖 / 讨论；都正常返回并附 instruction。重掷：更干净地重写并修复所有底线缺口——深度绝不缩水。深挖：先写研究摘要、研究 ≥12 个系统、以 ≥2× 深度重新编写、洞察全部引用证据。讨论：先在对话里聊清楚，不出表。小问卷可直接重发 ask_survey；大问卷从构建循环第 (3) 步重新进入。",
].join("\n\n")

/**
 * Locale-selected announcement: shipping both halves cost every session
 * (including subagent children) ~4k tokens for a translation it never reads.
 */
export const ANNOUNCEMENT = (() => {
  const locale = process.env.LANG ?? process.env.LC_ALL ?? ''
  return /^zh/i.test(locale) ? ANNOUNCEMENT_ZH : ANNOUNCEMENT_EN
})()

/**
 * Instruction text returned (not thrown) for the three intro-page pre-flight
 * actions offered next to "Start". Each resolves the tool call normally so
 * the model reads it as the next step, not a failure. The guarantees are
 * deliberately quantified: a Reroll escalates (never merely rewords) and a
 * Push doubles the depth on researched evidence that lands as reusable
 * artifacts under .docs/ and .refs/.
 */
const PREFLIGHT_INSTRUCTIONS = {
  reroll: "The user hit “Reroll” before answering: they want the same survey — topic, structure, intent — rewritten cleaner AND escalated. Do all of: (1) fix every quality-bar gap v1 had: missing or thin insight rows, vague options, a missing branch dimension, an intro that fails to orient; (2) make every prompt fully self-contained; (3) NEVER shrink — option count, branching, and insight density stay equal or grow; (4) plain-spoken, zero jargon, in the user’s chat language. Then re-issue without asking anything first: small surveys directly via ask_survey; large surveys re-enter the builder loop (survey_draft_set op=structure or op=patch → survey_draft_get → survey_draft_launch).",
  push: "The user hit “Push” before answering: they want the survey pushed deeper on the strength of RESEARCH, not intuition — and the research must land as reusable artifacts, not vanish inside this tool call. Do ALL of: (1) study a MINIMUM of 12 competitors or comparable implementations for this exact problem — twice the standing 9-12 bar; for each capture what it does differently, its approach, its key tradeoff, and what it got right that we have not. (2) Write the findings down: condensed digest → .docs/digest/<topic>.md; deeper findings → .docs/research/; captured competitor UI/API traces → .docs/research/rips/; downloaded competitor source → .refs/. Research that is not written down did not happen. (3) Re-author at GUARANTEED DOUBLE DEPTH: at least 2× the question count or equivalent branch depth (10→20+), every new option carrying evidence-cited row-laid-out insights drawn from the digest, and new branch dimensions wherever the research found them. (4) Re-issue without asking anything first: small surveys via ask_survey; large surveys re-enter the builder loop (structure/patch → get → launch).",
  discuss: "The user hit “Discuss” before answering: they do not want the form yet. Do not call ask_survey again immediately. Open a normal conversation about the survey’s subject — ask clarifying questions, share your thinking, converge on direction — and only propose the survey again once the discussion settles.",
  superseded: "A newer ask_survey call from the same session superseded this survey before the user answered it. Treat this call as cancelled: continue with whatever the newer survey returns; do not re-issue this one unless the user asks.",
  stale: "This survey ended unanswered and was cancelled. If the questions still matter, re-issue ask_survey sharper; otherwise continue without it.",
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
      const entry = { surveyId, sessionId, spec, createdAt: Date.now(), resolve, reject, onAbort: undefined, signal, banked: new Map() }
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

/**
 * The result-time handling contract, delivered WITH the answers — the exact
 * moment the model decides what to do with the user's input. Restates THE
 * FEEL from the announcement where it matters most.
 */
const RESULT_HANDLING = 'Open your next turn by mirroring the user’s stance in one line before acting on these answers (“You chose X over Y because Z, so I will…”). Trace each landed decision back to its answer as work proceeds. Never re-ask what this survey already answered; the justifications carry intent — honor them before overriding anything.'

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
    handling: RESULT_HANDLING,
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
      insight: { type: 'string', description: 'Markdown revealed on hover (~6 lines), 3-5 markdown ROWS, one specific checkable point per row, each led by a content label (Pattern / Proven at / Breaks when / Here now / Evidence — labels vary with the content). Minimum: one row names a real-world proven use (system/product/repo + outcome); one row states the tradeoff or break condition; one row gives the current-state handle (file path / number / record). No paragraphs, no one-word bumper stickers.' },
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
      insight: { type: 'string', description: 'Markdown revealed via the "?" button (~6 lines), 3-5 markdown ROWS, one specific point per row with content labels: what this template sets up, where that stance is proven in production (system/product/repo + outcome), what it costs or when it breaks, and who it is for today.' },
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
    description: 'Ask the user a rich branching survey/questionnaire: up to 150 questions, per-option branching (each option declares which questions follow), hover insights with sources, multi-select, free-text answers, and up to 6 one-click quick templates. Use for structured expectation/acceptance/alignment work — 4+ questions, or anything where one answer changes what comes next; keep ask_user_question for 1-3 simple confirmations; 10+ questions or research-backed surveys go through the BUILDER loop (survey_draft_set → survey_draft_get → survey_draft_launch), never one giant call. QUALITY BAR, at the moment you author: self-contained prompts (define every term in place and say what the answer changes); at least 5 stance-differentiated options per question (never filler, never a letter with no stance); every judgment option insight is 3-5 ROWS of specific checkable points with content labels — a proven real-world use (system/product/repo + outcome), the tradeoff or break condition, and the current-state handle (a number, a name, a file path). Branch wherever an answer should change what is asked next, and always open with an orienting intro: what this decides, why now, what happens with the answers, how long. All user-facing copy in the user chat language; option keys stay short ASCII. RESULTS HANDLING: when the answered result returns, open your next turn by mirroring the user stance in one line (You chose X over Y because Z, so I will...), trace decisions to answers as work lands, and never re-ask what a survey already answered. The survey pauses until the user completes it in the Web GUI; the result carries the ordered path actually asked, every answer (keys + labels), and the skipped list.',
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
          handling: { type: 'string', description: 'Present on outcome "answered": the human-handling contract — mirror the user’s stance back in one line, trace decisions to answers, never re-ask what this survey answered.' },
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
  // Draft lifecycle tools return structured objects in every success path:
  // summaries, checklist reads, and launched survey outcomes. Keep one
  // permissive object schema here because the exact fields vary by operation
  // while the registry still requires a canonical output projection.
  const draftToolOutput = {
    schema: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        outcome: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        revision: { type: 'integer' },
        active: { type: 'boolean' },
        file: { type: 'string' },
        instruction: { type: 'string' },
        draft: { type: 'string' },
        draftReopened: { type: 'boolean' },
        completeness: { type: 'object' },
        grounding: { type: 'object' },
        ignored: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
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
    grounding: result.draft.grounding ?? 'standard',
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
    description: 'Builder write, and the RESEARCH-FIRST LOOP in tool form: study 9-12 comparable systems BEFORE locking structure (findings to .docs/research/, condensed digests to .docs/digest/, captured competitor UI/API traces to .docs/research/rips/, downloaded competitor source to .refs/ — research that is not written down did not happen). op=begin: lock the skeleton {title, survey:{entry, questions}} — ids, >=5 option keys per option-bearing question (labels/prompts may be TODO stubs), branch wiring validated on the spot; the draft title defaults the survey title. op=patch: flesh out at most 3 questions per call — question fields and option fields MERGE per-field (send only what changes; per-option `sources` is the one exception and replaces the entire source list of that option), prose only (prompt/header/detail/multiSelect/allowCustom/skippable/options label+description+insight+sources — option next fields are structural and ignored), plus draft-level intro and quick (authored LAST over finished questions; validated immediately incl. the two-way coverage rule). op=structure: replace the whole graph while under the question cap; bumps revision — use it when research reshapes the skeleton or options must be reordered/removed. op=discard: retire the active draft. Loop [research → patch] until survey_draft_get reports zero gaps, then launch. One active draft per conversation; drafts persist as workspace files; old drafts remain.',
    parameters: {
      type: 'object',
      required: ['op'],
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['begin', 'patch', 'structure', 'discard'], description: 'Lifecycle operation.' },
        title: { type: 'string', description: 'op=begin: survey title; seeds the draft slug and defaults the survey title.' },
        grounding: { type: 'string', enum: ['standard', 'internal'], description: 'op=begin: grounding-bar mode. standard (default): launch requires every option to cite a source and every question to cite a comparison target (file path or URL). internal: skips the comparison half for surveys with no competitors.' },
        survey: { type: 'object', description: 'op=begin/structure: the survey skeleton {title?, intro?, entry, questions} — same shape ask_survey takes; prompts/labels may be "TODO:" stubs, structure must validate.' },
        slug: { type: 'string', description: 'op=patch/structure/discard: target draft; omit to use the conversation active draft.' },
        questions: { type: 'object', description: 'op=patch: map of question id -> content patch {prompt?, header?, detail?, multiSelect?, allowCustom?, skippable?, options?}. Option patches MERGE per-field against the option at the same index — send only what changes, lists may be partial (untouched tail options survive); the structure op replaces options wholesale.' },
        intro: { type: 'string', description: 'op=patch: set the survey intro (markdown first page).' },
        quick: { type: 'array', maxItems: 6, items: { type: 'object' }, description: 'op=patch: replace the quick templates — same shape as ask_survey quick [{key, label, description?, insight?, recommended?, answers: {qid: {selected}}}]. Author them last, over finished questions.' },
      },
    },
    output: draftToolOutput,
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
        outcome = await store.begin({ conversationId, title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title : 'Draft survey', survey: args.survey, grounding: args.grounding })
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
    description: 'Builder read and the LAUNCH GATE: returns the draft (by slug, else the conversation active draft) with the required-field checklist — every option needs label, description, insight (3-5 deep ROWS: proven use / tradeoff / current-state handle), and at least 1 source; every question needs a non-TODO self-contained prompt. Loop [research → survey_draft_set op=patch] until this reports zero gaps; only then call survey_draft_launch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Draft slug; omit for the conversation active draft.' },
      },
    },
    output: draftToolOutput,
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
        grounding: {
          ready: got.grounding.ready,
          mode: got.draft.grounding ?? 'standard',
          gaps: got.grounding.perQuestion.filter((entry) => entry.missing !== undefined),
        },
      }
    },
  }

  const launchTool = {
    name: 'survey_draft_launch',
    description: 'Launch the finished draft as the live wizard: validates structure, refuses any TODO stub or missing required field (the survey_draft_get checklist must be clean first — the gate is the loop exit), then starts the wizard in the composer seat exactly like ask_survey. On reroll/push/discuss the draft reopens for editing and the model re-enters the loop — deeper each time — instead of rebuilding from scratch. Answered results carry the handling contract: mirror the user stance in one line, trace decisions to answers, never re-ask.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Draft slug; omit for the conversation active draft.' },
      },
    },
    output: draftToolOutput,
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
      // Grounding bar (operator decision, v3 roadmap): launch refuses drafts
      // whose options lack sources, or that never cite a comparison target
      // where it lives (file path / URL) — unless the draft began as
      // 'internal' (no competitors to compare).
      const grounding = groundingGaps(draft.survey, { skipComparison: draft.grounding === 'internal' })
      if (!grounding.ready) {
        const gaps = grounding.perQuestion.filter((entry) => entry.missing !== undefined).map((entry) => `- ${entry.id}: ${entry.missing.join(', ')}`)
        throw new SurveyError(`survey_draft_launch blocked by the grounding bar — every option needs a source, and one option per question must cite where its comparison target lives (file path or URL). Fix with survey_draft_set op=patch, then relaunch:\n${gaps.join('\n')}`, 'SURVEY_DRAFT_UNGROUNDED')
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

/**
 * The memory cluster: a read-only reader over settled survey records
 * (pluginHome()/surveys/<surveyId>.json — every ended survey persists one,
 * operator rule: nothing ends silently). This is the no-re-asking
 * doctrine's machinery: call it BEFORE authoring any survey, cite what you
 * found, and never re-ask an answered question. Read-only by design — the
 * memory-doing-harm guard: records surface with their dates so stale
 * stances read as stale, and nothing injects anywhere automatically.
 * @param ctx - plugin context (agents registry for the live-root check).
 * @returns the survey_records tool definition.
 */
function recordsToolDefinition(ctx) {
  return {
    name: 'survey_records',
    description: 'Memory: read the settled-survey record store (every answered survey this machine has run, newest first) BEFORE authoring or answering-planning any new survey. Each record carries its date, title, the questions asked (prompts), the chosen options (labels), free-text answers, and the user’s written justifications. Search with a query across titles, prompts, chosen labels, custom answers, and justifications; matched records return whole. Cite what you find (e.g. “per your 2026-08-28 survey on X you chose Y because Z”) and NEVER re-ask a question a record already answers — re-asking says nobody was listening. Records age: prefer recent stances, and re-confirm anything older than the current conversation when it matters.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring matched across titles, prompts, chosen option labels, free-text answers, and justifications. Omit to list the most recent records.' },
        limit: { type: 'number', description: 'Maximum records returned (default 8, max 25).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                surveyId: { type: 'string' },
                settledAt: { type: 'string' },
                title: { type: 'string' },
                outcome: { type: 'string' },
                answers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      prompt: { type: 'string' },
                      selected: { type: 'array', items: { type: 'string' } },
                      custom: { type: 'string' },
                      justifications: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      requireLiveRootAgent(ctx, exec)
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.trunc(args.limit), 1), 25) : 8
      const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.toLowerCase() : undefined
      const dir = join(pluginHome(), 'surveys')
      const names = await readdir(dir).catch(() => [])
      const records = []
      for (const name of names) {
        if (name.endsWith('.json') === false) continue
        try {
          const raw = JSON.parse(await readFile(join(dir, name), 'utf8'))
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw.answers) === false) continue
          const questions = raw.spec?.questions ?? {}
          const answers = raw.answers.map((answer) => ({
            id: answer.id,
            prompt: questions[answer.id]?.prompt ?? answer.id,
            selected: answer.selected.map((key) => questions[answer.id]?.options?.find((option) => option.key === key)?.label ?? key),
            ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
            ...(answer.justifications !== undefined ? { justifications: answer.justifications } : {}),
          }))
          records.push({
            surveyId: raw.surveyId,
            // Null (not dropped) for a hand-damaged record: the date is the
            // staleness signal, so surface its absence instead of hiding it.
            settledAt: Number.isFinite(raw.settledAt) ? new Date(raw.settledAt).toISOString() : null,
            outcome: raw.outcome,
            ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
            answers,
          })
        } catch { /* one torn record must not blind the reader */ }
      }
      records.sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''))
      const matches = query === undefined
        ? records
        : records.filter((record) => {
          const haystack = [
            record.title ?? '',
            ...record.answers.flatMap((answer) => [answer.prompt, ...answer.selected, answer.custom ?? '', ...Object.values(answer.justifications ?? {})]),
          ].join('\n').toLowerCase()
          return haystack.includes(query)
        })
      return { count: matches.length, records: matches.slice(0, limit) }
    },
  }
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
  ctx.tools.register(recordsToolDefinition(ctx))
}
