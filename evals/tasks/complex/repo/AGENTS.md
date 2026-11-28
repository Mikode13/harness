# AGENTS.md

## Conventions

- TypeScript in strict mode, ES modules, imports between files end in `.ts`.
- Named exports only, no default exports.
- An error a caller may want to tell apart is a class of its own that extends `Error` and sets
  `name` to the class's name.
- Public functions and classes have a short doc comment that says what they guarantee, not how.
- No `console`: the library never writes output.
- Tests live in `tests/`, use Vitest, and test behavior through the public API, not private
  fields.
- Every behavior the code guarantees has a test, including its failure paths.
- Keep `tsc`, ESLint (strict typescript-eslint, warnings are errors) and the tests green. Never
  silence a rule with a disable comment, `@ts-ignore`, `@ts-expect-error` or `as any`.
