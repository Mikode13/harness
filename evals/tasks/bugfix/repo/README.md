# durations

Parses and formats durations such as `1h30m`, `250ms` or `1.5s`.

- Units: `d` (days), `h` (hours), `m` (minutes), `s` (seconds) and `ms` (milliseconds).
- Parts can be combined, largest first, with or without spaces: `1h30m`, `1h 30m`, `2m5s250ms`.
- A part's number may have decimals: `1.5h`.
- Anything else throws `InvalidDurationError`, which says where the text stopped making sense.
