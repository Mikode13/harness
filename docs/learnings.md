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

## A failed Claude compaction sent back (2026-10-20)

An external audit of 2026-10-18 found that `ClaudeLLMClient` took any compaction block as the
point to send the context from, including one whose `content` is `null`, which the SDK documents
as a compaction that failed (#119). Three calls to Claude Opus 5.5 checked what the API does with
such a block. Each sent a code word, an assistant turn, and then asked for the code word.

### Claude reads a failed compaction as if it were not there

- **What happened:** with a valid compaction block in the assistant turn, Claude no longer knew
  the code word: it read the context from the compaction on. With a block whose `content` and
  `encrypted_content` were `null`, it answered with the code word, as without any block.
- **Evidence:** 116 input tokens without a block, 145 with the valid one, and 116 with the failed
  one. The API accepted all three. A failure on the server could not be caused, so what a real
  failed block carries in `encrypted_content` is unknown.
- **What it means:** the client did the opposite of the API. After a failed compaction it would
  have left out of every later request all the context before it, with no summary in its place.
- **What changed:** see "A compaction that failed is left out of the conversation" in
  decisions.md.

## Two roles on #22 after #100 (2026-10-20)

The same script ran #22 twice, one run per set of roles, on a clone holding only the tree of its
base, `fb87ba4`, in one commit. It used the harness at `6ab67fb`:

- explorers;
- the formatter on every write;
- the stop for a command that ends the same way five times;
- the provider's compaction at 200,000 tokens;
- 180 steps for the executor.

The issue's text was in the prompt, and the commands were `test`, `format`, `lint`, `typecheck`
and `check`, so no command could read another issue or a pull request. The first run had the
default roles. The second had the planner on Claude Opus 5.5 at `high`, the executor on Claude
Haiku 5.5 at `xhigh`, and the reviewer on `gpt-5.6-sol` at `high`. Haiku 5.5 is not a model the
harness offers, so that run used a copy of the harness with an alias for it. Both were approved,
and both left `check` and the tests green. The results are in
`bench-results/2026-10-20-issue22-explorers-formatter`.

### Haiku 5.5 failed fewer edits, and the formatter is not what fails GPT's patches

- **What happened:** the OpenAI executor's `apply_patch` failed as often as in the run of
  2026-10-17 without compaction, the one its patches compare with. Claude Haiku's
  `str_replace_based_edit_tool` failed less often. The formatter ran and did its work, yet the
  OpenAI executor still ran the `format` command 13 times, and Haiku 4 times.
- **Evidence:**
  - 8 of 61 patches failed (13%), against 8 of 62 (13%) without compaction and 25 of 98 (26%)
    with it in the runs of 2026-10-17. This executor compacted only on its last call, after
    every failed patch; the one that failed 26% compacted on its 12th.
  - 4 of the 8 failed patches were on `README.md`, `docs/architecture.md` and
    `docs/workflows.md`, which the formatter never changed. Each came after the executor read
    the file, with no change to it in between, so the patch did not match what the model saw.
  - Haiku failed 4 of 50 edits (8%): 3 of 39 replacements, 1 of 10 creations and none of 1
    insertion. Its tool also reads files, and its 59 views are not counted.
  - The run's history records 12 changes made by the formatter among the OpenAI executor's
    writes, and 8 among Haiku's. The `format` command changed no file in either run.
  - The progress events carry no tool output, so why the patches failed is not known.
- **What it means:**
  - Formatting on write removes one cause, a file changed by a formatter after it was read, and
    it was not the main one here: half the failed patches were on files it never changed, and
    the rate matched the run without it whose patches, like these, came before any compaction.
    The failures left come from the model's edit not matching the file, which belongs to the
    edit format and the model, not the harness.
  - The `format` command's own description tells the model to run it before lint, and the
    model did, although there was nothing left to format.
  - With one run per setup, neither rate is a measurement.
- **What changed:** nothing yet. To learn why edits fail, a run has to keep the output of the
  calls that fail.

### The compaction cost cents; the rounds and the planner set the price

- **What happened:** the default roles cost $1.99, about what the run of 2026-10-17 without
  compaction cost. The second run cost $3.84 and took three rounds against two.
- **Evidence:**
  - **Compaction calls:**
    - The OpenAI executor compacted once, on its last call, which cost $0.04 uncached.
    - Haiku compacted once, at 209,000 tokens, for $0.02. Before it, each of its calls cost
      about $0.018, since Haiku 5.5 charges five times as much past 100,000 tokens; after it,
      about $0.001.
  - **The second run's planner:** Opus cost $2.06 against $1.01 for `gpt-5.6-sol`. It took 20
    calls against 12, wrote twice as much to the cache ($1.07 against $0.45), and wrote twice
    as much output ($0.73 against $0.35).
  - **The second run's executor:** Haiku cost $0.81 against $0.42 for `gpt-5.6-luna`. It wrote
    277,000 output tokens against 119,000.
  - **The third round** cost $0.39.
  - **In both runs,** the planner and the reviewer made up 79% of the cost with their explorers.
- **What it means:**
  - A failed patch costs little, because an executor call on `gpt-5.6-luna` costs a fraction of
    a cent. What sets the price is a round more of the planner and the reviewer, and how much
    the planner works.
  - In the runs of 2026-10-17, the run with compaction cost $2.95 for its third round and its
    planner and reviewer, not for the compaction, which cost $0.04.
  - Which run wrote the better code is not known from these figures: both reviewers approved,
    but they were different models.
- **What changed:** nothing.

## Provider profiles on #22 (2026-10-20)

The script of "Two roles on #22 after #100" ran #22 twice more, on the same base, `fb87ba4`, with
the harness at `6ba50b7`: `readFiles`, explorers that say where to read, a transcript of every
run, and the 5.5 models. One run had the `openai` roles: `gpt-5.6-sol` at `high` plans and
reviews, and `gpt-5.6-luna` at `xhigh` executes. The other had the `anthropic` roles: Claude Opus
5.5 at `high` plans and reviews, and Claude Haiku 5.5 at `xhigh` executes. Neither reached the
reviewer: the OpenAI executor was ended by the stop for a command that ends the same way, and
Haiku by the output limit. They cost $0.79 and $1.05. The results, transcripts included, are in
`bench-results/2026-10-20-issue22-provider-profiles`.

### The stop for a repeated command ended a run whose checks were green

- **What happened:** the OpenAI executor was stopped at its 64th call: "`pnpm run typecheck`
  ended the same way, with the same output, 5 times in a row". The tree it left passes `check`
  and the 1,090 tests, against 1,084 at the base.
- **Evidence:** of its 17 commands, `typecheck` ran 10 times, and its last 5 runs, each with
  exit code 0, were the ones counted. Between the first of them and the last, the executor made
  21 successful patches, most to `workflowRunner.ts`, and ran `test`, `lint` and `format`. A
  `tsc` that passes prints the same whatever changed.
- **What it means:** the decision took the same output as a sign that nothing the check sees
  had changed. That holds for a check that fails, not for one that passes.
- **What changed:** "A command that keeps ending alike warns the model, then asks the user" in
  decisions.md: a pass counts only with nothing changed, read from the content of the files.

### Haiku at `xhigh` spent its whole output on one answer

- **What happened:** the Haiku executor read 26 ranges, 166,261 characters of files, and
  changed nothing. Its tenth call stopped at the 64,000 output tokens the client allowed, after
  251 seconds, and the run failed.
- **Evidence:** the tenth `step` event reports 64,000 output tokens; the run's error is "The
  model stopped with \"truncated\"". The transcript ends with the results of the ninth call: it
  does not hold the answer the limit cut, so what Haiku was writing is not known.
- **What it means:** one run cannot say whether `xhigh` caused it. A transcript is missing the
  one answer that would explain a cut.
- **What changed:** "A run cut by the output limit stays in the conversation" in decisions.md:
  Claude may write 128,000 tokens, and a cut answer is kept with its run.

### The planners read in fewer calls, and cost a little less

- **What happened:** `gpt-5.6-sol` asked one `explore` with four questions, then read in 2
  `readFiles` calls and 1 `readFile`. Opus sent no explorer, and read in 7 `readFiles`, 3
  `readFile` and 4 `searchText` calls.
- **Evidence:** the planner runs once per round, and the earlier runs had two and three rounds,
  so only the first rounds compare:
  - `gpt-5.6-sol`: $0.48 in 5 calls, against $0.58 in 6. Its explorers cost $0.09.
  - Opus: $1.00 in 12 calls, against $1.09 in 11.
- **What it means:** reading several files in one call shortened `gpt-5.6-sol`'s plan by one
  call; Opus batched its reads, but made as many calls. A plan still costs about what it did,
  and Opus still costs twice as much as `gpt-5.6-sol`.
- **What changed:** nothing.

### Patches failed after a read too

- **What happened:** the OpenAI executor's `apply_patch` failed 10 of 40 times (25%), against 8
  of 61 in the run before. With the `error` of each failed `tool` event, each failure has a
  cause.
- **Evidence:**
  - 5 did not match the file. 2 followed a patch to the same file with no read since; 3 came
    after a read: a sentence of `README.md` the model remembered wrapped at another word, and,
    twice, a row of `docs/architecture.md`'s module table padded with hundreds of spaces.
  - 3 matched two places, and the patch needed more context.
  - 2 named a function, in their `@@` line, that was not in the file.
  - 6 of the 10 were on `workflowRunner.ts`, between the 42nd call and the 48th, with one patch
    that applied among them.
- **What it means:** as in "Haiku 5.5 failed fewer edits, and the formatter is not what fails
  GPT's patches", a read just before is no guarantee: the model writes the context from memory,
  and a wrapped sentence or a padded line is where it goes wrong. With one run, 25% is not a
  rate.
- **What changed:** nothing.

## #22 with the guard for commands that keep ending alike (2026-10-21)

The script of "Provider profiles on #22" ran #22 three more times, on the same base, `fb87ba4`,
with the harness of #130 at `9231c60`: 128,000 output tokens for Claude, a run cut by the output
limit kept, and "A command that keeps ending alike warns the model, then asks the user" in
decisions.md. No run had `ask`, so the fifth ending alike would have stopped it. The runs had the
`openai` roles, the `anthropic` roles, and the default ones: `gpt-5.6-sol` plans, `gpt-5.6-luna`
executes and Claude Opus 5.5 reviews. They cost $4.01, $1.97 and $2.41. The results, transcripts
included, are in `bench-results/2026-10-21-issue22-stuck-guard`.

### Every run ended, and the guard stopped none

- **What happened:** the `anthropic` run was approved in its first round, in 20 minutes, and the
  default one in its second, in 32. The `openai` run ended after 50 minutes, its three rounds
  rejected by the reviewer. Each left a tree that passes `check` and the tests: 1,120, 1,096 and
  1,098 of them.
- **Evidence:**
  - No command was warned about or stopped. In its first round, the OpenAI executor ran
    `typecheck` 17 times, many of them green. Each pass came after a change, and its failures,
    with exit code 2, each printed something else.
  - Haiku's longest answer had 38,152 output tokens. That is below the 64,000 it was cut at the
    day before, so this run does not show that 128,000 is needed.
  - The `openai` reviewer rejected each round with real design findings:
    - routed handoffs that lost their types;
    - cancellation not checked again after host callbacks;
    - transition builders the root does not export, which the only test of them imports from
      the module.
- **What it means:** the guard no longer ends a run whose checks pass. One run each does not
  show that it still catches a real loop. The `openai` run ended on the orchestrator's limit of
  rounds, not on a guard.
- **What changed:** nothing.

### The default roles cost more, in the reviewer

- **What happened:** the run with the default roles cost $2.41, against $1.99 for the same roles
  on 2026-10-20 ("Two roles on #22 after #100"). Both had two rounds.
- **Evidence:**
  - The reviewer: $0.93 over 18 steps, against $0.45 over 9.
  - The planner: $0.86 over 9 steps, against $1.01 over 12.
  - The planner's explorers: $0.17 over 97 steps, against $0.11 over 56.
  - The executor: $0.45 over 135 steps, against $0.42 over 100.
  - The executor read in 56 calls, against 74.
  - On 2026-10-17, the same roles cost $1.89 in one run and $2.95 in another.
- **What it means:** what changed since 2026-10-20 acts on runs that fail. In a run that does
  not fail, only fewer reads show. One run per setup varies more than the difference between
  setups, so comparing their cost needs three to five runs of each.
- **What changed:** nothing.

### No run reached the bar #109 was merged at

- **What happened:** seven solutions of #22 were compared against two references:
  - #22's acceptance criteria;
  - the two blocking findings of #109's own review: stage agents shared across runs, and
    handoffs not typed.

  The seven are 2026-10-17 without and with compaction, the two runs of 2026-10-20, and the three
  of this day. #109 itself started from the two runs of 2026-10-17, with both findings fixed by
  hand ("A workflow is a chain of stages, each with an agent and a context of its own" in
  decisions.md).

- **Evidence:**
  - **Agents created per run:** only this day's `anthropic` solution does so, as #109 does.
    Every other one keeps one agent per stage, whose conversation carries over from one run of
    the workflow to the next.
  - **Handoffs typed at compile time:** only this day's `openai` solution has them. It gets them
    through 9 `as unknown as` casts and duplicate names for the same options: `prompt` and
    `buildPrompt`, `validate` and `validator`, `transition` and `onResult`, and three ways to set
    the attempts. The run of 2026-10-17 with compaction typed a handoff's input, but not its
    destination.
  - **What all of them cover:** the four transitions, a stop that succeeds, a bound on
    transitions, usage per stage, and the link to #17. Every one except the run of 2026-10-17
    without compaction asks again with the reason an output was refused.
  - **Size:** between 556 and 991 lines of source, against 498 for #109. The tests of the
    workflow number between 9 and 41, against 20.
  - **This day's default solution** rethrows `options.signal.reason` as it is. A signal aborted
    with a string reason escapes it unclassified, which `AGENTS.md` rules out.
  - **The Opus reviewer** raised neither blocking finding in any run.
- **What it means:**
  - The harness's changes made the runs end, not the solutions better. Their quality follows the
    model and the reviewer.
  - The comparison is not blind, since who wrote each one was known, and there is one run per
    setup.
  - What it can count is what it checked: agents per run, typed handoffs, casts, size.
- **What changed:** nothing.

### Most failed patches matched twice, or were written from memory

- **What happened:** the OpenAI executor's `apply_patch` failed 16 of 77 times in the default run
  (21%), against 8 of 61 on 2026-10-20. In the `openai` run it failed 37 of 175 times (21%).
  Haiku's `str_replace_based_edit_tool` failed 2 of 88 times (2%).
- **Evidence:**
  - A hunk matched two places or more: 4 times in the default run, 26 in the `openai` one.
  - A hunk did not match the file: 9 times in each.
  - The patch changed nothing: 3 times, and once.
  - **Hunks that matched more than once:** 18 of the 30 were a hunk after the first. `applyUpdate`
    already searches each hunk from the one before it. They failed on the rule that a hunk with
    no `@@` line must match once in the rest of the file, where Codex takes the first match ("Each
    provider edits in its native format, on the one edit engine" in decisions.md).
  - **Hunks that did not match:** 11 of the 18 came right after a patch to the same file had
    applied. A patch's result shows only the lines around its change. 6 came after a read, and
    about 2 differed only in formatting.
  - **One example:** Luna sent a hunk of two context lines with no change, to pass over a block,
    and the next hunk expected code the file did not have.

- **What it means:**
  - Most failures come from the edit format and the model: too little context, and a file
    remembered from before the model's own changes.
  - With Codex's rule, the 30 that matched more than once would have applied, some of them
    perhaps in the wrong place. That choice is still open.
- **What changed:** nothing.

### Replayed, the patches that matched twice would have applied as the model meant

- **What happened:** the 53 failed patches of the default and `openai` runs were applied again,
  offline, to each file as the run's history says it was. The applier refused 52 of them again,
  with the same error. The one left had been refused because the file already held its content,
  and applied: the history missed a change there.
- **Evidence:**
  - **At their first match:** 29 of the 30 that matched more than once applied. 9 gave what the
    model's next patch to that file gave. 13 gave the file the model reached 1 to 6 patches
    later. Of the other 7, 5 held changes the patch asked for that the model's later patches
    did not make, and 2 differed only in formatting, one of them also in a line. In call 41, the
    model's next patch left out a change the failed one had.
  - **The one that still failed** took a first match that left the next hunk with nothing to
    match.
  - **The 18 that did not match:**
    - 5 expected lines as the model had written them, which the formatter had rewritten after
      the write. Two came after a `create_file`, whose response gave only the size, and three
      after a change, whose response showed the formatted lines with nothing to tell them apart.
    - 7 expected lines the file never had: a wrapping, a double space, `) ;`, and once a line
      number copied from `readFile`.
    - 6 had lines that were all in the file, but not together: twice the hunks came out of
      order, and four times the model left lines out.
  - **What the error showed:** the old error showed the file's lines for 10 of the 18, the new
    one for 14. The new one showed more of what the model's next patch changed in 6, and less in
    none. Twice it said the hunks came out of order.
  - With the first match, the `openai` run would have failed 12 patches of 175, not 37, and the
    default run 12 of 77, not 16.
- **What it means:**
  - Luna counts on the order of its hunks to tell alike places apart, as Codex reads them. The
    rule that a hunk must match once caused most of its failures.
  - The applier cannot fix a hunk written from memory. A better error is all it can give.
  - This is one task in two runs, and where a hunk was meant to go was judged from the file's
    later states and the diffs, not proved.
- **What changed:** "A V4A hunk applies at its first match, and a refused one shows the lines
  most like it" and "An edit shows the lines the formatter rewrote, and has the file read again"
  in decisions.md.

## #22 with hunks at their first match and the formatter's lines shown (2026-10-21)

The same script ran #22 once more on `fb87ba4`, with the default roles and the harness of this
change at `45e90d5`: hunks at their first match, the lines most like a hunk that failed, and the
lines the formatter rewrote in an edit's response, before the file had to be read again. It cost
$2.33, against $2.41 that morning, and took 30 minutes. The reviewer approved it in the second round,
as in the morning, and the tree passed `check` and its 1098 tests. The results are in
`bench-results/2026-10-21-issue22-patch-first-match`, with the scripts of the replay.

### Luna's failed patches fell from 21% to 8%

- **What happened:** the executor's `apply_patch` failed 5 of 65 times (8%), against 16 of 77
  (21%) that morning. In the first round it failed 4 of 46 times, against 13 of 49.
- **Evidence:**
  - No hunk failed for matching more than once.
  - Two hunks came out of order, and the error said so. The next patch to the file applied one
    call later and three calls later.
  - One hunk expected an import in the README as the model had written it, on several lines.
    The formatter had put it on one, and the response to that edit showed it so, 54 calls
    before. The next patch applied.
  - One hunk expected a wrapped paragraph the file never had, and one patch changed nothing.
  - The formatter rewrote 19 of the 60 writes, and each response said which lines.
- **What it means:**
  - The first match removed the largest cause of failures, as the replay predicted.
  - Showing the formatter's lines did not stop a model that edits from what it wrote long
    before.
  - It is one run, and the cost fell little: the failures were a small part of it.
- **What changed:** "An edit shows the lines the formatter rewrote, and has the file read again"
  in decisions.md, not measured.

## Three overlapping runs on Claude Haiku (2026-10-25)

The validation scenario of #28 ran once live, on the integration branch at `a0308b3`, with the
user's approval: three `createLLMAgent` runs at once on `haiku` with `low` effort and at most 8
steps, each in its own session, over two throwaway repositories. A simple agent read one, an
agent with an `agentAsTool` researcher asked about the same one and was cancelled at its first
`subagent` event, and an unrelated agent wrote a file in the other. The simple run was sent an
`Inbox` message once it started working. The three runs together spent about 8,000 input tokens,
most of them read from the cache, and under 500 output tokens, cents at most.

### Runs kept apart, and a message sent mid-run was followed

- **What happened:** the simple run summarized its README and ended with the word the message
  sent mid-run asked for ("PINEAPPLE"), and its inbox was left empty. The parent was cancelled
  at 10.7 s, while the other two still worked; they ended at 13.9 s and 16.9 s. The unrelated
  run wrote `NOTES.md`, and the history listed that run with its session.
- **Evidence:** each run's callback narrated only its own tools (`readFile`; `researcher`;
  `str_replace_based_edit_tool`), neither answer mentioned the other repository, and each run
  reported its own usage and the session it was given.
- **What it means:** what the offline scenario proves held with a real model, once. Whether a
  model follows a message read while it waits for agents in the background is still for the
  live round.
- **What changed:** nothing; the offline scenario is in `tests/unit/overlappingRuns.unit.test.ts`.

### A workspace without file tools gives the model no tools

- **What happened:** the first attempt passed `workspace` to `createLLMAgent` and no `tools`.
  The agents had no tool at all: the simple one wrote a call to a `read` tool as text, which
  the run returned as its answer, and the unrelated one said it could not write.
- **Evidence:** 210 and 218 input tokens per run, no tool events, and no history.
- **What it means:** `workspace` says where the agent works; its file tools come from
  `createFileTools`, passed in `tools`, as the README shows. Nothing warns of a workspace given
  without them.
- **What changed:** "An agent given a workspace needs tools" in decisions.md: such an agent is
  now refused when it is built (#148).
