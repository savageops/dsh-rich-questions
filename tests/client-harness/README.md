# Client-bundle harness (React + jsdom)

`pnpm test` covers the pure engine only — the browser bundle (`src/client.bundle.js`) had no executable verification until two composer-killing crashes proved it needed some. This folder is that verification.

## What it does

`drive.mjs` loads an actual bundle build into a jsdom window, activates the plugin through the same `ctx.slots` seam the host uses, hydrates the survey store through the `/state` poll path, then walks a real spec: start page, question pages with option selects, branch follow, insight expansion, back navigation, quick screen with a template pick. It then drives the crash classes and builder surfaces:

- `matched=null` — `selectSurvey` returns `null` (not `undefined`) when the viewed session has no pending survey; the composer must render nothing and survive.
- a poison spec (`questions: {q1: null}`) — the `SurveyBoundary` error boundary must catch the render crash, show the visible error card, and keep the composer mounted through a Retry click.
- the builder draft card — after the survey settles, the seat falls to the tracker-style card (title, status chip, `4/12` progress counts), dismissal hides it, and a revision bump re-shows it.

Exit code 0 only when every step passes and zero runtime errors were collected.

## Running

The driver resolves `react`, `react-dom`, and `jsdom` from a DeepSeek Harness checkout (the plugin itself stays zero-dependency):

```
node tests/client-harness/drive.mjs src/client.bundle.js tests/client-harness/spec.question-builder.json tests/client-harness/spec-poison.json
```

`spec.question-builder.json` is the exact 14-question spec whose arrival crashed the operator's composer — it stays as the regression spec. Swap the first argument for any historical bundle (e.g. `git show 66e0df0:src/client.bundle.js`) to reproduce the old crashes: the pre-fix build fails the null step with `Cannot read properties of null (reading 'surveyId')`, and the merged build without this fix fails every survey render with `ReferenceError: loadRecovery is not defined`.
