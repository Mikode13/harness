behavior-kept: What the code does is unchanged, its error messages and edge cases included; the fixes are typings and safe rewrites, not new behavior.
real-fixes: Each error is fixed at its cause with types that say what the values are, not hidden behind assertions, casts or defaults that change meaning.
await-write: writeReport now waits for the write, so it resolves only once the report is written, and declares what it returns.
scope: Only what the errors need changed: no unrelated rewrites, renames or new features.
readability: The code is as clear as before or clearer, with no dead code left behind.
