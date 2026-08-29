/**
 * Tests for the pure survey engine: quick-template reachability under
 * option-level branches, type-aware "not an object" diagnostics, and the
 * degraded-payload recovery in resolveSurveyArgument (the failure mode of
 * models with small output budgets: a large ask_survey payload truncated
 * mid-JSON arrives as raw text or {} instead of an object).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computePath, draftCompleteness, groundingGaps, isStub, resolveSurveyArgument, validateSpec } from '../src/survey-engine.js'

const option = (key, extra = {}) => ({ key, label: `Option ${key}`, ...extra })
const fiveOptions = (extra = {}) => ['a', 'b', 'c', 'd', 'e'].map((key) => option(key, { ...extra }))
const followup = () => ({ prompt: 'Follow-up?', options: fiveOptions(), next: 'q3' })

/** Branching spec shaped like a real reroll: q1 forks per option, forks rejoin at q3. */
const branchSpec = () => ({
  entry: 'q1',
  questions: {
    q1: {
      prompt: 'Pick a branch?',
      options: [
        option('a', { next: 'q2a' }),
        option('b', { next: 'q2b' }),
        option('c', { next: 'q2c' }),
        option('d', { next: 'q2c' }),
        option('e', { next: 'q2c' }),
      ],
    },
    q2a: followup(),
    q2b: followup(),
    q2c: followup(),
    q3: { prompt: 'Final?', options: fiveOptions() },
  },
})

test('quick templates may follow option-level branches', () => {
  const spec = branchSpec()
  spec.quick = [
    { key: 'a', label: 'Branch A', answers: { q1: { selected: ['a'] }, q2a: { selected: ['b'] }, q3: { selected: ['a'] } } },
    { key: 'b', label: 'Branch D→C', answers: { q1: { selected: ['d'] }, q2c: { selected: ['c'] }, q3: { selected: ['a'] } } },
  ]
  const result = validateSpec(spec)
  assert.equal(result.ok, true)
})

test('computePath follows the selected option edge, not just question-level next', () => {
  const answers = new Map([['q1', { selected: ['a'], custom: '' }]])
  assert.deepEqual(computePath(branchSpec(), answers), ['q1', 'q2a', 'q3'])
})

test('an unreachable quick answer names the path the branch actually reaches', () => {
  const spec = branchSpec()
  spec.quick = [{ key: 'x', label: 'Wrong fork', answers: { q1: { selected: ['a'] }, q2b: { selected: ['b'] }, q3: { selected: ['a'] } } }]
  const result = validateSpec(spec)
  assert.equal(result.ok, false)
  const message = result.errors.join(' ')
  assert.match(message, /q2b" which this template's own selections never reach/)
  assert.match(message, /reaches only: q1, q2a, q3/)
})

test('a template that skips the entry question is told where its branch died', () => {
  const spec = branchSpec()
  spec.quick = [{ key: 'x', label: 'No entry', answers: { q2a: { selected: ['b'] }, q3: { selected: ['a'] } } }]
  const result = validateSpec(spec)
  assert.equal(result.ok, false)
  const message = result.errors.join(' ')
  assert.match(message, /never reach/)
  assert.match(message, /reaches only: q1/)
})

test('a non-object survey names the received type', () => {
  assert.match(validateSpec('{"entry":"q1"}').errors[0], /got a string/)
  assert.match(validateSpec([]).errors[0], /got an array/)
  assert.match(validateSpec(null).errors[0], /got null/)
})

test('resolveSurveyArgument accepts a normal object payload', () => {
  const survey = branchSpec()
  const resolved = resolveSurveyArgument({ survey })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.args.survey, survey)
})

test('resolveSurveyArgument parses a JSON-string survey field', () => {
  const survey = branchSpec()
  const resolved = resolveSurveyArgument({ survey: JSON.stringify(survey) })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.args.survey.entry, 'q1')
})

test('resolveSurveyArgument parses whole-arguments raw text', () => {
  const resolved = resolveSurveyArgument(JSON.stringify({ survey: branchSpec() }))
  assert.equal(resolved.ok, true)
  assert.equal(resolved.args.survey.entry, 'q1')
})

test('truncated arguments text fails with a truncation diagnostic', () => {
  const cut = JSON.stringify({ survey: branchSpec() }).slice(0, 40)
  const resolved = resolveSurveyArgument(cut)
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /failed to parse as JSON/)
  assert.match(resolved.error, /cut off/)
  assert.match(resolved.error, /SMALLER/)
})

test('an empty arguments object reports the missing survey field with the remedy', () => {
  const resolved = resolveSurveyArgument({})
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /no "survey" field/)
  assert.match(resolved.error, /SMALLER/)
})

test('degraded non-object arguments fail cleanly', () => {
  assert.match(resolveSurveyArgument(null).error, /got null/)
  assert.match(resolveSurveyArgument(42).error, /got a number/)
})

test('a survey field of the wrong type fails cleanly', () => {
  assert.match(resolveSurveyArgument({ survey: [] }).error, /"survey" must be an object — got an array/)
  const resolved = resolveSurveyArgument({ survey: '[1,2]' })
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /not a JSON object — got an array/)
})

test('isStub detects blank, absent, and TODO-marked fields', () => {
  assert.equal(isStub(undefined), true)
  assert.equal(isStub('   '), true)
  assert.equal(isStub('TODO: working title'), true)
  assert.equal(isStub('  TODO: indented'), true)
  assert.equal(isStub('A real prompt'), false)
})

test('validateSpec repairs literal escape sequences in prose (the flattened-intro corruption)', () => {
  // Measured on this deployment: writer/tool boundaries delivered "\n" as
  // backslash+n, flattening the intro and every insight into one run-on.
  const spec = {
    title: 'T',
    intro: '**A:** first\\n\\n**B:** second',
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'One line\\nplus a second',
        header: 'Scope\\nDelivery',
        options: [
          { key: 'a', label: 'Stance one\\ncontinued', description: 'One sentence\\nspilled', insight: '**Promise** p\\n**Price** c\\n**Present** t', sources: ['s'] },
          { key: 'b', label: 'Plain', description: 'No escapes here', insight: 'Real newline\nkept as-is', sources: ['s'] },
          { key: 'c', label: 'Third', description: 'd', insight: 'i', sources: ['s'] },
          { key: 'd', label: 'Fourth', description: 'd', insight: 'i', sources: ['s'] },
          { key: 'e', label: 'Fifth', description: 'd', insight: 'i', sources: ['s'] },
        ],
      },
    },
    quick: [{ key: 'a', label: 'Quick\\nstance', description: 'd\\nmore', insight: 'p\\nc', answers: { q1: { selected: ['a'] } } }],
  }
  const check = validateSpec(spec)
  assert.equal(check.ok, true)
  assert.equal(check.spec.intro, '**A:** first\n\n**B:** second')
  assert.equal(check.spec.questions.q1.prompt, 'One line\nplus a second')
  assert.equal(check.spec.questions.q1.header, 'Scope Delivery', 'one-line fields collapse, never carry newlines')
  const [a, b] = check.spec.questions.q1.options
  assert.equal(a.label, 'Stance one continued')
  assert.equal(a.description, 'One sentence spilled')
  assert.equal(a.insight, '**Promise** p\n**Price** c\n**Present** t')
  assert.equal(b.insight, 'Real newline\nkept as-is', 'real newlines pass through untouched')
  assert.equal(check.spec.quick[0].label, 'Quick stance')
  assert.equal(check.spec.quick[0].insight, 'p\nc')
  // Ids and branch wiring are untouched by the repair.
  assert.equal(check.spec.entry, 'q1')
  assert.equal(check.spec.questions.q1.options[0].key, 'a')
})

test('draftCompleteness reports ready for a fully fleshed draft', () => {
  const spec = {
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'Pick a branch?',
        options: ['a', 'b', 'c', 'd', 'e'].map((key) => ({
          key,
          label: `Option ${key}`,
          description: 'One sentence.',
          insight: 'What great looks like.',
          sources: ['dsh-rich-questions/src/survey-engine.js'],
        })),
      },
    },
  }
  const report = draftCompleteness(spec)
  assert.equal(report.ready, true)
  assert.deepEqual(report.totals, { questions: 1, complete: 1, missingFields: 0 })
  assert.deepEqual(report.perQuestion, [{ id: 'q1' }])
})

test('draftCompleteness lists every missing required field per question', () => {
  const spec = {
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'TODO: working title',
        options: [{ key: 'a', label: 'TODO: stance', sources: ['  ', ''] }],
      },
      q2: { prompt: 'Real prompt' },
    },
  }
  const report = draftCompleteness(spec)
  assert.equal(report.ready, false)
  const q1 = report.perQuestion.find((entry) => entry.id === 'q1')
  assert.deepEqual(q1.missing, [
    'prompt',
    'options[0].label',
    'options[0].description',
    'options[0].insight',
    'options[0].sources',
  ])
  const q2 = report.perQuestion.find((entry) => entry.id === 'q2')
  assert.deepEqual(q2.missing, ['options: none declared'])
  assert.equal(report.totals.questions, 2)
  assert.equal(report.totals.complete, 0)
})

test('draftCompleteness refuses an empty question map', () => {
  assert.equal(draftCompleteness({ entry: 'q1', questions: {} }).ready, false)
})

test('groundingGaps passes when an option cites a comparison target where it lives', () => {
  const spec = {
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'P?',
        options: [
          { key: 'a', label: 'L', description: 'd', insight: 'i', sources: ['settled record 681238b8'] },
          { key: 'b', label: 'L', description: 'd', insight: 'i', sources: ['src/draft-store.js'] },
        ],
      },
    },
  }
  assert.equal(groundingGaps(spec).ready, true)
})

test('groundingGaps demands a path-or-URL citation for the comparison half', () => {
  const spec = {
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'P?',
        options: [
          { key: 'a', label: 'L', description: 'd', insight: 'i', sources: ['competitor X', 'https://example.com/a'] },
        ],
      },
    },
  }
  assert.equal(groundingGaps(spec).ready, true, 'a URL counts as a comparison citation')
  const without = groundingGaps({ entry: 'q1', questions: { q1: { prompt: 'P?', options: [{ key: 'a', label: 'L', description: 'd', insight: 'i', sources: ['competitor X only'] }] } } })
  assert.equal(without.ready, false)
  assert.match(without.perQuestion[0].missing[0], /comparison: no option cites a file path or URL/)
})

test('groundingGaps internal mode skips the comparison half but keeps sources', () => {
  const spec = {
    entry: 'q1',
    questions: {
      q1: {
        prompt: 'P?',
        options: [{ key: 'a', label: 'L', description: 'd', insight: 'i', sources: ['internal note'] }],
      },
    },
  }
  assert.equal(groundingGaps(spec).ready, false, 'comparison fails under standard mode')
  assert.equal(groundingGaps(spec, { skipComparison: true }).ready, true, 'internal mode skips only the comparison half')
})

test('groundingGaps still demands sources in internal mode', () => {
  const spec = { entry: 'q1', questions: { q1: { prompt: 'P?', options: [{ key: 'a', label: 'L', description: 'd', insight: 'i' }] } } }
  const report = groundingGaps(spec, { skipComparison: true })
  assert.equal(report.ready, false)
  assert.match(report.perQuestion[0].missing[0], /sources/)
})
