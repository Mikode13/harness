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

partially superseded by: "Issue #89: progress is concise, attributed, and still useful live" (below) — progress and the final response remain separate, but the orchestrator now wraps the callback for each role and overwrites role attribution instead of forwarding the callback unchanged.

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

**Decision:** `handleEvents` moved from `src/agent/domain/agent.ts` to the instance-based
`ProgressEventFormatter` in `cli/progressEventFormatter.ts`, and is no longer exported from the
package.

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

partially superseded by: "A Claude answer is streamed, so it can be 64,000 tokens long" (below) — `max_tokens` is 64,000.

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

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — `sonnet` and `haiku` now pin `claude-sonnet-5-5` and `claude-haiku-5-5`, Haiku takes an effort, and the Agent SDK is sent the pinned ID instead of resolving the alias itself.

**Decision:** `AgentProvider` is `'anthropic' | 'openai'`, for `createAgent`, `createOrchestrator` and `createLLMAgent` alike. A provider is the company that authenticates and bills the call; whether it is reached through its Agent SDK (Claude Code, Codex) or its model API is the factory's choice. The model API clients also take the Agent SDK's names, so one role of the orchestrator's table can run on either path:

- `ClaudeLLMClient` takes `opus`, `fable` and `sonnet`, and sends the ID each one pins: `claude-opus-5-5`, `claude-fable-5-1` and `claude-sonnet-5`. Haiku was left out at first, because it has no adaptive thinking; #81 added it (`claude-haiku-4-5`), without thinking or an effort, for the summary of what was undone.
- Both clients take a `reasoningEffort`, `high` by default as on the engines: `output_config.effort` on Anthropic and `reasoning.effort` on OpenAI. Each validates its own list, from `low` to `max`. Codex's `ultra` has no API equivalent, so the API clients reject it.

**Context:** slice 7 of #23 puts the planner and reviewer on the model APIs, where the provider had been `'openai'` while the SDK path called the same company `'codex'`. Calling both `'codex'` would tell a caller it reaches Codex through a ChatGPT login, when the API path needs `OPENAI_API_KEY` and bills per token. Without an effort, a role on the API path ran at the provider's default and lost the effort its role sets on the SDK path.

**Alternatives considered:** `'codex'` on both paths — rejected for the credential confusion above. `'codex'` on the SDK path and `'openai'` on the API path — rejected: two names for one company, translated in every role table. Full model IDs on the API path, as "The Claude client follows the OpenAI client's rules" decided — superseded: the role table would need a model column per path.

**Consequences:** a breaking change to the public API. `createAgent('claude')` becomes `createAgent('anthropic')`, `'codex'` becomes `'openai'`, and `createOrchestrator`'s `provider` takes the same names. The alias table is kept by hand and pins one model per alias: when Anthropic moves `opus` to a newer model, the Agent SDK follows at once and the API path stays on the pinned ID until the table changes. The lists still live in `src/llm`, so the new path does not import the engine it replaces. Class names stay as they are (`ClaudeAgent`, `CodexAgent`, `ClaudeLLMClient`, `OpenAILLMClient`), because each names what it wraps.

---

## The model-backed orchestrator plans and reviews on the model APIs and executes on the Agent SDK

tags: #mikode-harness #agent-loops #orchestration

superseded by: "Each role gets its own tools, and every role of the model-backed orchestrator runs on the model APIs" (below). The executor is an `LLMAgent` now that the harness's own tools change files.

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

partially superseded by: "Issue #89: progress is concise, attributed, and still useful live" (below) — `RetryingAgent` and `InstructedAgent` still pass the original object whole; `OrchestratorAgent` now makes a shallow copy per role that retains every own enumerable field and replaces only `onProgress`.

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

- **`FileEditor.prepare`** checks the change: the access policy allows the path, a create finds nothing there, and a replace or delete finds the file. If the caller worked from a version of the file, given by its hash, the file must still hold it. The result is a frozen `PreparedEdit` holding its own copy of the new content and that content's hash. A buffer's bytes cannot be frozen, so `apply` copies the prepared content, refuses it if it no longer matches the hash, and writes the copy: what is approved is exactly what is written, whoever changes a buffer while the approval waits.
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

**When the record cannot confirm a change,** because recording it as applied failed or because the file's state cannot be explained, `apply` throws `EditUnconfirmedError`. It never reports a success or a refusal. The change stays in the journal as prepared, with both states, so an undo can still compare the file with them, and the session refuses every further write.

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

partially superseded by: "Issue #89: progress is concise, attributed, and still useful live" (below) — the private symbol still carries one context through the run, but `OrchestratorAgent` now makes a shallow copy per role; the enumerable symbol survives that spread instead of object identity carrying it through every agent.

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

## An agent narrows `.gitignore` freely; widening it waits for the user

tags: #mikode-harness #tools #permissions #filesystem

**Decision:** `FileEditor.prepare` marks a change to a `.gitignore` that can make it hide less, and `editRisk` turns that change into a `destructive` one, which the approver must allow. A widening change is one that:

- removes a rule;
- adds a negation such as `!.env`;
- reorders rules, because the last match decides;
- deletes a file that had rules.

Adding plain rules, comments or blank lines narrows the boundary and is an ordinary, recoverable edit. The check reads the text, so a change it cannot prove narrowing counts as widening.

**Context:** `.gitignore` is the boundary of what every tool reads and writes. The v2 plan for #52 lets the agent edit it under normal authorization, with three conditions:

- new exclusions narrow access immediately;
- a widening takes effect only with explicit authorization;
- a widening the agent wrote is never activated silently on a later run.

**Alternatives considered:**

- **Freezing the rules a session started with, and evaluating every path against them too.** Rejected for now. A frozen copy needs a mirror of every ignore file and a second `git check-ignore` per path. Without an approval to anchor it, a widening that survives the session would still take effect on the next one.
- **Forbidding writes to `.gitignore`.** Rejected by the user: adding an ignore rule is ordinary work.

**Consequences:**

- **A widening is authorized when it is written,** by the person who allowed it, so it never takes effect silently.
- **With `autoApprove`, a widening is allowed.** It is a confirmation, not a block, and `autoApprove` exists for hosts that answer for themselves.
- **Only `.gitignore` files are watched.** `.git/info/exclude` is protected git metadata, and the read tools never honour ripgrep's own `.ignore` files.

## Runs form a tree, so the user can go back to any of them and forward again

tags: #mikode-harness #recovery #undo

**Decision:** the recovery store keeps the runs that write to a workspace as a tree, like commits:

- each run records the run the workspace was at when it started (`parentRunId`);
- the store records the run the workspace is at now (`head.json`);
- going back deletes nothing, so a run that was undone can be redone, and writing after going back starts a new branch.

A run whose process died while `running` is `interrupted`. The next run to take the workspace settles each change it left `prepared` from what the file holds now: its after-state means the change was made, its before-state that it was not, and anything else leaves it `prepared`. Until then, `listRuns` and `readRun` already report it as `interrupted`.

**Context:** the v2 plan for #52 offered an undo of the latest run only. The user wants to go back to any earlier point, for example after run 2 when runs 3 to 5 went wrong, then tell the model to carry on from there, and to be able to change their mind. The user also decided that per-file conflicts make a move partial instead of refusing it, that retention keeps 25 runs, and that the conversation is cut back with a summary of what was undone. The [amendment to the v2 plan](https://github.com/Mikode13/harness/issues/52#issuecomment-6048362400) on #52 records these decisions.

**Alternatives considered:**

- **Undo of the latest run only**, as v2 planned. Replaced by the user's idea of a history: with it, going back past several bad runs takes several undos, and nothing can be redone.
- **Going back without redo.** The user chose redo too. It needs no more data, since the journal already holds every change's before-state and after-state. It only needs a head that is not always the newest run.
- **Treating a dead run as `failed`**, with no new status. The user chose a status of its own, so `listRuns` tells a run that failed from one whose process vanished.

**Consequences:**

- Moving between runs (sub-PR 2b) undoes runs back to the common ancestor, then redoes runs forward to the target, checking each file's state on the way.
- The head is written after the new run's record, so it never names a run that does not exist.
- The v2 byte quota is replaced by retention by number of runs (sub-PR 2c).

## Diffs come from our own Myers implementation, kept free of the harness

tags: #mikode-harness #recovery #dependencies

**Decision:** `showChanges` renders a run's effects as a git-style diff per file, with hunks from `unifiedDiff` in `src/diff/`, our own implementation of Myers' algorithm. The module imports nothing, so it can move to a package of its own unchanged.

- The shared start and end of the two texts are cut off first, since most edits leave most of a file alone.
- Beyond 1,000 differing lines, the search stops and the differing middle is shown as removed, then added. Memory grows with the square of that distance.
- Lines are compared whole, a `\r` included, and a missing final newline is marked as git marks it.
- Content with a NUL byte near its start, as git tests it, or that is not valid UTF-8 is shown as binary. Decoding invalid UTF-8 would replace its bytes, so two different files could otherwise show no difference.

**Context:** the user chose a unified diff as the format of `showChanges`, both for the consumer and for the planner and reviewer tools. The package had no diff dependency.

**Alternatives considered:** the `diff` package (jsdiff), the standard and well-tested choice. The user chose our own implementation for now, as a candidate to publish later as a package of our own. It also avoids a new production dependency in the published package.

**Consequences:**

- The tests check, over 500 random texts, that each patch rebuilds the new text and that its number of changed lines is the minimum.
- Git's own heuristics can place a change differently in ambiguous cases, such as a repeated line. The diff is still minimal and correct, but not always identical to `git diff`.

## A move through the history is taken one run at a time, and leaves alone any file the user changed

tags: #mikode-harness #recovery #undo

**Decision:** `goTo(target)` undoes runs one by one back to the closest common ancestor, then redoes runs one by one forward to `target`. `undo()` goes to the parent of the run the workspace is at, `redo()` to its child towards where the workspace was most recently, or the newest branch. `historyStart` is the state before any run. For each file a run changed, from before its first change to after its last:

- a file that already holds the state the step leads to is left alone, so taking a step again is safe;
- a file that holds the state the step leaves is written;
- any other file, one under a folder that became a link, or a file someone wrote to between two of the run's changes (when undoing) is left as it is and reported as a conflict.

A move with conflicts is recorded as not `complete`. Each move is appended to `revisions.jsonl` with where it came from, where it went, its conflicts and the reason the host gave. While it runs, `head.json` names the move and the run each step reached, so the next move or run finishes a move whose process stopped.

**Context:** the user chose the stepwise route, in which each run knows how to go forward and back relative to its parent, like a doubly linked list, so undo and redo are the same operation in two directions. They also chose to restore the other files and report a partial move, rather than refusing a move with any conflict. The host asks for the reason when the user goes back; it reaches the model in a later sub-PR.

**Alternatives considered:**

- **The net change of each file across every run crossed**, applied once. Fewer writes, but a different path from undo and redo, and a crash in the middle leaves no run the workspace is at.
- **Refusing the whole move when any file conflicts**, as v2 planned. Replaced by the user's choice.
- **`redo` to the newest child always.** Simpler, but after going back from one branch and visiting another, it would not return where the user just was.

**Consequences:**

- A file in conflict when a run is undone is also in conflict for each earlier run that changed it, since it never reaches the state they expect. The user's edit always wins.
- Moves and runs share the workspace lock, and a move first settles interrupted runs, so it never crosses a change nobody settled.
- The busy-workspace error a write tool returns now says that a move may hold the workspace too.
- A restored file is built in a hidden temporary beside it, created readable by its owner only and given the file's mode once whole. The temporary has a random name, recorded in the pending move before it is created, so finishing a move after a crash removes that temporary and never a file of the user's with a similar name.
- The folders above a file are checked before anything else, so a file reached through a folder that became a link is never read, removed or counted as already moved.

## Retention keeps 25 runs and never loses the start of the history

tags: #mikode-harness #recovery #undo

**Decision:** before a run starts, the store brings its history down so that, with the new run, it holds at most 25 runs per workspace (`keepRuns`). Each step removes one run:

- **an abandoned branch first**, a leaf at a time, oldest first, removed whole since nothing depends on it;
- **then the oldest run on the current line**, other than the run the workspace is at, **chained into the next run**. The current line runs from the start to the run the workspace is at, then on through what `redo` would take.

Chaining works like removing a node of a doubly linked list. The next run now hangs from the removed run's parent and carries both runs' changes. Each file's chain is reduced to its net, from before its first change to after its last. A break, where someone wrote to the file between two changes, is kept as a second change. The new record is the commit point. A crash before it leaves the history as it was, and one after it is cleaned up before the next prune. Contents no kept run refers to are then freed.

A move to a run that is gone reports `HistoryExpiredError`, naming the run that now holds its changes when it was chained.

**Context:** the user chose this when asked what going back to the start should mean once the start of the current path had been pruned. The two options offered were the start of what is kept, or an error. The user answered that the start must never be removed and that removal must chain the changes, like a linked list. 25 runs is the user's "reasonable number on the short side"; a run is roughly one prompt. It replaces v2's byte quota.

**Alternatives considered:**

- **The start of what is kept**, the state before the oldest run kept. Rejected by the user: the original state would be lost after a long session.
- **An expired-history error for the start.** Rejected by the user for the same reason.
- **Keeping the chained runs' journals whole**, under the run that absorbed them. That is simpler and crash-safe by renaming folders, but it never frees the intermediate contents, and freeing disk is what retention is for.

**Consequences:**

- `historyStart` always restores the state before the agent's first run. Only the intermediate states are lost.
- Going back past a break in a chained file leaves that file as it is: the state between the two runs, which would have restored the user's edit, is gone.
- Chaining reads and rewrites at most two journals, and collecting contents reads every kept journal. Both stay small with 25 runs.
- `keepRuns` must be at least 3. The run the workspace is at is never removed, and the last run of its line has no next run to be chained into, so two runs can remain besides the new one.
- Retention is expected to move to the session manager (#29).

## The conversation follows the workspace through its history

tags: #mikode-harness #recovery #undo #llm

**Decision:** an `LLMAgent` given the workspace's history (`history`) follows the user's moves through it before each run.

- **A conversation is a tree of turns.** A turn that wrote is tied to the history run it wrote in. The tie lives in an object the run's context shares, so a turn recorded before the run first wrote still learns it. A turn that wrote nothing belongs to the run of the turn it followed.
- **Which turn to continue from:** among the turns whose run is on the line from the start to the head, the one nearest the head, and of those the newest. A run chained into a later one counts as that one, and a run retention removed is off every line.
- **Nothing is deleted.** The context is the path to that turn, and the turns left behind stay in the tree, so a redo brings them back.
- **The note:** turns whose run left the line were undone. The next run's prompt starts with a note naming them:
  - what they asked, or a summary from a `summarizer` (a cheap model);
  - the files those runs had changed;
  - the files a move left as they were;
  - the user's reasons since the conversation last looked.
- **A failed run records nothing**, so the next run gives the note again.

**Context:** #68, under the history the user chose for #52. The user decided that the conversation is cut back and keeps what was cut, that only turns which wrote are tied to a run (a read-only turn goes with the one before it), and that the summary comes from the cheap model of the agent's own provider. The orchestrator uses the planner's provider. The note is deterministic by default.

**Alternatives considered:**

- **A notice in place of the turns**, keeping the conversation whole. That was v2's plan for undo of the latest run. The model would still reason over work the user threw away.
- **Deleting the undone turns.** Simpler, but a redo could not bring them back.
- **A note message of its own**, between turns. Some providers want turns to alternate. Folding the note into the next prompt keeps the context valid, and ties the note to the turn that read it.

**Consequences:**

- A turn left on another branch whose run is still on the line, such as a question asked while the workspace was back, is hidden after a redo but not counted as undone, so no note is given.
- In the orchestrator, the planner and reviewer turns follow the executor's run only once the three roles share one run context. Today each role starts its own; #71 makes it one.
- The factory turns this on with the workspace in #71, where it also gives the summarizer, Haiku or `gpt-5.6-luna` at high effort.
- A conversation that was compacted cannot be cut back past the compaction; #48 decides what a move behind it does.

## The history is a public object beside `Agent`, and a run names what it recorded

tags: #mikode-harness #recovery #undo #api

**Decision:** a consumer reaches the history of a workspace through `createHistory({ root })`, not through `Agent`:

- **`History`** has `list()`, `changes(runId)`, `goTo(runId | historyStart)`, `undo()` and `redo()`. Each move takes an optional `reason`.
- **A move can be conditional.** With `from`, the store checks where the workspace is under the lock. If it is elsewhere, the move fails with `WorkspaceMovedError` and changes nothing. A host that showed the user what a move will do passes where the workspace was, so a run that ends while the user answers cannot turn the confirmed move into another.
- **`list()`** gives each run with its parent, status, times and the files it changed. It gives no label: a host that wants one names the run itself.
- **A move** returns where it came from and went, whether it was `complete`, and the files it left. Paths are relative to the root, as in `changes`.
- **`AgentResponse.runId`** names the run a writing run recorded. A run that wrote nothing, and the Agent SDK engines, leave it out.
- **A run that changed nothing leaves the history.** That is a run whose every prepared change was abandoned, or that prepared none. When it finishes, the store points the workspace back at its parent, then removes the run. The response then has no `runId`, and the run's turns count as turns that wrote nothing.
- The errors a consumer branches on are exported: `WorkspaceBusyError`, `WorkspaceMovedError`, `NothingToMoveError`, `UnknownRunError` and `HistoryExpiredError`. An id that is not one, or that this workspace never had, is an `UnknownRunError`.

**Context:** #69. The user decided several points:

- methods do not repeat the noun: `list`, not `listRuns`, and `goTo`;
- `Agent` keeps only `run()`, and `runId` is an optional field of `AgentResponse`;
- the Agent SDK engines offer no history, because their changes are not inferred afterwards;
- `changes` is shown whole to the consumer;
- `list()` carries each run's files, for the host to show or not, and no label;
- a run that started recording but changed nothing is discarded, rather than kept as an empty step. The PR review found the case: a write that failed after the journal started.

The user delegated the remaining names to me.

**Alternatives considered:**

- **Methods on `Agent`**, such as `agent.undo()`. Rejected by the user: every engine would have to answer them, and the Agent SDK engines have no history to give.
- **A label per run**: the prompt cut short, or a name the consumer passes in `RunOptions`. The user chose none for now. The files and the diff identify a run, and either label can be added later without breaking anything.
- **Keeping a run that changed nothing**, with no `runId` in the response. Smaller, but `/history` would show empty runs, and an undo would step through them doing nothing. Rejected by the user.
- **Checking in the CLI alone**, by reading the head again after the user answers. It needs no new API, but a run can still end between that read and the move. The user chose the conditional move. The review of #70 found the case: `/undo` described undoing one run, and undid the run that ended during the confirmation.
- **Exporting `RecoveryStore` itself.** It also exposes the journal, the content hashes and the store's own records, which would all become public API.

**Consequences:**

- A history opened beside a writing agent is a second view of the same files on disk. The workspace lock keeps them apart, so a move during a run fails with `WorkspaceBusyError`.
- `list()` reads every kept run's journal, at most 25.
- A change counts while it may have reached its file: it is prepared and its abandonment was not recorded.
- Whether a run changed nothing is read from its journal, not from a removal that succeeded. The response leaves out its `runId` even when the removal fails. `list()` hides a dead run that changed nothing, and moves the head to its parent. The next run or move then finishes the removal under the lock. This covers a failed removal, a crash, and a run that died having changed nothing.
- A run counts as live only while its process holds the lock and, in that process, the run has not ended. A lock left behind because releasing it failed names a run this process has ended. That lock is stale, like a dead process's: the run is listed as `interrupted`, and the next run or move takes the workspace over without waiting for the process to exit.
- When this was decided, the write tools that record these runs were not exported, and the orchestrator's response had no `runId`. #81 did both.

## An edit starts only from a version the conversation read

tags: #mikode-harness #tools #llm

**Decision:** each `LLMAgent` keeps a `ReadRegistry`, its conversation's map from a file's real path to the hash of the content it saw. Before a modification or a deletion, `prepareTrackedEdit` checks it:

- a file the conversation never read is refused with `READ_REQUIRED`;
- a file whose content changed since is refused with `STALE_FILE`;
- a new file needs a path that does not exist.

The registry changes in four ways:

- a successful edit records what the file now holds;
- a deletion forgets the file;
- a move through the workspace's history forgets every file;
- the reads of a failed run are dropped. A run's reads are staged and kept only when the run succeeds, together with the turns that made them.

The harness's own `readFile` (`createTrackedReadFile`) reads through the access policy, and reads the file once, so the hash it records is the content it showed. A partial read counts.

An edit returns little:

- a modification returns the lines around each change as the file now reads them, numbered, with two lines of context. At most 60 lines are shown, and the rest are counted;
- a creation returns its size;
- a deletion returns a confirmation;
- an error returns only what fixes the call.

Messages name a file only as the model wrote it.

**Context:** #79, the first part of #71. The [v2 plan](https://github.com/Mikode13/harness/issues/52#issuecomment-5984397266) for #52 decided the registry, the two errors and the shape of the responses, in its section 6. The rest is mine:

- staging a run's reads;
- keying by real path;
- forgetting everything on a move, rather than only the files the move wrote;
- the 60-line bound.

**Alternatives considered:**

- **Committing reads as they happen.** That is simpler, but after a failed run the model has not seen that content, and the registry would say it has.
- **Forgetting only the files a move touched.** That is more precise, but needs each move's file list, and an undone turn's reads were part of the conversation it no longer holds.
- **The public `readFile` over `Workspace`.** It reads through ripgrep or git, line by line. Recording its hash would mean reading the file twice, and the second read could differ from the first.

**Consequences:**

- After a move, or a failed run, the model reads a file again before editing it. That costs a call, and it never edits a version it did not see.
- Each role keeps its own registry, so a file the planner read is not read for the executor.
- Reads follow the policy's rules for every path, and the review of #82 tightened two of them.
  - **A path below a secret name inside a root is a secret.** `.env/x` used to be refused for running through `.env` when that file existed, and read as missing when it did not. Folders above the root do not count, so a workspace inside `.env.d` stays open.
    - This also closes a whole folder with a secret name, such as a Python virtual environment named `.env/`. Such a folder is usually ignored by git anyway. `allow` opens exact files only, so a host cannot open the folder whole.
  - **A path that runs through a file** is judged from where that file really is. Its links are resolved first, so it goes through the same outside, protected, secret and ignore checks as any other path. It is refused for running through a file only when nothing else refuses it. A path through a link out of the workspace, or into `.git`, gets the same answer whether its names exist or not.
  - **A filesystem error the policy or a read does not expect,** such as a loop of links or a file it may not open, is named by the model's path and its error code only.
- The tracked `readFile` splits lines as the diff of an edit does: on `\n`, dropping a `\r` before it. The line numbers of a read and of an edit's response always agree. A lone `\r` stays inside its line.
- The path convention is unchanged: a path is relative to the first root, or absolute for a file in another root. Tool responses, `showChanges` and the undo note already follow it. The system prompt that tells the model the roots arrives with the factories (#81).

## Each provider edits in its native format, on the one edit engine

tags: #mikode-harness #tools #llm

**Decision:** an editing agent writes files with the tool its provider's models were trained on:

- **OpenAI's `apply_patch`**: one `create_file`, `update_file` or `delete_file` operation per call, with V4A diffs.
- **Claude's text editor** (`text_editor_20250728`): `view`, `str_replace`, `create` and `insert`, plus our own `delete_file`.

Both formats become the same internal operations through `prepareTrackedEdit`, so the access policy, the recovery journal and the read checks apply the same way whatever the provider.

- **Declaring a native tool is internal.** A symbol on the definition (`asNative`) marks it, so `ToolDefinition` is unchanged for consumers and none of their tools can claim to be native. A client declares the tools it `supportsNative`. `LLMAgent` refuses one its client cannot declare when it is built, not on the first call.
- **OpenAI's items.** `apply_patch_call` becomes a tool call whose input is the operation. It goes back as the same item, and its result as `apply_patch_call_output`, `failed` when the call failed.
- **Claude's tool blocks.** The text editor's calls and results are ordinary `tool_use` and `tool_result` blocks, under the name Anthropic fixes, `str_replace_based_edit_tool`.
- **The V4A applier is ours** (`applyUpdate`). It applies each hunk after the one before it.
  - It finds a hunk's lines exactly, then ignoring trailing whitespace, then ignoring whitespace at either end, as Codex does.
  - Without an anchor, Codex takes the first match; here a hunk's lines must appear once in the part of the file it searches. When they do not, the error asks for an `@@` line naming the function, or more context.
  - An `@@` anchor is found first, and must appear once. Each nested `@@` after it, and the hunk's lines, are the first match that follows, as in Codex: the anchor already says where. So `@@ class B:` then `@@ def __init__(self):` reaches B's method even when C has the same one.
  - `*** End of File` ties a hunk to the end of the file, and nothing may follow it in that hunk.
  - A kept line stays as the file has it, even where the patch copied it with a space lost.
  - Every line the patch does not change keeps its own ending, so a file that mixes `\n` and `\r\n` is not rewritten. An added line ends like the removed line whose place it takes, or else like the line before it. The file keeps its final newline, or its lack of one.
  - A diff larger than 512 KB, or one with more than 500 hunks, is refused.
- **The text editor:**
  - `view` reads through the access policy and counts as a read. On a folder it lists the files in it through the read `Workspace`, so ignored files stay hidden.
  - `str_replace` needs the old text to appear exactly once. It is tried as sent first. Only when that finds nothing is text sent with `\n` tried with CRLF. Each bare `\n` in the new text is written with the ending of the line where the match sits, so a CRLF line gains no bare `\n`.
  - `create` makes only a file that does not exist. Anthropic's reference implementation overwrites, but here a file is changed only from a version the conversation read.

**Context:** #80, the second part of #71. The [v2 plan](https://github.com/Mikode13/harness/issues/52#issuecomment-5984397266) for #52 decided the native formats, that both translate into the same operations, that the V4A applier is ours, and that native declarations stay internal. `examples/edit-tools-wire-smoke.ts` verified both formats live with `gpt-5.6-luna` and `claude-sonnet-5`.

**Alternatives considered:**

- **One function-call edit tool for both providers.** Simpler, but the models are trained on their own tools, and the v2 plan chose the native formats.
- **A field `native` on `ToolDefinition`.** That type is public, so consumers could declare a native tool and receive provider operations in their own `execute`.
- **Applying a hunk at its first match**, as Codex does. That is more forgiving, but a context that appears twice can land the change in the wrong place without any error.

**Consequences:**

- An OpenAI executor has `readFile` beside `apply_patch`, because `apply_patch` cannot read. A Claude executor reads with `view`.
- A conversation that moves between providers keeps each call under its tool's name. A patch call sent to a client that does not offer `apply_patch` goes as a plain function call, and an `apply_patch_call` from a response that offered no such tool is logged and dropped.
- Which tools each role gets, and the system prompt that names the roots, come with the factories in #81.
- A folder `view` lists through the read `Workspace`, which covers the first root. #81 decides what a folder in another root shows.

## Each role gets its own tools, and every role of the model-backed orchestrator runs on the model APIs

tags: #mikode-harness #tools #orchestration #llm

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — the Anthropic summary of what was undone runs Claude Haiku 5.5 at `high`, as `gpt-5.6-luna` does, not Haiku 4.5 without thinking.

**Decision:** an agent's file tools come from `createFileTools(provider, workspace)`, and the consumer gives them to `createLLMAgent` beside its own tools:

- **OpenAI:** `listFiles`, `searchText`, `readFile` and its native `apply_patch`.
- **Anthropic:** `listFiles`, `searchText`, its native text editor and `delete_file`.

Without a `write` root they only read. `WorkspaceOptions` lists the roots, each `read` or `write`, the secret rules and where the history is kept.

- **`createLLMAgent({ workspace })`** follows the workspace's history. Its system prompt is followed by the roots and how to name a file in them.
  - **By default**, the note on what was undone carries a summary from the provider's cheap model: Claude Haiku without thinking, or `gpt-5.6-luna` at high effort. `summarizeUndone: false` turns it off.
  - **The history opens on first use,** so the factory stays synchronous.
- **`createLLMOrchestrator`** runs all three roles on the model APIs over one opened workspace. Without `workspace`, that is the current directory, read only.
  - The planner and reviewer get `listFiles`, `searchText`, `readFile` and `showChanges`.
  - The executor, an `LLMAgent`, gets its provider's file tools, `maxSteps` and `autoApprove`.
  - The summary comes from the planner's provider.
- **`OrchestratorAgent` creates one `RunContext` for a whole run.** That makes every round's writes one run of the history, and ties the planner's and reviewer's turns to it. It ends the context with the run, and its response names the run.
- **Every path the file tools touch goes through the access policy.**
  - **Closed files are hidden by name before a search counts anything.** A secret that `.gitignore` lets through is neither listed nor searched. The read workspace leaves out every file the policy closes by name (`hidesFromReading`: protected, or a secret the host did not open) before it stores or counts a match. So neither the page, nor `total`, nor the error at the 50,000 stored matches can answer whether a guess at a secret's contents was right.
    - The check is by name and synchronous: the candidates are already free of ignored files, and running the whole policy, with git, on every file would be too slow.
    - That filter is the whole policy for what `listFiles` and `searchText` return, which stays inside the root. The program that lists does not follow links, and links are not regular files.
    - Running `check` on every returned path cost one `git check-ignore` each: 18 seconds to list 1,000 files, found in the review of #84. It is gone. `readFile`, given any path the model writes, still goes through the whole policy.
  - The history's folder is made, then resolved to one real path, before the policy is built. The store and the policy name the same folder even when it is given through a link or as a relative path, and no tool reaches it when it lies inside a root.
  - `showChanges` for the model shows only what the role may read, and counts the rest.
- **The tool event narrates changes.** A tool call that changed a file reports the change as a unified `diff` on its `completed` event, and the CLI prints it.
- **The CLI's `--llm`** works on the current directory with a `write` root, and leaves `autoApprove` off. Its Agent SDK path keeps the permission bypass, because nobody answers those engines' own prompts there.

**Context:** #81, the last part of #71.

- **Decided earlier:** the tools per role, the shared run context, the summarizer's models and the live diff, in the issue and in the [v2 plan](https://github.com/Mikode13/harness/issues/52#issuecomment-5984397266).
- **The user then chose:**
  - that the consumer composes the file tools, not the factory;
  - that the summary is on by default;
  - that Haiku runs without thinking, since it accepts neither adaptive thinking nor an effort;
  - to keep #81 one pull request.
- **Mine:** the policy filter on the read tools, the hidden count in `showChanges`, the lazy history, and appending the workspace to a consumer's own prompt.

**Alternatives considered:**

- **The factory adds the file tools itself when given a workspace.** That is one option fewer, but the consumer could not choose the set. Rejected by the user.
- **The summary off by default.** That avoids an extra billed call after an undo, at the cost of a poorer note. The user chose on.
- **Haiku with a thinking budget, or Sonnet at low effort, for Anthropic summaries.** Both cost more for a short summary. Rejected by the user.
- **Splitting #81 into two pull requests.** That would mean smaller reviews but one more round. Rejected by the user.

**Consequences:**

- **Two collaborators, one store.** An agent from `createLLMAgent` and the tools from `createFileTools` each open the workspace's store, so they share its files on disk. The workspace lock keeps their writers apart.
- **Reading covers the first root.** `listFiles` and `searchText` read the first root only; a file in another root is read by its full path. A folder `view` in another root lists nothing.
- **Extra files in the state directory.** A workspace with no `write` root still opens its store, which creates its folder in the state directory.
- **Paid models.** The executor bills per token, like the other model API roles. `createOrchestrator` stays the Agent SDK path on the provider's login.
- **A breaking change to `createLLMOrchestrator`.** With the same options, its executor now:
  - bills per token through the model API;
  - writes nothing until a `write` root is given;
  - takes `autoApprove` as the harness's own approval, no longer as an Agent SDK permission bypass.

  The release needs `feat!:` and a `BREAKING CHANGE:` note, as #50 did when the planner and reviewer moved.

- **A caller's own role prompt** replaces our instructions and guidance, but is still followed by the workspace's roots, as in `createLLMAgent`. The model needs them to name a file.

## The executor runs configured commands by name, and each one's effects go to the history

tags: #mikode-harness #tools #recovery

**Decision:** with `commands`, `createFileTools` and `createLLMOrchestrator` give the executor `runCommand`, which runs one of the commands the consumer configured.

- **The consumer declares each command in code** (`Commands`): a fixed `executable`, its `args`, a `cwd` inside a `write` root, extra `env`, and optional limits. It runs without a shell, so no argument is read as shell syntax.
- **One tool, `runCommand`.** The model sends `{ command: { name, ...parameters } }`. Its schema is a union of one object per command, each with that command's parameters, and strict mode accepts it.
- **The model fills only typed parameters,** placed among the fixed arguments:
  - `paths`: each one checked by the access policy for reading, then given relative to the command's `cwd`. A path that would read as a flag is given as `./` and its name.
  - `choice`: one of the values the consumer listed, which may be flags.
  - `text`: a value that matches the consumer's pattern whole, at most 1,000 characters, and never starting with `-`.
- **A small environment.** A command inherits only `PATH`, `HOME`, `TMPDIR`, `USER`, `SHELL`, `LANG` and `LC_*`, plus the variables its definition sets. The provider keys never reach it.
- **Limits.** A command stops after 10 minutes by default; the model reads the last 16 KB of its output, standard output and error together. Its process group is asked to stop with `SIGTERM`, then killed after 5 seconds. What it left running in its group is stopped when it ends too. The group is confirmed gone by asking the system, never assumed.
- **Approval.** Every call is `destructive`, so it asks the approver unless `autoApprove`. `ApprovalRequest.command` shows the program, its arguments and its `cwd` as they will run. The CLI shows that line and remembers "always" per command name, not for every command.
- **A checkpoint around each command.** Formatters and tests write without our tools, so:
  1. Before it runs, every covered file is read and stored by content hash, with a manifest of them. The journal records an observation that names the manifest. If any of that fails, the command does not run.
  2. After it ends, the covered files are listed and read again. Each one that differs is recorded as its own change, `observedBy` the command, and the observation is closed with what it cost: files, bytes read, new bytes stored and time.
  3. This first version reads and hashes everything both times, trusting neither size nor modification time. The cost is kept with each observation, to measure before optimizing.
- **Coverage.** The covered files are those of the `write` roots that `.gitignore` does not exclude, tracked or not, less what the policy closes to writing by name: protected paths and secrets the host did not open for writing. Ignored files such as `node_modules`, files outside the roots, files over 64 MB, git history, the network and remote services are not covered. `showChanges` marks a change seen around a command apart from one a tool journaled.
- **Never a false completion.**
  - A timeout fails the call with its report.
  - A cancellation records what changed, then ends as the cancellation.
  - A program that cannot start reports that nothing ran.
  - When the group cannot be confirmed gone, what changed so far is recorded, the observation stays open, writing stops for the run, and the call fails.
- **An interrupted observation.** If the process dies while a command runs, the next run settles it: each file of the manifest that changed since is recorded as changed by that command. A file the command created was never in the manifest, and is missed.
- **If the harness exits while a command runs,** as on an uncaught exception, the command's group is killed on the way out. A harness killed by a signal gets no such chance, and the command runs on until it ends.
- **Not on Windows yet.** There is no process group to stop there, so `runCommand` cannot be built on Windows.
- **The CLI** reads its commands from `$XDG_CONFIG_HOME/mikode-harness/commands.json`, or `~/.config/mikode-harness/commands.json`, keyed by each repository's real path. It refuses that file inside the repository, where the agent could rewrite it.

**Context:** #72, the last feature of #52. The issue and the [v2 plan](https://github.com/Mikode13/harness/issues/52#issuecomment-5984397266) decided: no shell, typed arguments, a small environment, bounded duration and output, stopping the whole group, the checkpoint, approval, and no sandbox. The user then chose:

- commands declared in code, and for the CLI a file outside the repository;
- one `runCommand` tool rather than one tool per command;
- `paths`, `choice` and `text` parameters;
- 10 minutes and 16 KB as the defaults;
- an inherited base plus declared variables;
- a typed `command` field on `ApprovalRequest`;
- Windows left unsupported for now.

**Alternatives considered:**

- **A configuration file inside the repository.** It would travel with the repository, but a cloned repository, or the agent, would then decide what runs. Rejected by the user.
- **One tool per command.** Each would have a simpler schema, and "always" by tool name would already mean one command. The user chose one tool, which keeps the tool list fixed.
- **Only paths, or paths and choices.** Safer, but no test filter. The user chose to add patterned text, never starting with `-`.
- **Only declared variables, or inheriting more by name.** The first makes every command repeat `PATH` and `HOME`. The second would make the key protection depend on a name filter. Rejected by the user.
- **A generic `description` on `ApprovalRequest`.** More general, but text a consumer cannot reason about. Rejected by the user.
- **`taskkill /T /F` or Job Objects on Windows.** The first misses a process that leaves the tree; the second needs native code. Deferred.
- **Trusting size and modification time** to skip unchanged files. Faster, but a command can change a file and keep both. Deferred until the measurements say it is needed.
- **Keeping the last capture's contents** instead of freeing them, so the next command only reads and hashes. Much faster after the first command, at the cost of a lasting copy of the covered files in the state directory. The user chose to measure in #73 first.
- **One sync at the end of a capture,** instead of one per stored content. Faster, but Node has no `syncfs`, so it would weaken the store's rule that nothing returns before it is on disk. Rejected by the user for now.

**Consequences:**

- Each command reads every covered file twice, and stores each one it captures, with a sync, unless the store already holds that content. Measured on this repository (166 files, 1.4 MB, macOS), capturing took about 1.4 s and comparing 50 ms. Capturing runs 16 files at a time. A run that changed nothing frees what it captured, so the next command stores it all again. The cost of each observation is in the journal, to decide on.
- Folders a command creates are not recorded, so undoing it removes the files in them and leaves the folders.
- A command that writes outside the covered files, such as to `node_modules`, a build folder or a remote service, cannot be undone by the history.
- The user's edits made while a command runs are recorded as the command's.
- A command counts as one change towards the run's limit of 500, however many files it changes.
- `RunJournal` gains `observe`, `observed` and `storedBytes`, and `JournalEntry` gains `observedBy`. Journals written before read as before.

## Configured commands are trusted, not sandboxed

tags: #mikode-harness #tools #security

**Decision:** a configured command runs as the user, with everything the user's account can reach. The harness bounds how it is started, how long it runs and what it is given, but does not isolate it.

- **A test runs the repository's code,** including code the model has just written. It can read any file the user can, secrets included, write outside the roots and reach the network. The access policy of the file tools does not apply to it, and cannot be made to.
- **What the harness does control:** which programs run, with which arguments, in which folder, with which environment, for how long, and that the user approves each one. It also records what the command changed in the covered files.
- **The consumer chooses the commands,** and with them how much to trust the repository. The model only picks one by name and fills its declared parameters.

**Context:** decided by the user on 2026-10-06, in #52. Pi's documented argument applies: a partial sandbox would be read as a security boundary it is not, and anyone relying on it would trust it for more than it gives.

**Alternatives considered:**

- **An OS sandbox** (`sandbox-exec` on macOS, namespaces or seccomp on Linux). It differs per platform, and is deprecated on macOS. Toolchains need wide access to work, so a sandbox that lets them run would leave most of the risk.
- **Running the commands in a container.** A real boundary, but it needs a container runtime, and the user's toolchain set up inside it. That is out of scope for the harness.

**Consequences:**

- The docs say plainly that commands are trusted execution, and that their safety is the consumer's choice of commands and the user's approval.
- The secret rules of the file tools do not cover commands. A command can print a secret, which the model then reads in its output.

## The live run of #52 decided commands per role, 50 steps, a stop for loops, and each role's end

tags: #mikode-harness #tools #llm

partially superseded by: "The reviewer takes from the executor whether the tests pass, and is never told they did" (below) — the reviewer is no longer told that the tests passed; it takes that from the executor's response, and still does not run them.

**Decision:**

- **A command declares the roles that get it** (`roles`: `planner`, `executor`, `reviewer`), the executor by default.
  - Each role of `createLLMOrchestrator` gets `runCommand` with its own share.
  - The checkpoint runs whoever runs the command, and every call asks the approver.
  - `createFileTools` has no roles, so it offers every command.
- **`maxSteps` defaults to 50** for every role, up from 25.
- **A run stops when five answers in a row ask for exactly the same tool calls,** by tool and input, ids aside. It fails with `UnrecoverableError` before the fifth set runs, as at the step limit. A call repeated with anything else in between, such as tests run again after an edit, does not count.
- **`listFiles` and `searchText` explain their glob:** `*` stays inside one folder, and `**` crosses folders.
- **The executor finishes on green tests, and the reviewer reviews the code.**
  - The executor's instructions tell it to run the project's tests and checks before finishing, and to finish only when they pass, or to say which fail and why.
  - The reviewer's instructions tell it that the tests have already passed, and not to run them again. It judges the change against the request, and any issue it names: that the plan is right for it, and that the change fulfills it.
  - This refines "The reviewer judges like a senior engineer": the request still comes first. It also explains why the CLI's commands for this repository give `issue` to every role, but `test` and `check` only to the executor.

**Context:** the live run of #20 through `--llm`, the test #73 asked for, found three things:

- The planner tried to read the issue with the `issue` command, which only the executor had.
- The model took the glob `*` to be recursive.
- The executor finished its work, then hit the limit of 25 steps while still checking it, so the run failed and the reviewer never ran.

The user chose:

- that the executor's end of the loop is green tests, and that the reviewer reviews the code against the issue and the plan, without running the tests again;
- roles per command over read-only commands, so nothing depends on a command's promise not to write;
- 50 steps;
- the stop for five identical answers.

**Alternatives considered:**

- **Read-only commands for every role, without a checkpoint.** Cheaper, but "read only" would be the consumer's promise, which the harness cannot check. Rejected by the user.
- **A final call without tools at the step limit,** to end with a summary. It would change what `maxSteps` means. Not chosen.
- **Comparing the results of repeated calls too.** It would let a model poll something that changes, but a stuck model gets the same results anyway. The user kept the rule on calls alone; see when that stops being enough under Consequences.
- **Counting calls to the same tool, whatever their input.** It would catch a loop that changes its input a little each time, but reading five files, or applying five patches, in a row is ordinary work. A threshold high enough to spare that would catch little the step limit does not.
- **A `repeatable` flag on `Tool`,** to exempt a tool from the rule. Explicit, but a field more in the public contract, which a consumer has to know about. Not needed while the rule only catches identical calls.

**Consequences:**

- A planner or reviewer command shows in the history like the executor's, since every role shares the run.
- A run that loops spends at most five of its steps on the loop.
- **Where the loop rule would stop a run wrongly, and how to fix it.** It stops five identical calls in a row, by tool and input.
  - A tool designed well passes its position as input, such as a cursor or `fromLine`, so paging through results never trips it. The harness's own tools do.
  - **A tool that keeps hidden state,** such as `nextPage({})` with an internal cursor, would trip it while still making progress. The fix belongs in that tool: take the cursor as input.
  - **Polling something outside,** such as a command that reports CI status until it is done, sends the same call while the answer changes. Today that is a poll with no pause, since there is no tool to wait, and stopping it is no loss.
  - If a waiting tool is added, or polling becomes something a role should do, compare the results too. Then a run stops only when the same call returns the same result five times in a row. Hash each step's results beside its calls in `RepeatedCalls`, in `llmAgent.ts`.
- Changing the default from 25 to 50 changes behavior for every consumer that left `maxSteps` out, inside the breaking release of #52.

## Each role has its own step limit, which the consumer and the CLI can raise

tags: #mikode-harness #llm #orchestration

**Decision:**

- **Defaults per role:** 80 calls for the executor, and 65 for the planner and the reviewer. `createLLMAgent` and `LLMAgent` take one number, 65 by default.
- **`createLLMOrchestrator`'s `maxSteps`** takes one number for every role, or a number per role (`RoleSteps`), with no upper bound. A role left out keeps its default. A role that does not exist, such as a typo, is refused.
- **The CLI** reads its settings from `~/.config/mikode-harness/config.json`, keyed by the repository's real path: `commands` and `maxSteps`. That replaces `commands.json`, and the old shape is refused rather than misread.
- **Each step does more work, and the executor knows when to stop:**
  - The model API roles are told to ask for several files or searches in one answer, because each answer is a step.
  - The executor is told to finish as soon as the tests and checks pass and the plan is carried out, without adding work beyond the plan, because the reviewer asks for what is missing.

**Context:** the second live run of #20, after #88, ended the same way as the first. The executor's work was green, and it went on polishing until it hit the limit of 50. That run's learnings are in [`learnings.md`](learnings.md). The user chose:

- to raise the defaults, to 80 for the executor and 65 for the others;
- to make the limits configurable, per role, from the API and the CLI, with no upper bound;
- to tell the executor when it is done;
- to ask for reads in parallel.

**Alternatives considered:**

- **One number, raised again.** It needs one change, but every task larger than the last one would need another raise, and nobody could adjust it without a release.
- **A final call without tools at the limit.** It would keep a nearly finished run, but changes what `maxSteps` means. Not chosen again.
- **The limit only through the API.** The CLI would stay on the defaults, and the live runs that found the problem could not raise it.

**Consequences:**

- `maxSteps` used to reach only the executor; now one number applies to every role. That is a change of behavior inside #52's breaking release.
- `RoleSteps` joins the public API.
- The CLI's users move their `commands.json` to `config.json`, under `commands`.

## A consumer narrows a model and an effort per provider, with one pair of narrowers per path

tags: #mikode-harness #public-api #provider-integration

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — Claude Haiku now takes an effort on the model API, so it is no longer an example of a pair refused when the agent is built.

**Decision:** `src/index.ts` exports the models and efforts each provider takes, on each path, and narrowers built on them:

| Path                         | Lists                                  | Narrowers                                                                  |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Agent SDK (`createAgent`)    | `agentModels`, `agentReasoningEfforts` | `isModelOf(provider, value)`, `isReasoningEffortOf(provider, value)`       |
| Model API (`createLLMAgent`) | `llmModels`, `llmReasoningEfforts`     | `isLLMModelOf(provider, value)`, `isLLMReasoningEffortOf(provider, value)` |

- **The lists are the arrays the engines and clients already validate against,** so adding a model is still a change in one file.
- **Each pair lives beside its path's factory:** `agentFactory.ts` and `agentLLMFactory.ts`.
- **A narrower narrows to that provider's union,** so a consumer drops its cast.
- **Each narrower checks one value.** A pair can still be refused when the agent is built, such as `gpt-5.6-luna` with `ultra`, or any effort for Claude Haiku on the model API. So is a value that skips the narrowers.
- **The two paths keep their own lists,** as "Providers are named after the company" decided. Today they hold the same names except Codex's `ultra`, and a test fails if they drift apart.

**Context:** #20. "Stable publication starts at `1.0.0`" deferred a model narrower until a consumer needed one, and harness-cli does. The harness's own executor wrote it through `--llm`, as the live test of #52.

- In the first run, the executor took a list, as in `isModelOf(agentModels[provider], value)`. The user chose the provider instead, with one pair of functions per path.
- The third run, which the reviewer approved, built that shape.

**Alternatives considered:**

- **A list as the first argument.** One pair serves both paths, but it is a renamed `isOneOf`, and a consumer can pass the wrong list. Rejected by the user.
- **One pair with a path option,** such as `isModelOf(provider, value, { path: 'llm' })`. That is one parameter more on every call, against one function more per path. The user chose two functions.
- **One list per provider for both paths.** It would remove the drift, but `src/llm` would then import the engines it replaces.

**Consequences:** additive, so it would ship as a minor change on its own. Four functions and four lists join the public API. A model added to one path only has to change the drift test on purpose.

## Prose files show their long lines whole

tags: #mikode-harness #tools

**Decision:**

- **The limit depends on the file.** A line the model reads is cut at 5,000 characters in Markdown and plain text (`.md`, `.markdown`, `.mdx`, `.txt`), and at 300 in every other file.
- **One limit for every tool.** `readFile`, Claude's `view`, the matches `searchText` returns and the lines an edit returns all use the same per-file limit, from `maxLineLength` in `src/tools/domain/lineLength.ts`.
- **A cut line is still marked,** with `…` and a count, as before.

**Context:** in the third live run, 9 of 22 patches failed. The model's reasoning shows why for about four of them: the rows of the module table in `docs/architecture.md` are up to 3,217 characters long. Cut at 300, a row could not be copied into a patch's context, so the patch never matched. Measured in this repository, `docs/architecture.md` has 12 lines over 300 characters and `docs/decisions.md` has 187, against 3 in every TypeScript file together. Long lines are a property of prose, which keeps a paragraph or a table row on one line. The cut exists for code, where one line can be a whole minified bundle. See [`learnings.md`](learnings.md).

**Alternatives considered:**

- **No cut for small ranges, in any file.** Rejected by the user: a minified file is a single line, so reading a small range protects nothing.
- **No cut at all in prose files.** That would solve the case seen, but a generated Markdown file with enormous lines could fill the context. 5,000 characters covers the longest line here and still bounds that.
- **A linter that keeps prose lines short.** It would only help the repositories that adopt it, not any project the harness works on.

**Consequences:**

- A prose line up to 5,000 characters can be copied into an edit, so `apply_patch` and `str_replace` can change it.
- A page of 200 prose lines can now be about 16 times larger than before, at worst.
- Long lines in code, such as a long string literal or a JSON fixture, are still cut at 300, and cannot be patched whole.

## Each role is told whether the tests were run

tags: #mikode-harness #orchestration #llm

partially superseded by: "The reviewer takes from the executor whether the tests pass, and is never told they did" (below) — with a command, the reviewer is no longer told that the tests passed; the version without one is unchanged.

**Decision:**

- **Two versions of the executor's and the reviewer's instructions,** chosen by `createLLMOrchestrator` when it builds the roles.
  - **The executor has a command** (`runCommand` is among its tools): the executor finishes only once the tests and checks pass, and the reviewer is told they passed and not to run them again, as in "The live run of #52 decided commands per role, 50 steps, a stop for loops, and each role's end".
  - **The executor has none:** the executor is told it cannot run the tests or checks, finishes once the plan is carried out, and says in its summary that they were not run. The reviewer is told nobody ran them, judges from the code whether the tests would pass, and does not approve a change whose tests could not.
- **Any command counts.** The harness cannot tell which command runs the tests, so an executor with only `issue` gets the first version.
- **The Agent SDK path keeps the first version.** Its executor has a shell, so it can always run them.
- **A caller's `systemPrompts` still replaces either version** word for word.

**Context:** the AI review of #93 found that, without `commands`, the executor was told to finish only on passing tests it had no way to run, and the reviewer to trust that they had passed. That is the default configuration of `createLLMOrchestrator`. The executor would spend its steps looking for a way to test, or finish without testing, and the reviewer would approve on a false premise.

**Alternatives considered:**

- **One wording that holds in both cases**, such as "if you have a command that runs the tests…". It is cheaper, with no branch and one text per role. The user chose two versions, which are more precise and spend no words on the case that does not apply.
- **Leave it for an issue.** It would have shipped the false premise in the release that adds commands.

**Consequences:**

- Each of the two roles has two texts, both tested through the factory.
- An executor whose commands do not include the tests is still told to run them. Telling those cases apart would need commands to declare what they are for.

---

## Issue #89: progress is concise, attributed, and still useful live

tags: #mikode-harness #progress #cli #orchestration

**Decision:**

- A tool owns its short `summary`. The harness computes it once from the model's validated input
  and reuses it for the call's progress events. If a consumer-provided `summarize` fails
  irrecoverably, that failure ends the call before preparation, approval, or execution can leave
  ambiguous side effects.
- `OrchestratorAgent` is authoritative about roles. It uses object spread to make one shallow
  options copy per role, retaining own enumerable string- and symbol-keyed properties, including
  the signal, approval callback, future fields and shared run context, and wraps only `onProgress`
  to overwrite any inner role label.
- The CLI prints one final line per tool, keeps active calls in a spinner, dims operational and
  reasoning text, and supports `--thinking-headings` for heading-only reasoning. A completed write
  keeps its live unified diff below that line.
- A configured command that exits non-zero is a tool error result carrying its `exitCode`. This
  reverses the earlier #72 behaviour that treated such an exit as a successful tool result: the
  model must now see the failure while the progress stream narrates its code.
- The default planner, executor, and reviewer instructions require concise, professional
  communication and stop routine narration. `systemPrompts` continues to replace those defaults
  word for word for consumers that need their own instructions.
- Every OpenAI model-API request asks for a `concise` reasoning summary instead of leaving its
  length on `auto`. This affects both `createLLMAgent` and `createLLMOrchestrator`; the summary is
  optional narration, while the opaque reasoning item used for replay is unchanged.

**Context:** the live validation of #89 needed progress that distinguished the acting role and
the operation without flooding a terminal, while preserving the information needed to understand
file changes and command failures. The summary belongs to the tool rather than the renderer so
every consumer receives the same call description, and role labels belong to the orchestrator
rather than nested agents so an inner value cannot be misleading. Live validation found that
OpenAI's `auto` summaries still narrated routine intentions despite the concise role instructions.
One minimal live request confirmed that `concise` is accepted by each catalogued OpenAI model:
`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-luna` and `gpt-5.6-terra`.

**Alternatives considered:**

- **Let the formatter derive summaries, or retry a failing summarizer.** Rejected: rendering
  would need tool-specific input knowledge, and retrying consumer code after a provider turn could
  replay side effects.
- **Trust role labels from each nested agent.** Rejected: a role's progress must remain
  attributable across retries and later rounds.
- **Drop diffs, or print every active event as a line.** Rejected: the first loses the live view
  of writes, while the second scrolls a terminal and hides the useful final state.
- **Treat a non-zero command exit as successful output, as #72 did.** Rejected: the model needs
  an error result to correct its next action, with the code retained as narration.
- **Keep OpenAI reasoning summaries on `auto` and hide them only in the CLI.** Rejected: hiding
  them changes presentation but still generates and bills narration that live validation found
  unnecessarily long.

**Consequences:** consumers can render a stable tool lifecycle without knowing tool inputs, and
the CLI remains readable in both normal and heading-only thinking modes. A new option field
continues through the orchestrator without another forwarding change, while role attribution
remains presentation metadata rather than a value supplied by a provider.

## Each call to the model is narrated as a step, with what it sent

tags: #mikode-harness #llm #progress

**Decision:**

- **A `step` `ProgressEvent`.** `LLMAgent` emits one after each call to the model whose answer the client returns, once the call's tokens are counted. That includes an answer the model stopped early, which was billed too. It carries the step number, the call's `tokens` when the provider reported them, and a `StepContext`.
- **A billed answer the client turns into an error is a step too,** such as Claude's `model_context_window_exceeded`: the failure carries what the call spent, and the step carries the same. A request the provider refused before answering spent nothing and is not a step. The cheap summary of what an undo left behind is not a step either, since it is not a call of the run's own model, so after an undo the steps add up to less than the run's total, which stays the authority.
- **`StepContext` counts characters by where they come from:**
  - the system prompt and the tool definitions;
  - the text of prompts and answers;
  - reasoning sent back: only the client's own signed or encrypted blocks, which hold the readable text, since a client drops readable reasoning and another provider's blocks;
  - the input of the tool calls;
  - each tool's results, largest first;
  - the five largest single results, each named by the summary its call got when it ran.
- **Characters, not tokens.** The harness does not tokenize, and the provider's count arrives with the answer. The breakdown says what fills the context; `tokens` says what it cost.
- **Measuring never runs a consumer's summarizer again.** `LLMAgent` keeps the summary each call got when it ran, so a call resent on every step is summarized once.
- **The CLI writes the events to a file** with `--steps <file>`, one JSON line each, and does not print them.

**Context:** #100. The `--llm` run of #22 and #98 resent about 122k tokens of context on each of its 140 steps, and only its total was known. Reading the log showed some causes, such as the architecture document and 25 outputs of `check`, but not how much each weighed. Every lever in #100 needs a before and an after to compare on the same benchmark.

**Alternatives considered:**

- **A debug log behind an environment variable.** It changes no public type, but only this repository could measure. The user chose a public event, which #89 and job-search can use too.
- **Counting tokens per part with a tokenizer.** It would be exact, but per provider, and it would add a dependency. Characters are enough to rank what fills a context.

**Consequences:**

- A `feat`: a new event type, which consumers that switch exhaustively over `ProgressEvent` must ignore, as the type tells them.
- Measuring walks the whole context once per step, which is linear in its size and small next to the call itself.
- `LLMClient` gained an optional `systemPrompt`, which both clients already held, and `providerDataSource`, the one source each sends back.

## A model-backed agent can ask its user what is theirs to decide

tags: #mikode-harness #llm #tools #api-design

**Decision:**

- **`RunOptions.ask`, an `Asker`.** It works like `approve`: a callback per run. It receives one to four `UserQuestion`s, each with two to four options and `multiSelect`, and answers each in order, with an option's label or with the user's own words.
- **`askUser`, the agent's own tool,** offered only in a run given `ask`. `LLMAgent` owns it, as it owns approval, because the answer belongs to the run, not to the agent. A consumer's own tool named `askUser` wins: the agent then offers its own in no run, so the two never meet, and a consumer that already had one keeps building its agent.
- **When to ask is in the tool's description,** so it holds for any agent that has the tool: the shape of a public API or of anything other code depends on, a new dependency, behaviour the request does not ask for, and choices with real trade-offs. Before building on the choice, all questions in one call, and not what the repository or a reasonable default answers.
- **Every role of `createLLMOrchestrator` can ask,** because `OrchestratorAgent` passes each role the run's options.
- **A retry keeps the user's answers.** `RetryingAgent` wraps `ask` with `rememberAnswers` for the whole run: a question asked again with the same words gets the answer already given, and the retried prompt lists what the user answered, so the model does not ask again in other words. The user chose this over asking again, which costs them the same answers twice, and over not retrying after a question, which would give up on a failure a retry fixes.
- **Questions the model wrote wrong go back to it,** with what to fix. An asker that throws, or that does not answer each question with some text, is host code and ends the run with an `UnrecoverableError`.
- **The CLI asks in the terminal.** It numbers the options, and the user answers with a number, several separated by commas for a `multiSelect` question, or in their own words. With piped input it reads nothing and tells the model to decide and say what it assumed.

**Context:** #100. In the `--llm` run of #22 and #98, the planner decided by itself what the user should have: about 20 public exports, the workflow's transitions, its retry policy, and a `decisions.md` entry as if it were the user's. The executor then spent 140 steps building a design nobody had approved. A question at planning time costs one step with a small context; a wrong decision costs the whole run.

The user chose:

- several questions with options, which gathers the doubts into one step and gives the user ordered choices;
- no tool without `ask`. A run with nobody to answer is the one-shot mode CI uses, so an interactive run always has someone;
- all three roles;
- the criteria in the tool's description, not in the orchestrator's instructions, which wait for #22.

**Alternatives considered:**

- **One question per call, or free text.** Simpler to show, but more steps, or choices the user has to work out.
- **A tool that answers "nobody" without `ask`.** It mirrors `approve`, but costs a step and a tool definition every time.
- **The criteria in the planner's instructions.** Stronger for the planner, but they would change the orchestrator before #22.

**Consequences:**

- A `feat`: `RunOptions.ask` and the `Asker`, `UserQuestion` and `QuestionOption` types are new. Nothing is refused: a consumer's tool named `askUser` keeps working, and such an agent does not offer its own.
- A run with `ask` sends one more tool definition on every step.
- Whether the model asks well, neither too much nor too little, is measured by the benchmark of #100, not by the offline tests.

## One read or search returns at most 16 KB, and only the planner learns the repository

tags: #mikode-harness #tools #llm #orchestration

**Decision:**

- **A byte limit as well as a line limit.** `readFile`, in both its versions, and `searchText` return at most 16 KB per call, in whole lines. A read cut short says which lines it showed and where to continue; a search says how many matches it showed and asks to narrow the pattern, the path or the glob. The first line is always shown. Cut by `cutLine`, a line holds at most 5,000 UTF-16 units, so it never exceeds the limit on its own.
- **Each role has its own guidance,** sent after the workspace's roots:
  - **the planner** starts with `AGENTS.md`, which says where the architecture and the decisions are, reads only the parts its task needs, and names in the plan every file to change and what to change in it;
  - **the executor** works from the plan: it reads the files the plan names and only what it needs to change them, and does not study the architecture or the decisions, which the plan already applied;
  - **the reviewer** works from the plan and the changes, and reads what they touch.
- A caller's own `systemPrompts` replaces the guidance, as before.

**Context:** #100. In the benchmark run of #20 on 2026-10-13, one `readFile` of `docs/architecture.md:1-200` brought 53 KB and one `searchText` in `docs/decisions.md` 40 KB. The guidance told every role to start with `AGENTS.md` and the architecture document, so the planner and the executor both read the first 53 KB. Every result stays in the context and is resent on every later step: reads were 38% of the executor's context at its largest.

The user chose 16 KB, the same as a command's output. The user also set the roles' boundary: the planner reads `AGENTS.md`, which must say where the architecture and the decisions are, or something is wrong; the executor and the reviewer receive a plan, and the executor does what the plan says where it says it, without having to understand the architecture.

**Alternatives considered:**

- **32 KB.** Fewer reads for the same file, but half the saving: the architecture document would still bring 32 KB at once.
- **8 KB.** More saving per read, but prose files would take several reads, and every read is a step that resends the whole context.
- **Keep one guidance for all roles, telling them to search the architecture instead of reading it.** It would cut the read, but keep the executor studying the repository, which is the planner's job.

**Consequences:**

- A plan that leaves the executor guessing shows up as an executor that searches, and is the planner's to fix.
- The orchestrator still sends the executor the original request beside the plan. Sending it only the plan is part of the workflows of #22.

## The provider compacts a conversation, only when asked, and the harness never edits it

tags: #mikode-harness #llm #cost

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — `haiku` names Claude Haiku 5.5, which compacts, so its client no longer refuses `compactAt`.

**Decision:**

- **Compaction is the provider's own.** With `compactAt`, the OpenAI client sends `context_management` with a `compaction` threshold, and the Claude client the `compact_20260112` edit under the `compact-2026-01-12` beta. The provider compacts inside the call that passes the threshold and answers with its summary first. The harness never removes or rewrites a part of the context itself.
- **Off by default.** `createLLMAgent` takes one `compactAt`; `createLLMOrchestrator` takes one for every role or one per role, as `maxSteps`; the CLI reads it from the user's configuration. A role without one is never compacted. Each client rejects what its provider cannot take: on Anthropic a threshold under 50,000, and Claude Haiku, whose alias names Haiku 4.5.
- **The conversation keeps every turn.** The summary is a `compaction` part, labelled with its client's source like a `providerData` part. That client sends the conversation from its latest compaction on; another provider's client leaves the part out and sends every turn, so a hand-off between providers loses nothing but the summary.
- **A step narrates what its call sent:** after a compaction, the summary counts as `messages`, and nothing before it counts.
- **Anthropic's compaction is in the usage.** Its top-level counts leave the compaction out, so the client sums `usage.iterations`. The Claude client uses the beta surface for every call, sending the beta header only with `compactAt`, and then marks the system prompt for the cache, which would otherwise not survive the summary.

**Context:** #100 and #48. Compaction of our own (#107) cleared stale tool results and old reasoning once a run's prompt passed `compactAt`. In the benchmark run of #20 at 64k it read 3.10M cached tokens against 1.70M without it, and wrote 561k against 147k: each clearing changed the prefix, so the provider cached it again from there, and the executor read again what had been cleared, in 54 calls against 28. Signed and encrypted reasoning can only be kept or dropped, never edited.

The user's view: the provider knows how to keep its own cache and signed blocks, and the harness would only lose money competing with it. On 2026-10-17 the same run with OpenAI's compaction at 64k compacted the executor once, at 67k: that call reported 67k uncached input tokens, the context fell to 6k, and the executor read nothing again, in 28 calls. It cost about 14% more than not compacting, against about 100% more for ours. The run of #20 never needs compaction at a sensible threshold: the executor peaked at 75k.

**Alternatives considered:**

- **Our own clearing, #107.** Measured above: it rewrites the cache on every clearing.
- **A summarizer of our own.** It would rewrite the whole context with a summary the model did not write, and drop every signed block.
- **Anthropic's compaction on demand** (`compact-2026-09-04`). It lets the caller choose when and keep recent turns, but needs a compaction loop and a newer SDK. Threshold compaction matches OpenAI's, inside an ordinary call.
- **A default threshold now.** Left to the user, after measuring on a task whose context outgrows a sensible threshold.

**Consequences:**

- On OpenAI the call that compacted reported its whole input uncached; Anthropic reports the compaction's own cache reads, not yet measured. Compaction pays only where the context would otherwise keep growing, well past what a task needs.
- OpenAI's usage has no breakdown of the compaction: whether the summary's generation is in it is unknown.
- On Claude Fable 5.1, Opus 5.5 and Sonnet 5.5, thinking from before a compaction is not carried forward: the summary is all the model has of it.
- Marking what to keep before a compaction, by the user or by Jev, can come later: where the call that compacts already loses its cache, changing the context just before it costs no cache of its own.

---

## A workflow is a chain of stages, each with an agent and a context of its own

tags: #mikode-harness #workflow #api-design

**Decision:**

- **A workflow works like a middleware chain.** Each stage has a function that creates its agent, a `prompt` built from the stage's input, a `Validator` for the agent's JSON answer, and a `transition` that receives the valid answer and the stage's own input. A stage's agent starts with an empty context and builds its own conversation; only the transition's `input` crosses into the next stage.
- **A stage's agent lives as long as the run.** It is created the first time the stage runs; when the run comes back to the stage, the same agent goes on with its conversation, and the next run creates another. Two runs, even at once, never share a conversation. The workflow records what crossed each stage, its input, output, attempts, usage and transition, in `WorkflowResult.stages`.
- **The types check the chain.** The consumer declares a map from each stage's name to what it receives, and `defineWorkflowStages` binds the stages to it. A `go` to a stage that does not exist, or with an input that stage does not take, does not compile, and neither does a workflow that leaves a stage out. The transitions are `go`, `stop` and `complete`: a typed destination makes `continue`, `skip` and `handoff` the same thing.
- **The validator is the reviewer's own.** `Validator<T>` moves from `src/orchestration/` to `src/shared/` and is exported. A Zod schema fits it with `safeParse(value).data`. An answer that is not JSON or not valid is asked for again with the reason appended, up to `maxAttempts`, as the orchestrator already does for the reviewer.
- **A stop is a result, a failure is a rejection.** `WorkflowResult.status` is `'completed'` or `'stopped'`; every failure rejects with a classified error carrying what the run spent.
- **Progress is two new event types,** `workflowStage` and `workflowTransition`. The agents' own events pass through unchanged, with no stage field: stages run one at a time, so the order tells them apart.
- **A timeout is the consumer's signal.** `AbortSignal.timeout` aborts with a `TimeoutError`, which `isAbortError` now recognizes beside `AbortError`, so a timeout is a cancellation for every agent, not only a workflow.

**Context:** #22. The harness attempted #22 itself in the 2026-10-17 benchmark, twice, at 160 executor steps. One attempt, "compact", typed each stage and checked the stage graph in a factory. The other, "plain", added input and output validators at every boundary, a timeout option and its own progress callback type. This design starts from compact, with plain's stage reports and its tests for timeouts and concurrent runs.

What the user wants from the harness: it does not ship every kind of agent. Its consumers, the CLI and job-search, build and compose their own, and the harness absorbs every problem of talking to an AI. That makes its API simple, with types a consumer understands and good documentation, not a minimal count of exports: five things that each do a lot are harder to use. Breaking changes are acceptable now, before the CLI is brought up to date.

How the user sees a workflow's context: like the orchestrator's roles, each agent has a conversation of its own. When a stage ends, its result is what the next stage starts from, not the original prompt. A round back to a stage goes on with the agent it already created. The workflow knows everything that happened, which is what the Session Manager (#29) will store.

**Alternatives considered:**

- **One agent per stage, built once with the workflow,** as in both attempts. A second run's stages would see the first run's conversation, and two runs at once would write to the same one.
- **A new agent every time a stage runs.** Every stage would start clean, but a stage the run comes back to would forget its previous attempt, which would then have to travel in the input.
- **Names as plain strings,** as in both attempts. A `go` to a misspelled stage, or with an input the stage does not take, would compile and fail silently at runtime.
- **Plain's validators on every stage's input.** With the map of stage inputs, the types check what a runtime validator would; it would only add code.
- **A `stage` field on every existing event,** compact's way. It touches all eleven existing event types for a parallelism the workflow does not have, and it would not tell parallel explorers apart either: they would all run inside one stage.
- **A `timeoutMs` option.** It duplicates what the signal already does, and only for workflows.

**Consequences:**

- The planner's explorers, the next work in this release, must give progress events an origin that tells parallel agents apart; today `agent` names only the orchestrator's three roles.
- A stage's agent conversation, its tool calls and reasoning, stays in the agent and ends with the run. Storing it is the Session Manager's.
- A stage whose agent cannot be built, for example with a model its provider does not support, fails when the run first reaches it, not when the workflow is built.
- A host callback, such as an `ask`, that throws its own `TimeoutError` now passes through as a cancellation, as its own `AbortError` already did.
- `OrchestratorAgent` still runs the fixed planner → executor → reviewer loop. It is retired once that loop is a workflow, not in this change.

## A Claude answer is streamed, so it can be 64,000 tokens long

tags: #mikode-harness #provider-integration #llm

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — `haiku` names Claude Haiku 5.5, so the limit is no longer the most the smallest model writes. It stays at 64,000 because no answer has needed more.

**Decision:**

- **`max_tokens` is 64,000 on every Claude model.** Adaptive thinking spends from the same budget as the answer, so a hard step at a high effort can need most of it. 64,000 is the most Claude Haiku 4.5 writes, so one value fits every alias; the other models write up to 128,000. A higher limit costs nothing until it is used: Anthropic bills the tokens written, and its output rate limit counts only those, not `max_tokens`.
- **The request is streamed.** The SDK refuses more than about 21,000 output tokens on a request that is not streamed, because it could outlast the ten-minute timeout. The client calls `beta.messages.stream()` and awaits `finalMessage()`, so `LLMClient` still returns the whole answer and nothing above the client changes.
- **A stream that breaks off is recoverable.** Once the stream has its response, the SDK reports any failure, such as a connection lost halfway, as an `AnthropicError` that is not an `APIError`. Before that, such an error is the SDK refusing to send and stays unrecoverable. An error event the API sends mid-stream, such as an overload, is an `APIError` and is classified as before.
- **A broken stream's usage is unreported.** Claude may already have written, and billed, part of the answer, and the client never receives its count, so the run's total becomes unknown instead of counting the call as free.

**Context:** on 2026-10-17 the benchmark of #22 with a Claude Haiku 5.5 executor at `xhigh` stopped both of its runs with `truncated`, after $0.78 and $1.01: one call reached the 16,000 tokens the client allowed. The limit was set at 16,000 only because the request was not streamed; see "The Claude client follows the OpenAI client's rules, and the model contract held".

**Alternatives considered:**

- **Each model's own maximum, 128,000 except Haiku 4.5.** No answer in the benchmarks has needed more than 64,000. An answer that runs away writes until the limit, which at 128,000 costs Opus 5.5 $2.56 for that one call.
- **The most a request without a stream allows, about 21,000.** It depends on the SDK's estimate of its timeout, and the step that was cut off can need more.
- **Narrating the text as it streams.** `LLMClient` would need a method that returns events. Nothing consumes text before the answer ends, so it stays out, as in "`LLMClient` does not stream" in the architecture.
- **`max_tokens` as an option.** Still deferred until a consumer needs to vary it.

**Consequences:** an answer that runs away costs up to four times what it did at 16,000 before it stops as `truncated`. The test fakes of the Anthropic SDK answer through `stream()`, and the tests of a broken stream use the real SDK over a fake `fetch`, so a change to how the SDK reports a stream failure fails there. The OpenAI client is unchanged: it sets no output limit, and its SDK refuses no request for lacking a stream.

## The planner and the reviewer send cheaper explorers, all at once, through a tool

tags: #mikode-harness #agent-loops #cost

partially superseded by: "Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic" (below) — an explorer on Claude runs Claude Haiku 5.5 at `medium`, not Haiku 4.5.

**Decision:**

- **`explore` is a tool of the planner and the reviewer.** One call takes up to 4 questions and runs one explorer per question, all at once, inside the tool, then returns their reports in order, each under its question. The agent loop still runs a turn's tool calls one at a time.
- **An explorer is a new agent for each question.** It runs on its role's provider's cheaper model, Claude Haiku 4.5 or `gpt-5.6-luna` at `medium`. It has only `listFiles`, `searchText` and `readFile`, at most 30 steps, and starts from its question alone. Its instructions tell it to report what it found, with files and lines, and not to plan.
- **It works inside the role's run.** It shares the run's context, so its reads belong to that run. Its usage counts in the run's, whether it answered or failed. A failure becomes its report, so the other explorers' reports are kept. A cancellation ends the call. A report is cut at 16,000 characters, like a read.
- **A tool call that works on the model gets the run's usage and narration.** `ToolCallContext` carries the call's id, a `spend` that adds tokens to the run, and an `onProgress` that never throws. A callback that fails while a tool narrates ends the run once the tool returns, because `LLMAgent` turns any failure inside a tool into a result for the model.
- **Each explorer's events arrive wrapped.** The wrapper is a new `subagent` event, carrying the call's id, the explorer's number and its question, so the events of explorers running in parallel stay apart. `OrchestratorAgent` stamps the wrapper with the role, as it stamps every event. The CLI shows only the explorers' tool calls, as `planner › explorer 2`.
- **The roles are told to explore first.** The guidance of the planner and the reviewer asks them to send the independent questions they have in one call, and to read themselves only what they must see exactly. They keep their own reading tools.

**Context:** the flow the user designed on 2026-10-12 has a planner that can call a cheaper, read-only explorer, and a reviewer that can too. The benchmarks of 2026-10-17 put the planner and the reviewer at 70% to 80% of a run's cost: the most expensive model reads the repository itself, and fills its own context with it. On 2026-10-18 the user asked for the explorers, with an origin on their events that tells parallel explorers apart. `OrchestratorAgent` is unchanged: the tool is given by the factory.

**Alternatives considered:**

- **Running a turn's tool calls in parallel in the agent loop.** Every tool would gain parallelism, but approvals, the order of narration and what a cancellation leaves half done would all change. Parallel explorers inside one tool need none of that.
- **An `explorer` value of `ProgressAgent`.** It does not tell two explorers apart, and widening the union breaks a consumer's exhaustive `switch`.
- **An origin field on every event.** Every event type would change, for an origin that only subagents have.
- **Explorers on the role's own model.** They would save the role's context, but not its price per token.
- **Keeping an explorer's conversation across calls.** Each question stands on its own, and a long conversation is what the explorers exist to avoid.
- **Choosing the explorers' model in the options.** Deferred until a consumer needs it: the cheaper model of each provider is the point of the tool.

**Consequences:**

- Whether the explorers make a run cheaper is not measured yet. It takes a paid benchmark, which the user decides.
- An explorer can be wrong, and the role acts on its report. The tool tells the role to read a file itself when it needs the exact text.
- A callback that fails while the explorers run ends the run only once all of them finish, so they spend until then.
- `subagent` is a new `ProgressEvent` type, which is a minor release. A consumer that ignores unknown types sees none of the explorers' narration.

## The edits run the consumer's formatter on each file they write

tags: #mikode-harness #tools #cost

**Decision:**

- **A `formatter` option.** `createLLMOrchestrator` and `createFileTools` take a `Formatter`: an `executable`, its `args`, and optionally `cwd`, `env` and `timeoutMs`. The file's path is always its last argument, relative to `cwd`, so `pnpm exec prettier --write --ignore-unknown` works as it is. The CLI reads it from the repository's `formatter` setting.
- **It runs after the write, on the written file.** Every create or change of the edit tools writes the model's content, then runs the formatter on that file. A delete does not. The edit returns the file as the formatter left it, and the conversation knows that version, so the next edit needs no read.
- **It is recorded like a command.** Only that file is captured around it, and what it changed there is a change `observedBy` the formatter in the history, so `undo` takes back both. It runs without a shell, in the small environment of a command, and has 1 minute per file by default.
- **A failure leaves the file as written.** A formatter that exits with an error, runs past its limit or cannot start does not fail the edit: the model is told, with the last 4 KB of the formatter's output, and reads the file as it is. Only a formatter whose changes cannot be recorded, or that cannot be stopped, fails the edit and stops writing for the run, as such a command does.

**Context:** step 2 of #100. In the `--llm` run of #22 and #98, 28 of 89 `apply_patch` calls failed, and the reasoning named a `format` that had rewritten a file after it was read as one of the causes. In the benchmarks of 2026-10-14 to 2026-10-17 the OpenAI executor still failed 13% to 32% of its patches. The reasoning after 11 of those 64 failures mentioned formatting, a weak signal because only its headings were kept. Each failure is a step that resends the context. On 2026-10-18 the user chose an option of the factories with an executable and its arguments, running after the write, and a file left as written when the formatter fails.

**Alternatives considered:**

- **Marking a configured command as the formatter.** It needs no new option, but only the CLI's configuration has commands by name, and an API consumer would get nothing.
- **A callback that formats the content in memory.** It is the most flexible, but it is consumer code inside every edit, and its failure would end the run as a host failure.
- **Formatting before the write, through standard input.** One write instead of two, but only formatters that read standard input would work.
- **Failing the edit when the formatter fails.** The model would retry an edit that was applied. A formatter that fails on a file mid-change, for a syntax error, would block every step towards fixing it.
- **Capturing every covered file around the formatter, as around a command.** It would record whatever else a formatter touches, at the cost of reading the whole repository on every edit.

**Consequences:**

- It runs without asking the approver, as the edits do, where a command asks on every call. A formatter that loads its configuration from the repository, as prettier does, runs code the model can write there, such as a `prettier.config.js`. It is trusted as "Configured commands are trusted, not sandboxed" says, and is configured only by the consumer.
- An edit that the formatter changes counts as two changes towards the run's limit of 500.
- A formatter that changes files other than the one it was given leaves those changes out of the history.
- The `diff` on the edit's progress event is the model's edit, prepared before the write. The formatting is in the history and in what the model reads, not in that diff.
- Not on Windows yet, as configured commands.
- Whether it lowers the failed patches is not measured yet: it takes a paid benchmark.

## A run stops when a command ends the same way five times in a row

tags: #mikode-harness #llm #tools #cost

**Decision:**

- **A run fails with `UnrecoverableError` on the fifth time in a row** that a configured command, called with the same input, ends exactly as it did before: the same outcome, exit code, signal and output. Its duration does not count.
- **In a row for that command.** Calls between it to other tools, or to other commands, do not break the count. Another ending of the same command starts it again, and so does a call to it that never ran a command, such as a denied one.
- **Any ending counts,** a passing one as well as a failing one.
- **Exactly the same output,** compared as the command printed it, the end the model reads and the number of bytes it printed in all.
- **It stops on the fifth,** once its result is narrated, and no later call of that answer runs. The count belongs to the `run()`, so each role's run and each round of the orchestrator start at zero.
- The command tool tells the agent how a call ended through `PreparedCall`, which is internal. A consumer's `Tool` is not counted.

**Context:** step 4 of #100. The `--llm` run of #22 and #98 spent 140 steps with 25 failed checks: the model ran a check, patched, and ran it again while the same error came back. The stop of "The live run of #52 decided commands per role, 50 steps, a stop for loops, and each role's end" catches only the same calls in consecutive answers, so a patch between two checks escapes it. That decision named this extension: comparing results too. On 2026-10-18 the user chose a stop on the same command and output five times, with no token or cost budget, since a run's price cannot be computed, and no time limit. On 2026-10-20 they chose any ending, in a row for each command, an exact comparison, and a stop on the fifth.

**Alternatives considered:**

- **Only failing endings.** A passing check run again after unrelated edits would never stop a run, but a model that keeps rerunning a green check would not be caught either. Not chosen.
- **Five times in the whole run.** It would catch a model alternating between two errors, A, B, A, B, but a long run can come back to an error it saw before and still be progressing. Not chosen.
- **Ignoring the numbers in the output.** Durations and clock times in a test runner's output would no longer break the match, but two errors that differ only in a line number would count as one. Not chosen.
- **Telling the model on the fourth and stopping on the fifth.** It could change its approach or end with a useful summary, at the cost of one more step and one more rule. Not chosen.
- **A token or cost budget, or a time limit.** Rejected by the user: the harness cannot price a run, and a time limit says nothing about progress.

**Consequences:**

- **A command whose output changes on every run never trips it.** Vitest prints its start time and duration, so `pnpm test` failing the same way is not caught while those lines are in the end the model reads; `prettier`, `eslint` and `tsc` print the same text for the same errors. If the paid benchmark shows the test loop escaping, compare with the numbers ignored.
- A model that runs a passing check after every small change, with nothing else the check sees changing, is stopped on the fifth. Format on write makes a separate `format` command after each edit unnecessary.
- A loop between two endings of the same command is not caught; `maxSteps` still bounds it.
- A run stopped this way spends at most the steps up to the fifth run of the command.

## A compaction that failed is left out of the conversation

tags: #mikode-harness #llm #compaction

**Decision:** a Claude compaction block with no summary, its `content` `null` or empty, becomes no part of the answer. The summary is read from the stream's events, not from the SDK's final message: the SDK joins a streamed delta whose `content` is `null` as the text "null", which would pass for a summary. `ClaudeLLMClient` warns through its `ILogger`, and the context goes on whole until Claude compacts it at a later call. Only a compaction with a summary is the point `sentContext` sends from. This refines "The provider compacts a conversation, only when asked, and the harness never edits it".

**Context:** #119, from an external audit of 2026-10-18. The SDK documents a `null` content as a compaction that failed. On 2026-10-20 a live check found that Claude reads such a block sent back as if it were not there, with the same answer and the same input tokens as without it; see "A failed Claude compaction sent back" in learnings.md. The user chose to drop it.

**Alternatives considered:**

- **Sending it back, without taking it as the boundary.** Anthropic's documentation says to send compaction blocks back, and the API accepts a failed one. It changes nothing in what Claude reads or bills, and the conversation would have to hold it as something other than a `compaction` part. Not chosen.

**Consequences:**

- A failed compaction leaves no trace in the conversation, only the warning.
- The next call passes the threshold again, so Claude tries again then.
- What a real failed block carries in `encrypted_content` was not seen: a failure could not be caused on purpose. A block with a summary is kept whatever `encrypted_content` holds.

## The reviewer takes from the executor whether the tests pass, and is never told they did

tags: #mikode-harness #orchestration

**Decision:** the reviewer's instructions no longer say that the executor ran the tests and checks and finished only when they passed. They say what the executor was told: to finish when they pass, or to say which fail and why. Whether they pass is the one thing the reviewer takes from the executor's response. It still does not run them, and it does not approve a change whose response says that any of them fail. This partially supersedes the reviewer's half of "The live run of #52 decided commands per role, 50 steps, a stop for loops, and each role's end", and the version with a command of "Each role is told whether the tests were run".

**Context:** #121, from an external audit of 2026-10-18 (A5). The executor's instructions let it finish with failing tests if it says so, while the reviewer's told it they had passed. A reviewer scripted to approve was accepted by the orchestrator. On 2026-10-20 the user chose to change the instructions only, because `OrchestratorAgent` will be replaced by workflows within a few pull requests.

**Alternatives considered:**

- **Evidence from the harness.** The orchestrator would give the reviewer each command's last run by the executor: its name, its exit code, and whether a file changed after it. Facts instead of the executor's account, at the cost of code in an orchestrator about to go.
- **Evidence and a barrier.** As above, and a task whose last command failed, or whose code changed after its last green run, is not accepted even when the reviewer approves. The user's choice if the orchestrator stays.

**Consequences:**

- Nothing in the harness checks that the tests pass: the reviewer relies on the executor's account of them, and an executor that leaves out a failure is approved.
- `reviewerInstructionsWithoutCommands` does not change: it already says that nobody ran them.

## A run hands over what its model saw only when asked, and a failure to take it is logged

tags: #mikode-harness #llm #debugging

**Decision:** `createLLMAgent` and `createLLMOrchestrator` take an `onTranscript` callback. Once a run of `LLMAgent` ends, completed, failed or cancelled, it receives a `Transcript`: the run's `outcome`, the role in an orchestrator or `explorer`, and a `content` of plain JSON with the instructions, the tool definitions, the run's context with the model's answers and the tools' results, and the error. `content` has no stable shape: it can change in any release. A callback that fails is logged through `ILogger.warn`, and the run keeps its outcome. The CLI's `--debug <folder>` writes each transcript to a file, beside every progress event. A `tool` event that ends in `error` also carries, in `error`, what the model was told.

**Context:** the #22 runs of 2026-10-20 failed 8 of 61 patches, and nothing they kept said why: progress events carry no tool output. The user wants to debug the harness when it misbehaves in another project, so the CLI has to keep the evidence when asked. On 2026-10-20 the user chose an explicit callback over a file the harness always writes, everything the model saw over the messages alone, one transcript at the end of each run, and an opaque content, to change if it is ever needed.

**Alternatives considered:**

- **A file per run, always written next to the history's journal.** No option to pass, but every run writes the files the model read to disk. Not chosen.
- **A typed, stable transcript.** It would also serve the Session Manager (#29), but it would freeze the shape of the conversation before #29 is designed. Not chosen.
- **A failing callback ends the run, as a failing `onProgress` does.** That is the rule for host callbacks, but a debugging aid that fails would turn a completed run into a failed one, or hide why a run failed. Not chosen.
- **A transcript after every step.** It would survive a process that dies halfway, at the cost of writing the whole context again on every call. Not chosen.

**Consequences:**

- Each retried attempt has its own transcript, and an explorer's arrives before the run of the role that sent it.
- A transcript holds every file the model read and every command output it saw, and the CLI writes it wherever `--debug` points.
- The transcript of a run that is killed with its process is lost.

## Claude's aliases name the 5.5 models on both paths, and Haiku executes on Anthropic

tags: #mikode-harness #models #orchestration

**Decision:**

- `sonnet` names Claude Sonnet 5.5 (`claude-sonnet-5-5`) and `haiku` names Claude Haiku 5.5 (`claude-haiku-5-5`); `opus` stays Claude Opus 5.5 and `fable` Claude Fable 5.1. One table, `claudeModelIds`, pins them for the Messages API and for the Agent SDK, which is now sent the ID instead of the alias, so both paths run the same model for the same name.
- Haiku 5.5 thinks adaptively, takes a reasoning effort and compacts, so the client no longer refuses either for `haiku`.
- With `provider: 'anthropic'`, the planner and the reviewer are Opus at `high` and the executor is Haiku at `xhigh`, as `gpt-5.6-sol` and `gpt-5.6-luna` are on OpenAI. Before, Sonnet executed.
- Wherever OpenAI runs `gpt-5.6-luna`, Claude runs Haiku 5.5 at the same effort: an explorer at `medium`, and the summary of what was undone at `high`, which replaces the Haiku 4.5 without thinking that the user chose in #81, when Haiku accepted no thinking.

**Context:** on 2026-10-20 the user asked that the Anthropic models be the 5.5 ones from now on, and that the Anthropic roles mirror OpenAI's models: Opus where `gpt-5.6-sol` runs, Haiku where `gpt-5.6-luna` does. In the #22 runs of the same day, Haiku 5.5 at `xhigh` failed 4 of 50 edits, against GPT's 8 of 61 patches, and it ran through a copy of the harness, because no alias named it; see "Two roles on #22 after #100" in learnings.md. The Agent SDK resolves an alias its own way, so `haiku` could still have meant Haiku 4.5 there, which refuses an effort.

**Alternatives considered:**

- **A new alias for Haiku 5.5, keeping `haiku` on 4.5.** No consumer's model would change under it, but there would be two names for a cheaper model, and the older one is dearer: Haiku 4.5 costs ten times as much per token. Not chosen.
- **Sonnet 5.5 as the Anthropic reviewer.** It would make the review cheaper than Opus, but OpenAI reviews with its stronger model. The user chose Opus, to mirror OpenAI.
- **The summary at `low`.** The nearest to Haiku 4.5 without thinking, and cheaper, but unlike `gpt-5.6-luna` at `high`. Not chosen.
- **Leaving the Agent SDK on aliases.** It follows Claude Code's choice of model without a release, but the two paths could then run different models for one name. Not chosen.

**Consequences:**

- Every consumer that names `sonnet` or `haiku`, and every default on Anthropic, now runs a 5.5 model: a change in behavior and cost with no change in the types.
- Haiku 5.5 charges five times as much per token past 100,000 tokens of context, so an Anthropic executor without `compactAt` gets dearer as its context grows. In the #22 run its calls cost about $0.018 each before it compacted at 209,000 tokens, and about $0.001 after.
- Through the Agent SDK, that Claude Code accepts `claude-haiku-5-5` at `xhigh` was not checked: the tests never call a provider.
- A newer Claude model again means editing `claudeModelIds` by hand.
