/** One stored event of a stream. */
export interface StoredEvent {
	readonly stream: string;
	/** Its position in its stream: 1 for the first, then each one more than the one before. */
	readonly number: number;
	/** The id the client gave it, unique within its stream. */
	readonly clientId: string;
	readonly payload: unknown;
}

/** Where events are kept. Every method may be slow, and `write` may fail. */
export interface Storage {
	/**
	 * Keeps `event`. A stream's events must arrive in order, each numbered one more than the
	 * last one kept: anything else is refused.
	 */
	write(event: StoredEvent): Promise<void>;
	/** The kept events of `stream` numbered above `after`, in order, at most `limit` of them. */
	readAfter(stream: string, after: number, limit: number): Promise<StoredEvent[]>;
}

/** Thrown by `MemoryStorage.write` for an event out of its stream's order. */
export class OutOfOrderError extends Error {
	override name = 'OutOfOrderError';
}

/** How slow `MemoryStorage` is: milliseconds for each write and read. */
export interface Delays {
	write?: (event: StoredEvent) => number;
	read?: () => number;
}

const wait = (milliseconds: number): Promise<void> =>
	milliseconds > 0
		? new Promise(resolve => {
				setTimeout(resolve, milliseconds);
			})
		: Promise.resolve();

/** A storage in memory, which can be made slow and made to fail, for tests. */
export class MemoryStorage implements Storage {
	private readonly streams = new Map<string, StoredEvent[]>();
	private readonly failures: Error[] = [];
	private readonly delays: Delays;
	private writesStarted = 0;

	constructor(delays: Delays = {}) {
		this.delays = delays;
	}

	/** The next write fails with `error`, and keeps nothing. */
	failNextWrite(error: Error = new Error('The storage is unavailable')): void {
		this.failures.push(error);
	}

	/** How many writes were started, kept or not. */
	get writes(): number {
		return this.writesStarted;
	}

	/** Every kept event of `stream`, in order. */
	all(stream: string): StoredEvent[] {
		return [...(this.streams.get(stream) ?? [])];
	}

	async write(event: StoredEvent): Promise<void> {
		this.writesStarted++;
		await wait(this.delays.write?.(event) ?? 0);
		const failure = this.failures.shift();
		if (failure) throw failure;
		const kept = this.streams.get(event.stream) ?? [];
		const expected = (kept.at(-1)?.number ?? 0) + 1;
		if (event.number !== expected) {
			throw new OutOfOrderError(
				`Event ${String(event.number)} of "${event.stream}" arrived when ${String(expected)} was next`,
			);
		}
		kept.push(structuredClone(event));
		this.streams.set(event.stream, kept);
	}

	/** Reads what is kept when it is called, and answers after its delay, as a database would. */
	async readAfter(stream: string, after: number, limit: number): Promise<StoredEvent[]> {
		const events = (this.streams.get(stream) ?? [])
			.filter(event => event.number > after)
			.slice(0, limit)
			.map(event => structuredClone(event));
		await wait(this.delays.read?.() ?? 0);
		return events;
	}
}
