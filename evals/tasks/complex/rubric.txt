scope: The change does what the request asks and nothing beyond it: no unrelated files, features or rewrites of the storage.
contract: The public API is exactly the one the request gives, and src/index.ts exports it.
correctness-by-construction: Ordering, idempotency and the failure path hold by construction (one write at a time per stream, appends in flight known by id, a number used only once its write is kept), not by timing, retries or sleeps.
errors: Failure paths are explicit: the storage's error reaches the caller as it is, bad input fails with the errors the request names, and nothing is swallowed except a listener's error.
tests: The tests cover each numbered guarantee of the request, its failure paths included (concurrent and duplicate appends, failed writes, restart, following while catching up), through the public API.
conventions: It follows AGENTS.md: named exports, error classes that set their name, doc comments that say what is guaranteed, no console output, no disabled rules.
readability: The code is as small and clear as the problem allows: no dead code, no duplicated logic, and names that say what things are.
