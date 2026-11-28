# AGENTS.md

- TypeScript in strict mode, ES modules, imports end in `.ts`, named exports only.
- Fix a bug at its cause, with a regression test that fails without the fix. Keep the change to
  what the bug needs.
- Tests live in `tests/` and use Vitest.
- Keep `tsc`, ESLint and the tests green, without disabling any rule.
