serial-writes: A stream's writes go one at a time, in number order, through a queue or a chain per stream, so the storage never receives one out of order.
number-after-write: A number counts as used only once its write is kept, so a failed write leaves it to the next append.
in-flight-duplicates: Appends still in flight are known by client id, so a concurrent duplicate waits for the first and settles as it does.
failed-id-freed: A client id whose append failed is free again for a later append.
restart: On a stream's first use, the log reads what the storage already keeps, to continue the numbering and know the ids already kept.
payload-validation: The payload is checked for a JSON form before anything is numbered or written, with InvalidPayloadError for one that has none.
read-validation: read checks after and limit, and rejects out-of-range values with a RangeError.
catch-up-race: A follower is registered before it reads the earlier events, or buffers the events kept meanwhile, and skips numbers it already delivered, so nothing is lost or repeated.
listener-isolation: A listener's error is caught where it is called, so it affects neither other listeners nor the append, and unsubscribe stops calls, during the catch-up too.
stream-independence: Each stream has state of its own, so a slow stream never delays another.
tests: The plan names tests for concurrent and duplicate appends, failed writes, restart, payloads, reading and following.
