# Decisions & lessons — mikode-harness

Personal learning log for this project: what was decided, what alternatives
were considered, and what the transferable lesson is — independent of this
specific codebase. Written to survive outside this repo (Obsidian, an
interview, a future project).

Chronological. Entries roughly through Step 3 of the former `tasks.txt`
roadmap, now only in Git history (the `Agent`
seam, Codex/Claude engines, `RetryingAgent`) are reconstructed from a
compacted summary of an earlier session, not a full transcript — the
technical facts are solid, but double-check these few against your own
memory before quoting them verbatim. Everything from the orchestrator
onward is written from the live conversation.

---

## The Agent seam: minimal interface first

tags: #mikode-harness #api-design #agent-loops

**Decision:** one interface, `Agent { run(prompt, signal, callback): Promise<AgentResponse | undefined> }`, is the single seam every consumer (chat loop, retry wrapper, orchestrator) depends on — nothing upstream imports a concrete SDK type.

**Context:** the point of the project was to understand agent harnesses by building the seams myself, not to design a "complete" contract upfront. `AgentResponse` started deliberately underspecified rather than the richer `{text, actions, usage}` shape that seemed obviously "right" from the start.

**Alternatives considered:** design the full response shape (structured actions, usage, cost) before implementing a single engine. Rejected — with only one implementation to design against, the shape would have been guessed, not proven; the plan was to design it against two real engines instead of one imagined one.

**Consequences:** `loopImpl.ts` imports nothing from `@openai/codex-sdk` — verified as the actual success criterion, not just claimed. `AgentResponse` gained fields once a second engine and real consumers proved they were needed, not before.

**Lesson:** build a public seam as small as it can possibly be, and let real, second-implementation usage force it wider — not an upfront survey of what a "complete" interface should contain. A seam that's too specific too early gets designed against imagined needs, which are usually wrong.

---

## Codex: stream, don't buffer

tags: #mikode-harness #agent-sdks #streaming

**Decision:** `CodexAgent` consumes `thread.runStreamed()` (the raw `ThreadEvent` stream), not the buffered `thread.run()`/`Turn` API.

**Context:** the buffered API's `finalResponse` only keeps the last `agent_message` and hides turns that produced no message at all (pure tool-use turns) — the code was already reconstructing text from raw items to work around this, meaning the buffered layer wasn't saving any work, only hiding information.

**Alternatives considered:** keep the buffered API for Codex and build the abstraction on top of "one buffered engine + one stream-only engine" (Claude's `query()` has no buffered mode at all). Rejected — unifying both engines around "consume a stream, accumulate yourself" removes the mismatch, and got live progress streaming (built much later) close to free, since both engines already process one event at a time.

**Consequences:** both engines share the same internal shape (iterate events, translate each into a shared type, accumulate). The live-streaming work later needed almost no structural change to either engine — it reused a loop that already existed.

**Lesson:** when a vendor SDK offers a "convenience" buffered wrapper over a stream, check whether you're already working around what it hides before adopting it — if you are, the wrapper isn't saving you the work it claims to.

---

## Claude: explicit session continuity

tags: #mikode-harness #agent-sdks #state

partially superseded by: "MiKode owns the conversation on the model APIs, and provider sessions stay the default path" (below) — still true of the Agent SDK path, which remains the default, but no longer the foundation new work builds on.

**Decision:** `ClaudeAgent` captures `session_id` from the first message of a stream and passes it as `resume` on the next call.

**Context:** Codex's `Thread` object gives free conversation continuity just by reusing the same instance across calls. Claude's `query()` does not — a new call starts a fresh conversation unless told otherwise.

**Alternatives considered:** feed the whole conversation history back in manually every call (an `AsyncIterable<SDKUserMessage>` instead of a plain string prompt). Rejected for this harness's needs — session resume is simpler and keeps both engines symmetric from the outside: the engine remembers, the caller doesn't have to.

**Consequences:** both engines behave identically from any caller's perspective (multi-turn context is free), even though the underlying mechanism differs completely — a caller-invisible detail (`sessionId` as private state) instead of a structural difference leaking into the `Agent` contract.

**Lesson:** when two vendor SDKs solve the same problem differently, the fix belongs inside the adapter, not the shared interface — the interface's job is to hide exactly this kind of divergence.

---

## RetryingAgent as a decorator, with a real error taxonomy

tags: #mikode-harness #error-handling #retry-design

**Decision:** `RetryingAgent` implements `Agent` and wraps another `Agent`, retrying on `RecoverableError` up to `maxAttempts`, never retrying on `UnrecoverableError` or an aborted call.

**Context:** needed a way to distinguish "this specific failure is worth retrying" from "nothing further should be attempted" without hardcoding that judgment into every engine.

**Alternatives considered:** a single generic `Error` type with retry logic based on message-string sniffing. Rejected — string-matching error messages is exactly the kind of fragile text-matching problem that later resurfaced (and bit hard) with the reviewer's OK/KO handling; a typed distinction avoids it from the start.

**Consequences:** every engine throws one of exactly two typed errors, and every consumer can `instanceof`-check instead of parsing text. The decorator composes cleanly: `new RetryingAgent(new CodexAgent(...))` is itself a valid `Agent`.

**Lesson:** when a system needs to distinguish "retry this" from "give up," encode that as a type the throwing code chooses deliberately — not as a property inferred later by whoever catches it.

---

## Retry mitigates repeated side effects via context, not truncation

tags: #mikode-harness #retry-design #llm-agents

**Decision:** on a `RecoverableError`, `RetryingAgent` resends the original prompt followed by why the previous attempt failed, instead of silently resending the identical prompt.

**Context:** a naive retry re-runs the whole turn from scratch — for an agent with real tool access, that risks redoing a side effect (a command, a file write) that already succeeded before the failure occurred elsewhere in the same turn.

**Alternatives considered:** truncate/resume from the exact point of failure. Rejected as impractical — there's no clean "resume point" in an LLM agent's turn, and the SDK doesn't expose one.

**Consequences:** verified against the real Codex SDK that a `Thread`'s server-side session memory already recognizes what happened in a prior turn — a retried turn has both the injected failure reason and its own session history to avoid blindly repeating an action. Accepted as sufficient without proof it's airtight; a mitigation via context, not a structural guarantee. The retried prompt keeps the original request, because an attempt that failed before the provider registered the turn leaves no session that remembers it: Codex keeps a thread id only after `thread.started`, and Claude a session id only after the first streamed message.

**Lesson:** "retry the same input" is rarely actually safe for a stateful, side-effecting system — if you can't cleanly resume, the next best thing is telling the same actor what already happened and leaning on it to reason about that context.

---

## The orchestrator IS an Agent — no special-casing at the consumer

tags: #mikode-harness #api-design #multi-agent

**Decision:** `OrchestratorAgent` implements the same `Agent` interface as every leaf engine. `Loop` calls it exactly like it calls `RetryingAgent` or a bare `CodexAgent` — no branch anywhere for "this one coordinates other agents."

**Context:** this is the moment the earlier abstraction work was building toward — proving that composing three agents into a workflow doesn't require a different API shape than running one agent directly.

**Alternatives considered:** a distinct `Workflow`/`Orchestrator` type with its own run signature. Rejected — chat and workflow were decided, explicitly and early, to be two consumers of exactly the same contract, before an orchestrator existed to test that idea against.

**Consequences:** swapping `index.ts` from a bare agent to a fully orchestrated one is a one-line change in composition, nothing else moves.

**Lesson:** when a "coordinator" of several things needs to plug into the same places a single thing already plugs into, make it satisfy the same interface as the thing it coordinates — recursion in the type system, not a parallel type, is what makes composition free later.

---

## Build the fixed flow before the router

tags: #mikode-harness #scope-discipline #multi-agent

**Decision:** build plan → execute → review as a fixed, hardcoded sequence first; defer any dynamic "decide who handles this request" routing to a later phase.

**Context:** it was tempting to design routing (not every request needs the same handling — a greeting shouldn't invoke a full architecture review) at the same time as the first workflow, since the motivating idea was clear from the start.

**Alternatives considered:** design routing and the fixed flow together. Rejected — routing needs its own hard problem solved first (getting a structured decision out of an agent), and that turned out to be the exact same problem the reviewer's OK/KO verdict needed. Solving it once, for the simpler case, and reusing it later is cheaper than solving both problems at once with no working reference yet.

**Consequences:** the same "schema + parse + retry-on-malformed-output" technique built for the reviewer's decision is explicitly earmarked for the router when it's eventually built.

**Lesson:** when two features share an unsolved hard sub-problem, build the simpler feature first to prove out the sub-problem, then reuse it — don't solve the hard sub-problem for the first time inside the more complex feature.

---

## Only the review verdict crosses agent boundaries explicitly

tags: #mikode-harness #multi-agent #context-management

partially superseded by: "MiKode owns the conversation on the model APIs, and provider sessions stay the default path" (below) — `LLMAgent` remembers its own turns too, but in a `Conversation` MiKode keeps, not in a provider session. The orchestrator still moves only the round's data between roles.

**Decision:** the orchestrator doesn't maintain or replay a shared context/history object between planner, executor, and reviewer. It injects exactly one thing across a boundary: the reviewer's feedback, fed to the planner's next call.

**Context:** the instinct was to have the orchestrator store "all context lines" and pass them around — until realizing `CodexAgent`/`ClaudeAgent` are already stateful per-instance (same session/Thread across calls), so each agent already remembers its own prior turns for free.

**Alternatives considered:** a generic shared "conversation log" threaded through every call. Rejected once the statefulness of each engine was actually verified in the code — the orchestrator only needs to move information between two _different_ agents' sessions, since nothing else crosses automatically.

**Consequences:** the orchestrator's own logic is much smaller than a full context-management layer would have been — plumbing for exactly one cross-agent handoff, not a general memory system.

**Lesson:** before building a coordination layer to manage state between components, check whether each component already carries the state you think you need to manage — coordination code should move only the information that doesn't already flow for free.

---

## AgentResponse stays minimal; role-specific meaning lives at the role

tags: #mikode-harness #api-design #structured-output

**Decision:** `AgentResponse` never grew fields for "is this OK or KO" or "which agent to route to." Each orchestration role (reviewer, later router) defines its own schema and parses `response.response: string` itself.

**Context:** the natural-seeming next step, once a reviewer needed to signal approve/reject, was to add a `status`/`reason` field to the shared response type.

**Alternatives considered:** extend `AgentResponse` with fields for each new orchestration need as it appeared. Rejected on Interface Segregation grounds — a field only one caller needs, sitting unused on every other call, invites invalid states and grows without bound as more roles appear.

**Consequences:** `AgentResponse` has the same four fields it had at Step 3, despite the orchestrator, reviewer schema, and progress-event system all being built on top of it since.

**Lesson:** a shared, low-level contract used by every caller should only grow for needs every caller has — a need specific to one calling context belongs in that context's own type, layered on top, not merged into the shared one.

---

## Progress narration and the final response are different channels

tags: #mikode-harness #ui-design #streaming

**Decision:** agents report ongoing activity via an injected `callback: (event: ProgressEvent) => void`, never via `console.log` inside the agent itself. `AgentResponse.response` stays just the model's own words.

**Context:** originally everything an engine's SDK reported (tool calls and the model's actual text) was concatenated into one string — meaning if that string were ever handed to another agent, the next agent would receive operational noise mixed in with the substantive answer.

**Alternatives considered:** (a) let each agent print directly to the terminal — rejected, couples an SDK wrapper to a specific UI and makes it untestable without capturing stdout; (b) return progress as a field on `AgentResponse`, printed after the call resolves — rejected, because the orchestrator's own returned response has no non-arbitrary answer to "what's my progress" when it wraps three sub-agents, and it loses live display entirely.

**Consequences:** `Loop` (or a future web handler) supplies the callback and decides how to render; agents never know their output's destination. The orchestrator forwards its received callback straight down to each sub-agent — no aggregation logic needed anywhere.

**Lesson:** when a component needs to both "do its job" and "report on what it's doing," don't merge the two into one return value — the report is a side channel and the job's result is the actual return value; conflating them breaks the moment components compose.

---

## String-literal discriminants, not a TypeScript enum, for a shared event type

tags: #mikode-harness #typescript #api-design

**Decision:** `ProgressEvent`'s discriminant field is a plain string literal (`type: 'command'`, `'search'`, ...), not a numeric `enum`.

**Context:** an early draft used `enum AgentEvents { command, search, ... }` without explicit numeric values.

**Alternatives considered:** keep the enum. Rejected on two grounds specific to this design's own stated goal (a future web consumer): unexplicit numeric enums silently renumber every member after an insertion with no compiler error, and a numeric value (`{"type": 0}`) carries zero information to a JSON consumer without also shipping the enum's definition.

**Consequences:** every `ProgressEvent` is self-describing when logged, serialized, or sent over a future websocket.

**Lesson:** check a data-modeling choice against the concrete reason you're building the thing — a numeric enum is a fine general TypeScript pattern, but specifically wrong the moment "legible outside the process that produced it" is a stated requirement.

---

## Retry granularity: wrap each agent, not the whole orchestrator

tags: #mikode-harness #retry-design #multi-agent

**Decision:** `RetryingAgent` wraps each of planner, executor, and reviewer individually, not the orchestrator as a whole.

**Context:** the original wiring wrapped the entire `OrchestratorAgent` in one outer `RetryingAgent`. A transient failure in any single sub-agent call then retried the _entire_ plan→execute→review cycle from scratch.

**Alternatives considered:** keep the single outer wrapper for simplicity. Rejected once a real production crash traced back to exactly this — three full agent cycles redone before giving up and killing the whole session.

**Consequences:** a flaky individual call now gets absorbed locally, without discarding the other two agents' already-successful work in the same attempt.

**Lesson:** when wrapping a retry/resilience mechanism around a multi-step process, put it around each step, not around the whole process — retrying "everything" because one small part failed is usually far more expensive than the failure it's protecting against.

---

## Convert Recoverable → Unrecoverable strictly on exhaustion, never on abort or an already-unrecoverable error

tags: #mikode-harness #error-handling #bugfix

**Decision:** in `RetryingAgent`, the abort/`UnrecoverableError` check runs first and unconditionally; only a `RecoverableError` on the _last_ attempt converts to `UnrecoverableError`.

**Context:** a refactor accidentally reordered this — checking `attempt === maxAttempts` before checking the error's type. On the last attempt, an abort or a genuine `UnrecoverableError` got relabeled as "max attempts exhausted," discarding the real reason and, for the abort case, silently skipping the exit-confirmation UX.

**Alternatives considered:** none seriously — caught as a straightforward regression during review, not a design tradeoff.

**Consequences:** caught before merging, by re-deriving from the code exactly which two concrete inputs it would silently mishandle.

**Lesson:** when a loop has two independent conditions gating different behavior, check both explicitly and in the right order — collapsing them into one nested `if` is where this exact class of bug hides, and it's easy to introduce silently during an unrelated refactor.

---

## Structured, schema-validated agent decisions — not free-text matching

tags: #mikode-harness #structured-output #llm-agents

**Decision:** the reviewer responds with JSON validated by a Zod schema (`{decision: 'approved'|'rejected', feedback}`), not the word "OK" in free text.

**Context:** the first version compared `response !== 'OK'` to decide whether to keep looping. It worked in short manual tests, but in a real production session the reviewer never returned that exact string — the loop ran literally forever, reloading context and re-verifying repeatedly, until it had to be killed by hand.

**Alternatives considered:** tolerate variation with `.trim().toUpperCase()`. Rejected — still guessing at a free-text format rather than fixing the underlying problem; only makes the failure less likely, not impossible.

**Consequences:** the reviewer's prompt now asks for explicit JSON; a parse failure retries only that one call (with the previous failure reason injected), not the whole plan→execute→review cycle.

**Lesson:** never use exact-match on free-text LLM output as a control-flow condition — no matter how clear the prompt, the model won't comply 100% of the time. Treat it as a data-validation problem (schema + parse), and design explicitly for what happens when validation fails.

---

## Unify every orchestrator failure into "consume an attempt, retry with a reason"

tags: #mikode-harness #error-handling #retry-design

**Decision:** every failure mode inside `OrchestratorAgent.run()` — missing plan, missing executor response, a malformed reviewer decision, an explicit rejection — follows the same shape: record why, retry (scoped as narrowly as possible), and convert to `UnrecoverableError` only once attempts are exhausted.

**Context:** before this, only "reviewer rejected" used that shape. The other three threw a `RecoverableError` immediately, uncaught by anything, killing the whole orchestration on the very first occurrence — including a malformed-JSON reviewer response, a formatting hiccup, not evidence the plan or execution were wrong.

**Alternatives considered:** let a `RetryingAgent` wrapping the reviewer catch the malformed-JSON case. Rejected — structurally impossible: the JSON parsing happens in the orchestrator, one layer above the reviewer's own `Agent.run()` call, which already returned successfully from that call's own perspective.

**Consequences:** a malformed reviewer response now retries _only_ the reviewer call (its own small bounded loop, told exactly why the previous response didn't parse), not the whole plan/execute cycle.

**Lesson:** when the same underlying idea is implemented correctly in one place and as an immediate hard failure everywhere else in the same function, that inconsistency is worth hunting down explicitly — it usually means one failure mode was added later, by copy-adjacent-pattern, without going back to fix the older ones.

---

## The reviewer judges like a senior engineer, not a literal plan-compliance checker — and "how much to investigate" is explicitly deferred

tags: #mikode-harness #prompt-design #scope-discipline

**Decision:** the reviewer's prompt changed from "check whether the executor followed this plan" to "independently inspect the repository... evaluate the original request first; plan compliance is secondary" — explicit permission to use its own tool access to judge structural fit, not just literal compliance.

**Context:** the underlying agent already had real tool access and, empirically, sometimes used it to catch real structural regressions (an unrelated safety limit silently removed during an unrelated change) — but the narrow prompt framing risked constraining a capable agent to a shallower check than it was able to do.

**Alternatives considered:** also make the reviewer _scale_ how much it investigates based on what the request actually touches (skip repo exploration entirely for a trivial, no-code-change request). Explicitly deferred, self-caught mid-conversation — that's a routing/classification problem, already decided against building before a fixed flow existed to prove out first.

**Consequences:** every review, even a trivial one, now does full independent inspection — accepted cost for now, not yet solved.

**Lesson:** "what kind of judgment should this apply" and "how much effort should this spend" are two different axes — one can be fixed with a prompt change today; the other needs infrastructure that doesn't exist yet. Conflating them either blocks a cheap real improvement on an expensive unbuilt one, or smuggles scope creep into what should've been a small change.

---

## Headless agents need explicit sandbox/approval configuration — the SDK default assumes a human is present

tags: #mikode-harness #agent-sdks #production-incidents

**Decision:** both `CodexAgent` and `ClaudeAgent` need explicit auto-approval/sandbox configuration for unattended operation, added as an opt-in `autoApprove` flag mapped to each SDK's own option.

**Context:** found the hard way, twice, independently — once with Codex (an executor agent got stuck in a loop asking for filesystem permission nobody was present to grant, eventually exhausting `RetryingAgent`'s attempts and killing the whole chat session) and once with Claude (isolated by swapping only the reviewer's engine and re-running the identical scenario, which stopped reproducing — strong evidence of the same class of problem in the other SDK).

**Alternatives considered:** none really — both vendor SDKs default to requiring interactive approval for real tool use, correct for a human-in-the-loop CLI session and simply wrong for a harness running unattended.

**Consequences:** guarded behind an explicit flag, not a silent default — real, unrestricted command execution granted to a backend process is a genuine security tradeoff worth a deliberate, visible switch.

**Lesson:** any coding-agent SDK's defaults are tuned for "a human is watching and can click approve" — running the same SDK headlessly needs an explicit, deliberate opt-in to bypass that, and the failure mode when you forget it isn't a clean error, it's the agent silently stalling in a permission request loop that never resolves.

---

## Silent failure is worse than a visible one

tags: #mikode-harness #error-handling #observability

**Decision:** `Loop`'s top-level catch no longer swallows any error that isn't an abort or an `UnrecoverableError` — anything else now prints via `console.error` before the chat loop continues.

**Context:** the original catch block had exactly two branches and did nothing for anything else — a `RecoverableError` that escaped every retry mechanism above it would vanish with zero visible trace.

**Alternatives considered:** rely entirely on fixing every place that could produce such an error so this branch would never be hit. Rejected as the sole fix — it only covers the failure modes already known about; a defensive fallback protects against the ones that aren't.

**Consequences:** a bug that produces an unexpected error type is now visible immediately, at the cost of one extra `console.error` line.

**Lesson:** a catch block's default branch should never be "do nothing" — even when every case you can think of is handled explicitly above it, the fallback is what protects you from the case you didn't think of; make it loud, not silent.

---

## Harness as a reusable core package, CLI as a separate consumer

tags: #mikode-harness #architecture #package-design

superseded by: "ConversationLoop is a consumption pattern, not the harness seam" (below) — the CLI entry point has since moved again, from `bin/cli.ts` to `scripts/cli.ts` to its own `cli/` workspace project; the package's export list has also grown well past `Loop`/`Agent`/interfaces/orchestrator classes. Reasoning and lesson below remain valid.

**Decision:** separate the harness into a core npm package (`@mikode13/harness`, exports only `Loop`, `Agent`, interfaces, and orchestrator classes) and a separate executable consumer (`bin/cli.ts`, which imports from `src/` and instantiates the orchestrator for interactive terminal use).

**Context:** the harness started as a single executable with hardcoded models and orchestrator setup in `index.ts`. The goal was to enable multiple consumers (CLI, chatbot UI, future integration in other projects) to use the harness core independently, each bringing their own configuration, orchestration strategy, and I/O layer.

**Alternatives considered:** keep everything in one package and handle consumer-specific setup through build flags or runtime config. Rejected — the risk of CLI-specific dependencies leaking into the core package, and the core carrying unused configuration concerns for consumers that don't need them.

**Consequences:** the harness package is now import-clean (no `index.ts` side effects or executable code), and consumers can depend on `@mikode13/harness` as a library without inheriting terminal or CLI concerns. The CLI still works locally, consuming from `src/` during development, and compiles to `dist/bin/cli.js` for installation.

**Lesson:** a shared library should have zero opinions about how it's invoked or configured — the package itself should export only abstractions; every concrete choice (which model, which orchestrator, how to read input, where to print output) belongs to a consumer layer that imports the package, not inside it.

---

## LoopTerminal: abstractions for I/O instead of hardcoded readline

tags: #mikode-harness #abstraction #testability

superseded by: "Split LoopTerminal into two single-responsibility ports" (further below) — `LoopTerminal` itself no longer exists. Reasoning and lesson (decouple the loop from a hardcoded I/O mechanism) remain valid.

**Decision:** `Loop` no longer imports `readline` directly. Instead, it depends on a `LoopTerminal` interface with methods like `question()`, `onInterrupt()`, `log()`, `write()`, `clearLine()`, etc. A factory function `createReadlineTerminal()` produces the default Node.js `readline` implementation; other transports can provide different implementations.

**Context:** `Loop` was deeply coupled to Node's `readline` module and `process.stdout/stdin`, making it impossible to test without capturing stdout or inject a different transport (websocket, REST, etc.) in a future consumer like the chatbot UI.

**Alternatives considered:** keep readline as-is but mock it in tests. Rejected — testing doesn't reveal the real blocker: the hardcoded i/o layer prevented the harness core from being useful in non-terminal contexts without forking and rewriting that code.

**Consequences:** `Loop` is now transport-agnostic. It accepts a `LoopTerminal` in its constructor (defaulting to readline), so tests can inject a fake, and future consumers (web UI, REST API) can provide their own implementation without modifying the harness.

**Lesson:** when a core component (agent loop) hard-couples to a specific I/O mechanism (terminal readline), it becomes unusable as a reusable library — the abstraction layer should be inside the core, not a wrapper around it.

---

## Generic orchestrator prompts, not hardcoded skill names

tags: #mikode-harness #prompt-design #reusability

**Decision:** the planner, executor, and reviewer prompts no longer mention specific skill names like `mikode-skills:mikode-code-philosophy`. Instead, prompts describe the engineering principles and judgment directly (e.g., "preserve contracts and boundaries" instead of "apply the mikode-code-philosophy skill").

**Context:** the prompts referenced MiKode-specific skills, coupling the harness to MiKode's skill ecosystem. If the harness is published or used in a different context (e.g., internal tools at a company with its own skill catalog, or a project without skills at all), the hardcoded references would be misleading or wrong.

**Alternatives considered:** make skills configurable via dependency injection into the prompts. Rejected for now — the agents already have access to the skills (via tools), and a well-written prompt doesn't need to name them explicitly to guide a capable agent toward using them. Deferring injection to a future phase keeps this simpler.

**Consequences:** the prompts are now generic and reusable; they rely on the model's native judgment and the available tools, not on MiKode-specific conventions. If a consumer wants to surface specific methodologies, they can wrap the orchestrator with additional context or a different model.

**Lesson:** when a core component references external conventions by name, it's declaring a hard dependency on those conventions existing and being recognized everywhere the component is used — omit the name, state the principle, and let tools and context carry the specifics instead.

---

## Split LoopTerminal into two single-responsibility ports, not one growing interface

tags: #mikode-harness #architecture #interface-segregation

partially superseded by: "ConversationLoop is a consumption pattern, not the harness seam" (below) — `IPromptEmitter` did not stay in the harness core as described here; it moved into `cli/` along with `ConversationLoop` itself. `ILogger` and the `ConversationLoop`/`scripts/cli.ts` renames described here remain accurate (`scripts/cli.ts` itself later moved again, to `cli/cli.ts`), except that `ILogger` later lost `log` — see "The harness logs the failures it absorbs and throws the rest" (below).

**Decision:** `LoopTerminal` (one interface bundling `question`, `onInterrupt`, `log`, `write`, `clearLine`) is gone. `ConversationLoop` (renamed from `Loop`) now depends on two focused ports instead: `IPromptEmitter` (`emit`, `close`) and `ILogger` (`log`, `error`). Terminal presentation that isn't a core concern at all — the spinner, cursor control — moved out of any shared interface entirely and lives only in the CLI composition root (`scripts/cli.ts`, moved from `bin/cli.ts`), alongside the rest of `src/` reorganized into one folder per bounded module (`agent`, `conversationLoop`, `engines/{claude,codex}`, `orchestration`, `retry`, `shared`), each split into `domain`/`infrastructure`.

**Context:** `LoopTerminal` was introduced to decouple the loop from a hardcoded `readline` import. As more was hung off it, it turned out to bundle two genuinely different responsibilities — turn-taking I/O and logging — plus terminal cursor control that no consumer actually needed as part of a _shared_ contract; it was CLI presentation detail, not something a future web consumer would ever implement.

**Alternatives considered:** keep one `LoopTerminal` and just keep adding methods as new needs appeared. Rejected — every concrete implementation and every test fake was already only using part of it, the classic sign an interface has stopped tracking one responsibility.

**Consequences:** `ConversationLoop`'s dependencies are two minimal, independently fakeable ports instead of one broad one; the spinner/cursor logic in `scripts/cli.ts` doesn't need an abstraction at all, since it has exactly one implementation and one caller. Also fixed in this same pass: `ConversationLoop.cancel()` now distinguishes "abort the in-flight turn" from "exit the idle loop" (verified by dedicated tests), and the package's public entry point exports `RecoverableError` and `AgentResponse` alongside what was already exported — both are required by `Agent`'s own documented contract, so a consumer implementing a custom engine could not previously comply with it.

**Lesson:** an interface that started minimal can still accumulate more than one responsibility as consumers add methods to it one at a time — the useful check isn't "does everything still compile," it's "does every implementation and every consumer actually use all of it," and splitting along the boundary consumers already respect is cheaper the earlier it happens.

---

## ConversationLoop is a consumption pattern, not the harness seam — planned split into a separate CLI workspace project

tags: #mikode-harness #architecture #scope-discipline

status: implemented

partially superseded by: "The harness logs the failures it absorbs and throws the rest" (below) — `ClaudeAgent` now takes an `ILogger`, because it now has failures to report, and `ILogger` no longer has `log`.

**Decision:** `ConversationLoop` and its `IPromptEmitter` port moved out of the harness package entirely, into `cli/`, a standalone workspace project (a pnpm workspace member — first use of workspaces in this repo — with its own `package.json`/`tsconfig`). `ILogger` stayed in the harness core, at `src/shared/domain/logger.ts` (not nested under the now-departed `conversationLoop` module). `CodexAgent` alone gained `ILogger` as a constructor dependency, removing the one stray `console.warn` in `codexAgent.ts`'s handling of an unrecognized SDK item type. That case is a genuine warning, not an error or routine log line, so `ILogger` gained a third method, `warn`, rather than force-fitting the call into `error` — a real, demonstrated severity distinction, unlike adding a method speculatively. `ClaudeAgent` was deliberately left unchanged: it has no current logging need, and adding an unused dependency "for symmetry" would be exactly the speculative flexibility this log's own principles argue against elsewhere; it can gain `ILogger` the moment it actually needs to log something. `IConversationLoop` (the interface, not the class) was dropped rather than moved — with `ConversationLoop` no longer part of a publicly embeddable package, nothing actually depended on the abstract type (unlike `IPromptEmitter`, which real tests fake against).

**Context:** came up while asking whether `IPromptEmitter` belongs to the harness or to the CLI, using a hypothetical REST/WebSocket consumer to pressure-test it. A REST consumer would never implement `IPromptEmitter` — it would call `Agent.run()` directly per request and would never want `ConversationLoop`'s blocking "wait for the next turn" loop at all. That's the signal that the loop itself, not just its I/O port, encodes one specific interactive consumption pattern of the real minimal seam (`Agent`, see the first entry in this log) rather than being part of the seam itself. `ILogger` is different: `CodexAgent`'s existing `console.warn` fallback is core infrastructure already coupled to a logging destination, independent of which consumer's I/O model is in use.

**Alternatives considered:** keep `ConversationLoop`/`IPromptEmitter` in `src/`, since a real second interactive consumer (a WebSocket server) is a stated goal from an earlier entry in this log. Rejected as the deciding factor — "a plausible future second consumer" is the right test for whether to _introduce_ a new abstraction, but the wrong test for whether an _already-written_ piece of code is misplaced today; that's answered by asking what capability the code represents (talking to/orchestrating agents) versus what consumption pattern it encodes (a blocking, turn-based loop), regardless of who might reuse it later. No ADR was raised for the workspace split — it affects only this repo; the engineering repo's own rule reserves ADRs for decisions affecting more than one MiKode project, revisit only if the same split needs replicating elsewhere.

**Consequences:** the harness package's public surface shrinks to `Agent` and its implementations, `ILogger`, and the shared error types — genuinely consumer-agnostic; `cli/` now owns `ConversationLoop`, `IPromptEmitter`, the `Logger`/`PromptEmitter` adapters, and their tests. `cli/cli.ts` reaches the harness via a relative import (`../src/index.ts`), the same path it always used, not via `@mikode13/harness` as an installed dependency — the pragmatic choice, since importing the published package name would resolve through `dist/` and require building the harness before every CLI run, breaking today's zero-build dev loop; this also means `cli/package.json` has no formal dependency on the harness, since nothing in it is actually resolved through package resolution. Switching to a real package import (with the build-step cost) remains available later if simulating an external consumer exactly matters more than that workflow. Root `package.json` scripts (`typecheck`, `test`, `lint`, `format:check`) now cover `cli/` too, closing a gap this move surfaced: `scripts/cli.ts` had never actually been part of any tsconfig's `include`, so it was never typechecked at all before this. `eslint`'s shared config still has no `no-console` rule, so a future stray `console.*` in `src/` wouldn't be caught automatically — not fixed here, noted as a follow-up. Fixed as a directly adjacent, trivial issue found while verifying packaging: `dist/` had accumulated stale output from earlier layouts (`dist/src/models/`, `loopImpl.js`, `terminal.js` — files with no current source), because `tsc` never deletes output it no longer generates; `build` now runs `rm -rf dist` first.

**Lesson:** "does a second implementation already exist" guards against premature abstraction, but it doesn't tell you whether code already in the core is actually core — that's a question about which capability the code represents, not about who else might reuse it.

---

## `build`'s dist cleanup is not cross-platform — left as known debt, candidate for a cross-project ADR

tags: #mikode-harness #tooling #technical-debt

**Decision:** `package.json`'s `build` script now runs `rm -rf dist && tsc -p tsconfig.build.json`. `rm -rf` is a Unix shell command; it fails on native Windows `cmd.exe` (works under Git Bash, WSL, or PowerShell with an alias, but that's not what `npm`/`pnpm` invoke by default there). Left as-is rather than fixed immediately.

**Context:** found while fixing `dist/` accumulating stale output from earlier layouts (see the entry above). The fix itself (clean before build) is right; the specific shell command isn't portable. CI only runs on `ubuntu-latest`, so nothing catches this today, and no one has asked for native Windows support on this repo.

**Alternatives considered:** fix it immediately, either with Node's own `fs.rmSync` via a `node -e` one-liner (no new dependency, less readable) or the `rimraf` package (standard, readable, one more dependency). Deferred — this isn't specific to this repo: any MiKode project with a `build` script that cleans an output directory hits the exact same choice, which makes it a candidate for a cross-project ADR (a standard way to handle cross-platform-unsafe shell commands in `package.json` scripts) rather than a one-off local fix that the next repo reinvents differently.

**Consequences:** the harness build is not verified cross-platform right now; anyone building from native Windows hits a broken `build` script. Acceptable for now given no stated Windows requirement and Ubuntu-only CI, but worth revisiting the moment either changes.

**Resolved.** The cross-project decision this entry anticipated was taken: [ADR 0016](https://github.com/Mikode13/engineering/blob/main/adr/0016-centralize-cross-platform-script-utilities.md) and the [cross-platform script utilities standard](https://github.com/Mikode13/engineering/blob/main/standards/cross-platform-script-utilities.md) established `@mikode13/cross-platform`, and `build` now runs `mikode-scripts clean dist`. The debt described above no longer exists; the entry is kept because the reasoning that deferred a local fix in favour of a cross-project one is what produced the package.

---

## Provider failures are classified at the adapter boundary, and cancellation is not

tags: #mikode-harness #error-handling #contracts

**Decision:** every call into a provider SDK — starting a turn _and_ iterating its event stream — goes through `classifyProviderFailure` (`src/shared/domain/providerFailure.ts`). Anything unclassified becomes a `RecoverableError`; an `AbortError` and an already-classified error pass through untouched.

**Context:** the `Agent` docblock has always promised that implementers only ever reject with `RecoverableError` or `UnrecoverableError`, because every consumer branches on exactly that. Neither engine honoured it. `CodexAgent.run()` awaited `thread.runStreamed()` bare, and both engines iterated their stream bare, so a dropped connection or a rejected request escaped as a raw `Error`. `RetryingAgent` then retried it blindly — an unclassified error is not `UnrecoverableError`, so it looked retryable — and on exhaustion replaced it with a generic error that named no cause at all. A promise in a docblock that nothing enforces is not a contract.

Recoverable is the default for the unclassified case because the failures that reach it are transport-shaped: a dropped connection, a rejected request, a malformed frame. Retrying is the response that helps, and `RetryingAgent` converts a persistent one into an `UnrecoverableError` on exhaustion anyway. Defaulting to unrecoverable would make every transient network blip fatal.

Cancellation is deliberately _not_ classified. An `AbortError` is not a failure of the run, and `RetryingAgent` already checked for it before either error type — wrapping it would have turned a deliberate stop into a retried error. The `Agent` docblock now says so, rather than leaving the exception implicit in the code.

**Consequences:** the classification is enforced by tests that fake a request-start rejection and a mid-stream iterator rejection for both engines, and by tests that assert cancellation and already-classified errors survive the boundary unchanged. Retry exhaustion now carries the last cause, so a run that failed three times says why. A new engine has one more obligation, documented in `AGENTS.md`: route its SDK boundaries through the same helper.

**Lesson:** a contract stated only in a docblock is a wish. This one had been written down, precisely and persuasively, while both implementations violated it.

---

## Usage accounting belongs to a `run()`, not to the orchestrator instance

tags: #mikode-harness #correctness #state

**Decision:** `OrchestratorAgent` builds a `RunTotals` accumulator inside `run()` and threads it through the planner, executor, and reviewer calls, instead of accumulating into instance fields.

**Context:** `duration`, `inputTokens`, and `outputTokens` were constructor-initialised instance state, incremented by every turn and returned on approval. Calling the same orchestrator twice returned the first run's usage added to the second's — a second call reporting three times the duration and tokens it actually used. The CLI keeps one orchestrator for a whole session, so this was every session after the first, not an edge case. Two concurrent runs would each have reported the other's usage as their own.

**Alternatives considered:** keeping the instance counters and resetting them at the top of `run()`. Rejected: it fixes the sequential case and leaves the concurrent one broken, because two overlapping runs still share one set of fields. Per-invocation state is the only version that is correct for both, and it needs no reasoning about call ordering.

**Consequences:** the orchestrator holds no mutable run state at all, which is what makes it safe to share. Session totals are deliberately not provided — no consumer has asked for them, and the right place to sum runs is the consumer that decides what a session is.

**Lesson:** "does this instance get reused?" is worth asking of any counter that lives next to a method rather than inside it. The CLI's single long-lived orchestrator turned an invisible design choice into wrong numbers on every session.

---

## The provider boundary is the SDK call, not the loop that consumes it

tags: #mikode-harness #correctness #boundaries #retry

**Decision:** `classifiedProviderStream` wraps only the SDK iterator operations; item mapping, logging, and the consumer callback run outside that provider boundary. Failures from those local or host operations are classified separately as `UnrecoverableError`. `RetryingAgent` retries a `RecoverableError` and nothing else — an unclassified failure becomes an `UnrecoverableError` without a second call.

**Context:** classifying failures at the adapter boundary (the entry above) was done with a `try/catch` around the whole `for await` loop. That is wider than the boundary it names: `describeItem`, `logger.warn`, and the consumer's callback execute inside it too, so a bug in the host was labelled a recoverable _provider_ failure. Combined with a retry loop that advanced on any non-fatal error, a callback that threw made `RetryingAgent` re-run the provider — replaying a turn whose commands and file writes had already happened. Reproduced with a throwing callback: `runStreamed` called twice before ending as exhaustion.

**Alternatives considered:** letting consumer failures propagate unchanged after narrowing the provider boundary. Rejected because a bare `CodexAgent` or `ClaudeAgent`, without `RetryingAgent`, would then violate the public `Agent` error contract. Also considered leaving `RetryingAgent` permissive and relying on adapters to classify correctly — rejected, since it is public and can wrap a consumer-provided `Agent`, so "the adapter is compliant" is an assumption it cannot make.

**Consequences:** side-effecting work is never replayed on a host failure, and the same typed contract holds whether an engine is used directly or behind `RetryingAgent`. A non-compliant custom adapter also ends a run instead of being retried three times. `classifiedProviderStream` closes the SDK iterator in a `finally`; a cleanup failure cannot replace the primary classified error. `CodexAgent`'s constructor also classifies `startThread`, as unrecoverable: a thread the SDK refused to open is rejected configuration, and constructing it again cannot fix it.

**Lesson:** a `try` block is a boundary declaration. Every statement inside it is claimed to be the thing being classified, and the loop body is usually not.

---

## The progress formatter is presentation, so it left the published core

tags: #mikode-harness #boundaries #api-surface

**Decision:** `handleEvents` moved from `src/agent/domain/agent.ts` to `cli/progressEventFormatter.ts` as `formatProgressEvent`, and is no longer exported from the package.

**Context:** it renders `ProgressEvent` into terminal-shaped strings — labels, `✔`/`X`, newline-joined lists — and its only consumer was `cli/cli.ts`. Keeping it in `agent/domain` put presentation logic in the public core of a package whose stated seam is the provider-agnostic event itself, which is the boundary the CLI split existed to draw.

**Alternatives considered:** keeping it exported as a convenience for consumers. Rejected: it encodes one renderer's choices, and a web consumer that imported it would inherit terminal formatting it has to undo. The name also promised event _handling_ while the function only formats.

**Consequences:** the published surface is `ProgressEvent` alone; consumers render it, and `cli/progressEventFormatter.ts` is a reference implementation rather than a dependency. Its tests moved to the `cli` project with it, so coverage did not change hands.

**Lesson:** "only the CLI imports it" is usually the module telling you where it belongs.

---

## The harness logs the failures it absorbs and throws the rest

tags: #mikode-harness #observability #error-handling #api-surface

partially superseded by: "`ILogger` keeps only `warn`" (below) — `ILogger` later lost `error` as well.

**Decision:** a harness component logs a failure only when it handles it and carries on — provider output it does not recognize, an attempt that a later retry recovers, a round the orchestrator discards. A failure that ends the `run()` is thrown and not logged. `ILogger` shrinks to `warn` and `error`. Every component that logs receives a `logger`; the factories default it to `Logger` in `src/shared/infrastructure/logger.ts`, which writes to stderr.

**Context:** once `ConversationLoop` left the package, nothing inside the harness observed failures any more: `run()` throws to whichever consumer called it. That separated two concerns that had looked like one. Reporting a failure to the consumer already worked, through the typed errors. What had no owner was the failure the consumer never sees: `RetryingAgent` swallowed every attempt a later one recovered, and `ClaudeAgent` dropped SDK output it did not understand without a trace. A provider that failed every first attempt looked healthy from outside.

**Alternatives considered:** a `ProgressEvent` variant for unknown provider output. Rejected: progress events are narration for the end user, while an unknown SDK item is a diagnostic for the harness maintainer, and every consumer that switches exhaustively over `ProgressEvent` would have to handle a variant that means nothing to its users — a public API cost that would outlive `1.0.0`. Also logging the errors that are thrown was rejected: the harness cannot know whether the consumer expects, retries, or logs them itself, so it would only report them twice. Sending failures to a hosted error tracker was deferred: a library runs inside the consumer's process, and shipping data elsewhere needs infrastructure, consent, and an opt-out that do not exist yet. An injected `ILogger` adapter can provide it later without a redesign.

**Consequences:** `ClaudeAgent` now takes a logger, which the "ConversationLoop is a consumption pattern" entry had deferred until it had something to log. The package is no longer free of I/O: without an injected logger it writes warnings to stderr, which keeps stdout for the consumer — the CI reviewer driven through `harness single-turn` reads its answer from stdout. `log` left `ILogger` because nothing in the harness called it; the CLI had been borrowing it for its own terminal output. Applied in both engines, `RetryingAgent`, and every round or reviewer call the orchestrator retries. Each wraps the call in `treatErrors` with `classifyHostFailure`: the logger only logs, and the caller decides how its failure is classified, so a logger that throws cannot escape the `Agent` unclassified.

**Lesson:** log what you absorb, throw what you don't. A failure that is both logged and thrown is reported twice; one that is absorbed without a log disappears.

---

## Claude SDK output is classified exhaustively, so an SDK upgrade cannot add a silent case

tags: #mikode-harness #provider-adapters #type-safety

**Decision:** `ClaudeAgent` switches over every `SDKMessage` type, every `system` subtype, and every assistant content-block type, each `switch` ending in a `default` that assigns the value to `never`. Every case is narrated, handled as a tool result, deliberately ignored, or logged. The logged cases are failures the SDK absorbed without failing the turn (`api_retry`, `model_refusal_fallback`, `model_refusal_no_fallback`, `permission_denied`, `mirror_error`) and, at runtime, anything reaching a `default`.

**Context:** `CodexAgent` already warned about an unrecognized `ThreadItem` type. `ClaudeAgent` handled three of the SDK's 39 message types and dropped the rest silently, SDK-reported failures included. Codex's check sits on the SDK's structural types, not on tool names, and so does Claude's: the tool set is open-ended (MCP servers, custom tools), and a tool without narration, such as `Read` or `Grep`, is a presentation choice rather than something unknown.

**Alternatives considered:** a `Set` of ignored types with a runtime-only warning — shorter, but a new SDK type would first surface in production logs. Warning about unnarrated tool names — rejected as noise.

**Consequences:** an `@anthropic-ai/claude-agent-sdk` upgrade that adds a message type, subtype, or block fails typechecking until someone decides what the new case means. The runtime warning still covers a bundled `claude` binary that is newer than the SDK's types. The ignore lists are long; that is the price of the compile-time signal.

**Lesson:** a `never` check turns "remember to read the changelog" into a build failure at the moment a dependency changes shape.

---

## Engines build their own SDK, and every constructor takes one options object

tags: #mikode-harness #api-surface #consistency

**Decision:** `CodexAgent` creates its `Codex` instance internally instead of receiving one, as `ClaudeAgent` already did with `query()`. `ClaudeAgent`, `CodexAgent`, `RetryingAgent`, and `OrchestratorAgent` each take a single options object, with their defaults (`autoApprove`, `reasoningEffort`, `maxAttempts`, `logger`) declared in the destructuring.

**Context:** issue #15 needs a factory that turns a provider name into an `Agent`. The engines disagreed on how they were built — positional arguments on one side, an options object with an injected SDK on the other — and the injected `Codex` made harness-cli depend on `@openai/codex-sdk` itself, leaking provider construction into consumers. One `Codex` per agent behaves the same as a shared one: the instance holds only configuration and the resolved binary path, and every `startThread()` returns an independent thread.

**Consequences:** a breaking change to every public constructor, made while the package is still `0.x`. Consumers no longer import a provider SDK to build an engine. Tests replace `Codex` through `vi.mock` instead of passing a fake instance. The engine classes later became internal, and the `logger` default moved to the factory — see "A factory is the public way to build agents" (below).

---

## A factory is the public way to build agents; engines, retry, and the orchestrator class are internal

tags: #mikode-harness #api-surface #boundaries

**Decision:** consumers build agents only through `createAgent(provider, options)` and `createOrchestrator(options)` in `src/factory/`. `ClaudeAgent`, `CodexAgent`, `RetryingAgent`, and `OrchestratorAgent` are no longer exported. `createAgent` wraps every engine in `RetryingAgent`: retry is how the harness makes an agent work, not something a consumer composes. Each engine's constructor validates the model and reasoning effort it receives against its own `as const` lists and throws `InvalidAgentConfigError` for anything its provider does not support; the factory only picks the engine and fills in defaults. The options take a union across providers (`AgentModel`, `ReasoningEffort`).

**Context:** issue #15. Every consumer that selects an agent by name — harness-cli's `single-turn --agent`, the router planned in #17 — would otherwise repeat the same name-to-engine mapping and the same retry wrapping. The two SDKs expose neither their models nor a shared effort scale: `'ultra'` exists only for Codex, and support can differ per model — `gpt-5.6-luna` is the one Codex model without `'ultra'`. So an unsupported model or effort has to be rejected at runtime whatever the static types say.

**Alternatives considered:** validating in the factory — rejected, because what a provider supports is knowledge its engine owns, and a second list in the factory would drift from it. Options discriminated by provider, which catch a mismatch at compile time — not adopted: runtime validation is needed anyway for untyped input such as a CLI flag, and a single union keeps the options simple. Keeping the engine classes exported — rejected: after `1.0.0`, their constructors and the retry composition could no longer change.

**Consequences:** a breaking change to the public API, made before `1.0.0`. Defaults — the model per provider and the stderr `Logger` — live in the factory, so `RetryingAgent` and `OrchestratorAgent` now require a logger and no longer import infrastructure from the domain layer. A new model is added to its engine's list; a new engine is registered in the factory. Consumers narrow provider names from untyped input with `isAgentProvider`; an unknown one that still reaches a factory throws `InvalidAgentConfigError`. `OrchestratorAgent` became internal along with the rest, since `createOrchestrator` covers its only current use; exporting it again is possible if a consumer needs a composition the presets do not offer.

---

## The harness owns the orchestrator's composition, with a manual provider flag

tags: #mikode-harness #orchestration #scope

**Decision:** `createOrchestrator` decides which provider, model, and reasoning effort play each role. By default Codex plans (`gpt-5.6-sol`, `high`) and executes (`gpt-5.6-luna`, `xhigh`), and Claude reviews (`opus`, `high`). `provider: 'claude'` or `provider: 'codex'` runs every role on one provider, keeping a stronger model for planning and reviewing and pairing a cheaper model with a higher effort for executing.

**Context:** issue #15 had left this composition to the consumer. More than one consumer needs the same one — the CLI, and the router planned in #17 — and the practical reason to change it is running out of quota on one provider. Which model suits which role is knowledge about providers, which the harness already owns.

**Alternatives considered:** leaving the composition to the consumer, as #15 proposed — rejected for the duplication above, knowingly reversing that issue's ownership table. Switching providers automatically when one reports a rate limit — deferred: a flag covers the need, and automatic fallback is a resilience feature with its own failure policy to design.

**Consequences:** the "which agent plays planner, executor, and reviewer" row of #15's ownership table no longer holds. The provider is fixed per orchestrator, not chosen per request.

---

## `ProgressEvent` can gain new types in a minor release

tags: #mikode-harness #api-surface #versioning

**Decision:** after `1.0.0`, a new `ProgressEvent` type ships as a minor release. Removing a type or changing an existing type's fields stays a breaking change. `ProgressEvent`'s own documentation tells consumers to render the types they know and ignore the rest, and `cli/progressEventFormatter.ts`, the reference renderer, does that with a `default` branch.

**Context:** issue #16. `ProgressEvent` is a closed union, and harness-cli's formatter switches over it exhaustively, so any new type fails that consumer's compilation. Dynamic routing (#17) will want to narrate its decision, and #16 already plans #17 as a minor release.

**Alternatives considered:** a closed union where every new type is a major release — rejected: narration would wait for major versions, and the first routing event would force `2.0.0`. A generic variant such as `{ type: 'custom'; name: string; data: unknown }` — rejected: it never breaks anyone, but every future event would lose its type, and each consumer would parse `data` by hand.

**Consequences:** a consumer that keeps a `never` check over `ProgressEvent` gets a compile error on a minor upgrade; that is the documented cost of opting into exhaustiveness. A new type must never carry information a consumer needs to be correct: the result of a run travels in `AgentResponse`, and progress stays optional narration. harness-cli has to add a fallback branch to its formatter.

---

## `ILogger` keeps only `warn`

tags: #mikode-harness #api-surface #observability

**Decision:** `ILogger.error` is removed before `1.0.0`, leaving `warn` as the port's only method. The CLI prints its own failures through `IOutput.printError`, and `ConversationLoop` no longer takes a logger.

**Context:** issue #16, and the reasoning that already removed `log` (see "The harness logs the failures it absorbs and throws the rest"): nothing in `src/` calls `error`, because a failure that ends a run is thrown, not logged. Only the CLI called it, for its own terminal output. After `1.0.0`, removing a method that consumers may call through the exported type is a breaking change, so the decision could not wait.

**Consequences:** a consumer's logger implements a single method. `cli/adapters/logger.ts` is gone, and the CLI uses the factories' default stderr `Logger`. harness-cli has to stop calling `error` through the harness's `ILogger` type.

---

## Stable publication starts at `1.0.0`

tags: #mikode-harness #release #versioning

**Decision:** `@mikode13/harness` is published through the automated path of the [automated npm publication standard](https://github.com/Mikode13/engineering/blob/main/standards/automated-npm-publication.md). `.github/workflows/release.yml` calls `Mikode13/.github`'s reusable release workflow, pinned to `b9403230`, the same revision `@mikode13/tsconfig`'s release caller pins. The source version stays at `0.0.0-development`, and the manually published `0.1.0` is reconciled with a `v0.1.0` tag on `d6771de`.

**Context:** issue #16. npm held `0.1.0` without a `gitHead`, and the repository had no tags. Packing a clean build of `d6771de`, committed four minutes before that publication, reproduces the published tarball byte for byte; the next commit came a day later.

**Consequences:** each pull request's title sets the next version: `fix` is a patch, `feat` a minor, and a breaking marker a major. The stability pull request carries one, so semantic-release advances from `v0.1.0` to `1.0.0`. Everything `src/index.ts` exports is now a public contract. Additions can wait for a consumer: a model narrower such as `isAgentModel` was deferred, because adding it later is a minor release, while removing `ILogger.error` could not wait.

---

## Read the provider APIs through runnable examples before designing the model types

tags: #mikode-harness #api-design #learning

**Decision:** before writing any `src/llm/` type, write reference scripts against the two low-level APIs the adapters will use, one for the OpenAI Responses API and one for the Anthropic Messages API. Each runs a stateless two-turn exchange, one tool round trip, a cancellation and an error chain. A third file sets their request and response shapes side by side, as type aliases re-exported from the SDKs, so the compiler breaks when an SDK changes them. The scripts are a working tool for designing the types and writing the adapters, not part of the harness: they live in a git-ignored `examples/` folder.

**Context:** issue #23 replaces the agent SDKs (Codex's `Thread`, Claude's session) with MiKode-owned calls to the model APIs. The `Agent` seam had been designed against two real engines, and the new `LLMClient` needed the same footing. Without the real shapes, the first questions had no answer: what goes into a call, what an answer is made of, and what "stopped" means.

**Consequences:** several design facts came from the examples, not from guesses:

- **History.** OpenAI's is a flat list of items; Anthropic's alternates messages made of content blocks.
- **Tool arguments.** OpenAI's are a JSON string; Anthropic's arrive already parsed.
- **Usage.** Cached tokens are inside OpenAI's `input_tokens` and outside Anthropic's.
- **Private reasoning.** Both providers return reasoning that can be replayed but not read.
- **Cancellation.** Both SDKs raise `APIUserAbortError` on cancellation, whose `name` is `"Error"`, not `"AbortError"`. `isAbortError` does not recognise it, so an adapter that let it through would turn a cancelled run into a retried one. Each adapter must rethrow the signal's own reason when it is aborted.

`openai` and `@anthropic-ai/sdk` are development dependencies until an adapter imports them, so consumers do not install SDKs the published code never loads.

**Lesson:** design an abstraction over two concrete things by looking at both, side by side, in code that compiles against them. A type alias re-exported from an SDK keeps that reference honest; a hand-copied shape goes stale silently.

---

## The model boundary is stateless; the agent owns the conversation

tags: #mikode-harness #agent-loops #api-design

**Decision:** `LLMClient` has one method, `send(context, signal)`, and keeps nothing between calls. It receives every message it needs each time and returns `{ message, usage, stopReason }`. The model and the system prompt are fixed when a client is built, not passed per call. `LLMAgent` owns a `Conversation` and is the only piece that knows both it and the client. Implementations are named after what distinguishes them — `FakeLLMClient`, and later `OpenAILLMClient` and `ClaudeLLMClient` — rather than `LLMClientImpl`, because there will be several.

**Context:** issue #23. Codex's `Thread` and Claude's `sessionId` were the only memory of a conversation, so it could not be persisted (#29), handed to another provider, or shaped by MiKode. The first draft let the agent push onto a raw `history` array that it then passed to the client. That looked like the agent doing the client's job, and the first instinct was to move the history into the client. What settled it was asking whether the client needs the state to do its job. It does not: both provider APIs accept the full context on every call.

**Alternatives considered:**

- **The client owns the context and appends to it, like a chat session.** Rejected: that recreates the provider session inside MiKode. It also breaks as soon as tools arrive, because between two calls only the agent can decide which tool runs and what its result is.
- **A callback on the client that streams events.** Rejected: mapping the answer to `ProgressEvent` is the agent's job.
- **A read/write permission flag on the model, for agents such as the reviewer that must not touch code.** Rejected: what an agent may do is the set of tools it is given (#25), not a property of the model.

**Consequences:** the loop that turns a stateless model into an agent lives in `LLMAgent`, where the tool loop (slice 4) and compaction will go. `Conversation` is a class, not an interface: it is a domain object with one implementation and no infrastructure to swap, and tests use the real one. `LLMAgent` has no provider adapter and is not registered in the factory yet.

**Lesson:** the component that consumes some state is not necessarily its owner, just as an HTTP client reads a request body without owning it. Keep the component that calls the network a function of its inputs, and give the state to whoever makes decisions between calls.

---

## Context, conversation and workflow artifacts are three different things

tags: #mikode-harness #agent-loops #multi-agent

**Decision:** three concepts, three owners:

- **The context** is what one call sends, built fresh for that call.
- **The conversation** is everything one agent remembers across its runs. `Conversation` owns it and derives the context with `getContext()`.
- **Workflow artifacts** — the plan, the executor's result, the verdict — cross from one role to the next as prompts. The orchestrator owns them.

`Message` belongs to `src/llm/`. `Conversation` and `LLMClient` both depend on it, and neither knows the other.

**Context:** the question was whether the planner's history should reach the executor, and the executor's the reviewer. It should not. A role that received another agent's conversation would inherit its reasoning, its abandoned attempts and its system prompt. Encrypted reasoning items are also useless to a different provider. The orchestrator already passes each role's result as the next role's prompt; that is the right channel. A separate confusion came from a type named `ConversationMessage`: it made the client look as if it knew about the conversation, when it only knew the message type.

**Alternatives considered:** one conversation shared by every role — rejected for the reasons above. An `info` role in the history for harness notes — rejected: the provider APIs know only user and assistant turns, and a harness note that the model must see is a user message.

**Consequences:** today the context equals the conversation, which is why the two looked like one thing. They diverge with compaction. When `MaxContextError` is handled, the conversation will keep every message plus compaction marks (`{ upTo, summary }`), and `getContext()` will return the latest summary as a user message followed by the messages after it. A compaction cut must not separate a tool call from its result, or both APIs reject the context. Neither the agent nor the client changes when that lands.

**Lesson:** a type two objects share is not a dependency between them — name a type for what it is, not for who uses it. And keep "what this call sends" apart from "what this agent remembers" even while they are equal: the moment they diverge is the moment the design is tested.

---

## A message is a role and a list of parts, and the whole context is sent on every call

tags: #mikode-harness #api-design #data-modelling

**Decision:** `Message` is `{ role: 'user' | 'assistant', content: MessagePart[] }`, and `MessagePart` is a discriminated union, `text` or `reasoning` today. The response's message is typed `Message & { role: 'assistant' }`, so the compiler checks the role instead of a comment. Every call sends the whole context, and `Conversation` stores it as a plain array.

**Context:** a user prompt is always one text part today, which made the array look like overhead. It is not. An assistant turn routinely holds several parts: reasoning, then text, then two parallel tool calls. Tool results arrive as parts of a user message in Anthropic's API, one per parallel call. Resending everything looked expensive and hard to maintain. Two things answer that. Both providers cache the unchanged prefix of the context, billed as `readCacheTokens`. And compaction bounds the size once it no longer fits.

**Alternatives considered:**

- **A single string as the user's content.** Rejected: the type would change when tools arrive.
- **A linked list or a queue for the conversation, since it only grows at the end.** Rejected. `push` on an array is already O(1) amortised. Every call serialises the whole context to JSON anyway, which is O(n) whatever the structure. A linked list is slower to walk and cannot be serialised for persistence. The cost of a call is tokens and network time, not the data structure.
- **Letting the provider keep the history (`previous_response_id`).** Rejected: that is the provider session #23 moves away from.

**Consequences:** slice 4 adds tool-call and tool-result parts to the union without changing `Message`. The conversation is append-only, so nothing in it is ever edited.

**Lesson:** model the data for the second case you already know is coming, when the cost is one pair of brackets. Before optimising a data structure, find where the time actually goes.

---

## Record an exchange only after the call completed, and keep copies at the boundary

tags: #mikode-harness #agent-loops #failure-handling

**Decision:** `LLMAgent` sends the stored context plus the new prompt without touching the conversation. Only after a completed answer does it call `Conversation.addExchange(prompt, answer)`, which stores both together. `Conversation` deep-copies every message it takes in and every context it hands out. The agent sends the prompt as a copy, so the prompt it records is the one it built.

**Context:** the first version appended the prompt before calling the model. When `send` fails with a `RecoverableError`, `RetryingAgent` runs the same prompt again, so the conversation would hold it twice. The same happened after a refusal, a truncation or a cancellation. A review of PR #38 then found that `getContext()` copied only the array: a client that edited the messages it was sent would silently rewrite the stored history. A test with such a client also found that the prompt reached the client as the same object the agent recorded afterwards.

**Consequences:** a failed call leaves no trace in the conversation, which is what makes `RetryingAgent` safe around `LLMAgent`. For the same reason `createLLMAgent` retries with the original prompt alone (`noteFailures: false`): the note `RetryingAgent` adds for provider sessions would be recorded as the user's message and resent on every later turn, about a failure the model never saw. Copies cost microseconds per call, against a model call measured in seconds. `FakeLLMClient` also records copies, so a test cannot be fooled by later mutation.

**Lesson:** commit state after the operation succeeds, not before: a retry decorator turns every half-recorded failure into a duplicate. A shallow copy protects nothing when the elements are mutable objects.

---

## Stop reasons belong to the model; what they mean for the run belongs to the agent

tags: #mikode-harness #failure-handling #api-design

**Decision:** `StopReason` is `'completed' | 'truncated' | 'refused'`. `truncated` means the output limit only. The client reports why the model stopped, and the agent decides what that means: today both `truncated` and `refused` end the run with an `UnrecoverableError` whose cause names the reason. A context that no longer fits is not a stop reason but a domain error, `MaxContextError`, which extends `UnrecoverableError` so the classifiers keep it as it is. The agent will catch it to compact. Callback failures are classified with `classifyHostFailure`, because the model has already answered and a replay could repeat side effects.

**Context:** the first list had five outcomes: completed, truncated, refused, unrecoverable error and aborted. An error and a cancellation are not ways a model stops. They already have their channels, a rejected promise and an `AbortError`, so they left the type. A context overflow looked like a truncation at first. It is a different problem with a different fix: truncation needs more output room, overflow needs a shorter context.

**Consequences:** the adapters inherit these rules. Quota exhaustion (OpenAI's `insufficient_quota`) will be an `UnrecoverableError`, because retrying cannot add credit; a 429 rate limit stays recoverable. `MaxContextError` is defined but not thrown yet. Each adapter must also rethrow the signal's reason on cancellation, as the examples showed.

**Lesson:** let the layer that observes something report it, and the layer that has the context decide what it means. A result type that mixes outcomes with failures makes every caller handle both twice.

---

## Turn boundaries belong to the consumer, and the model does not stream yet

tags: #mikode-harness #progress-events #agent-loops

**Decision:** `LLMAgent` emits no `turnStarted` or `turnEnded`. It narrates each part of the answer as `reasoning` or `agentMessage`, and answers with the text parts alone. `LLMClient.send` returns the whole answer at once; there is no streaming method.

**Context:** the agent first emitted turn events around its call. Codex and Claude never did: `ConversationLoop` emits them around `run()`, and the CLI starts and stops its spinner on them. An agent emitting its own would stop the spinner halfway through an orchestrator run, once per role. Without streaming, a run makes one call and narrates everything when the answer arrives, which felt like the synchronous design #23 was meant to leave. It is only synchronous because there are no tools yet.

**Consequences:** with tools, a run becomes a loop of calls with tool execution in between, and the callback narrates each step as it happens. The CLI shows a spinner and then the message, which is all it needs today. A `stream()` method can be added when a consumer needs text as it is generated.

**Lesson:** before adding an event, check who already emits it. A progress channel shared by nested agents needs one owner for each boundary.

---

## `Tokens` counts usage by billing category; pricing is out of scope

tags: #mikode-harness #api-surface #observability

**Decision:** `AgentResponse` carries `tokens: Tokens` instead of `inputTokens` and `outputTokens`. `Tokens` has four fields that never overlap: `inputTokens`, `readCacheTokens`, `writtenCacheTokens` and `outputTokens`. `inputTokens` counts prompt tokens neither read from nor written to the cache. `Tokens` lives in `src/shared/` because the agent and the model boundary speak it alike, and it is exported. They are counts, not a cost: the harness does not promise that a run can be priced from them.

**Context:** the old pair was never defined precisely, and cached input is billed separately from fresh input. The fields are defined by billing category rather than by where the tokens come from. The same `AGENTS.md` or skill text is written to the cache on one call and read from it on the next. Providers also disagree on their own counter: Claude's `input_tokens` excludes the cache counters, while Codex's already contains `cached_input_tokens` and `cache_write_input_tokens`. Copying each as-is would have counted Codex's cached tokens twice.

**Alternatives considered:** a pricing guarantee, which the first version of this entry promised. A review of PR #38 showed why it could not hold:

- **Mixed cache lifetimes.** Anthropic bills 5-minute and 1-hour cache writes at different rates, and both can appear in one response.
- **Mixed models.** The default orchestrator mixes `gpt-5.6-sol`, `gpt-5.6-luna` and `opus`, and summing their counts loses which model spent what.

Keeping the promise would mean per-model usage records, split cache lifetimes, and price tables kept current against every provider. That is worth doing only once there is somewhere to store and use the data. It was dropped rather than half-built.

**Consequences:** a breaking change to `AgentResponse`, so it ships with a breaking marker. `CodexAgent` subtracts both cache counters from `input_tokens`, `OrchestratorAgent` sums all four per run, and the CLI prints all four. Every future adapter converts to the same meaning, including the OpenAI Responses API, which also reports cached tokens inside `input_tokens`.

**Lesson:** when two providers use the same field name, check that they mean the same thing before mapping them. And document what a contract guarantees, not what it might enable: an unkept promise in a public type is a bug report waiting to happen.

---

## The OpenAI client replays text only, and classifies OpenAI's failures itself

tags: #mikode-harness #provider-integration #error-handling

**Decision:** `OpenAILLMClient` sends each message as its text parts joined into one string and leaves reasoning parts out of the request. It asks for reasoning summaries and turns them into `reasoning` parts, but does not request `encrypted_content`. Before the shared classifier sees a failure, it maps OpenAI's own: `context_length_exceeded` becomes `MaxContextError`, and an exhausted quota or spend limit (`insufficient_quota`, `credit_balance_exhausted`, `project_spend_limit_exceeded`) or a 400, 401, 403, 404 or 422 becomes `UnrecoverableError`. A rate limit, a 5xx or a network failure stays recoverable. A response that comes back `failed` is classified by its own code the same way: `server_error` and `rate_limit_exceeded` are recoverable, anything else is not.

**Context:** with `store: false`, OpenAI can replay reasoning only from the encrypted item it returned, and a `Message` has nowhere to keep it. A summary sent back as text would be a different input, not the model's reasoning. `classifyProviderFailure` treats any unclassified failure as recoverable, so without the adapter's mapping a wrong API key or an exhausted quota would be retried to exhaustion. The SDK's abort error is named `Error`, so the client rethrows the signal's reason instead.

**Alternatives considered:** keeping `encrypted_content` in the message — deferred to the provider-state slice of #23, since done in "Both clients offer tools in strict mode, and each replays only its own reasoning", which must decide where state one provider can read and another cannot lives. Making `Message` a class that renders itself for a provider — rejected: the domain would learn every provider's format, and `structuredClone`, which the conversation relies on, drops a class's prototype.

A response without usage is reported as missing, not as zero: zeros would present a call that may have been billed as free. See "Every token a run spends travels with its end" for what the agent does with it.

**Consequences:** a reasoning model starts each turn without its earlier reasoning, which costs some quality on multi-turn work until provider state exists. Unknown output items are logged and left out, which is correct while no tools are sent. `openai` moves to `dependencies`.

---

## The Claude client follows the OpenAI client's rules, and the model contract held

tags: #mikode-harness #provider-integration #error-handling #agent-loops

partially superseded by: "Providers are named after the company, and both paths share their names" (below) — the provider is now `'anthropic'`, and the client takes the Agent SDK's aliases.

**Decision:** `ClaudeLLMClient` is the second `LLMClient`, on the Anthropic Messages API, and `createLLMAgent` takes a provider, `'claude'` or `'openai'`, like `createAgent`. It follows the rules the OpenAI client set:

- **Text only is replayed.** Summarized thinking becomes a `reasoning` part and never goes back; redacted thinking is dropped silently. The system prompt goes in the API's `system` field.
- **Its own model list.** It accepts the Messages API's model IDs (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5`), not the Agent SDK's aliases such as `opus`, which the API answers with a 404. The list lives in the client, so `src/llm` does not depend on the engine it is meant to replace.
- **Stop reasons.** `end_turn` is `completed`, `max_tokens` is `truncated` and `refusal` is `refused`. `model_context_window_exceeded` becomes `MaxContextError`, because the agent must compact. `tool_use`, `pause_turn` and `stop_sequence` need tools, server tools or stop sequences that the client never sends, so they are an `UnrecoverableError` carrying the call's tokens. `tool_use` became `completed` once the client offered tools; see "Both clients offer tools in strict mode, and each replays only its own reasoning".
- **Usage.** Anthropic counts cache reads and writes apart from `input_tokens`, the reverse of OpenAI, so the fields map one to one. A missing cache count is zero, and zero output is still a reported count.
- **Failures.** A 400 whose message says the prompt is too long becomes `MaxContextError`, because Anthropic gives it no code of its own. A `billing_error`, `authentication_error` or `permission_error`, or a 400, 401, 403, 404, 413 or 422, is an `UnrecoverableError`. A rate limit, an overload (529), a 5xx or a network failure stays recoverable.
- **Prompt caching is requested.** Anthropic caches only when asked, unlike OpenAI, so every call sets a top-level `cache_control`, which marks the last block. The next call reads everything before it from the cache: in a real two-call test the second call read 10,425 tokens from the cache and paid for 2 uncached. Without it, a conversation resent in full would bill every earlier turn again at the full input rate.
- **Failures raised before sending are unrecoverable.** The SDK resolves credentials lazily, so a missing `ANTHROPIC_API_KEY` does not fail `new Anthropic()`, as a missing OpenAI key does, but the first call, with a plain `Error`. That error, and any `AnthropicError` that is not an `APIError`, becomes an `UnrecoverableError` instead of being retried.
- **A fixed `max_tokens` of 16,000.** The API requires it and adaptive thinking spends from it. Above roughly 21,000 the SDK refuses a request that is not streamed.

**Context:** a second provider was the test of whether `LLMClient`, `Message`, `StopReason` and `Tokens` were shaped after OpenAI. None of them changed: every Anthropic difference — the separate system prompt, the stop reasons, the cache accounting — fitted inside the adapter. Not replaying thinking is safe for the same reason as on OpenAI: Anthropic documents earlier thinking blocks as needed only to continue a turn that called a tool, and no tools are sent yet. A later call against the real API showed that even such a turn is accepted without them; see "The agent runs a tool call; the model only asks for it". A two-turn call against the real API kept the conversation across turns, and a harder prompt returned its thinking as a `reasoning` part. With two clients, a conversation started on one provider now continues on the other in either direction, carrying its text and leaving each provider's reasoning behind; an offline test covers both directions, and a Claude-to-OpenAI run against the real APIs answered from the handed-over messages alone.

**Alternatives considered:** reusing `claudeModels` from the Agent SDK engine and translating aliases to IDs — rejected: it couples the new path to the engine it replaces, and an alias names a different model whenever Anthropic moves it. `max_tokens` as a constructor option — deferred until a caller needs to vary it. Treating a rate limit as unrecoverable — rejected: a 429 is transient, and on Anthropic an empty balance arrives as `billing_error`, not as a rate limit.

**Consequences:** a cache write costs more than plain input, so a conversation of a single call pays a little extra for a cache it never reads; a prefix below the model's minimum is not cached and costs nothing extra. `createLLMAgent('claude')` builds without credentials, and the first run reports them missing. `@anthropic-ai/sdk` moves from `devDependencies` to `dependencies`, because the published package now imports it. Replaying thinking blocks with their `signature` within a tool-using turn is part of the provider-state slice of #23, since done in "Both clients offer tools in strict mode, and each replays only its own reasoning". `createLLMAgent` changes signature, which is internal and not exported.

---

## Every token a run spends travels with its end

tags: #mikode-harness #api-surface #observability #error-handling

**Decision:** `Agent.run` resolves to an `AgentResponse` or rejects; it no longer resolves to `undefined`. A run that produced no text answers `{ response: '', tokens }`. `RecoverableError` and `UnrecoverableError` gain an optional `tokens`: what the run spent before it failed. Each engine attaches the usage it knows to its failures, `RetryingAgent` adds its failed attempts to the response or error that ends the run, and `OrchestratorAgent` adds every earlier role to any error that leaves the run. `AgentResponse.tokens` becomes optional: missing means some call in the run completed without reporting usage, which is not the same as zero. On a failure, `tokens` alone cannot tell a call the provider answered without usage from one that never got an answer, so the errors also carry `usageUnreported`. The engine sets it when it received an answer without usage, such as a failed OpenAI response without usage or a Codex turn that failed after producing items. Any total that includes it becomes unknown, while a dropped connection still adds nothing and the tokens around it keep counting. `duration` is the wall clock of whichever layer returns it: every engine measures from the start of `run()`, and `RetryingAgent` and `OrchestratorAgent` measure their own run instead of passing on the last attempt or summing roles.

**Context:** measuring what the direct API path would cost exposed that tokens only travelled when a run ended in an `AgentResponse`. A `truncated` or `refused` LLM answer, the failed attempts before a successful retry, a Codex turn that only edited files, and every role of an orchestrator run that failed after three rounds were billed and reported nowhere. `undefined` could not carry anything, and it meant two different things: no text, and no usage.

**Alternatives considered:**

- **Throwing when usage is missing.** A Codex executor turn that already edited files would be retried only because its accounting was missing, so the work is kept and the tokens are marked unknown instead.
- **A usage `ProgressEvent`.** Consumers may ignore event types they do not know, and an accurate total is information a consumer needs to be correct.
- **Treating every failure without tokens as unknown.** It would be honest without a new field, but a single dropped connection or rate limit before a successful retry would erase an otherwise complete count. Only the engine knows whether the provider answered, so it marks that case instead.
- **A partial total with an `incomplete` flag.** It keeps the known counts, but adds a field to a public type for what is, in practice, a provider bug. A total that is either complete or missing is simpler, and the warning logged where the usage went missing says which call it was.
- **Keeping `undefined` and adding tokens to errors only.** Cheaper, but a run without text would still lose its usage. The break costs nothing extra: the integration branch already reaches `main` with a breaking change.

**Consequences:** a breaking change to the `Agent` contract and to `AgentResponse`. Consumers test `response` for emptiness instead of the result for `undefined`, and read `error.tokens` to account for a failed run. `ClaudeAgent` no longer takes `duration` from the SDK's `duration_ms`, so the three engines measure the same thing, including process start-up. A cancelled run still loses its tokens, because an `AbortError` must propagate unchanged.

**Lesson:** a result type that can be absent can carry nothing. When every outcome of a call costs money, every outcome has to be able to report it.

---

## The provider SDKs keep their transport retries under `RetryingAgent`

tags: #mikode-harness #provider-integration #error-handling

**Decision:** `OpenAILLMClient` and `ClaudeLLMClient` build their SDK clients with the default retry policy, and `createLLMAgent` still wraps the agent in `RetryingAgent`. Each layer does a different job:

- **The SDK** retries transport failures: dropped connections, 429s and 5xx responses. It backs off exponentially and honours `Retry-After`.
- **`RetryingAgent`** retries what the SDK cannot see: an OpenAI response that arrives as HTTP 200 with `status: 'failed'` and a transient code, and any other failure the client classified as recoverable.

**Context:** an AI review of #36 pointed out that the two layers stack. A persistent transient failure can make up to nine requests: three agent attempts, each with the SDK's own retries. The retries the SDK absorbs are not logged, contrary to "log what you absorb". The SDK logs them at `info`, the same level it uses for every successful response, so they could only be picked out by matching the message text.

**Alternatives considered:** turning the SDK's retries off (`maxRetries: 0`), so `RetryingAgent` owns every retry and logs it. Rejected for now: `RetryingAgent` retries immediately, without backoff or `Retry-After`, so a rate limit would use up its three attempts at once and end the run as `UnrecoverableError`.

**Consequences:** a stateless call has no side effects and a failed HTTP request is not billed, so nine requests cost time but no tokens. The Anthropic SDK retries the same way, two retries with backoff and `Retry-After` by default, so `ClaudeLLMClient` stacks exactly as the OpenAI client does. The SDK's retries stay invisible to the logger. The follow-up is to give `RetryingAgent` a backoff that honours a provider's retry hint, and then turn the SDK's retries off so one layer owns and logs them all.

---

## `#src/*` is a Node subpath import, not a `tsconfig` path alias

tags: #mikode-harness #typescript #build #module-resolution

**Decision:** imports inside the package can use `#src/*` instead of deep relative paths. It is declared in the `imports` field of `package.json`, written without an extension, and resolved by condition: `mikode-harness-source` points it at `src/*.ts`, and the default points it at `dist/*.js`. Every `tsconfig` sets that condition in `customConditions`, `pnpm run dev` passes it to Node, and Vitest mirrors it with a resolve alias.

**Context:** `@` aliases such as `@/` are `tsconfig` `paths` or bundler aliases. `tsc` does not rewrite them when it emits, so a library built with `tsc` would publish `dist/` files importing paths Node cannot resolve. Node reserves `#` for package-internal specifiers precisely so they cannot collide with package names, including scoped ones like `@mikode13/harness`. A packed tarball was imported from outside the repository to verify both the runtime and the published declaration files.

**Consequences:** running source with plain `node` silently falls back to `dist/` and can load a stale build, so any new entry point that executes `src/` directly must pass the condition. The condition name is private on purpose: a shared name such as `development` is enabled by Vite and other tools in consumer projects, which would resolve to `.ts` files the tarball does not contain. Imports that cross a module boundary were migrated in the same pull request, which changes no behaviour; imports within one module stay relative.

The published declaration files contain `#src/...` too, so TypeScript consumers need `moduleResolution` `node16`, `nodenext` or `bundler`: the legacy `node10` resolution cannot read the `imports` field, and under `skipLibCheck` the affected types silently become `any`. The review of #37 caught it with a probe the original prototype had not run. It was accepted rather than avoided: the only known consumer, `harness-cli`, uses `nodenext` through `@mikode13/tsconfig/node` like every MiKode project, and the package is opinionated about its toolchain. The README states the requirement.

**Lesson:** an import alias in a published library is part of what ships. Choose the mechanism the runtime resolves, not the one the compiler understands, and prove it from the tarball rather than from the repository.

---

## The agent runs a tool call; the model only asks for it

tags: #mikode-harness #agent-loops #tool-use #error-handling

**Decision:** `LLMAgent` runs its own tool loop. The model receives the definitions of the agent's tools and may answer with calls; the agent runs them and calls the model again with their results, until an answer calls no tool. The rules:

- **A call is a part; results travel in a `tool` message.** An answer's `toolCall` parts sit in the assistant message beside its text and reasoning. The step's results go back together as `toolResult` parts in one message with the role `tool`, never flattened into text. Each part carries a string id that pairs a result with its call.
- **The domain `Tool` knows no validation library.** A `Tool` is a name, a description, a JSON Schema as plain data, and `execute(input: unknown, signal)`. The input is unknown because the model can send anything; validating it belongs to the tool. A client receives only the `ToolDefinition`, never `execute`, so it cannot run a tool.
- **Tools belong to the agent, not to a run.** They are given to the constructor. A name used twice is an `InvalidAgentConfigError`, because the model calls tools by name and a second one could never run.
- **The model decides when the run ends.** The loop ends on an answer with no `toolCall` part. The `StopReason` still only says whether the answer is whole: Anthropic stops with `tool_use`, but OpenAI reports `completed` beside its calls, so only the content says the same thing on both.
- **Calls run one at a time, in order.**
- **A tool's failure goes back to the model.** A missing tool, a tool that throws and, through it, invalid input become a `toolResult` with `isError`, and the run continues. A cancellation escapes as it is, even when the tool turned it into another error: the signal decides, not the error. A cancelled run neither starts nor announces another call, even when the one before ignored the signal.
- **`maxSteps` counts calls to the model**, 25 by default, and must be a positive integer. A run still calling tools after the last one fails with `UnrecoverableError` carrying its tokens, without running that step's calls, whose results no call would receive.
- **A run is recorded whole, only once it succeeds.** The conversation takes the prompt, every answer and every tool result together, so a failed run leaves no tool call without its result.
- **A failure after a tool ran is not retried.** Once a call has reached an existing tool, a `RecoverableError` becomes `UnrecoverableError`, because `RetryingAgent` would run the prompt again and repeat the tool's effects. A call to a missing tool does not count: nothing ran that a retry could repeat.
- **Tokens are summed over the run's calls** with `addTokens`. One call without usage leaves the total unknown, and a failure carries what the earlier calls spent.
- **`ProgressEvent` gains `{ type: 'tool', id, name, status }`**, emitted as each call starts (`in_progress`) and as it ends (`completed` or `error`). A call is announced only when its turn comes, so a consumer never shows a call as running while another one runs, or a call the run never starts, such as those of the last step. The status is a closed union, unlike `mcpTool`'s string, so a consumer can switch on it exhaustively; a new status is therefore a breaking change. The `id` is the call's, so a consumer can pair the two events even when one step calls the same tool twice.

**Context:** under the Agent SDK engines the SDK runs the tools inside its own runtime, and the harness sees only their events. #23 moves the loop into MiKode, so the harness decides what runs, in what order, and what a failure means. The shapes were checked against both APIs with a real tool round trip before designing the types. Claude answers with thinking, text and every `tool_use` block in one assistant message and takes every `tool_result` in one user message. OpenAI returns flat output items: a `function_call` carries its arguments as a JSON string and pairs with its result by `call_id`. Both models asked for several calls in one answer. The same run corrected an assumption recorded with the Claude client: Anthropic accepted a tool turn whose earlier thinking was left out, so replaying thinking improves continuity but does not block tools.

**Alternatives considered:**

- **Results in a `user` message**, Anthropic's shape. Rejected: the conversation would no longer tell a person's prompt from a tool's output, which compaction and session persistence (#29) need to know. The Claude client can still send them as a user message.
- **A Zod schema in the domain `Tool`.** Rejected: it ties the domain to a validation library and describes the input twice. A later infrastructure helper can build a `Tool` from a Zod schema, deriving the JSON Schema and validating inside `execute`.
- **Tools per run.** Rejected: it would change the `Agent` contract, and Anthropic caches the tools before the system prompt and the messages, so tools that change between calls would invalidate the whole cached prefix.
- **Running a step's calls in parallel.** Deferred: it is faster for independent reads, but it interleaves effects and narration, and approving calls one by one (#43) needs them in order.
- **Ending the run on a missing tool or a tool failure.** Rejected: the model can correct itself from an error result, and ending the run would waste every step before it.

**Consequences:** `LLMClient.send` takes `{ context, tools }`, which is internal. Neither client offers tools yet (until "Both clients offer tools in strict mode, and each replays only its own reasoning"): both reject a request that carries any, instead of letting an agent believe the model saw them, and leave `tool` messages out of the context until they map them for their provider. `ProgressEvent` gains a type, a minor change; the CLI prints it. A run that already ran a tool is not retried even after a transient failure, but the SDKs' own transport retries still absorb those inside a call.

---

## Both clients offer tools in strict mode, and each replays only its own reasoning

tags: #mikode-harness #provider-integration #tool-use #agent-loops

**Decision:** both `LLMClient`s map the tool loop to their provider in both directions, and send back the reasoning their provider needs beside its calls. The rules:

- **Calls and results.** Claude's `tool_use` becomes a `toolCall` and a `tool` message becomes one user turn of `tool_result` blocks with `is_error`. OpenAI's `function_call` becomes a `toolCall` whose id is the `call_id`, and each result a `function_call_output` paired by it. Claude's `tool_use` stop reason is `completed`: the answer is whole, and whether to run the calls is the agent's decision.
- **Strict mode on both providers.** Every tool is offered with `strict: true`, so the model's input always parses and matches the schema. Anthropic made strict tool use generally available, so the same rule holds on both clients.
- **Arguments that do not parse reach the tool as the raw string.** Strict mode makes it rare, and a response cut mid-call already ends as `truncated`. Failing the mapping would make the run unrecoverable; the tool's rejection lets the model correct itself instead. The string goes back to OpenAI as the model wrote it. Claude, which rejects a `tool_use` whose input is not an object, receives such a call after a handoff with an empty input, beside the error result that already says it failed.
- **OpenAI's failed results are marked in their text.** `function_call_output` has no error flag and OpenAI leaves the format to the caller, so a failed result goes as its output after the prefix `The tool call failed:`, and a successful one goes as it is. Only the request carries the marker: the conversation keeps the output as the tool gave it, with `isError`, and Claude receives that flag as `is_error`.
- **Provider data is a part of its own.** A `providerData` part holds a block only its client can read back, whole: Claude's thinking with its `signature`, a `redacted_thinking` block, or OpenAI's reasoning item with its `encrypted_content`, which the client now requests through `include`. Its `source` is a plain string each client sets to its own label, and a client sends back only parts carrying its label. A `reasoning` part stays the readable summary, for narration; it is no longer what gets replayed. The agent never narrates provider data.

**Context:** OpenAI documents that reasoning items returned with tool calls must be passed back with their outputs, so shipping tools without replay would have released a loop that loses its reasoning between the steps of one run. Anthropic accepted a tool turn without its thinking, but replaying it keeps the model's continuity. A run against both real APIs confirmed the design: each provider accepted its own signed or encrypted reasoning sent back before its parallel calls, a failing tool came back as an error result both models read, a second run continued the same conversation, and each conversation, tool calls included, continued on the other provider without its reasoning. OpenAI accepted the `function_call` items without their own `id`, sent only with `call_id`.

**Alternatives considered:**

- **Sending OpenAI's results unmarked**, as first decided. Rejected in review: a failure and a success with the same output, such as `42`, reached the model identical.
- **Envelopes for OpenAI results**, such as `{"error": ...}`. Wrapping only errors is no less ambiguous than a prefix, because a tool can return that JSON as a success. Wrapping every result escapes file contents into one JSON string, which costs tokens and reads worse once repository tools return code (#25). The prefix leaves one residual ambiguity, a successful output that begins with the same words, which is far less likely.
- **Non-strict tools.** They accept any JSON Schema, but the model can then send input that does not match or does not parse. Strict mode costs a subset of JSON Schema instead; see the constraint in `architecture.md`.
- **Replaying reasoning after the release.** Rejected: the release would ship a tool loop that OpenAI documents as needing it, and the integration branch keeps the pull requests small anyway.
- **A `provider` union such as `'claude' | 'openai'`.** Rejected: the domain would grow with every provider, and no other domain type names one. The domain gives `source` no meaning.
- **An opaque field on the reasoning part.** Rejected: redacted thinking has no text, and a provider's block would be split from nothing but its summary. A part of its own keeps the whole block, in the order the provider returned it, which both APIs require before the calls.
- **Keeping the provider state in the client.** Rejected: the client is stateless, and recreating it would lose the state, which #23 forbids.

**Consequences:** the conversation stores thinking twice, as its summary and inside its block. A schema outside strict mode fails every request with a 400. Claude also allows at most 20 strict tools per request. The provider-state question #23 left open is answered: continuation state lives beside the canonical parts, as parts of its own, and is dropped when a conversation changes provider. Compaction can drop `providerData` first, since only one provider can read it.

---

## `.gitignore` is the boundary of what an agent reads, and ripgrep never receives a path from the model

tags: #mikode-harness #tool-use #security #provider-integration

**Decision:** the read-only repository tools of the first slice of #25 (`listFiles`, `searchText`, `readFile`) see only what `.gitignore` does not ignore, inside one fixed root. The rules, agreed before the implementation:

- **An ignored file does not exist for the agent.** It is not listed, searched or read, and neither is a path outside the root, even through a symlink. The three operations share that boundary behind one port, `Workspace`.
- **ripgrep first, shipped with the package; git as the fallback.** `@vscode/ripgrep` is a runtime dependency, so every install carries a pinned `rg` for its platform. git covers a platform without a published binary or an install without optional dependencies. With neither available the tool fails with an error; it never falls back to plain `grep`, which knows nothing of `.gitignore`.
- **ripgrep never receives a path or a glob the model wrote.** It always runs from the root with no path argument, and the scope the model asked for is applied to its output as it arrives, before anything is stored. Narrowing a search therefore makes it lighter, which keeps honest the advice to narrow it.
- **The fallback sees no more than ripgrep.** git keeps tracking a file committed before `.gitignore` named it, and `git grep` searches it; ripgrep hides it. The git implementation removes those files too, so a `.env` committed by mistake and ignored later stays hidden on both. Both write every path with `/`, ripgrep through `--path-separator /` on Windows. ripgrep also reads its own `.ignore` and `.rgignore`, which outrank `.gitignore`: a `!.env` line in either would show the secret, so it runs with `--no-ignore-dot` and only git's ignore sources count. A folder the user cannot read is skipped by both, git with a warning and ripgrep with exit code 2, and the rest of the answer stands; a program stopped by a signal from outside fails the operation, because what it printed is not the whole answer.
- **Patterns are regular expressions**, with case-insensitivity as its own option. The git fallback uses `-P`, because POSIX extended syntax has no `\d`.
- **Results are bounded and say so.** A result carries what fits, the total and whether it was cut. Counting the total means letting the search finish, so an operation stops after 30 seconds and fails with an error asking for a narrower query, instead of reporting a false total. The time limit is not a cancellation: the model reads it as an error result, and only the run's own signal cancels the run. git's Perl engine can backtrack without end on a pathological pattern, which is what the limit is for. The parser also pins the git settings that change its output, `grep.column` and `grep.fullName`, as ripgrep's `--no-config` does for ripgrep.

**Context:** a tool result is sent to the provider, so a `readFile` of `.env` would hand the API keys to OpenAI or Anthropic inside a tool result. The repository already ignores `.env` and `node_modules`, which makes `.gitignore` a boundary that needs no configuration. Both programs were then run against a scratch repository holding an ignored `.env` and an ignored `node_modules`:

| Search for the secret             | ripgrep             | git     |
| --------------------------------- | ------------------- | ------- |
| No scope                          | only tracked source | same    |
| Scoped to the path `.env`         | returns the secret  | nothing |
| Scoped to the path `node_modules` | searches inside it  | nothing |
| Scoped with the glob `.env`       | returns the secret  | n/a     |

ripgrep stops applying ignore rules to a path or glob given explicitly, and that scope is exactly what the model writes. `git grep --untracked` and `git ls-files --exclude-standard` keep applying them. ripgrep also skips hidden files and, outside a git repository, ignores `.gitignore` unless told otherwise, so it runs with `--hidden --no-require-git` to see what git sees. On the machine this was tested on, ripgrep was not installed for a spawned process: the `rg` in the terminal is a shell function. That is why it ships with the package.

The three programs were then timed, best of several runs on a 10-core Mac, with ripgrep 15 from `@vscode/ripgrep`:

| Search                                          | `grep -r`          | `git grep` | ripgrep |
| ----------------------------------------------- | ------------------ | ---------- | ------- |
| A literal, 25,915 files and 786 MB              | 2.53 s             | 0.94 s     | 0.72 s  |
| A regular expression, same tree                 | 2.95 s             | 1.00 s     | 0.75 s  |
| Listing the same tree (`find` for `grep`)       | 0.22 s             | —          | 0.07 s  |
| A literal in this repository, as an agent would | 3,250 ms, 45 lines | 23 ms      | 10 ms   |

Against plain `grep` ripgrep wins by far, and the 22 extra lines are `node_modules` and `.git`. Against `git grep` the gap is about a quarter, which an agent waiting seconds for a model does not notice. The dependency is therefore not bought for speed today: it buys a pinned version that behaves the same on every machine, search outside a git repository, `--json` output instead of colon-separated text, and a preferred implementation CI can test. The speed gap grows with the repository. When spawned without a path, ripgrep searches its standard input if that is a pipe, so it must be spawned with standard input ignored.

**Alternatives considered:**

- **A deny list of secret file names**, alone or beside `.gitignore`. Rejected for now: it is never complete, and alone it leaves `node_modules` and build output visible. It remains the answer if a secret ever lives in a tracked file.
- **git first, or git alone, with no new dependency.** It enforces the boundary by itself, needs nothing installed and measured close to ripgrep. Rejected for the pinned behaviour and the work outside git listed above, and for the margin ripgrep gains on large repositories; the cost is that the harness, not the program, enforces the boundary.
- **ripgrep only when the host has it.** No dependency, but the preferred path would not run on the machine the harness is developed on, nor in CI.
- **Passing the model's scope to ripgrep after validating it.** Rejected: every validation is a second implementation of `.gitignore`, and one mistake leaks a secret. Filtering results costs nothing, because ripgrep searches a whole repository in milliseconds.
- **Literal patterns only.** They behave the same on both programs, but cannot express a word boundary or an alternative, which is most of what a code search needs.

**Consequences:** #25 lists optional binaries as runtime dependencies among its non-goals; this is a deliberate exception. Every install grows by 4.5 to 5.7 MB, depending on the platform, including for consumers that only use the Agent SDK engines; the binary arrives as an optional dependency per platform, with no install script, which pnpm would block. A secret that is not ignored is visible to the agent, so `.gitignore` is now a security control as well as a convenience. Scoping a ripgrep search saves no work, only output. The two implementations must be tested against the same boundary cases: an ignored file, an ignored directory, a glob naming an ignored file, a path above the root and a symlink out of it.

**Lesson:** a tool's safe default can stop applying the moment an argument is explicit. When the argument comes from a model, test the explicit case against the real program before trusting the default.

---

## Providers are named after the company, and both paths share their names

tags: #mikode-harness #provider-integration #public-api

**Decision:** `AgentProvider` is `'anthropic' | 'openai'`, for `createAgent`, `createOrchestrator` and `createLLMAgent` alike. A provider is the company that authenticates and bills the call; whether it is reached through its Agent SDK (Claude Code, Codex) or its model API is the factory's choice. The model API clients also take the Agent SDK's names, so one role of the orchestrator's table can run on either path:

- `ClaudeLLMClient` takes `opus`, `fable` and `sonnet`, and sends the ID each one pins: `claude-opus-5-5`, `claude-fable-5-1` and `claude-sonnet-5`. Haiku is left out, because it has no adaptive thinking.
- Both clients take a `reasoningEffort`, `high` by default as on the engines: `output_config.effort` on Anthropic and `reasoning.effort` on OpenAI. Each validates its own list, from `low` to `max`. Codex's `ultra` has no API equivalent, so the API clients reject it.

**Context:** slice 7 of #23 puts the planner and reviewer on the model APIs, where the provider had been `'openai'` while the SDK path called the same company `'codex'`. Calling both `'codex'` would tell a caller it reaches Codex through a ChatGPT login, when the API path needs `OPENAI_API_KEY` and bills per token. Without an effort, a role on the API path ran at the provider's default and lost the effort its role sets on the SDK path.

**Alternatives considered:** `'codex'` on both paths — rejected for the credential confusion above. `'codex'` on the SDK path and `'openai'` on the API path — rejected: two names for one company, translated in every role table. Full model IDs on the API path, as "The Claude client follows the OpenAI client's rules" decided — superseded: the role table would need a model column per path.

**Consequences:** a breaking change to the public API. `createAgent('claude')` becomes `createAgent('anthropic')`, `'codex'` becomes `'openai'`, and `createOrchestrator`'s `provider` takes the same names. The alias table is kept by hand and pins one model per alias: when Anthropic moves `opus` to a newer model, the Agent SDK follows at once and the API path stays on the pinned ID until the table changes. The lists still live in `src/llm`, so the new path does not import the engine it replaces. Class names stay as they are (`ClaudeAgent`, `CodexAgent`, `ClaudeLLMClient`, `OpenAILLMClient`), because each names what it wraps.

---

## The model-backed orchestrator plans and reviews on the model APIs and executes on the Agent SDK

tags: #mikode-harness #agent-loops #orchestration

**Decision:** `createLLMOrchestrator` runs the same workflow and role table as `createOrchestrator`, with the planner and reviewer from `createLLMAgent` and the read-only repository tools. The executor still comes from `createAgent`, and `autoApprove` reaches only the executor. Each role's instructions move out of the prompts `OrchestratorAgent` writes, which now carry only the round's data: the request, the plan, the executor's answer, the feedback. A model-backed role holds its instructions as its system prompt, followed by a short note on finding its way around the repository: paths are relative to the root, start with `AGENTS.md` and the architecture document it links to, then read only the files the task needs. An Agent SDK role has no system prompt, so `InstructedAgent` puts its instructions at the head of every prompt, which is what it received before. Both orchestrator factories take `systemPrompts`, per role, which replaces the harness's text word for word, repository note included; a role left out keeps the harness's own. The instructions are an opinion of the harness, not part of its contract, so a consumer can replace them without forking it; the reviewer's JSON decision is the one part the workflow depends on, and the option says so.

**Context:** an agent of ours can read the repository (#25) but cannot change it, and approving a change is #43. A conversation owned by MiKode resends every earlier prompt on each call, so instructions inside the prompt were paid for once per round and stood in the conversation as if the user had written them. The system prompt is sent once per call, so it holds only what the role needs on every call; a repository's `AGENTS.md` and architecture document already say where things live, which costs less than searching the whole tree.

**Alternatives considered:** all three roles on `LLMAgent` — rejected: the executor could not write. Keeping the instructions in the prompt and adding only the repository sentence as the system prompt — rejected for the cost and the misattribution above. A flag on `OrchestratorAgent` saying which roles hold their own instructions — rejected: where an agent keeps its instructions is decided when the agent is built, so the factory composes it and the orchestrator stays unaware.

**Consequences:** the planner and reviewer need API keys and bill per token, while the executor keeps the subscription. `createLLMOrchestrator` is asynchronous, because finding the program that reads the repository is, and it reads the current working directory, as the Agent SDK engines do. The model-backed reviewer reads files but cannot run `git diff`, so it judges the code as it stands, not the change. Both factories stay internal; exporting them belongs to the last slice of #23.

---

## MiKode owns the conversation on the model APIs, and provider sessions stay the default path

tags: #mikode-harness #agent-loops #state #public-api

**Decision:** the harness has two paths to a provider, and both are public. The Agent SDK path, `createAgent` and `createOrchestrator`, keeps the conversation in the provider's session (Codex's `Thread`, Claude's `session_id`) and stays the default. The model API path, `createLLMAgent` and `createLLMOrchestrator`, keeps it in a `Conversation` that MiKode owns, sends the whole context on every call, and runs MiKode's own tool loop. Work that needs to read or change a conversation builds on the second path. The tool contract is exported with it: `Tool`, `defineTool`, the `Workspace` port, `createWorkspace` and `createWorkspaceTools`. This closes #23.

**Context:** provider sessions were the right choice when "Claude: explicit session continuity" was taken. The harness had two engines and one consumer, and all it did with a conversation was continue it. A session gave that for free, kept both engines identical from outside, and kept the orchestrator small. Its cost was that the conversation lived with the provider, opaque, and only that provider could continue it. The next requirements all need what that cost ruled out:

- persisting and restoring a conversation (#29);
- handing it to another agent or provider (#17, #22);
- running tools MiKode defines, and later gates (#25, #43);
- loading skills into it (#44);
- compacting it before it outgrows the model (#48).

**Alternatives considered:**

- **Replacing the Agent SDK path now.** Rejected: an agent of ours cannot change files until it has write tools and permissions (#43), so the executor still needs an Agent SDK. The two paths are also billed differently. The Agent SDKs run on the provider's own login, while the model APIs need `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and bill per token.
- **Keeping the model API factories internal until the executor moves too.** Rejected: the planner and reviewer already run on that path. A consumer can only use them, or replace their instructions, through the public API.

**Consequences:**

- **Two paths to maintain.** Both are maintained, with one provider naming and one role table. Whether the model API path becomes the default is not decided: that waits for an agent of ours that can write, and for what a run costs per token.
- **Agent SDK dependencies.** They stay required dependencies. Making them optional waits for a consumer that does not want them.
- **Zod in the public contract.** `defineTool` takes a Zod 4 schema, so Zod's major version is now part of the public contract. `zod` moves from a dependency to a peer dependency, so the consumer's schemas and the harness share one copy instead of two that may differ.
- **Tool approval.** `createLLMAgent` runs whatever tools it is given, with no approval step until #43.
- **Billing.** The Claude Agent SDK authenticates with `ANTHROPIC_API_KEY` whenever the key is set. So a process that sets the key for the model API path also bills its Claude executor through the key, not the subscription.

**Lesson:** a decision that fit its requirements is not undone by new ones; it gets a successor. Keeping the old path as the default, and recording what would move the default, let the replacement ship before it could do everything the original did.

---

## `run` takes its options as one object, passed on whole

tags: #mikode-harness #public-api #agent-loops

**Decision:** `Agent.run(prompt, signal, callback)` becomes `run(prompt, { signal, onProgress })`.

- The prompt stays positional, because every run needs one.
- `onProgress`, the former callback, is optional.
- `RunOptions` is exported.
- Each decorator (`RetryingAgent`, `InstructedAgent`, `OrchestratorAgent`) passes the object on whole, never a copy it rebuilt, and a test pins that for each one.

**Context:** #43 needs an approval callback, and #52 needs a snapshot of the working tree. Both belong to one run, not to an agent: in a server each request is approved by its own user, and the CLI keeps one orchestrator for a whole session. A fourth optional parameter would have been compatible, but a fifth would follow, and positional parameters only grow.

**Alternatives considered:**

- **A per-run context through `AsyncLocalStorage`.** Rejected: it reaches the tools without touching any signature, but it is a dependency nobody can see.
- **An optional fourth parameter.** Rejected: it was compatible, but it only postponed this change.

**Consequences:**

- A breaking change for every consumer of `Agent`. It ships in one major release with the rest of #43, and harness-cli is rewritten once.
- A field added to `RunOptions` reaches every agent without changing any decorator. That holds only as long as no decorator rebuilds the object, which is why each one has a test for it.

---

## Each tool judges the risk of each call, and only a destructive one waits for a human

tags: #mikode-harness #permissions #agent-loops #public-api

**Decision:** before `LLMAgent` runs a tool call, the tool classifies that call:

- `safe` changes nothing;
- `mutating` makes a change git can undo;
- `destructive` loses something.

`risk` is required on `Tool` and on `defineTool`, as a fixed level or as a function of the validated input. Only a `destructive` call is held back: it runs when the run's `approve` allows it, or always when the agent was built with `autoApprove`. With no approver, it is denied. A denial reaches the model as an error result, with the user's reason when one was given. Progress reports it with a new `status: 'denied'`, and the run carries on. A throwing approver ends the run as a host failure.

**Context:** #43, before #52 gives agents tools that write. Its first layer was already in place: an agent runs only the tools it was given. The second layer is each tool's own checks on its arguments, such as the `.gitignore` boundary. This entry is the third layer: asking a human.

**Alternatives considered:**

- **A list of dangerous tool names.** Rejected: the danger is in the call, not in the tool. The same write that creates a file can overwrite one, and only the tool can tell from the input.
- **Asking about `mutating` calls too.** Rejected: an executor edits constantly, so asking on every edit would make it unusable, and git can undo those edits.
- **Remembering "allow for the session" in the harness.** Rejected: that is state that outlives a run, which AGENTS.md rules out. The consumer's own approver remembers instead, and it also decides what counts as the same call: the same tool, or the same tool and path.
- **A per-role policy in the orchestrator.** Rejected: #52 gives each role its own tools, so what a role may do is already decided when it is built.
- **Asking for approval through a `ProgressEvent`.** Rejected: consumers are told to ignore event types they do not know. A consumer that ignored the request would never answer. The run would then wait forever, or need a timeout that decides for the user, and the deny default for "no one can answer" would never apply. Approval needs a callback that returns an answer. Only an `approve` the consumer passed can allow a call, and its absence is itself the signal to deny.

**Consequences:**

- A tool that changes something git does not track must count as `destructive`, or nothing protects that change.
- Adding `denied` to an existing event's `status` is breaking for an exhaustive switch, so it ships in #43's major release with the run options.
- Input that fails validation counts as `safe`, because `execute` rejects it before doing anything.
- A tool whose `risk` throws is a failing tool: its call does not run, and the model receives the error.
- The Agent SDK engines ignore `approve`, because their own permission systems decide.
- `rememberApprovals(ask, { key })` is the consumer's memory, offered by the harness so each consumer does not write it again. It allows a call again without asking once `ask` answered `remember`, and never remembers a denial. Its memory lives in the approver it returns, so the consumer chooses its lifetime. The CLI keeps one for the session and asks in the terminal: yes, always, or no with a reason.

## One access policy decides every path a tool reads or writes

tags: #mikode-harness #tools #filesystem #security

**Decision:** before a tool touches a path, `RootsAccessPolicy` decides, and refuses unless every step allows it:

1. **Location.** The path's real location, every symlink resolved, is inside a declared root. A symlink is followed and judged by where it leads, so `CLAUDE.md → AGENTS.md` works and a link out of the roots does not. A link that leads nowhere is refused, because writing to it would create its target wherever that is.
2. **Access.** The root allows the access: each root is `read` or `write`, and the most specific root decides.
3. **Protection.** It is not protected: git's metadata (`.git` as a folder or a worktree's pointer file, under any spelling), and the host's protected paths, such as the recovery store.
4. **Secrets.** It is not a secret, by the default list and by the paths the host's `protect` adds.
5. **`.gitignore`.** It does not exclude the path, even one that does not exist yet, nor any symlink the path goes through. git sees a link as an entry of its own, so an ignored link stays closed even when it leads somewhere that is not ignored.

A file the host's `allow` names exactly, for reading or also writing, skips steps 4 and 5. A `.env` is usually both a secret and ignored, and an opening that `.gitignore` still blocked would open nothing. Nothing opens step 3.

**Context:** #52 adds write tools, and the v2 plan asks for one policy on every route instead of a check per tool.

**Details:**

- **Error messages** name only the path the model sent, never a host path. In the research for #52, a host path in an error sent Claude looking for it.
- **Containment** compares real paths component by component. `fs.promises.realpath` returns the case the disk stores, so a case-insensitive disk needs no lower-casing.
- **Names are compared without case.** Secret names and `.git` are compared in lower case, because `.ENV` and `.env` are one file on macOS.
- **The secrets list goes by names and places:**
  - `.env` and `.env.*`, except `.example`, `.sample` and `.template`;
  - private key names (`id_rsa`…);
  - key and state endings (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.tfstate`);
  - credential folders and files under the home directory (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`…).
- **`.gitignore` is checked with `git check-ignore --no-index`,** which knows every rule source and answers for paths that do not exist yet.
  - Outside a repository, git uses a private, empty git directory and still reads the folder's `.gitignore` files.
  - git runs without the host's `GIT_*` variables, which could point it at another repository.
  - git refuses a path beyond a symlink, so each link on the way is checked alone, at its real place, and then the place the path leads.
- **A root inside git's metadata is refused when the policy is created.** Protection looks for `.git` below a root, so such a root would open what nothing may open.

**Alternatives considered:**

- **Refusing every symlink.** Rejected by the user: common setups link `CLAUDE.md` to `AGENTS.md`.
- **Glob patterns for the secrets list.** Rejected: whether `**` crosses folders whose name starts with a dot is a matcher option. A list of names, endings and home folders is predictable.
- **Lower-casing every path.** Rejected: on a case-sensitive disk, `/work/Repo` and `/work/repo` are different roots.

**Consequences:**

- **Not a secret detector.** The list catches the usual suspects; a key pasted into an ordinary source file is not found. The host can add paths, and open exact false positives.
- **Requires git.** The `.gitignore` check needs git, even outside a repository.
- **One check is not a lock.** The policy answers for one moment, so whoever writes must check again right before writing. A host that races its own agent on the filesystem is outside what it guarantees.
- **Hard links are not detected.** `realpath` cannot reveal another name of the same file, so a hard link to a file outside the roots passes as an ordinary file.
- **Not yet used.** The read tools keep their current boundary until the tools move to this policy, later in #52.

## A writing run records what it will change, outside the repository, before changing it

tags: #mikode-harness #recovery #tools #filesystem

**Decision:** a run that writes to a workspace keeps a recovery record in a store outside the repository, under the platform's state directory (`$XDG_STATE_HOME`, `~/Library/Application Support` on macOS, `~/.local/state` elsewhere), in a private directory per workspace.

- Before a file changes, the run stores the content the change replaces, named by its SHA-256, and appends a `prepared` line to its journal.
- Only once both are synced to disk is the change made. Afterwards the journal marks it `applied`, or `abandoned` when it never happened.
- A crash in the middle therefore always leaves a record of what the run may have done.
- One run writes to a workspace at a time, through a lock that names the run and its process. A lock whose process died is taken over.

**Context:** #52 lets model-backed agents change files, and the user must be able to undo the latest run without losing work that existed before the agent touched it, including uncommitted and untracked work. See the v2 plan in that issue.

**Alternatives considered:**

- **A git snapshot when the run starts** (`git stash create`, or a tree written through a temporary index). Rejected:
  - `stash create` cannot recover untracked files.
  - `git add` runs the clean filters a user configured, such as LFS, so taking a snapshot can execute programs.
  - A snapshot copies the whole repository to protect the few files a run touches.
- **The store inside `.git/`.** Rejected: it only exists in a git repository, and it would mix the harness's state with git's own.
- **Memory only.** Rejected: an undo must still work after the process that ran the agent has exited or crashed.

**Consequences:**

- Only what a run touches is copied, and identical content is stored once.
- The store holds source code, so its directories and files are readable by their owner only, and it must never reach a model, a log or the package.
- The lock keeps a second run of this harness from writing at the same time. It does not stop an editor or another program, and two processes taking over a dead run's lock in the same instant could both believe they hold it.
- Retention, quota and undo itself arrive with the recovery service in a later slice of #52.

## A file change is prepared, then applied only if the file still holds what was prepared

tags: #mikode-harness #tools #filesystem #recovery

**Decision:** every change a write tool asks for is one of three: create, replace or delete. Each edit format, such as a patch or a text replacement, first works out the whole new content of the file.

- **`FileEditor.prepare`** checks the change: the access policy allows the path, a create finds nothing there, and a replace or delete finds the file. If the caller worked from a version of the file, given by its hash, the file must still hold it. The result is a frozen `PreparedEdit`, so what is approved is exactly what is written.
- **`FileEditor.apply`** checks the policy and the file again, then:
  1. stores the content being replaced and the new content;
  2. records the change as prepared;
  3. writes the change;
  4. records it as applied.

**How each change is written:**

- **Create:** the content goes to a temporary file beside the target, which is then linked into place. `link` fails if something took the path meanwhile, whereas `rename` would silently replace it.
- **Replace:** the temporary file gets the old file's mode and is renamed over it in one step.
- **Delete:** the file is unlinked.
- **After any of them,** the folder is synced. New parent folders are recorded in the journal, so an undo can remove them while they are empty.

**When a write throws,** the editor reads the file again:

- If it still holds what it held, the change is abandoned and the folders it created are removed.
- If it holds the new state, the change counts as applied.
- Anything else cannot be explained, so the run's `WriteSession` refuses every further write. The journal must stay a complete record of what the run did.

**Context:** #52, whose v2 plan asks for one lifecycle (prepare, approve, apply) and for writes that never land on a version of a file that nobody looked at.

**Alternatives considered:**

- **Applying edits in place,** for example by splicing a patch into the file. Rejected: a crash halfway leaves half an edit, and the content to restore is not known until after the write.
- **Reading the umask with `process.umask()`.** Rejected: with no argument it briefly changes the umask for every thread. The mode a new file gets is measured once by creating a probe file in the temporary folder.

**Consequences:**

- **Write sessions start lazily.** A run that only reads never holds the workspace, because the journal starts on its first write.
- **Default limits:** 5 MB per file and 500 changes per run.
- **Errors never show host paths.** Every message names the file as the model wrote it, and filesystem errors are reduced to their code, such as `EACCES`, because Node's own messages carry host paths.
- **The guarantee assumes no concurrent writer.** The file is checked again just before the write, but another program can still change it between that check and the rename.
- **Replacing a file breaks its hard links,** because a renamed new file is a new inode.

## Every tool call is prepared before it is approved, and a run's context travels under a private symbol

tags: #mikode-harness #tools #agent-loops #permissions

**Decision:** `LLMAgent` runs every tool call through one lifecycle:

1. **Prepare.** The tool checks the call and fixes what it will do. A harness-built tool, a `PreparingTool`, works out the real effect, such as the exact bytes a write will leave, and judges its risk from that. A consumer's `Tool` is brought in by `prepareCall`: its `risk` is judged, and its `execute` later runs on the input as sent. So consumers keep their contract and there is only one engine.
2. **Approve.** As in #43, only for a `destructive` risk.
3. **Run.** Only the prepared call runs, so what was approved is what happens. A call that cannot be prepared reaches the model as an error result.

The tools of one top-level run share a `RunContext`. Whatever a tool starts for the run, such as the recovery record of what it writes, registers how to end it. The agent that created the context ends it with the run: completed, failed or cancelled.

- A standalone `LLMAgent` creates its own context for each run.
- An agent reached by an outer one runs in the context it is given and leaves ending it to that outer agent. An orchestrator will create one context for all its roles and rounds.
- The context travels in `RunOptions` under a private `Symbol`, so decorators carry it as they carry every option, and consumers never see it.
- A context that cannot be ended is reported through the logger, and the run keeps its result: the changes it recorded are already on disk.

**Context:** #52's v2 plan asks for one lifecycle for every tool and for one recovery context per top-level run, passed internally and never stored on an instance. The CLI keeps one orchestrator for a whole session, and #29 will run several at once.

**Alternatives considered:**

- **A public field in `RunOptions`.** Rejected by the plan: consumers would see and could set plumbing they must not manage.
- **`AsyncLocalStorage`.** Rejected: an implicit channel that every async boundary must preserve, harder to test and to follow than an explicit argument.
- **Building the agents again for each run.** Rejected: each role's conversation lives in its agent, and the CLI's session relies on it surviving from one run to the next.
- **A context on the agent instance.** Rejected: two runs at once on one agent would share it.

**Consequences:**

- **The symbol property survives because no agent rebuilds `options`.** A decorator that rebuilt them would drop the context silently. The existing tests that check identity forwarding guard this.
- **`PreparingTool` is internal.** Consumers keep `Tool`, with `risk` and `execute`.
- **Tools see the context only in `prepare`.** Run-scoped state, such as the `WriteSession` per context in `WorkspaceWrites`, is held in a `WeakMap` keyed by the context, so it goes away with the run.
