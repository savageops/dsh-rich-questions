# dsh-rich-questions

**Rich branching surveys for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**
Turn flat `ask_user_question` exchanges into full questionnaires with conditional paths, per-option intelligence, visual flows, and one-click decision templates — delivered entirely as a plugin, with zero changes to DSH source.

> 富问题/问卷系统 — 把扁平的 ask_user_question 升级为带分支路径、悬停洞察、流程图与一键决策模板的完整问卷系统。

---

## Why

`ask_user_question` answers one narrow need: 1–3 simple questions, flat, no context. Real alignment work is bigger than that — expectation gathering, acceptance surveys, scoping decisions across dozens of dimensions. You need **paths** (the answer to one question decides which questions follow), you need **depth** (a one-line label is never enough to choose well), and you need **speed** (sometimes the user already knows the destination and shouldn't walk every step).

`ask_survey` is that system:

- **Branching paths** — every option declares what follows it. Selecting *C* routes the user down an entirely different range of questions than *A*. Multi-select fans out depth-first, skip and free-text fall through cleanly, and the whole graph is validated up front (no cycles, no dangling references, unreachable questions never asked).
- **Per-option intelligence** — insights, tradeoffs, "(today)" markers, citations, and **Mermaid flow diagrams** live inside the option row, revealed through deliberately non-invasive UX.
- **Quick mode** — up to six whole-survey decision templates. One click applies a complete, coherent answer map and submits. The user who already knows they want "the Vercel-grade option set" never walks a single question.
- **Pre-flight steering** — Reroll / Push / Discuss sit next to Start: rewrite the survey in cleaner English, push it deeper with web research, or drop the form and talk it through instead.

## Feature tour

### Branching paths (the core)

A survey is a directed graph, not a list. Each option carries an optional `next`:

```json
{
  "q1": {
    "prompt": "Which direction fits?",
    "options": [
      { "key": "a", "label": "Ship the public surface", "next": "q2a" },
      { "key": "b", "label": "Rework the core first",  "next": "q2b" },
      { "key": "c", "label": "Pause and decide later", "next": null }
    ],
    "next": "q2b"
  }
}
```

Edge semantics, exactly enforced:

| Situation | Follows |
|---|---|
| Single-select, option has `next` | that option's `next` (a question id, a list, or `null` = end) |
| Single-select, option has no `next` | the question-level `next` |
| Multi-select | every selected option's branch, depth-first, in option order |
| Skipped / free-text-only answer | the question-level `next` |
| Branch end (`next: null`, or nothing left) | the survey finishes |

The wizard re-computes the live path as answers change — going **back** and changing an early answer collapses the now-unreachable branch and re-asks only what still applies. The host independently recomputes the path from submitted answers and rejects any mismatch, so a claimed path is always re-derivable, never trusted from the client.

### Rich options

Every option can carry:

- **Arbitrary keys** — any string (`a`, `f`, `other`, `opt-3`), as many options as a question needs (default cap 40).
- **`description`** — one always-visible line under the label.
- **`insight`** — markdown revealed on demand (~6 lines): what great looks like, the tradeoff, the "(today)" state, caveats.
- **`sources`** — links or citations, clickable inside the expanded panel.
- **`diagram`** — a compact **Mermaid** flow chart for the option: architecture, decision path, pipeline — rendered inline, sized to fit without scrolling.
- **`recommended`** — badge + first position for the option the model endorses.

**Non-invasive reveal (a deliberate UX stance).** Hovering an option row does nothing — casual mouse travel never detonates panels. Insight lives behind a dedicated `?` affordance: a **3-second-delayed tooltip** previews it for a deliberate hover, and a click **expands the row inline** with the full markdown and clickable sources. The branch icon beside it opens the same panel in diagram mode. One row, one shared disclosure, zero layout jumps, zero pop-up ambushes.

### Quick mode — one-click owner decisions

Surveys can ship up to **six whole-survey answer templates** (`a`–`f`), offered as a **Quick** button next to Start:

```json
{
  "quick": [
    {
      "key": "a",
      "label": "Ship like Vercel/Railway: polish + DX first",
      "recommended": true,
      "insight": "Optimizes for first impressions and developer love…",
      "answers": { "q1": { "selected": ["a"] }, "q2a": { "selected": ["b"] }, "q3": { "selected": ["a", "c"] } }
    },
    {
      "key": "b",
      "label": "Lean internal tool: ship fast, minimal surface",
      "answers": { "q1": { "selected": ["b"] }, "q2b": { "selected": ["a"] } }
    }
  ]
}
```

Each template is a calibrated stance — "the highest standard, applied" — expressed as a complete answer map. Picking one applies it verbatim and submits immediately: a twelve-question alignment survey becomes a single click. Templates are validated at authoring time: every referenced question and option key must exist, and a template's answers must cover every question its own choices reach.

### Pre-flight steering: Reroll / Push / Discuss

Before the first question, the user can redirect the entire exercise:

- **Reroll** — same topic and branching intent, rewritten in cleaner, better-spoken English. No jargon, no complexity.
- **Push** — the survey comes back *deeper*: the agent runs web research on competitors and comparable systems, then expands the survey with research-grounded insights and more precise branching.
- **Discuss** — skip the form; the topic moves to plain conversation until a direction converges.

All three return a structured outcome with an explicit `instruction` to the model — never an error, never a dead end.

### The wizard

Renders in the **same composer seat** as the built-in question card, so a pending survey is always where the user is already looking:

- One question per page over the live branch path
- Progress bar + answered/total counter against the *current* path
- Back (re-evaluates branches from saved answers), Skip (per-question `skippable`), minimize, cancel
- Multi-select with check boxes, free-text `other` row (`allowCustom`, on by default)
- Bilingual out of the box (English / 简体中文), keyboard-operable rows, aria-labelled controls
- **Host-authoritative**: the pending survey lives on the host. Close the tab, refresh, come back from another browser — the survey rehydrates (SSE + reconciliation) and the tool keeps waiting the whole time. Routes are loopback-fenced like the rest of the DSH web surface.

## Authoring guide

Full spec with every capability in one place:

```json
{
  "survey": {
    "title": "Expectation alignment",
    "intro": "Short markdown preamble — the first page the user sees.",
    "entry": "q1",
    "questions": {
      "q1": {
        "prompt": "Which direction fits this release?",
        "header": "Scope",
        "detail": "Optional markdown context under the question.",
        "multiSelect": false,
        "allowCustom": true,
        "skippable": true,
        "options": [
          {
            "key": "a",
            "label": "Ship the public surface",
            "description": "One-line tradeoff, always visible.",
            "insight": "**What great looks like** — …\n**Tradeoff** — …\n**(today)** — …",
            "diagram": "flowchart TD; ship-->polish; polish-->latency; latency-->done",
            "sources": ["https://example.com/rfc-1"],
            "recommended": true,
            "next": "q2a"
          },
          { "key": "b", "label": "Rework the core first", "next": "q2b" },
          { "key": "other", "label": "Something else" }
        ],
        "next": "q2b"
      },
      "q2a": { "prompt": "…", "next": "q3" },
      "q2b": { "prompt": "…", "next": "q3" },
      "q3":  { "prompt": "…", "multiSelect": true }
    },
    "quick": [
      { "key": "a", "label": "Highest standard: Vercel/Railway grade", "recommended": true,
        "insight": "Who this is for, what it optimizes, the tradeoff.",
        "answers": { "q1": { "selected": ["a"] }, "q2a": { "selected": ["b"] }, "q3": { "selected": ["a", "c"] } } },
      { "key": "b", "label": "Lean internal tool", "answers": { "q1": { "selected": ["b"] } } }
    ]
  }
}
```

**Validation (submit-time, host-side).** `entry` exists; every `next` names a real question; option keys unique per question; the graph is cycle-free; quick templates reference only real questions/options and their answers cover their reachable path; size caps hold (150 questions, 40 options/question, 1500-char insights, 1200-char diagrams, 8 sources, 6 quick templates). Unreachable questions are never asked and never answered.

**Result — completed survey:**

```json
{
  "outcome": "answered",
  "path": ["q1", "q2a", "q3"],
  "answers": [
    { "id": "q1", "selected": [{ "key": "a", "label": "Ship the public surface" }] },
    { "id": "q3", "selected": [{ "key": "a", "label": "…" }, { "key": "c", "label": "…" }] }
  ],
  "skipped": []
}
```

Quick-mode submissions are indistinguishable from manual ones — the template's answers simply *are* the answers.

**Result — pre-flight redirect:**

```json
{
  "outcome": "push",
  "instruction": "The user hit \"Push\" before starting: … run aggressive research … Call ask_survey again with the expanded, better-informed spec; do not ask the user anything first."
}
```

## Install

```sh
dsh plugin --profile web add dsh-rich-questions
```

Or from a checkout / fork:

```sh
dsh plugin --profile web add file:/path/to/dsh-rich-questions
```

Restart the `dsh web` process after install (the host half loads at boot). Toggle on/off from the Plugins settings tab without uninstalling, or disable in the profile's `cordis.patch.yml`:

```yaml
- id: rich-questions
  disabled: true
```

**Requirements:** DSH ≥ 0.1.1-rc.1, Node ≥ 20. Works alongside the built-in `ask_user_question` — simple 1–3 question asks and plan review are untouched.

## Architecture

```
src/host.js            Node half — ask_survey tool, pending-survey registry,
                       /api/rich-questions/{state,action,events} routes,
                       system-prompt announcement. Node builtins only.
src/survey-engine.js   Pure engine — branch-path computation + spec/answer
                       validation. Imported by the host AND inlined verbatim
                       into the client bundle (keep the two in sync).
src/client.bundle.js   Browser half — the composer-seat wizard
                       (window.__ModuleLoader__ bundle; react + client
                       primitives only).
cordis.patch.yml       Bundle patch inserting the plugin row.
```

The Mermaid engine lazy-loads from CDN on first diagram expand and is cached thereafter — everything else is fully offline.

## License

[MIT](LICENSE)
