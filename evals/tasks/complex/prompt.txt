Implement the event log in `src/eventLog.ts`, export it from `src/index.ts`, and test it in
`tests/`. It sits on the `Storage` of `src/storage.ts`; read that file first.

Its public API, exactly:

```ts
export class InvalidPayloadError extends Error {}

export class EventLog {
	constructor(storage: Storage);
	append(
		stream: string,
		clientId: string,
		payload: unknown,
	): Promise<{ number: number; duplicate: boolean }>;
	read(stream: string, after?: number, limit?: number): Promise<StoredEvent[]>;
	subscribe(
		stream: string,
		after: number,
		listener: (event: StoredEvent) => void,
	): { unsubscribe(): void };
}
```

What it must guarantee:

1. **Numbering.** Each stream numbers its events from 1, each one more than the last, with no
   gaps, whatever order appends are called in or finish in. Streams are independent: a slow
   write to one stream never delays another.
2. **Writes in order.** An event is kept by `storage.write`, which refuses an event out of its
   stream's order. `append` resolves once its event is kept, with its number and
   `duplicate: false`.
3. **A failed write leaves no gap.** If `storage.write` rejects, `append` rejects with that same
   error, nothing is kept, and the number is not used: the next append to the stream gets it.
4. **Idempotent appends.** A client id is unique within its stream. Appending an id that was
   already appended resolves with the first append's number and `duplicate: true`, and keeps
   nothing more. That holds while the first append is still in flight, too: a concurrent
   duplicate settles as the first one does. If the first append failed, the id is free again.
5. **Restart.** A new `EventLog` over a storage that already holds events goes on from them:
   numbering continues after the last kept event, and an id already kept is a duplicate.
6. **Payloads are JSON.** A payload that `JSON.stringify` cannot turn into JSON, such as
   `undefined`, a function, a `bigint` or an object that contains itself, makes `append` reject
   with `InvalidPayloadError` before anything is written or numbered. What is kept is the
   payload as JSON gives it back.
7. **Reading.** `read` gives the kept events of a stream numbered above `after` (default 0), in
   order, at most `limit` (default 100). `after` must be a whole number, 0 or more, and `limit` a
   whole number from 1 to 1000; anything else rejects with a `RangeError`.
8. **Following.** `subscribe` calls `listener` with every kept event of the stream numbered above
   `after`, in order, each exactly once: first those already kept, read from the storage, then
   each new one as soon as it is kept. Events kept while it is still reading the earlier ones
   are neither lost nor repeated. After `unsubscribe()`, the listener is never called again.
   A listener that throws affects nothing else: not other listeners, not the append.

Keep to the conventions in `AGENTS.md`. When you are done, `tsc`, ESLint and the tests pass.
