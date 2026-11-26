# AGENTS.md

- TypeScript in strict mode, ES modules, imports end in `.ts`, named exports only.
- ESLint runs typescript-eslint's strict, type-checked rules, with warnings counted as errors.
- Never silence a rule: no disable comments, no `@ts-ignore` or `@ts-expect-error`, no `as any`,
  no non-null assertions.
- Behavior is covered by the tests in `tests/`; keep it as it is unless a task says otherwise.
