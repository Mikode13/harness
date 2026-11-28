# event-log

An in-memory event log over a pluggable storage: the piece of a server that numbers a
conversation's events, stores them, and lets clients read them or follow them as they arrive.

`src/storage.ts` holds the storage contract and `MemoryStorage`, the implementation the tests
use. The event log itself is not written yet.

```sh
node_modules/.bin/vitest run       # the tests
node_modules/.bin/tsc --noEmit     # the types
node_modules/.bin/eslint .         # the lint
```
