window.__ModuleLoader__.load({
	id: "dsh-rich-questions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/cx.js
		/** Tiny clsx stand-in (no runtime dependency for the local bundle). */
		function cx() {
			let out = "";
			for (const entry of arguments) {
				if (!entry) continue;
				if (typeof entry === "string" || typeof entry === "number") out += (out ? " " : "") + entry;
				else if (Array.isArray(entry)) { const nested = cx(...entry); if (nested) out += (out ? " " : "") + nested; }
				else for (const [key, value] of Object.entries(entry)) if (value) out += (out ? " " : "") + key;
			}
			return out;
		}
		//#endregion
		//#region lib/survey-engine.js (INLINE COPY — keep in sync with src/survey-engine.js)
		/**
		* The same pure engine the host validates with, inlined verbatim into the
		* browser bundle (ESM exports stripped). The client navigates the branch
		* path this computes; the host re-derives it to validate answers.
		*/
		function normalizeNext(value) {
			if (value === null || value === undefined) return [];
			if (typeof value === "string") return value === "" ? [] : [value];
			if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry !== "");
			return [];
		}
		function computePath(spec, answers = new Map()) {
			const nodes = spec.questions;
			const path = [];
			const seen = new Set();
			const expand = (id) => {
				if (typeof id !== "string" || Object.hasOwn(nodes, id) === false || seen.has(id)) return;
				seen.add(id);
				path.push(id);
				const node = nodes[id];
				const answer = answers.get(id);
				const nexts = [];
				const push = (list) => {
					for (const entry of list) nexts.push(entry);
				};
				if (answer !== undefined && answer.skipped !== true && answer.selected.length > 0) {
					for (const option of node.options ?? []) {
						if (!answer.selected.includes(option.key)) continue;
						if (Object.hasOwn(option, "next")) {
							if (option.next !== null) push(normalizeNext(option.next));
						} else {
							push(normalizeNext(node.next));
						}
					}
				} else {
					push(normalizeNext(node.next));
				}
				for (const next of nexts) expand(next);
			};
			expand(spec.entry);
			return path;
		}
		//#endregion
		//#region lib/transport.js
		const API = "/api/rich-questions";
		/**
		* Module-level survey store: sessionId -> { surveyId, spec, createdAt }.
		* Hydrated by the plugin SSE stream (hello + requested/resolved frames)
		* with a reconciliation poll as fallback; the host pending table is the
		* authority, so a closed/refreshed browser re-hydrates the in-flight
		* survey on reconnect.
		*/
		function createSurveyStore() {
			const bySession = new Map();
			const draftsBySlug = new Map();
			const listeners = new Set();
			let started = false;
			// Monotonic tick for useSyncExternalStore subscribers: a stable
			// primitive snapshot that changes exactly when notify() fires.
			let version = 0;
			function notify() {
				version += 1;
				for (const listener of [...listeners]) listener();
			}
			function applyState(surveys) {
				let changed = false;
				const live = new Map(surveys.map((survey) => [survey.sessionId, survey]));
				for (const [sessionId] of [...bySession]) if (!live.has(sessionId)) {
					bySession.delete(sessionId);
					changed = true;
				}
				for (const survey of surveys) {
					const current = bySession.get(survey.sessionId);
					if (current?.surveyId !== survey.surveyId) {
						bySession.set(survey.sessionId, { surveyId: survey.surveyId, sessionId: survey.sessionId, spec: survey.spec, createdAt: survey.createdAt, ...(Array.isArray(survey.banked) ? { banked: survey.banked } : {}) });
						changed = true;
					}
				}
				if (changed) notify();
			}
			function applyFrame(frame) {
				if (frame.type === "survey/requested") {
					if (bySession.get(frame.sessionId)?.surveyId !== frame.surveyId) {
						bySession.set(frame.sessionId, { surveyId: frame.surveyId, sessionId: frame.sessionId, spec: frame.spec, createdAt: frame.createdAt ?? Date.now() });
						notify();
					}
				} else if (frame.type === "survey/banked") {
					// Another tab banked answers: merge into the stored survey so
					// its wizard can adopt them as locked drafts.
					const current = bySession.get(frame.sessionId);
					if (current?.surveyId === frame.surveyId && Array.isArray(frame.banked)) {
						const merged = new Map((current.banked ?? []).map((answer) => [answer.id, answer]));
						for (const answer of frame.banked) merged.set(answer.id, answer);
						bySession.set(frame.sessionId, { ...current, banked: [...merged.values()] });
						notify();
					}
				} else if (frame.type === "survey/resolved") {
					if (bySession.get(frame.sessionId)?.surveyId === frame.surveyId) {
						bySession.delete(frame.sessionId);
						notify();
					}
				} else if (frame.type === "draft/updated") {
					// Live builder frame (every set op / launch / reopen). Discard
					// clears the card; anything else upserts, merged over the
					// hydrated frame so partial frames keep earlier fields.
					if (typeof frame.slug !== "string") return;
					if (frame.status === "discarded") draftsBySlug.delete(frame.slug);
					else draftsBySlug.set(frame.slug, { ...(draftsBySlug.get(frame.slug) ?? {}), ...frame, __live: true });
					notify();
				} else if (frame.type === "hello") {
					applyState(frame.surveys ?? []);
					applyDrafts(frame.drafts);
				}
			}
			/** Rebuild draft frames from a manifest snapshot (state route / hello). */
			function applyDrafts(manifest) {
				if (manifest === null || typeof manifest !== "object" || manifest === null) return;
				const entries = manifest.drafts;
				if (entries === null || typeof entries !== "object") return;
				const next = new Map();
				for (const [slug, entry] of Object.entries(entries)) {
					if (entry === null || typeof entry !== "object" || entry.status === "discarded") continue;
					next.set(slug, { slug, conversationId: entry.conversationId, title: entry.title, status: entry.status, updatedAt: entry.updatedAt, revision: entry.revision, ready: entry.ready, progress: entry.progress });
				}
				// Live frames may be fresher than the manifest (routes write the
				// manifest after the SSE push): keep any live-only slug.
				for (const [slug, frame] of draftsBySlug) if (frame.__live === true && !next.has(slug)) next.set(slug, frame);
				const signature = JSON.stringify([...next.entries()]);
				const previous = JSON.stringify([...draftsBySlug.entries()].map(([slug, frame]) => [slug, { slug, conversationId: frame.conversationId, title: frame.title, status: frame.status, updatedAt: frame.updatedAt, revision: frame.revision, ready: frame.ready, progress: frame.progress }]));
				if (signature === previous) return;
				draftsBySlug.clear();
				for (const [slug, frame] of next) draftsBySlug.set(slug, frame);
				notify();
			}
			function poll() {
				fetch(`${API}/state`, { cache: "no-store" }).then((res) => (res.ok ? res.json() : null)).then((data) => {
					if (data && Array.isArray(data.surveys)) applyState(data.surveys);
					if (data && typeof data === "object") applyDrafts(data.drafts);
				}).catch(() => {});
			}
			function start() {
				if (started || typeof window === "undefined" || typeof EventSource === "undefined") return;
				started = true;
				try {
					const stream = new EventSource(`${API}/events`);
					stream.onmessage = (event) => {
						try { applyFrame(JSON.parse(event.data)); } catch { /* one bad frame must not kill the stream */ }
					};
					stream.onerror = () => { /* EventSource reconnects; the hello frame re-hydrates */ };
				} catch { /* fall back to the poll below */ }
				window.setInterval(poll, 20_000);
				document.addEventListener("visibilitychange", () => {
					if (document.visibilityState === "visible") poll();
				});
			}
			return {
				get(sessionId) { return bySession.get(sessionId); },
				/**
				 * The conversation's active draft frame (builder card), or
				 * undefined. Launched/discarded drafts never render the card:
				 * launched means the wizard owns the composer, discarded is
				 * gone.
				 */
				draftFor(sessionId) {
					let best;
					for (const frame of draftsBySlug.values()) {
						if (frame.conversationId !== sessionId) continue;
						if (frame.status === "launched" || frame.status === "discarded") continue;
						if (best === undefined || (frame.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = frame;
					}
					return best;
				},
				/**
				 * Hydration MUST start at plugin activation, not on first
				 * subscribe: the composer chain only mounts the wizard when
				 * select() already sees a pending survey for the viewed
				 * session, and nothing subscribes before that mount — a
				 * lazy start() here would deadlock (store never fetches,
				 * wizard never mounts, tool call hangs forever).
				 */
				start,
				/** Forget locally after a successful action (the resolved frame confirms). */
				forget(sessionId) { if (bySession.delete(sessionId)) notify(); },
				subscribe(listener) {
					start();
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** Snapshot tick for useSyncExternalStore — stable between notifies. */
				getVersion() { return version; },
				async respond(surveyId, action) {
					const res = await fetch(`${API}/action`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ...action, surveyId }),
					});
					const body = await res.json().catch(() => ({ ok: false, error: "bad-host-response" }));
					if (!res.ok || body.ok !== true) throw new Error(body.error ?? `action failed: HTTP ${res.status}`);
					return body;
				}
			};
		}
		const surveyStore = createSurveyStore();
		//#endregion
		//#region lib/locales.js
		const NS = "rich-question";
		const zh = {
			"title.default": "问卷",
			"option.recommended": "推荐",
			"sources.title": "来源",
			"insight.expand": "查看详情",
			"justify.hint": "写下你的理由——它会随答案一起交给 agent，agent 必须兑现它",
			"justify.placeholder": "为什么选这个？（agent 会读到并兑现）",
			"justify.line": "理由：",
			"insight.collapse": "收起详情",
			"diagram.view": "查看流程图",
			"diagram.hide": "收起流程图",
			"diagram.loading": "图表加载中…",
			"diagram.error": "图表渲染失败",
			"crash.title": "问卷渲染出错",
			"crash.body": "渲染这份问卷时出了问题；对话输入区不受影响。可点击重试，或让模型重新发起问卷。",
			"crash.retry": "重试渲染",
			"draft.eyebrow": "问卷草稿",
			"draft.complete": "题完成",
			"draft.missing": "个必填缺口",
			"draft.revision": "结构版本",
			"draft.dismiss": "隐藏草稿卡片",
			"draft.hint": "正在按构建器流程构建这份问卷（调研 + 小步补全）；构建完成会自动切换为问卷向导。聊天输入不受影响。",
			"draft.status.building": "构建中",
			"draft.status.launched": "已启动",
			"draft.status.reopened": "已重开",
			"draft.status.discarded": "已废弃",
			"custom.placeholder": "输入你的答案",
			"action.start": "开始",
			"action.start.hint": "开始逐题作答——随时可以返回上一题或跳过。",
			"action.reroll": "重掷",
			"action.reroll.hint": "同一主题重新生成一版问卷：用你当前的语言，更简洁、更地道、更清晰的表达，去掉复杂措辞。",
			"action.push": "深挖",
			"action.push.hint": "先做一轮主动网络调研，挖掘竞品方法论、架构与情报，再据此把问卷加深加广后重新生成。",
			"action.discuss": "讨论",
			"action.discuss.hint": "先不急着填表——在对话里和 AI 讨论这个主题，想清楚方向后再重新生成问卷。",
			"action.quick": "快速",
			"action.quick.hint": "把当前问卷压缩成最多 6 个「决策模板」——选 1 个即可自动套用全部答案并直接提交，无需逐题作答。",
			"quick.chip": "快速模式",
			"quick.title": "快速模式",
			"quick.subtitle": "选择最贴近你目标的一项，自动套用全部答案并直接提交。",
			"action.skip": "跳过",
			"action.skip.hint": "本题不作答，直接进入下一题。",
			"action.bank": "暂存并继续",
			"action.bank.hint": "把到目前为止的答案立刻提交到后台暂存（此后不可再修改），随即继续下一题——中途刷新或换浏览器也不会丢。",
			"bank.count": "已暂存 {n}",
			"action.next": "下一题",
			"action.next.hint": "保存本题答案并继续。",
			"action.submit": "提交问卷",
			"action.submit.hint": "把你的答案交回给 AI。",
			"error.unanswered": "请先选择一个选项或填写答案。",
			"nav.prev": "上一题",
			"nav.cancel": "放弃问卷",
			"nav.minimize": "收起问卷卡片",
			"nav.maximize": "展开问卷卡片"
		};
		const en = {
			"title.default": "Survey",
			"option.recommended": "Recommended",
			"sources.title": "Sources",
			"insight.expand": "View details",
			"justify.hint": "Add your why — it rides the answer and the agent must honor it",
			"justify.placeholder": "Why this one? (the agent reads and honors it)",
			"justify.line": "why: ",
			"insight.collapse": "Hide details",
			"diagram.view": "View diagram",
			"diagram.hide": "Hide diagram",
			"diagram.loading": "Loading diagram…",
			"diagram.error": "Diagram failed to render",
			"crash.title": "Survey render error",
			"crash.body": "Something went wrong rendering this survey; the conversation composer is unaffected. Retry, or ask the model to re-issue the survey.",
			"crash.retry": "Retry render",
			"draft.eyebrow": "Survey draft",
			"draft.complete": "questions complete",
			"draft.missing": "required fields missing",
			"draft.revision": "rev",
			"draft.dismiss": "Hide draft card",
			"draft.hint": "This survey is being built through the builder lifecycle (research + small patches); the wizard takes over the composer automatically on launch. The chat input stays usable meanwhile.",
			"draft.status.building": "Building",
			"draft.status.launched": "Launched",
			"draft.status.reopened": "Reopened",
			"draft.status.discarded": "Discarded",
			"custom.placeholder": "Type your answer",
			"action.start": "Start",
			"action.start.hint": "Begin the question-by-question walk — you can go back or skip anytime.",
			"action.reroll": "Reroll",
			"action.reroll.hint": "Regenerate this survey on the same topic: cleaner, more well-spoken, competent writing in your language — no jargon, no complexity.",
			"action.push": "Push",
			"action.push.hint": "Run aggressive web research first to gather competitor methods, architecture, and intelligence, then regenerate the survey deeper and broader.",
			"action.discuss": "Discuss",
			"action.discuss.hint": "Don't fill the form yet — discuss the topic with the agent in chat first, then regenerate once the direction is clear.",
			"action.quick": "Quick",
			"action.quick.hint": "Condense this survey into up to 6 decision templates — pick one to auto-fill every answer and submit immediately, no question-by-question walk.",
			"quick.chip": "Quick mode",
			"quick.title": "Quick mode",
			"quick.subtitle": "Pick whichever is closest to what you want — it auto-fills every answer and submits right away.",
			"action.skip": "Skip",
			"action.skip.hint": "Leave this question unanswered and move on.",
			"action.bank": "Bank & continue",
			"action.bank.hint": "Commit your answers so far to the host in the background — they lock and survive a reload or another browser — then continue to the next question.",
			"bank.count": "{n} banked",
			"action.next": "Next",
			"action.next.hint": "Save this answer and continue.",
			"action.submit": "Submit survey",
			"action.submit.hint": "Send your answers back to the agent.",
			"error.unanswered": "Please select an option or type an answer first.",
			"nav.prev": "Previous question",
			"nav.cancel": "Dismiss the survey",
			"nav.minimize": "Collapse the survey card",
			"nav.maximize": "Expand the survey card"
		};
		//#endregion
		//#region lib/draft-store.js
		/**
		 * Best-effort local draft persistence, keyed by surveyId: a reload or
		 * tab switch never loses half-answered progress. localStorage tier
		 * covers the same browser; banked answers (host side) cover any
		 * browser. All operations are fail-safe — persistence must never
		 * break the wizard (private mode, quota, disabled storage).
		 */
		const DRAFT_PREFIX = "dsh-rich-questions/draft/";
		function loadDraftState(surveyId) {
			try {
				const raw = window.localStorage.getItem(DRAFT_PREFIX + surveyId);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.drafts !== "object" || parsed.drafts === null) return null;
				return parsed;
			} catch { return null }
		}
		function saveDraftState(surveyId, value) {
			try { window.localStorage.setItem(DRAFT_PREFIX + surveyId, JSON.stringify(value)) } catch { /* best-effort */ }
		}
		function clearDraftState(surveyId) {
			try { window.localStorage.removeItem(DRAFT_PREFIX + surveyId) } catch { /* best-effort */ }
		}
		const RECOVERY_PREFIX = "dsh-rich-questions/recovery/";
		/**
		* Spec identity for recovery: entry + question ids + prompt prefixes.
		* A re-ask (fresh surveyId) over the same tree hashes identically, so
		* banked answers survive cancel, crash, and re-issue.
		*/
		function specHash(spec) {
			const questions = spec?.questions;
			if (questions === null || typeof questions !== "object") return String(spec?.entry ?? "");
			const parts = [String(spec?.entry ?? "")];
			for (const id of Object.keys(questions).sort()) {
				const node = questions[id];
				const prompt = node !== null && typeof node === "object" && typeof node.prompt === "string" ? node.prompt : "";
				parts.push(id + ":" + prompt.slice(0, 120));
			}
			return parts.join("|");
		}
		function saveRecovery(hash, value) {
			try { window.localStorage.setItem(RECOVERY_PREFIX + hash, JSON.stringify(value)) } catch { /* best-effort */ }
		}
		function loadRecovery(hash) {
			try {
				const raw = window.localStorage.getItem(RECOVERY_PREFIX + hash);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return null;
				return parsed;
			} catch { return null }
		}
		//#endregion
		//#region lib/styles.css
		const css = `.rq-frame{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;justify-content:center;display:flex}
.rq-card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;padding:0;display:flex;overflow:hidden}
.rq-card,.rq-card *{box-sizing:border-box}
.rq-card,.rq-body,.rq-insight,.rq-source-list{scrollbar-width:none}
.rq-card::-webkit-scrollbar,.rq-body::-webkit-scrollbar,.rq-insight::-webkit-scrollbar,.rq-source-list::-webkit-scrollbar{display:none;width:0;height:0}
.rq-cardMinimized{max-height:none}
.rq-cardMinimized .rq-header{padding-bottom:14px}
.rq-header{flex-shrink:0;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px;display:flex}
.rq-headingBlock{min-width:0}
.rq-eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:11px;line-height:16px;display:flex;align-items:center;gap:6px;min-height:16px}
.rq-chip{background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px}
.rq-title{margin:0;font-size:16px;font-weight:500;line-height:22px;letter-spacing:-0.01em;overflow-wrap:anywhere}
.rq-headerActions{flex-shrink:0;align-items:center;gap:4px;display:flex}
.rq-iconButton{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid}
.rq-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rq-iconButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.rq-body{overscroll-behavior:contain;flex-direction:column;flex:auto;min-height:0;gap:10px;padding:12px 0 4px;display:flex;overflow-y:auto}
.rq-detail{padding:0 16px}
.rq-intro{padding:0 16px}
/* Bleed rows (design-system E3/Invariant-2): the option list negates the
body's horizontal padding so rows run edge-to-edge; separation between rows
is a 1px border-bottom divider (never a stroke-as-container); the card's
overflow:hidden clips the rounded corners. Rows keep their own inner padding
so content aligns with the header/footer text. */
.rq-options{flex-direction:column;gap:0;display:flex}
.rq-opt{width:100%;text-align:left;cursor:pointer;background:0 0;border:none;border-bottom:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:0;padding:10px 16px;display:flex;gap:10px;align-items:flex-start;font:inherit;color:inherit;transition:background-color 150ms cubic-bezier(0.2,0.7,0.2,1);user-select:none}
.rq-options .rq-opt:last-child{border-bottom:none}
.rq-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rq-opt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.rq-opt[aria-disabled="true"]{cursor:default;opacity:.7;pointer-events:none}
.rq-optSelected{background:color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 35%, transparent)}
.rq-key{min-width:22px;height:22px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;justify-content:center;align-items:center;margin-top:1px;display:inline-flex;overflow:hidden;padding:0 3px}
.rq-optSelected .rq-key{border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.rq-box{width:18px;height:18px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:5px;margin-top:2px;justify-content:center;align-items:center;display:inline-flex}
.rq-boxOn{border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.rq-copy{flex:1;min-width:0;display:flex;flex-direction:column}
.rq-headRow{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.rq-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0}
.rq-label{font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.rq-badge{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);border-radius:999px;font-size:11px;line-height:16px;padding:0 7px;flex:none}
.rq-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;overflow-wrap:anywhere;margin-top:2px}
.rq-infoBtn{width:20px;height:20px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid;transition:background-color 150ms cubic-bezier(0.2,0.7,0.2,1),color 150ms cubic-bezier(0.2,0.7,0.2,1)}
.rq-infoBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rq-infoBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.rq-infoBtnOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
.rq-expand{display:grid;grid-template-rows:0fr;transition:grid-template-rows 260ms cubic-bezier(0.2,0.7,0.2,1)}
.rq-expandOpen{grid-template-rows:1fr}
.rq-expandInner{overflow:hidden}
.rq-insight{margin-top:8px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-markdown-code-block);border-radius:10px;font-size:12px;line-height:18px;max-height:220px;overflow-y:auto;padding:8px 10px;opacity:0;transition:opacity 200ms cubic-bezier(0.2,0.7,0.2,1)}
.rq-expandOpen .rq-insight{opacity:1;transition-delay:90ms}
.rq-insight-md{font-size:12px}
.rq-sources{margin-top:6px;display:flex;flex-direction:column;gap:2px}
.rq-sources-title{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;text-transform:uppercase;letter-spacing:.04em}
.rq-source-list{display:flex;flex-direction:column;gap:1px}
.rq-source{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:16px;overflow-wrap:anywhere;text-decoration:none}
a.rq-source:hover{text-decoration:underline}
.rq-tooltipInsight{display:block;max-width:280px;font-size:12px;line-height:17px}
.rq-rowTools{flex:none;align-items:center;gap:2px;display:flex}
.rq-justifyRow{margin-top:4px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:8px;align-items:center;gap:6px;padding:4px 6px 4px 8px;display:flex;background:var(--dsw-alias-bg-base)}
.rq-justifyRowActive{border-color:var(--dsw-alias-state-business-primary)}
.rq-justifyInput{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.rq-justifyInput::placeholder{color:var(--dsw-alias-label-caption)}
.rq-justifyLine{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;margin-top:2px;overflow-wrap:anywhere;cursor:pointer;text-align:left;background:0 0;border:none;padding:0}
.rq-justifyLine:hover{text-decoration:underline}
.rq-diagram{margin-top:8px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-markdown-code-block);border-radius:10px;max-height:240px;overflow:hidden;justify-content:center;align-items:center;padding:8px;display:flex}
.rq-diagram svg{width:100%;height:auto;max-height:224px;display:block}
.rq-diagramLoading,.rq-diagramError{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.rq-draftCard{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);border-radius:14px;padding:10px 14px;display:flex;flex-direction:column;gap:7px}
/* Dock row: the card renders under the conversation input (composer.dock),
   so it only needs a breath of space from the input card above it. */
.rq-dockRow{margin-top:8px}
.rq-draftCard,.rq-draftCard *{box-sizing:border-box}
.rq-draftHead{display:flex;align-items:center;gap:8px;min-width:0}
.rq-draftTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rq-draftBarWrap{display:flex;align-items:center;gap:10px}
.rq-draftBar{width:140px;height:4px}
.rq-draftCounts{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rq-draftHint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.rq-crash{margin:8px 0;padding:12px 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px}
.rq-crashTitle{font-weight:600;color:var(--dsw-alias-state-error-primary)}
.rq-crashBody{margin-top:4px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.rq-crashMsg{margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.rq-crashRetry{margin-top:8px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:8px;background:transparent;color:inherit;font-size:12px;cursor:pointer}
.rq-diagramError{color:var(--dsw-alias-state-error-primary)}
.rq-customRow{cursor:text;border:none;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:0;align-items:center;gap:10px;padding:10px 16px;display:flex;transition:background-color 120ms ease}
.rq-customRowActive{background:var(--dsw-alias-interactive-bg-hover)}
.rq-customRowDisabled{opacity:.7;pointer-events:none}
.rq-bankedChip{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;flex:none}
.rq-customIcon{color:var(--dsw-alias-label-tertiary);flex:none;margin-top:2px;display:inline-flex}
.rq-footer{flex-shrink:0;justify-content:space-between;align-items:stretch;gap:0;padding:0;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin);display:flex}
.rq-pager{flex-shrink:0;align-items:center;gap:8px;display:flex;padding:0 8px 0 16px}
.rq-progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:13px;line-height:20px}
.rq-bar{width:96px;height:3px;background:var(--dsw-alias-border-l2-darkmode-thin);border-radius:999px;overflow:hidden}
.rq-barFill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:999px;transition:width 200ms cubic-bezier(0.2,0.7,0.2,1)}
.rq-feedback{flex:1;min-width:0;align-self:center;padding:0 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.rq-footerActions{flex-shrink:0;align-items:stretch;display:flex;margin-left:auto}
.rq-segBtn{background:0 0;border:none;border-left:1px solid var(--dsw-alias-border-l2-darkmode-thin);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0 14px;min-height:36px;font:inherit;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;align-items:center;transition:background-color 120ms ease,color 120ms ease}
.rq-footerActions .rq-segBtn:first-child{border-left:none}
.rq-segBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rq-segBtn:disabled{opacity:.45;cursor:default}
.rq-segPrimary{color:var(--dsw-alias-state-business-primary);font-weight:500}
.rq-segPrimary:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}
@media (prefers-reduced-motion: reduce){.rq-expand,.rq-insight,.rq-barFill,.rq-opt,.rq-infoBtn,.rq-segBtn{transition-duration:0ms}}
@media (width<=720px){.rq-card{border-radius:16px}.rq-header{padding:14px 12px 0 16px}.rq-body{padding:10px 0 2px}.rq-detail{padding:0 12px}.rq-intro{padding:0 12px}.rq-footer{flex-wrap:wrap}.rq-pager{padding:0 8px 0 12px}}`;
		const tagId = "dsh-rich-questions/survey-wizard.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-rich-questions";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region lib/components.js
		/** Free-text answer row (shared shape with the built-in composer). */
		function CustomRow({ value, placeholder, disabled, active, onChange, onEnter, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: cx("rq-customRow", active && "rq-customRowActive", disabled && "rq-customRowDisabled"),
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 13, className: "rq-customIcon" }),
					(0, react_jsx_runtime.jsx)("input", {
						type: "text",
						className: "rq-customInput",
						style: { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: "inherit", fontSize: 14, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
						placeholder,
						value,
						disabled,
						onChange: (event) => onChange(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
								event.preventDefault();
								onEnter();
							}
						}
					})
				]
			});
		}
		/** Full insight body (markdown + sources), shared by the tooltip preview and the expand panel. */
		function InsightBody({ insightText, sources, t, withSources }) {
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
				children: [
					insightText !== "" ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: insightText, className: "rq-insight-md" }) : null,
					withSources && sources.length > 0 ? (0, react_jsx_runtime.jsxs)("span", {
						className: "rq-sources",
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: "rq-sources-title", children: t("sources.title") }),
							(0, react_jsx_runtime.jsx)("span", {
								className: "rq-source-list",
								children: sources.map((source, index) => (0, react_jsx_runtime.jsx)(source.trim().startsWith("http") ? "a" : "span", {
									key: index,
									className: "rq-source",
									...source.trim().startsWith("http") ? { href: source, target: "_blank", rel: "noreferrer" } : {},
									children: source
								}))
							})
						]
					}) : null
				]
			});
		}
		/** Intro-page pre-flight button (reroll/push/discuss): outline button, explained by a short delayed tooltip so the row of four buttons stays legible without a wall of caption text. */
		function PreflightButton({ hint, disabled, onClick, children }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: hint,
				side: "top",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "rq-segBtn",
					disabled,
					onClick,
					children
				})
			});
		}
		//#region lib/mermaid.js
		/**
		 * Lazy, module-singleton Mermaid loader. Nothing downloads until the
		 * first diagram is actually expanded; every diagram afterwards reuses
		 * the same initialized instance. No local dependency — Mermaid ships
		 * nowhere in the host app, so this pulls the ESM build from a CDN on
		 * first use only (a one-time browser-cached fetch, not a bundle cost).
		 */
		const MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/+esm";
		let mermaidLoad;
		function loadMermaid() {
			if (mermaidLoad === undefined) mermaidLoad = import(/* @vite-ignore */ MERMAID_CDN_URL).then((module) => {
				const mermaid = module.default;
				const dark = typeof document !== "undefined" && (document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark");
				mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
				return mermaid;
			});
			return mermaidLoad;
		}
		let mermaidDiagramSeq = 0;
		/** Renders one compact Mermaid diagram; loads the engine on mount, keeps state per `code`. */
		function MermaidDiagram({ code, t }) {
			const [state, setState] = (0, react.useState)({ status: "loading" });
			(0, react.useEffect)(() => {
				let cancelled = false;
				setState({ status: "loading" });
				loadMermaid().then((mermaid) => mermaid.render(`rq-mmd-${String(mermaidDiagramSeq += 1)}`, code)).then(({ svg }) => {
					if (!cancelled) setState({ status: "ready", svg });
				}).catch((cause) => {
					if (!cancelled) setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
				});
				return () => { cancelled = true; };
			}, [code]);
			if (state.status === "loading") return (0, react_jsx_runtime.jsx)("span", { className: "rq-diagramLoading", children: t("diagram.loading") });
			if (state.status === "error") return (0, react_jsx_runtime.jsx)("span", { className: "rq-diagramError", children: t("diagram.error") });
			return (0, react_jsx_runtime.jsx)("div", { dangerouslySetInnerHTML: { __html: state.svg } });
		}
		//#endregion
		/**
		 * One option row: key badge, label, one-line description.
		 *
		 * Insight affordance is a dedicated trailing "?" button, not a
		 * whole-row hover trap: hovering it (any duration) previews the
		 * insight text in a delayed tooltip (does not fire on incidental
		 * mouse travel across the list), and clicking it pins the full
		 * insight — including clickable sources — open inline (disclosure,
		 * not a hover trap) until toggled again or the question changes.
		 *
		 * A second, independent affordance (the branch icon) opens the same
		 * panel in diagram mode instead: a compact Mermaid flow, no text.
		 * The two buttons share one expand panel — `expandedMode` says which
		 * content it currently shows (or null if closed).
		 */
		function OptionRow({ option, multi, selected, disabled, expandedMode, onChoose, onToggleExpand, onJustifySave, justifyText, t }) {
			const insightText = typeof option.insight === "string" ? option.insight.trim() : "";
			const sources = Array.isArray(option.sources) ? option.sources : [];
			const hasInsight = insightText !== "" || sources.length > 0;
			const diagramText = typeof option.diagram === "string" ? option.diagram.trim() : "";
			const hasDiagram = diagramText !== "";
			const recommended = option.recommended === true || /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i.test(option.label);
			const displayLabel = recommended ? option.label.replace(/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i, "") : option.label;
			const textOpen = expandedMode === "text";
			const diagramOpen = expandedMode === "diagram";
			const stopAndToggle = (mode) => (event) => {
				event.stopPropagation();
				onToggleExpand(mode);
			};
			// Justify: an answer affordance on the SELECTED option only — click the
			// pencil to open an inline input, checkmark (or Enter) submits; the saved
			// text rides the answer so the agent sees WHY this option was chosen.
			const [justifyEditing, setJustifyEditing] = (0, react.useState)(false);
			const [justifyDraftText, setJustifyDraftText] = (0, react.useState)(justifyText ?? "");
			const submitJustify = () => {
				const trimmed = justifyDraftText.trim();
				if (trimmed !== "") onJustifySave(option.key, trimmed.slice(0, 500));
				setJustifyEditing(false);
			};
			const justifyButton = selected ? (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cx("rq-infoBtn", justifyEditing && "rq-infoBtnOn"),
				"aria-label": t("justify.hint"),
				title: t("justify.hint"),
				disabled,
				onClick: (event) => {
					event.stopPropagation();
					setJustifyDraftText(justifyText ?? "");
					setJustifyEditing((value) => !value);
				},
				onKeyDown: (event) => event.stopPropagation(),
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 12 })
			}) : null;
			const justifyBlock = selected && justifyEditing ? (0, react_jsx_runtime.jsxs)("span", {
				className: cx("rq-justifyRow", justifyDraftText.trim() !== "" && "rq-justifyRowActive"),
				children: [
					(0, react_jsx_runtime.jsx)("input", {
						type: "text",
						className: "rq-justifyInput",
						placeholder: t("justify.placeholder"),
						value: justifyDraftText,
						maxLength: 500,
						autoFocus: true,
						onChange: (event) => setJustifyDraftText(event.target.value),
						onKeyDown: (event) => {
							event.stopPropagation();
							if (event.key === "Enter" && !(event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) { event.preventDefault(); submitJustify(); }
							if (event.key === "Escape") { event.stopPropagation(); setJustifyEditing(false); }
						}
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rq-iconButton",
						"aria-label": t("action.submit"),
						disabled: justifyDraftText.trim() === "",
						onClick: (event) => { event.stopPropagation(); submitJustify(); },
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, { size: 12 })
					})
				]
			}) : selected && justifyText != null && justifyText !== "" ? (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "rq-justifyLine",
				title: t("justify.hint"),
				onClick: (event) => {
					event.stopPropagation();
					setJustifyDraftText(justifyText ?? "");
					setJustifyEditing(true);
				},
				children: [t("justify.line"), justifyText]
			}) : null;
			const infoButton = (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cx("rq-infoBtn", textOpen && "rq-infoBtnOn"),
				"aria-expanded": textOpen,
				"aria-label": t(textOpen ? "insight.collapse" : "insight.expand"),
				disabled,
				onClick: stopAndToggle("text"),
				onKeyDown: (event) => event.stopPropagation(),
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutline14, { size: 12 })
			});
			const diagramButton = hasDiagram ? (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cx("rq-infoBtn", diagramOpen && "rq-infoBtnOn"),
				"aria-expanded": diagramOpen,
				"aria-label": t(diagramOpen ? "diagram.hide" : "diagram.view"),
				title: t(diagramOpen ? "diagram.hide" : "diagram.view"),
				disabled,
				onClick: stopAndToggle("diagram"),
				onKeyDown: (event) => event.stopPropagation(),
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, { size: 12 })
			}) : null;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: cx("rq-opt", selected && !multi && "rq-optSelected"),
				role: multi ? "checkbox" : "radio",
				"aria-checked": selected,
				"aria-disabled": disabled || void 0,
				tabIndex: disabled ? -1 : 0,
				onClick: () => { if (!disabled) onChoose(option.key); },
				onKeyDown: (event) => {
					if (disabled) return;
					if (event.key === " " || event.key === "Enter") {
						event.preventDefault();
						onChoose(option.key);
					}
				},
				children: [
					multi
						? (0, react_jsx_runtime.jsx)("span", {
							className: cx("rq-box", selected && "rq-boxOn"),
							"aria-hidden": "true",
							children: selected ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, { size: 12 }) : null
						})
						: (0, react_jsx_runtime.jsx)("span", { className: "rq-key", children: option.key }),
					(0, react_jsx_runtime.jsxs)("span", {
						className: "rq-copy",
						children: [
							(0, react_jsx_runtime.jsxs)("span", {
								className: "rq-headRow",
								children: [
									(0, react_jsx_runtime.jsxs)("span", {
										className: "rq-line",
										children: [
											(0, react_jsx_runtime.jsx)("span", { className: "rq-label", children: displayLabel }),
											recommended ? (0, react_jsx_runtime.jsx)("span", { className: "rq-badge", children: t("option.recommended") }) : null
										]
									}),
									hasInsight || hasDiagram ? (0, react_jsx_runtime.jsxs)("span", {
										className: "rq-rowTools",
										children: [
											hasInsight
												? infoButton
												: null,
											diagramButton,
											justifyButton
										]
									}) : null
								]
							}),
							option.description !== void 0 ? (0, react_jsx_runtime.jsx)("span", { className: "rq-desc", children: option.description }) : null,
							justifyBlock,
							hasInsight || hasDiagram ? (0, react_jsx_runtime.jsx)("div", {
								className: cx("rq-expand", expandedMode !== void 0 && expandedMode !== null && "rq-expandOpen"),
								children: (0, react_jsx_runtime.jsx)("div", {
									className: "rq-expandInner",
									children: diagramOpen && hasDiagram
										? (0, react_jsx_runtime.jsx)("div", { className: "rq-diagram", children: (0, react_jsx_runtime.jsx)(MermaidDiagram, { code: diagramText, t }) })
										: (0, react_jsx_runtime.jsx)("div", {
											className: "rq-insight",
											children: (0, react_jsx_runtime.jsx)(InsightBody, { insightText, sources, t, withSources: true })
										})
								})
							}) : null
						]
					})
				]
			}, `${option.key}`);
		}
		/**
		* The survey wizard: one question per page over the live branch path,
		* progress against the current path, hover insights, multi-select,
		* free-text, skip/back, and minimize.
		*/
		function SurveyFlow({ survey, t }) {
			const spec = survey.spec;
			const hasIntro = typeof spec.intro === "string" && spec.intro.trim() !== "";
			// Restore progress across reloads / tab switches: local drafts from
			// localStorage (same browser), banked answers from the host snapshot
			// (any browser — the host is the authority for banked). Banked
			// answers land as locked drafts and win over any local copy.
			const restored = (0, react.useMemo)(() => {
				const persisted = loadDraftState(survey.surveyId);
				const drafts = {};
				if (persisted !== null) {
					for (const [questionId, draft] of Object.entries(persisted.drafts)) {
						if (questionId === "" || typeof draft !== "object" || draft === null) continue;
						drafts[questionId] = {
							selected: Array.isArray(draft.selected) ? draft.selected.filter((key) => typeof key === "string") : [],
							custom: typeof draft.custom === "string" ? draft.custom : "",
							skipped: draft.skipped === true,
							...(draft.justify !== null && typeof draft.justify === "object" && !Array.isArray(draft.justify) ? { justify: Object.fromEntries(Object.entries(draft.justify).filter(([key, text]) => typeof key === "string" && typeof text === "string" && text !== "")) } : {})
						};
					}
				}
				const bankedIds = new Set(Array.isArray(persisted?.banked) ? persisted.banked.filter((id) => typeof id === "string") : []);
				if (Array.isArray(survey.banked)) {
					for (const answer of survey.banked) {
						if (typeof answer?.id !== "string" || spec.questions[answer.id] === undefined) continue;
						drafts[answer.id] = { selected: Array.isArray(answer.selected) ? answer.selected : [], custom: typeof answer.custom === "string" ? answer.custom : "", skipped: false };
						bankedIds.add(answer.id);
					}
				}
				// New surveyId (re-ask after cancel/crash): recover answers by spec hash.
				if (Object.keys(drafts).length === 0 || bankedIds.size === 0) {
					const recovery = loadRecovery(specHash(spec))
					if (recovery !== null && Array.isArray(recovery.banked) && recovery.banked.length > 0) {
						for (const [questionId, draft] of Object.entries(recovery.drafts ?? {})) {
							if (questionId === "" || typeof draft !== "object" || draft === null) continue
						if (spec.questions[questionId] === undefined || bankedIds.has(questionId)) continue
						drafts[questionId] = { selected: Array.isArray(draft.selected) ? draft.selected : [], custom: typeof draft.custom === "string" ? draft.custom : "", skipped: draft.skipped === true }
					}
					for (const id of recovery.banked) if (typeof id === "string" && spec.questions[id] !== undefined) bankedIds.add(id)
				}
				}
				const cursor = typeof persisted?.cursor === "number" ? persisted.cursor : undefined;
				return { drafts, bankedIds, cursor, quickMode: persisted?.quickMode === true };
			}, [survey.surveyId]);
			const [drafts, setDrafts] = (0, react.useState)(() => restored.drafts);
			const [cursor, setCursor] = (0, react.useState)(() => restored.cursor !== undefined ? restored.cursor : hasIntro ? -1 : 0);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [minimized, setMinimized] = (0, react.useState)(false);
			// Questions whose answers were banked (committed to the host):
			// view-only from then on — you can go back and read them, never
			// re-answer. (Before the host learns "bank", this set is empty.)
			const [bankedIds, setBankedIds] = (0, react.useState)(() => restored.bankedIds);
			// At most one option's panel is pinned open at a time (accordion),
			// shared between the two content modes (text insight vs. diagram);
			// never survives a question change.
			const [expanded, setExpanded] = (0, react.useState)(null);
			// Quick mode: an alternate intro-adjacent screen offering up to 6
			// whole-survey answer templates instead of the question-by-question
			// walk. Purely a client-side view switch — nothing to ask the host
			// until a template is actually picked (which submits like any answer).
			const [quickMode, setQuickMode] = (0, react.useState)(() => restored.quickMode);
			const hasQuick = Array.isArray(spec.quick) && spec.quick.length > 0;

			// Persist on every change (best-effort; tiny payloads). The recovery
			// snapshot is keyed by spec identity, so a re-ask with a fresh
			// surveyId still finds this progress (banked answers above all).
			(0, react.useEffect)(() => {
				const snapshot = { v: 1, drafts, banked: [...bankedIds], savedAt: Date.now() };
				saveDraftState(survey.surveyId, { ...snapshot, cursor, quickMode });
				saveRecovery(specHash(spec), snapshot);
			}, [survey.surveyId, drafts, cursor, quickMode, bankedIds]);
			// Adopt banked answers arriving later (another tab banked, or the
			// SSE hello frame landed after mount): they override local drafts.
			(0, react.useEffect)(() => {
				if (!Array.isArray(survey.banked) || survey.banked.length === 0) return;
				setDrafts((value) => {
					let changed = false;
					const next = { ...value };
					for (const answer of survey.banked) {
						if (typeof answer?.id !== "string" || spec.questions[answer.id] === undefined) continue;
						const nextDraft = { selected: Array.isArray(answer.selected) ? answer.selected : [], custom: typeof answer.custom === "string" ? answer.custom : "", skipped: false };
						const prev = value[answer.id];
						if (prev !== undefined && prev.selected.join("\u0000") === nextDraft.selected.join("\u0000") && prev.custom === nextDraft.custom && bankedIds.has(answer.id)) continue;
						next[answer.id] = nextDraft;
						changed = true;
					}
					return changed ? next : value;
				});
				setBankedIds((value) => {
					const next = new Set(value);
					let changed = false;
					for (const answer of survey.banked) {
						if (typeof answer?.id === "string" && spec.questions[answer.id] !== undefined && !next.has(answer.id)) { next.add(answer.id); changed = true; }
					}
					return changed ? next : value;
				});
			}, [survey.banked]);

			const toAnswers = (draftsValue) => {
				const map = new Map();
				for (const [questionId, draft] of Object.entries(draftsValue)) map.set(questionId, {
					selected: draft.selected,
					custom: draft.custom.trim(),
					skipped: draft.skipped
				});
				return map;
			};
			const path = (0, react.useMemo)(() => computePath(spec, toAnswers(drafts)), [drafts]);
			// The branch path shrinks/grows as answers change; keep the cursor in range.
			(0, react.useEffect)(() => {
				const floor = hasIntro ? -1 : 0;
				setCursor((current) => Math.min(Math.max(current, floor), path.length - 1));
			}, [path, hasIntro]);

			const currentId = cursor >= 0 ? path[cursor] : undefined;
			(0, react.useEffect)(() => { setExpanded(null); }, [currentId, quickMode]);
			const current = currentId !== undefined ? spec.questions[currentId] : undefined;
			const draft = currentId !== undefined && drafts[currentId] !== undefined ? drafts[currentId] : { selected: [], custom: "", skipped: false };
			const isIntro = cursor === -1;
			const isLast = !isIntro && cursor >= path.length - 1;
			const answeredOf = (value) => value !== undefined && value.skipped !== true && (value.selected.length > 0 || value.custom.trim() !== "");
			const answeredCount = path.filter((questionId) => answeredOf(drafts[questionId])).length;
			const currentAnswered = answeredOf(draft);
			const options = current?.options ?? [];
			const allowCustom = current?.allowCustom !== false;

			const isBanked = currentId !== undefined && bankedIds.has(currentId);

			const updateDraft = (update) => {
				if (currentId === undefined || bankedIds.has(currentId)) return;
				setDrafts((value) => ({ ...value, [currentId]: update(value[currentId] ?? { selected: [], custom: "", skipped: false }) }));
				setError(null);
			};
			const choose = (key) => {
				if (current?.multiSelect === true) updateDraft((value) => {
					const selected = value.selected.includes(key) ? value.selected.filter((entry) => entry !== key) : [...value.selected, key];
					// Unselecting an option drops its justification — a why for a
					// choice you no longer make is noise.
					const justify = { ...(value.justify ?? {}) };
					if (selected.includes(key) === false) delete justify[key];
					return { ...value, selected, justify, skipped: false };
				});
				else updateDraft((value) => ({ selected: [key], custom: "", skipped: false, justify: value.justify?.[key] !== undefined ? { [key]: value.justify[key] } : {} }));
			};
			// Justify: store the why for a selected option; rides the answer at submit.
			const saveJustify = (key, text) => {
				updateDraft((value) => ({ ...value, justify: { ...(value.justify ?? {}), [key]: text } }));
			};
			const onCustom = (value) => {
				updateDraft((entry) => ({
					...entry,
					selected: current?.multiSelect === true ? entry.selected : [],
					custom: value,
					skipped: false
				}));
			};
			const submitWith = (draftsValue) => {
				const surveyPath = computePath(spec, toAnswers(draftsValue));
				const entries = surveyPath.map((questionId) => {
					const value = draftsValue[questionId];
					const custom = value?.custom.trim() ?? "";
					const selected = value?.selected ?? [];
					const multi = spec.questions[questionId]?.multiSelect === true;
					const finalSelected = custom === "" || multi ? selected : [];
					// Justifications ride the answer for SELECTED options only.
					const justifications = Object.fromEntries(Object.entries(value?.justify ?? {}).filter(([key]) => finalSelected.includes(key)));
					return {
						id: questionId,
						selected: finalSelected,
						...custom === "" ? {} : { custom },
						...Object.keys(justifications).length > 0 ? { justifications } : {}
					};
				});
				setBusy("answer");
				setError(null);
				surveyStore.respond(survey.surveyId, { kind: "answer", answers: entries, path: surveyPath }).then(() => {
					clearDraftState(survey.surveyId);
					surveyStore.forget(survey.sessionId);
				}).catch((cause) => {
					setBusy(null);
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			};
			/**
			 * Bank & continue (wizard-style per-step commit for long surveys):
			 * fire the bank request with every answered-so-far entry, advance
			 * immediately (the bank runs in the background), and lock the banked
			 * questions only once the host confirms. On failure nothing locks —
			 * the answers stay local and editable, with the error surfaced.
			 */
			const bankAndContinue = () => {
				if (!currentAnswered || isBanked || isLast) return;
				const entries = path
					.filter((questionId) => answeredOf(drafts[questionId]))
					.map((questionId) => {
						const value = drafts[questionId];
						const custom = value.custom.trim();
						const multi = spec.questions[questionId]?.multiSelect === true;
						return {
							id: questionId,
							selected: custom === "" || multi ? value.selected : [],
							...custom === "" ? {} : { custom }
						};
					});
				setCursor((value) => value + 1);
				setError(null);
				surveyStore.respond(survey.surveyId, { kind: "bank", answers: entries }).then(() => {
					setBankedIds((value) => {
						const next = new Set(value);
						for (const entry of entries) next.add(entry.id);
						return next;
					});
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			};
			// One option's panel open at a time, shared by text/diagram; picking
			// the other mode on the same row swaps content without re-closing.
			const toggleExpand = (key, mode) => {
				setExpanded((value) => value !== null && value.key === key && value.mode === mode ? null : { key, mode });
			};
			// A quick template supplies a full (or partial) answers map keyed by
			// question id; seed drafts from it and submit immediately — no
			// separate confirmation step, that is the point of "quick".
			const pickQuick = (quickOption) => {
				const quickDrafts = {};
				for (const [questionId, answer] of Object.entries(quickOption.answers ?? {})) quickDrafts[questionId] = {
					selected: Array.isArray(answer?.selected) ? answer.selected : [],
					custom: typeof answer?.custom === "string" ? answer.custom : "",
					skipped: false
				};
				submitWith(quickDrafts);
			};
			const advance = () => {
				if (isIntro) { setCursor(0); setError(null); return; }
				if (!currentAnswered) { setError(t("error.unanswered")); return; }
				if (isLast) submitWith(drafts);
				else { setCursor((value) => value + 1); setError(null); }
			};
			const goBack = () => {
				const floor = hasIntro ? -1 : 0;
				setCursor((value) => Math.max(floor, value - 1));
				setError(null);
			};
			const skip = () => {
				if (currentId === undefined || current?.skippable === false || bankedIds.has(currentId)) return;
				const nextDrafts = { ...drafts, [currentId]: { selected: [], custom: "", skipped: true } };
				const nextPath = computePath(spec, toAnswers(nextDrafts));
				setDrafts(nextDrafts);
				setError(null);
				if (cursor >= nextPath.length - 1) submitWith(nextDrafts);
				else setCursor((value) => value + 1);
			};
			// Shared by every terminal, non-answer action (cancel + the three
			// intro-page pre-flight redirects): fire the request, mark busy,
			// forget the survey once the host confirms. The survey is over —
			// drop the local draft copy too.
			const respondTerminal = (kind) => {
				setBusy(kind);
				setError(null);
				surveyStore.respond(survey.surveyId, { kind }).then(() => {
					clearDraftState(survey.surveyId);
					surveyStore.forget(survey.sessionId);
				}).catch((cause) => {
					setBusy(null);
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			};
			const cancel = () => respondTerminal("cancel");
			// Pre-flight redirects: only meaningful before the first question is
			// answered, so only wired up on the intro page (see footer below).
			const reroll = () => respondTerminal("reroll");
			const push = () => respondTerminal("push");
			const discuss = () => respondTerminal("discuss");

			const primaryLabel = isIntro ? t("action.start") : isLast ? t("action.submit") : t("action.next");
			const primaryHint = isIntro ? t("action.start.hint") : isLast ? t("action.submit.hint") : t("action.next.hint");
			const progressPct = path.length === 0 ? 0 : Math.round((answeredCount / path.length) * 100);
			return (0, react_jsx_runtime.jsx)("div", {
				className: "rq-frame",
				"data-survey-key": survey.surveyId,
				children: (0, react_jsx_runtime.jsxs)("section", {
					className: cx("rq-card", minimized && "rq-cardMinimized"),
					"aria-label": typeof spec.title === "string" && spec.title !== "" ? spec.title : t("title.default"),
					children: [
						(0, react_jsx_runtime.jsxs)("header", {
							className: "rq-header",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "rq-headingBlock",
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											className: "rq-eyebrow",
											children: [
												typeof spec.title === "string" && spec.title !== "" ? spec.title : t("title.default"),
												quickMode ? (0, react_jsx_runtime.jsx)("span", { className: "rq-chip", children: t("quick.chip") }) : isIntro ? null : current?.header ? (0, react_jsx_runtime.jsx)("span", { className: "rq-chip", children: current.header }) : null
											]
										}),
										(0, react_jsx_runtime.jsx)("h2", { className: "rq-title", children: quickMode ? t("quick.title") : isIntro ? (typeof spec.title === "string" && spec.title !== "" ? spec.title : t("title.default")) : current?.prompt ?? "" })
									]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "rq-headerActions",
									children: [
										(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
											label: t(minimized ? "nav.maximize" : "nav.minimize"),
											side: "bottom",
											delayMs: 500,
											children: (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "rq-iconButton",
												"aria-label": t(minimized ? "nav.maximize" : "nav.minimize"),
												"aria-expanded": !minimized,
												disabled: busy !== null,
												onClick: () => setMinimized((value) => !value),
												children: minimized ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {})
											})
										}),
										(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
											label: t("nav.cancel"),
											side: "bottom",
											delayMs: 500,
											children: (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "rq-iconButton",
												"aria-label": t("nav.cancel"),
												disabled: busy !== null,
												onClick: cancel,
												children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {})
											})
										})
									]
								})
							]
						}),
						!minimized ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "rq-body",
									"data-survey-scroll": "true",
									children: [
										quickMode ? (0, react_jsx_runtime.jsx)("div", { className: "rq-detail", children: t("quick.subtitle") }) : null,
										!quickMode && isIntro ? (0, react_jsx_runtime.jsx)("div", { className: "rq-intro", children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: spec.intro }) }) : null,
										!quickMode && !isIntro && current.detail !== undefined ? (0, react_jsx_runtime.jsx)("div", { className: "rq-detail", children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: current.detail }) }) : null,
										quickMode ? (0, react_jsx_runtime.jsx)("div", {
											role: "radiogroup",
											"aria-label": t("quick.title"),
											children: spec.quick.map((quickOption, index) => (0, react_jsx_runtime.jsx)(OptionRow, {
												option: quickOption,
												multi: false,
												selected: false,
												disabled: busy !== null,
												expandedMode: expanded !== null && expanded.key === quickOption.key ? expanded.mode : null,
												onChoose: () => pickQuick(quickOption),
												onToggleExpand: (mode) => toggleExpand(quickOption.key, mode),
												t
											}, `${quickOption.key}-${String(index)}`))
										}) : null,
										!quickMode && !isIntro ? (0, react_jsx_runtime.jsx)("div", {
											role: current?.multiSelect === true ? "group" : "radiogroup",
											"aria-label": current?.prompt,
											children: options.map((option, index) => (0, react_jsx_runtime.jsx)(OptionRow, {
												option,
												multi: current.multiSelect === true,
												selected: draft.selected.includes(option.key),
												disabled: busy !== null || isBanked,
												expandedMode: expanded !== null && expanded.key === option.key ? expanded.mode : null,
												onChoose: choose,
												onJustifySave: saveJustify,
												justifyText: draft.justify?.[option.key] ?? null,
												onToggleExpand: (mode) => toggleExpand(option.key, mode),
												t
											}, `${option.key}-${String(index)}`))
										}) : null,
										!quickMode && !isIntro && allowCustom ? (0, react_jsx_runtime.jsx)(CustomRow, {
											value: draft.custom,
											placeholder: t("custom.placeholder"),
											disabled: busy !== null || isBanked,
											active: draft.custom.trim() !== "",
											onChange: onCustom,
											onEnter: advance,
											t
										}) : null
									]
								}),
								(0, react_jsx_runtime.jsxs)("footer", {
									className: "rq-footer",
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											className: "rq-pager",
											children: [
												(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
													label: t("nav.prev"),
													side: "top",
													delayMs: 500,
													children: (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "rq-iconButton",
														"aria-label": t("nav.prev"),
														disabled: quickMode ? busy !== null : isIntro || cursor === (hasIntro ? -1 : 0) || busy !== null,
														onClick: quickMode ? () => setQuickMode(false) : goBack,
														children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutline14, {})
													})
												}),
												quickMode || isIntro ? null : (0, react_jsx_runtime.jsx)("span", { className: "rq-bar", "aria-hidden": "true", children: (0, react_jsx_runtime.jsx)("span", { className: "rq-barFill", style: { width: `${progressPct}%` } }) }),
												quickMode ? null : (0, react_jsx_runtime.jsx)("span", { className: "rq-progress", "aria-label": `${answeredCount} / ${path.length}`, children: isIntro ? `0 / ${String(path.length)}` : `${String(answeredCount)} / ${String(path.length)}` }),
												quickMode || isIntro || bankedIds.size === 0 ? null : (0, react_jsx_runtime.jsx)("span", { className: "rq-bankedChip", "aria-label": t("bank.count").replace("{n}", String(bankedIds.size)), children: t("bank.count").replace("{n}", String(bankedIds.size)) })
											]
										}),
										(0, react_jsx_runtime.jsx)("div", { className: "rq-feedback", role: "status", children: error }),
										(0, react_jsx_runtime.jsxs)("div", {
											className: "rq-footerActions",
											children: [
												!quickMode && !isIntro && current?.skippable !== false ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.skip.hint"),
													disabled: busy !== null,
													onClick: skip,
													children: t("action.skip")
												}) : null,
												// Bank & continue: per-step commit for long surveys — answers-so-far go to
												// the host in the background and lock; the walk advances immediately.
												// Hidden once the current question is banked (nothing left to commit)
												// and on the last question (Submit already carries everything).
												!quickMode && !isIntro && !isLast && !isBanked ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.bank.hint"),
													disabled: busy !== null || !currentAnswered,
													onClick: bankAndContinue,
													children: t("action.bank")
												}) : null,
												// Quick mode replaces the whole footer with just the back arrow
												// above — picking a template submits directly, there is nothing
												// else to press.
												quickMode ? null : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
													label: primaryHint,
													side: "top",
													delayMs: 500,
													children: (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "rq-segBtn rq-segPrimary",
														disabled: busy !== null || (!isIntro && !currentAnswered),
														onClick: advance,
														children: primaryLabel
													})
												}),
												// Pre-flight redirects: only offered before the first question is
												// answered — once the wizard has moved past the intro page,
												// quick/reroll/pushing/discussing would abandon in-progress
												// answers, so they only ever sit next to "Start".
												!quickMode && isIntro && hasQuick ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.quick.hint"),
													disabled: busy !== null,
													onClick: () => setQuickMode(true),
													children: t("action.quick")
												}) : null,
												!quickMode && isIntro ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.reroll.hint"),
													disabled: busy !== null,
													onClick: reroll,
													children: t("action.reroll")
												}) : null,
												!quickMode && isIntro ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.push.hint"),
													disabled: busy !== null,
													onClick: push,
													children: t("action.push")
												}) : null,
												!quickMode && isIntro ? (0, react_jsx_runtime.jsx)(PreflightButton, {
													hint: t("action.discuss.hint"),
													disabled: busy !== null,
													onClick: discuss,
													children: t("action.discuss")
												}) : null
											]
										})
									]
								})
							]
						}) : null
					]
				})
			});
		}
		/**
		* Error boundary around SurveyFlow: a render crash inside the wizard
		* (bad spec field, poisoned state) shows a visible error card with a
		* Retry button instead of unmounting the conversation composer. The
		* boundary is keyed by surveyId at the wrap site, so a new survey
		* starts with a clean boundary.
		*/
		class SurveyBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
				this.retry = () => this.setState({ error: null });
			}
			static getDerivedStateFromError(error) { return { error } }
			componentDidCatch(error) { try { console.error("[rich-questions] survey render crashed:", error) } catch { /* console unavailable */ } }
			render() {
				if (this.state.error !== null) {
					const t = this.props.t;
					const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
					return (0, react_jsx_runtime.jsxs)("div", { className: "rq-crash", children: [
						(0, react_jsx_runtime.jsx)("div", { className: "rq-crashTitle", children: t("crash.title") }),
						(0, react_jsx_runtime.jsx)("div", { className: "rq-crashBody", children: t("crash.body") }),
						(0, react_jsx_runtime.jsx)("div", { className: "rq-crashMsg", children: message }),
						(0, react_jsx_runtime.jsx)("button", { type: "button", className: "rq-crashRetry", onClick: this.retry, children: t("crash.retry") }),
					] });
				}
				return this.props.children;
			}
		}
		const DRAFT_DISMISS_PREFIX = "dsh-rich-questions/draft-dismiss/";
		function loadDraftDismissal(slug) {
			try {
				const raw = window.localStorage.getItem(DRAFT_DISMISS_PREFIX + slug);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : null;
			} catch { return null }
		}
		function saveDraftDismissal(slug, value) {
			try { window.localStorage.setItem(DRAFT_DISMISS_PREFIX + slug, JSON.stringify(value)) } catch { /* best-effort */ }
		}
		/**
		* Tracker-style builder progress card (operator pattern: the tracking
		* board / goal UI), rendered as a conversation.composer.dock row — a
		* list slot beside the input, NOT the composer chain seat. A building
		* draft is passive progress information: electing it in the chain hid
		* the real composer (overlay fallback is display:none while an entry is
		* elected), and a dismissed card rendered null while still elected,
		* leaving the whole seat empty — the chat appeared to vanish. A dock
		* row renders (or not) independently; the input is never touched.
		* Persists until dismissed — and a stale dismissal never hides active
		* work: any revision or status change re-shows it. On launch the wizard
		* takes the composer (draft frames stop rendering), so the card closes
		* into the wizard by construction.
		*/
		function DraftCard({ draft, t }) {
			const [dismissed, setDismissed] = (0, react.useState)(() => loadDraftDismissal(draft.slug));
			if (dismissed !== null && dismissed.revision === draft.revision && dismissed.status === draft.status) return null;
			const progress = draft.progress ?? {};
			const total = typeof progress.questions === "number" ? progress.questions : 0;
			const done = typeof progress.complete === "number" ? progress.complete : 0;
			const missing = typeof progress.missingFields === "number" ? progress.missingFields : 0;
			const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
			const dismiss = () => {
				const value = { revision: draft.revision, status: draft.status };
				saveDraftDismissal(draft.slug, value);
				setDismissed(value);
			};
			return (0, react_jsx_runtime.jsx)("div", { className: "rq-dockRow", children: (0, react_jsx_runtime.jsxs)("div", { className: "rq-draftCard", children: [
				(0, react_jsx_runtime.jsxs)("div", { className: "rq-draftHead", children: [
					(0, react_jsx_runtime.jsx)("span", { className: "rq-chip", children: t("draft.eyebrow") }),
					(0, react_jsx_runtime.jsx)("span", { className: "rq-draftTitle", children: draft.title ?? draft.slug }),
					(0, react_jsx_runtime.jsx)("span", { className: "rq-chip", children: t(`draft.status.${draft.status ?? "building"}`) }),
					...(draft.revision !== undefined ? [(0, react_jsx_runtime.jsx)("span", { key: "rev", className: "rq-chip", children: `${t("draft.revision")} ${draft.revision}` })] : []),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rq-iconButton",
						"aria-label": t("draft.dismiss"),
						title: t("draft.dismiss"),
						onClick: dismiss,
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {}),
					}),
				] }),
				(0, react_jsx_runtime.jsxs)("div", { className: "rq-draftBarWrap", children: [
					(0, react_jsx_runtime.jsx)("div", { className: "rq-bar rq-draftBar", children: (0, react_jsx_runtime.jsx)("div", { className: "rq-barFill", style: { width: `${String(pct)}%` } }) }),
					(0, react_jsx_runtime.jsxs)("span", { className: "rq-draftCounts", children: [`${String(done)}/${String(total)} `, t("draft.complete"), ` · ${String(missing)} `, t("draft.missing")] }),
				] }),
				(0, react_jsx_runtime.jsx)("div", { className: "rq-draftHint", children: t("draft.hint") }),
			] }) });
		}
		/**
		* Composer-dock row: the conversation's active builder draft as a
		* tracker card under the input, subscribed to the store so it tracks
		* draft/updated frames without depending on unrelated re-renders.
		* Renders null when this session has no active draft — harmless in a
		* list slot (a chain election would hide the composer fallback).
		*/
		function DraftDockRow({ sessionId, t }) {
			(0, react.useSyncExternalStore)(surveyStore.subscribe, surveyStore.getVersion);
			const draft = sessionId === undefined ? undefined : surveyStore.draftFor(sessionId);
			if (draft === undefined) return null;
			return (0, react_jsx_runtime.jsx)(SurveyBoundary, {
				t,
				key: `draft-${String(draft.slug)}`,
				children: (0, react_jsx_runtime.jsx)(DraftCard, { draft, t }),
			});
		}
		/** Composer occupant: renders the wizard for the selected session's pending survey. */
		function SurveyComposer(props) {
			// selectSurvey returns null (not undefined) when the viewed session
			// has no pending survey — guard BOTH, or the key read crashes and
			// React unmounts the whole composer seat.
			if (props.matched == null) return null;
			// key by surveyId so a follow-up survey in the same session remounts with fresh drafts
			return (0, react_jsx_runtime.jsx)(SurveyBoundary, {
				t: props.t,
				key: props.matched.surveyId,
				children: (0, react_jsx_runtime.jsx)(SurveyFlow, { survey: props.matched, t: props.t, key: props.matched.surveyId }),
			});
		}
		//#endregion
		//#region lib/index.js
		/**
		* Chain routing: only a pending SURVEY claims the composer seat (the
		* wizard). Builder drafts render as a conversation.composer.dock row
		* instead (DraftDockRow) — a building draft must never hide the chat
		* composer, and a dismissed card must never leave the seat empty.
		*/
		function selectSurvey({ session }) {
			const sessionId = session?.sessionId;
			if (sessionId === void 0) return null;
			return surveyStore.get(sessionId) ?? null;
		}
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: locale dictionaries + the survey wizard into the
		* conversation composer chain (the same seat the built-in question
		* composer occupies; the two never claim one request — this one only
		* claims its own pending surveys) + the builder draft card into the
		* composer dock (list slot: rows render beside the input, never over
		* it).
		*/
		function apply(ctx) {
			// Hydrate at activation: SSE + reconciliation poll against the
			// host-authoritative pending table, BEFORE any UI exists. Without
			// this, selectSurvey always sees an empty store (see start() note).
			ctx.effect(() => surveyStore.start(), "rich-questions: survey store hydration (SSE + poll)");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "rich-questions: dictionaries");
			ctx.slots.inject("conversation.composer", () => ctx.slots.register({
				name: "conversation.composer",
				select: selectSurvey,
				locale: NS
			}, SurveyComposer));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "rich-questions-draft",
				order: 20,
				locale: NS
			}, DraftDockRow));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
