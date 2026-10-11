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
