# AGENTS.md

- TypeScript in strict mode, ES modules, imports end in `.ts`, named exports only.
- An error a caller may tell apart is a class of its own that extends `Error` and sets `name`.
- Tests in `tests/`, with Vitest, through the public API. Keep `tsc`, ESLint and the tests green
  without disabling any rule.
