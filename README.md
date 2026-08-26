# dsh-rich-questions

富问题/问卷系统 — expands DSH Web GUI's flat `ask_user_question` into a rich,
branching survey system, entirely as a plugin (no DSH source changes).

## What it adds

- **`ask_survey` tool** (model-facing, globally visible to every agent preset):
  a JSON survey spec with a **branch graph** — each option declares which
  question(s) follow it (`next`), so selecting C sends the user down a
  different range of questions. Flat questions with no `next` fall back to the
  question-level `next`; skipped / free-text answers do the same.
- **Rich options**: arbitrary option `key`s (any string, as many as you like
  per question), a one-line always-visible `description`, a markdown
  **insight** (~6 lines: what great looks like, tradeoffs, "(today)" current
  state), and `sources` (links or references).
  - **Non-invasive insight UX**: hovering the option does nothing. A dedicated
    `?` button previews the insight in a **3-second-delayed tooltip** (casual
    mouse travel never triggers it), and clicking it **expands the row
    inline** with the full insight + clickable sources.
  - **Diagrams**: an optional compact **Mermaid** `diagram` per option renders
    behind a second branch-icon button — same expand panel, visual flow
    instead of text, sized to fit without scrolling.
- **Quick mode**: an optional `quick` array ships up to **6 one-click answer
  templates** (`a`–`f`) offered next to Start — e.g. "optimize like
  Vercel/Railway: polish + DX first". Picking one auto-fills the entire answer
  map and submits immediately, skipping the question-by-question walk.
- **Pre-flight actions** next to Start: **Reroll** (rewrite the survey in
  cleaner English), **Push** (research competitors via web search, then
  return a deeper survey), **Discuss** (switch to plain chat discussion).
  Each returns a structured `outcome` + `instruction` to the model — not an
  error.
- **Large questionnaires**: up to 150 questions / 40 options per question,
  `header` section grouping, optional `intro` markdown first page.
- **Multi-select** per question, per-question free-text (`allowCustom`,
  default on — the conventional `other` key), `skippable`, `recommended` badge.
- **The wizard UI** lives in the **same conversation composer seat** as the
  built-in question card: one question per page, live branch path, progress
  bar, back (re-evaluates branches from your saved answers), skip, minimize,
  cancel.
- **Host-authoritative**: the pending survey lives on the host. Closing or
  refreshing the browser never loses it — the tool keeps waiting, and the
  wizard re-hydrates on reconnect (SSE `hello` + reconciliation poll).

## What it does NOT change

- `ask_user_question` (simple flat flow) stays untouched — it is a preset row
  and the tool registry's scoped-shadowing rules mean a plugin cannot replace
  it; simple 1–3 question asks keep working exactly as before, and plan review
  (which uses the `userQuestions` seam directly) is unaffected.
- The built-in question wire (`question/requested` frames) is untouched — the
  survey rides a plugin-owned channel (`/api/rich-questions/{state,action,events}`,
  loopback-fenced the same way as the task-board plugin).

## Answer shape (tool result)

Completed survey:

```json
{
  "outcome": "answered",
  "title": "...",
  "path": ["q1", "q2a", "q4"],
  "answers": [{ "id": "q1", "selected": [{ "key": "c", "label": "..." }], "custom": "..." }],
  "skipped": ["q3"]
}
```

Pre-flight redirect (user pressed Reroll / Push / Discuss before starting):

```json
{
  "outcome": "push",
  "title": "...",
  "instruction": "The user hit \"Push\" before starting: ... use the nsect skill ... Call ask_survey again with the expanded, better-informed spec; do not ask the user anything first."
}
```

Quick mode resolves as a normal `"answered"` result — the template's answers
are indistinguishable from manual ones.

`path` is the ordered question list actually presented (branch-derived,
recomputed host-side from the answers — the client's claimed path must agree
with reachability).

## Spec authoring (model-side)

```json
{
  "survey": {
    "title": "Expectation alignment",
    "intro": "Optional markdown preamble.",
    "entry": "q1",
    "questions": {
      "q1": {
        "prompt": "Which direction fits?",
        "header": "Scope",
        "detail": "Optional markdown context.",
        "multiSelect": false,
        "options": [
          {
            "key": "a",
            "label": "Ship now",
            "description": "One-line tradeoff.",
            "insight": "Hover detail, ~6 lines of markdown.",
            "sources": ["https://example.com/rfc-1"],
            "recommended": true,
            "next": "q2a"
          },
          { "key": "b", "label": "Rework", "next": null }
        ],
        "next": "q2b"
      },
      "q2a": { "prompt": "...", "next": "q4" },
      "q2b": { "prompt": "..." },
      "q4":    { "prompt": "..." }
    }
  }
}
```

Rules enforced at submit time (host-side): `entry` exists; every `next`
(question- or option-level) names an existing question; option `key`s are
unique per question; the graph is cycle-free; size limits (150 questions, 40
options, 1500-char insight, 8 sources, 1200-char diagram, 6 quick templates).
Unreachable questions are never asked and never answered.

Optional per-option diagram and whole-survey quick templates:

```json
{
  "survey": {
    "entry": "q1",
    "questions": {
      "q1": {
        "prompt": "Ship like Vercel/Railway, or lean internal tool?",
        "options": [
          {
            "key": "a",
            "label": "Vercel/Railway grade",
            "insight": "What great looks like, the tradeoff, (today)...",
            "diagram": "flowchart TD; polish-->dx; dx-->latency; latency-->done",
            "next": "q2"
          }
        ]
      }
    },
    "quick": [
      {
        "key": "a",
        "label": "Ship like Vercel/Railway: polish + DX first",
        "recommended": true,
        "insight": "Who this is for, what it optimizes, the tradeoff.",
        "answers": { "q1": { "selected": ["a"] }, "q2": { "selected": ["b"] } }
      },
      {
        "key": "b",
        "label": "Lean internal tool: ship fast, minimal surface",
        "answers": { "q1": { "selected": ["b"] } }
      }
    ]
  }
}
```

A quick template's `answers` must cover every question its choices reach —
picking it submits those answers verbatim with no further questions.

## Install / uninstall

From npm (published package):

```sh
dsh plugin --profile web add dsh-rich-questions
```

Or from a local checkout / fork (offline `file:` dependency):

```sh
dsh plugin --profile web add file:/path/to/dsh-rich-questions
```

Then restart the `dsh web` process (the host half loads at boot). The
plugin-manager GUI (Plugins settings tab) can also install it by name and
toggle it without uninstalling.

Disable without uninstalling — in the profile's own `cordis.patch.yml`
(later layer wins) or via the plugin-manager toggle:

```yaml
- id: rich-questions
  disabled: true
```

## Layout

- `src/host.js` — node half: `ask_survey` tool, pending survey registry,
  routes, system-prompt announcement. Node builtins only (no runtime deps).
- `src/survey-engine.js` — pure branch-path engine + spec/answer validation.
  **Imported by the host and inlined verbatim into the client bundle**
  (region `survey-engine` in `src/client.bundle.js`) — keep both in sync.
- `src/client.bundle.js` — browser half: composer-seat survey wizard
  (`window.__ModuleLoader__` bundle; requires only react + client primitives).
- `cordis.patch.yml` — bundle patch inserting the plugin row.

## Known limits (v0.2)

- Mermaid diagrams lazy-load the Mermaid engine from a CDN
  (`cdn.jsdelivr.net`) on first expand. Air-gapped installs still get the
  full text insights; only the diagram panel shows a load error. Everything
  else is fully offline.
- Partial survey drafts are not persisted across a browser refresh (the
  in-flight survey itself is; only the user's half-typed answers reset).
- No per-survey timeout (the tool waits as long as the turn/session lives;
  cancelling the turn aborts the survey, surfacing `SURVEY_ABORTED`).
- The chat tool row for `ask_survey` uses the generic tool card (the survey
  card itself is the interactive surface).
