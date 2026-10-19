# Learnings

What running, measuring or reviewing the harness taught us about how it really behaves, as
opposed to what it was designed to do. A decision taken because of a lesson is recorded in
[`decisions.md`](decisions.md), and linked from here rather than repeated.

Each entry says what happened, the evidence, and what it changed.

## The first live run of the write tools (2026-10-11)

`pnpm run dev --llm` implemented #20 on this repository. The planner ran on `gpt-5.6-sol`, the
executor on `gpt-5.6-luna` at `xhigh`, and the reviewer on Claude Opus. The configured commands
were `issue`, `test`, `check` and `format`. The executor's work became #87.

### 25 steps were not enough for a small, real task

- **What happened:** the executor finished #20, with tests and check green, and then ran out of
  steps while still checking its work. The run ended `failed`, and the reviewer never ran.
- **Evidence:** "The model was still calling tools after 25 steps." Before that, the executor ran
  `issue`, made seven changes, each after reading its file, and ran seven commands.
- **What changed:** `maxSteps` defaults to 50, and five identical answers in a row stop a run
  sooner. See "The live run of #52 decided commands per role, 50 steps, a stop for loops, and each
  role's end" in decisions.md.

### A planner reaches for tools it does not have

- **What happened:** told to read the issue with the `issue` command, the planner looked for it,
  found it only had file tools, and searched the repository for the issue instead.
- **Evidence:** the planner's reasoning: "the 'issue command' isn't available ... I only have
  options for files, search, and read".
- **What changed:** each command declares the roles that get it. See the same decision.

### A model takes the glob `*` to be recursive

- **What happened:** `listFiles` with the glob `*` listed only the root, and the model expected
  every file.
- **Evidence:** the model's reasoning: "list glob \* didn't recurse through directories".
- **What changed:** the glob's description now says that `*` stays inside one folder and `**`
  crosses folders.

### A model keeps the spirit of a given signature, not its letter

- **What happened:** the prompt gave `isModelOf(provider, value)`. The executor wrote
  `isModelOf(models, value)`, which works but is not what was asked.
- **What changed:** reviewing its work caught it, and #87 has the signature as given. A prompt
  that fixes a public API should state it as the one to build, not as an example.

### What a command's checkpoint costs

- **Evidence:** from the run's journal, on 166 covered files (2.8 MB read):
  - the first capture took 1.4 s and stored 1.4 MB;
  - each later one in the same run took 70 to 100 ms, because the content was already stored.
- **What changed:** nothing yet. A run that changed nothing frees what it captured, so the next
  run's first command pays the full cost again. See "Keeping the last capture's contents" among
  the alternatives in "The executor runs configured commands by name".

### Most of the input was read from the cache

- **Evidence:** at the failure, the run had spent 735 uncached input tokens, 1,192,000 read from the
  cache, 108,564 written to it, and 22,871 output tokens.
- **What it means:** every step resends the whole context, and the providers serve almost all of
  it from their caches. How long a run is matters more than how large each step is.

### The command schema works on OpenAI's API

- **Evidence:** the planner and the executor, both on OpenAI, called `runCommand`. Its input is a
  union of one object per command, and strict mode accepted it.
- **Not verified yet:** Claude calling `runCommand`. The reviewer never ran, and it had no
  commands then.

### `gh issue view --comments` shows only the comments

- **What happened:** the first `issue` command printed nothing for #20, which has no comments.
- **What changed:** the command uses `--json title,body,comments`, which also gives the title and
  the body.

## The second live run of the write tools (2026-10-11)

Same task, after the fixes of #88: roles per command, 50 steps, the stop for loops, and the executor told to finish on green tests.

### The planner reads the issue itself once it has the command

- **What happened:** with `issue` given to the planner, the planner ran `gh issue view 20` before it planned.
- **Evidence:** the CLI asked to approve `gh issue view 20 --json title,body,comments` during the planner's turn.
- **Where it is enforced:** commands per role, in "The live run of #52 decided commands per role, 50 steps, a stop for loops, and each role's end".

### Green tests are not a reason to stop, for the executor

- **What happened:** the executor ran the whole suite green, and then went on adding a test and editing the architecture document until it hit 50 steps.
- **Evidence:** between them, the planner and the executor made 105 tool calls: 48 `readFile`, 15 `apply_patch` (plus 2 that failed), 15 `runCommand`, 14 `searchText` and 11 `listFiles`. The run ended with "The model was still calling tools after 50 steps", and the result passed `check` and the 1048 tests.
- **Where it is enforced:** the executor is told to finish once the tests pass and the plan is carried out. Its limit is 80, and configurable. See "Each role has its own step limit, which the consumer and the CLI can raise".

### Each role reads again what the one before it read

- **What happened:** the executor read `AGENTS.md`, the architecture document and the factory files the planner had just read, because each role has its own conversation.
- **Evidence:** 48 `readFile` calls across the planner and the executor, many of them on the same files.
- **Where it is enforced:** nowhere yet. The roles are told to ask for several files in one answer, which makes each read cheaper in steps, but they still read twice.

### A command description that names the order saves a step

- **What happened:** the executor ran `check` before `format`, failed on formatting, and fixed the imports by hand. Running `format` first would have done that.
- **Evidence:** `check` ran four times, `format` twice.
- **Where it is enforced:** the CLI's `check` command for this repository now says "Run format first". That lives in the user's configuration, not in the harness.

### The cost grows with the run's length, through the cache

- **Evidence:** at the failure, the run had spent 918 uncached input tokens, 2,109,499 read from the cache, 109,142 written to it, and 18,828 output tokens. That is about twice the cache reads of the first run, for twice the steps.

## The third live run of the write tools (2026-10-11)

Same task, after #90: 80 steps for the executor, the executor told to stop once the tests pass and the plan is done, and every role told to batch its reads.

### The whole cycle ran, and the executor stopped by itself

- **What happened:** the planner read the issue and planned. The executor implemented, ran the tests and the check, and finished with a summary. The reviewer checked the change with `showChanges` against the issue, and approved it.
- **Evidence:** run `20261011T151755194Z-77402c`, about 18 minutes long. It spent 945 uncached input tokens, 2,533,071 read from the cache, 154,166 written to it, and 29,207 output tokens. The result passed `check`, 1016 tests and `pack:check`. This version became the one merged for #20.
- **Where it is enforced:** "Each role has its own step limit, which the consumer and the CLI can raise".

### A reviewer that reviews the code, not the tests, still checks what matters

- **What happened:** the reviewer did not run the tests. It read the diff and the types, and found the one thing missing: a `decisions.md` entry for the API shape chosen. It judged that minor and approved.
- **Evidence:** the reviewer's reasoning, before `{"decision":"approved"}`.
- **What changed:** the entry was added before merging. A missing decision record is something to tell the executor to write, not something to leave for the review.

### A line cut at 300 characters cannot be patched

- **What happened:** 9 of 22 `apply_patch` calls failed, against 2 of 17 in the second run. The CLI did not show why, but the model's reasoning after each failure did:
  - about four came from `readFile` cutting lines at 300 characters. The rows of the module table in `docs/architecture.md` are up to 3,217 characters long, and a cut line cannot be copied into a patch's context. The model's reasoning: "the line might be quite long", "use targeted substring contexts instead of whole lines";
  - about three came from context the model wrote from memory instead of copying it. Its reasoning: "I assumed the type of expectation was existing", "I forgot to include afterEach";
  - one or two came after `format` changed a file the model had read, and it read the file again, as designed.
- **Evidence:** the third run's log, around each `apply_patch, status: error`. No failed patch changed a file. The failures cost about 14 of the executor's 80 steps, and about 14% of the cache reads.
- **Where it is enforced:** prose lines are shown whole up to 5,000 characters. See "Prose files show their long lines whole" in decisions.md. Showing why a patch failed is #89.

### Batching reads did not shorten a run

- **What happened:** the run made 118 tool calls, 56 of them `readFile`, against 105 with 48 in the second run.
- **Evidence:** the CLI's tool events.
- **What it means:** the instruction to ask for several files in one answer either was not followed or did not cut the number of reads. The run finished because the executor stopped, not because it read less. Knowing the number of steps, not only the calls, needs #89.

## The cost benchmarks of #100 (2026-10-13 to 2026-10-17)

A script ran `createLLMOrchestrator` with no person present, on a clean clone of this repository
at the same commit, with the user's configured commands and `autoApprove`. Unless an entry says
otherwise, the roles were the defaults: the planner on `gpt-5.6-sol` at `high`, the executor on
`gpt-5.6-luna` at `xhigh`, and the reviewer on Claude Opus 5.5 at `high`. The tasks were #20,
which is small, and #22, the workflows, which became #109. Costs are estimated from each
call's tokens at the providers' list prices. The results are in `bench-results/`, outside this
repository.

### The runs of #20 could read its solution

- **What happened:** the planner read the pull request that had already solved the task. The
  `issue` command returns an issue's comments, and since 2026-10-11 one comment on #20 says
  "Completado por #91". The `pr` command, configured for the planner, then showed #91. This was
  only seen on 2026-10-18, while preparing the next benchmark.
- **Evidence:** in the runs of 2026-10-14 and 2026-10-17, the planner ran `gh pr view 91` and
  read its review comments, which quote the code they are on, in its first minute. The
  log of the run of 2026-10-13 was not kept. The clone also held the whole history, #91's
  commits included, but no file tool can read `.git`. In the runs of #22, the issue had no
  comments, and nothing read #109.
- **What it means:** the runs of 2026-10-14 and 2026-10-17 compare with each other, since each
  had the same help, but not with a task the harness has no answer for. Whether the run of
  2026-10-13 read #91 is unknown, so a comparison with it, such as the 3.45M against 1.70M cache
  reads in the next entry, may include that difference. The entries below that rest on #20
  measure cost, not how well the harness solves a task.
- **What changed:** nothing in the harness. The next benchmark is to run on a clone that holds
  only its base commit, without the `pr` and `prReviewComments` commands.

### Each role resent every file it had read

- **What happened:** in the fourth run of #20, on 2026-10-13, one `readFile` of
  `docs/architecture.md` brought 53 KB, and both the planner and the executor read it. A tool's
  result stays in the context and is sent again on every later step.
- **Evidence:** that run read 3.45M tokens from the cache, in two rounds and 23 minutes. With
  reads limited to 16 KB and only the planner told to learn the repository, the same task read
  1.70M in 6.4 minutes. That run needed one round, so the second round explains part of the drop.
- **What changed:** see "One read or search returns at most 16 KB, and only the planner learns
  the repository" in decisions.md.

### The planner and the reviewer cost the most

- **What happened:** the expensive models read the repository, and their steps cost more than
  the executor's even when the executor takes many more.
- **Evidence:** on #20, before compaction, the planner was 63% of the cost, the reviewer 27%,
  and the executor 10% over 28 steps. On #22 with 160 executor steps, the planner and the
  reviewer together were 79% of the run without compaction and 81% of the run with it.
- **What changed:** see "The planner and the reviewer send cheaper explorers, all at once,
  through a tool" in decisions.md.

### Clearing the context ourselves cost more than it saved

- **What happened:** the compaction of #107 cleared old tool results and reasoning once the
  prompt passed 64,000 tokens. Every clearing changed the prefix, so the provider cached the
  context again from that point, and the executor read again what had been cleared.
- **Evidence:** on #20, 3.10M tokens read from the cache against 1.70M without it, 561k written
  against 147k, and 543 s against 383 s. The executor made 54 calls against 28. The run cost
  about $0.73 against $0.67.
- **What changed:** #107 was closed. See "The provider compacts a conversation, only when
  asked, and the harness never edits it" in decisions.md.

### The provider's compaction costs one uncached call

- **What happened:** with OpenAI's compaction at 64,000 tokens, the executor compacted once, at
  67,000. That call sent its whole input uncached, and the context fell to 6,000 tokens. The
  executor did not read again what the summary replaced.
- **Evidence:** on #20, 1.05M tokens read from the cache, 134k written, and 67k uncached, in
  325 s, for about $0.48. The executor made 28 calls, as without compaction, and cost about 14%
  more than without it, measured in input-token equivalents. On #22 at 200,000 tokens, the
  executor compacted once, at 202,000 tokens, and that call cost about 4 cents.
- **What it means:** the whole-run figures do not compare on their own. The planner's cost
  changed between days with the same setup, and on #22 the run with compaction cost $2.95
  against $1.89 because it took a third round of planning, execution and review. One run cannot
  say whether the compaction caused that round.

### 80 steps were not enough for the executor on #22

- **What happened:** with the default 80 steps, the executor ran out of steps in its first round,
  in both runs, and the reviewer never ran.
- **Evidence:** "The model was still calling tools after 80 steps", after $0.78 and $0.84, of
  which the planner was 71% and 76%. With 160 steps, the first round took 98 executor steps without
  compaction and 109 with it. Both runs then passed `check` and the tests, 1094 and 1098 of them.
- **What changed:** nothing yet. A task the size of #22 needs about 100 steps for its first
  round, and the limit stays a consumer's choice; see "Each role has its own step limit, which
  the consumer and the CLI can raise" in decisions.md.

### A Claude executor at `xhigh` outgrew 16,000 output tokens

- **What happened:** with the planner on Claude Opus 5.5, the executor on Claude Haiku 5.5 at
  `xhigh`, and the reviewer on `gpt-5.6-sol`, both runs of #22 stopped with `truncated`.
- **Evidence:** the executor's last call reported 16,000 output tokens, the most the client
  allowed: its tenth call in one run and its thirteenth in the other. The runs stopped after
  $0.78 and $1.01.
- **What changed:** see "A Claude answer is streamed, so it can be 64,000 tokens long" in
  decisions.md.
