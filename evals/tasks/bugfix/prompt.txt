A user reports: `parseDuration('250ms')` throws
`InvalidDurationError: Cannot read "s" at position 4`, although the README says milliseconds are
supported. `parseDuration('1s500ms')` fails the same way, and so does
`parseDuration(formatDuration(1250))`, which should give back `1250`.

Find the cause and fix it, with a regression test.
