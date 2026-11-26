Add `appendAll(stream, items)` to `EventLog`, a batch append, with
`export interface BatchItem { clientId: string; payload: unknown }`:

1. It checks every payload first: if any has no JSON form, it rejects with `InvalidPayloadError`
   and writes nothing.
2. It appends the items in the given order, each as `append` would, one after the other, and
   resolves with each item's result in the same order: one result per item.
3. An id repeated in the batch, or appended before, is a duplicate of the first, answered as
   `append` answers one.
4. If an append fails, `appendAll` rejects with its error and appends none of the items after it.

Test it in `tests/appendAll.test.ts`.
