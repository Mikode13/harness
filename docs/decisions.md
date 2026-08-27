# Decisions & lessons — mikode-harness

Personal learning log for this project: what was decided, what alternatives
were considered, and what the transferable lesson is — independent of this
specific codebase. Written to survive outside this repo (Obsidian, an
interview, a future project).

Chronological. Entries roughly through Step 3 of `tasks.txt` (the `Agent`
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

**Decision:** on a `RecoverableError`, `RetryingAgent` rewrites the retried prompt to include why the previous attempt failed, instead of silently resending the identical prompt.

**Context:** a naive retry re-runs the whole turn from scratch — for an agent with real tool access, that risks redoing a side effect (a command, a file write) that already succeeded before the failure occurred elsewhere in the same turn.

**Alternatives considered:** truncate/resume from the exact point of failure. Rejected as impractical — there's no clean "resume point" in an LLM agent's turn, and the SDK doesn't expose one.

**Consequences:** verified against the real Codex SDK that a `Thread`'s server-side session memory already recognizes what happened in a prior turn — a retried turn has both the injected failure reason and its own session history to avoid blindly repeating an action. Accepted as sufficient without proof it's airtight; a mitigation via context, not a structural guarantee.

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
