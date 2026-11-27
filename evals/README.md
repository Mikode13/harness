# Evals

Real tasks the harness carries out, measured, so that a change to it — a prompt, the cache, a
role's model, the workflow itself — can be compared with what it replaced on numbers rather than
impressions.

Each task brings its own small repository, so it never depends on the harness's history and stays
valid as the harness changes: what varies between two measurements is the harness alone.

```sh
pnpm run evals -- --runs 3                     # every task, 3 runs each, the default roles
pnpm run evals -- --task complex --profile anthropic
pnpm run evals -- --task bugfix --path agent --model anthropic:sonnet:high
pnpm run evals -- --task review-seeded --role reviewer=anthropic:sonnet:high
pnpm run evals:compare -- evals/results/<before> evals/results/<after>
pnpm run test:evals                            # the tasks' own checks, offline, free
```

`pnpm run evals` needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and spends money: the judges
and every role run on the providers' APIs. Results go to `evals/results/`, which git ignores.

## The tasks

| Task            | Kind   | What it measures                                                                                                                                                    | Cost              |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `complex`       | task   | An event log over an asynchronous storage: numbering without gaps, idempotent appends, failed writes, restart and following. Design, concurrency and failure paths. | A few dollars     |
| `bugfix`        | task   | A reported bug one line from its symptom: search, read, a small fix and a regression test.                                                                          | Cents             |
| `strict-lint`   | task   | Code whose tests pass but that fails `tsc` and the strict lint: the command loop that cost most in October.                                                         | Cents             |
| `big-docs`      | task   | A list endpoint whose rules are in one section of a 50 KB handbook, beside a deprecated look-alike: whether the agents search, or carry the handbook in every call. | Cents to a dollar |
| `session`       | task   | Three prompts that build on each other, six minutes apart, the session saved and restored between them: what a person's pauses cost through the cache.              | Cents, 15 minutes |
| `plan`          | plan   | The planner alone on `complex`: the run stops when it asks to carry out its plan, and the judges check the plan against what it must cover.                         | Cents             |
| `review-seeded` | review | The reviewer alone on four versions of one change: one correct, three with a bug the visible tests miss.                                                            | Cents             |

The kinds:

- **task:** `createLLMOrchestrator` carries out the prompts, unattended, with the repository's
  `test`, `typecheck` and `lint` as commands and required checks. Then the result is checked and
  graded. With `--path agent`, one agent of `createLLMAgent` carries them out instead, on the
  executor's provider, model and effort, with the executor's file tools and the same commands:
  told to run the checks, which nothing requires of it, and reviewed by no one. What a task costs
  and passes on each path is what the workflow buys.
- **plan:** the orchestrator plans and is stopped at "Carry out this plan?", so only the planner,
  and the explorers it sends, work.
- **review:** the reviewer `createLLMOrchestrator` builds, its model, instructions, tools and
  explorers included, gets each change in the prompt a phase's review sends, with the harness's
  own check results. Its `showChanges` finds nothing, since the change was not made through the
  harness; the prompt carries the diff, as a run's review does.

`plan` and `review-seeded` isolate one role each, so a cheaper model in that role shows its effect
there without paying for a whole task.

The roles run on the models of `--profile`, the three profiles `createLLMOrchestrator` offers.
`--model provider:model:effort` puts every role, and the agent of `--path agent`, on one model;
`--role role=provider:model:effort` puts one role on its own, after `--model`. Both go to
`createLLMOrchestrator`'s `roles`, and each run is priced at the models it ran on.

## What a run gives

**Cost**, from the run's record (`onRecord`): every call's tokens by agent, a role or the
explorers it sent, priced at list prices from `lib/prices.ts`; and the share of the prompt read
from the cache. A call whose usage went unreported makes the cost unknown, not free. Each result
keeps its tokens by model, and `evals:compare` prices both sides with the table as it is when it
compares, so a price change never reads as a change of the harness.

**Whether it passed**, for a task: the hidden tests, which the agents never see and which are
copied in only at the end, all pass; `test`, `typecheck` and `lint` pass on what the agents left;
and no forbidden pattern, such as `eslint-disable`, is in `src/` or `tests/`. The checks judge by
the task's own configuration: a run that changed or added a `package.json`, a TypeScript, ESLint,
Prettier or Vitest configuration gets it put back first, and does not pass.

**What an accepted solution costs**, over a task's runs: how many were accepted, as `2 of 3`, or
`0 of 3`, and every run's cost and time, the failed ones included, over the accepted ones. A
cheaper path that fails more often can cost more per solution.

**Quality**, graded by two judges, Claude Opus 5.5 and GPT-6 Astra, each called through its
provider's SDK and never through the harness, so no change to the harness can change a grade.
Two families, so a result one favors because it writes like it shows as a disagreement. Each
judge sees the request, the rubric and the diff, never which configuration made it.

- A task's rubric scores each item 0, 1 or 2; the run's quality is the mean over items and
  judges, from 0 to 1. Only the rubric's own items count, each once, and one a judge left out
  scores 0.
- A plan's coverage is the share of its checklist the judges find covered, counted the same
  way.
- A review is correct when it approves the clean change, and rejects each seeded bug with
  feedback the judges agree names it; with no judge answering, it does not count as found. Recall is the bugs found; false alarms, the clean change
  rejected.

**The agents' own tests**, for `complex`: its mutants are the reference with one bug each,
swapped in for `src/eventLog.ts` one at a time and run against the tests the agents wrote. The
share they fail is how well those tests catch bugs. They must pass both on the agents' own file
and on the reference's, which every mutant copies: tests that do not, which may only expect the
agents' own implementation, score 0.

**How the agents worked together**, from the record: each role's rounds, counted from the
orchestrator's `workflowStage` events, questions, tool calls
and errors, command runs and failures, files read again after another agent read them, once per
agent and file, so paging and an agent's own re-reads do not count (with the read tools or
Claude's text editor), and a
**false approval**: the reviewer approved every phase, yet a hidden test or a check fails.

## Comparing two measurements

`evals:compare` reads two results' `summary.json` and applies one rule. A model does not answer
the same way twice, so a number only moves when the median after the change is past the whole
spread of the runs before it.

- **Cheaper:** the median cost is below every run before.
- **Worse:** a lower pass rate, more false approvals, or a quality, coverage, recall or mutant
  score whose median is past the spread on its wrong side.
- **The change works** when it is cheaper in at least two tasks and worse in none. Worse in any
  is a regression, whatever it saves.

It prints each side's acceptance too, as `2 of 3 accepted, $0.412 and 310 s per accepted
solution`, which the rule does not weigh: read it beside the verdict, above all when comparing two
paths or a cheaper model, which can save per run and lose per solution.

Measure the baseline first, three runs at least, to see the spread. `evals:compare` leaves a
task out of the verdict when either side has fewer than three runs, or none, and says so; a
measure, such as quality when the judges failed, moves only with three values a side.

## Which eval proves which change

| Change                                   | How to measure it                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What the workflow buys over one agent    | `bugfix` and `complex` on both paths, every role and the agent on one model first, as `--path workflow --model …` against `--path agent --model …`, so a difference is the coordination's. Then vary one role's model alone with `--role`. |
| A role on a cheaper model                | The reviewer: `review-seeded` with `--role reviewer=…`. The planner: `plan`, then `complex`, since a plan can cover the checklist and still leave the executor more to do.                                                                 |
| The cache across a person's pause (#185) | `session` as it is, six minutes between prompts, against `session --pause-minutes 0`, the same session without pauses: what a pause costs, and what a new policy saves the user who comes back later and costs a quick session.            |
| The router (#17)                         | Its golden cases, in `router/`: selection alone first, one call a case; then `bugfix` and `complex` end to end through the route it chose, against a fixed route and a route chosen by hand, its own cost and latency counted.             |

The provider reports cache writes of every lifetime in one count, and so does the harness's
`Tokens`: until it tells them apart, `session` shows what the writes cost, not which lifetime
paid. Still to add: one held-out task from a real MiKode issue, started from the commit before
its fix, as #180 planned, to check that what improves on these small repositories improves real
work.

## The router's cases

`router/cases.json` holds what choosing among a consumer's agents and workflows must get right,
written before the router exists, in Spanish as the product's users write. Each case gives the
routes on offer, the conversation before the request, and which decisions are right: a route
among several acceptable ones, a question that tells two open jobs apart and then one run, or
`not_applicable` with nothing run after it. A case marked `writes: none` may only take routes that
leave the repository as it was.

Most cases come in pairs that differ in one detail, such as "explain why it fails" against "fix
it", or "review" against "review and apply": a router that tells them apart reads the intent, not
words such as "error" or "review". A few are held out, kept from tuning the router's prompt and
run once at the end. Where one agent and the workflow are both right, both are accepted: which
one costs less per accepted solution is for the evals to say, not the case. `pnpm test` checks
that the cases hold together; no runner reads them until the router of #17 exists.

## A task's files

```text
tasks/<name>/
  task.json      what it is: kind, prompts, checks, and the files below
  repo/          the repository it starts from, over tasks/_base
  prompt*.txt    what the agents are asked
  hidden/        tests the agents never see, copied in at the end
  reference/     a solution, laid over repo: only the offline checks use it
  mutants/       versions of one file with one bug each
  rubric.txt     what the judges grade, one `id: item` per line
  checklist.txt  for a plan: what it must cover
  cases/         for a review: each change under review
```

`tasks/_base` holds what every repository shares: its `package.json`, `tsconfig.json`, ESLint
and Prettier configuration. A workspace links the harness's own `node_modules`, so a task
installs nothing.

`pnpm run test:evals` checks every task with no model: that it cannot be passed as it starts,
that its reference passes every check and hidden test, that every mutant is a real bug caught by
the hidden tests and by the reference's tests, and that every seeded bug fails a hidden test
while the clean change passes. An eval that fails these measures nothing. It takes minutes, since
it runs each task's tests, types and lint, so it stays out of `pnpm test`: run it after changing
a task, a runner, or what the orchestrator gives the evals, such as its roles' tools. The metrics'
tests, including one that reads a real orchestrator's record over a faked SDK, take seconds and
run in `pnpm test`, so pre-push and CI catch a change to `src/` that stops an event they count.

## Adding a task

Give it a repository, a prompt, hidden tests and a reference, and make `pnpm run test:evals`
pass. Keep it independent of the harness's code and history, and keep its hidden tests about
what the prompt asks, so a different correct design passes them too.
