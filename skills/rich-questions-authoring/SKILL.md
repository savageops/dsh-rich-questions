---
name: rich-questions-authoring
description: The full authoring doctrine for dsh-rich-questions surveys — the loop, the quality bar with a worked golden example, and the human-handling contract. Load this before authoring any survey of 4+ questions.
---

# Rich Questions — Authoring Doctrine (worked edition)

The announcement carries the summary; this skill carries the depth, including the one worked example you imitate. Load it before authoring any real survey; re-load after a Reroll or Push (both escalate — v2 must beat v1 on every axis).

## The loop (research-first, commanded)

1. **RESEARCH** — 9-12 comparable systems before locking structure. Artifacts: findings → `.docs/research/`, digests → `.docs/digest/`, competitor UI/API rips → `.docs/research/rips/`, downloaded source → `.refs/`. Not written down = did not happen.
2. **BEGIN** — `survey_draft_set op=begin`: skeleton with ids, ≥5 option keys per question, branch wiring. Stubs allowed.
3. **ENRICH** — loop [research → `op=patch` (≤3 questions/call; option fields merge per-field — send only what changes)].
4. **VERIFY** — `survey_draft_get` zero gaps (the gate).
5. **LAUNCH** — `survey_draft_launch`; the wizard takes the composer.
6. **HONOR** — mirror-back, receipts, no re-asking (`survey_records` before authoring).

## The bar — with the worked example

Every rule below is shown applied to ONE real option (from this plugin's own v3.1 survey — it shipped and was answered):

> **Rule: self-contained prompt.** Define every term in place; say where it applies and what the answer changes.
> Worked: *"No-re-asking is a doctrine promise with no machinery behind it yet: settled records persist on disk (~/.dsh/rich-questions/surveys/) but nothing reads them when a new survey is authored. What form should memory take?"* — the mechanism is defined, the location given, the stake named. A reader who missed the conversation understands it.

> **Rule: stance options, ≥5, never filler.**
> Worked labels: *A reader tool the agent calls · Auto-injection at ask time · A memory header on every survey · A remembered user dial · Gate-time check only* — five positions a reasonable person could defend, each implying different work.

> **Rule: insights are DEEP labeled ROWS — one specific, checkable point per row.** 3–5 markdown list rows; every row leads with a content label that carries meaning (Pattern / Proven at / Breaks when / Here now / Evidence — the label varies with what the option needs, never a fixed generic triple). Minimum per insight: one row names a real-world proven use (system/product/repo + what happened), one row states the tradeoff or break condition, one row gives the current-state handle (file path / number / record). A one-word-label row — "Proven: X" with no who or where — is as shallow as a paragraph; depth lives in the specifics.
> Worked (the same v3.1 option, deep format):
> *"- **Pattern:** ask-time memory injection — settled records are read at survey authoring, not at runtime.
> - **Proven at:** the context plugins resolve per-session data through provide contributions this way in production; `survey_records` (v0.3.0) already reads the settled store.
> - **Breaks when:** records outnumber relevance — fifty settled surveys later, injection needs ranking, not raw replay.
> - **Here now:** `SurveyHostService.ask` (src/host.js) has no injection seam; 2 settled records sit in `~/.dsh/rich-questions/surveys/` unread."* — four rows, four checkable claims, the proven use named with its evidence.

> **Rule: sources on every option.**
> Worked: `["SurveyHostService.ask — the ask-time seam", "~/.dsh/rich-questions/surveys/ — record contents"]` — file-level or product-level citations, not bare URLs.

> **Rule: branch-or-justify.** If an answer changes what gets asked next, wire `next`. Worked: the v3.1 entry question routes each cluster choice into its own detail question, then converges on depth/timeline/acceptance/risk.
> **Rule: one language** — the user's chat language for every user-facing string; keys stay ASCII (`a`, `b`, `c`).
> **Rule: orienting intro** — what this decides, why now, what happens with the answers, how long.

## The feel (handling the human)

- **Mirror-back**: first line of your next turn restates the stance — *"You chose X over Y because Z, so I will…"*.
- **Receipt**: every decision traces to its answer as work lands.
- **No re-asking**: `survey_records` first; the settled store is the memory.
- **Solicit the why**: surprising answer → ask for justification (inline affordance or chat); it is intent you can act on.

## Pre-flight escalations (both are guarantees)

- **Reroll** = rewrite cleaner AND fix every bar gap; depth never shrinks.
- **Push** = ≥12 systems studied, digest written to `.docs/digest/<topic>.md`, re-authored at ≥2× depth (questions or branch depth), every new option evidence-cited.

Then re-enter the loop at step 3 (ENRICH) — never one-shot a big re-issue.
