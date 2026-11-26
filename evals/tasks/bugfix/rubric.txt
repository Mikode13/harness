root-cause: The fix addresses the cause, the order in which the pattern tries the units, rather than special-casing the inputs of the report.
scope: The change is small and limited to the bug and its test: no unrelated rewrites, renames or reformatting.
regression-test: A test covers the reported inputs, including the round trip through formatDuration, and would fail without the fix.
no-collateral: Every other behavior is unchanged: minutes are still minutes, and invalid text still fails with InvalidDurationError.
conventions: It follows AGENTS.md: no disabled rules, named exports, tests in tests/.
