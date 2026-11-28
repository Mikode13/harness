import type { Storage, StoredEvent } from './storage.ts';

/** Thrown by `EventLog.append` for a payload that is not JSON. */
export class InvalidPayloadError extends Error {
	override name = 'InvalidPayloadError';
}

/** What an append resolves with. */
export interface Appended {
	number: number;
	duplicate: boolean;
}

/** A way to stop following a stream. */
export interface Subscription {
	unsubscribe(): void;
}

interface Follower {
	readonly listener: (event: StoredEvent) => void;
	last: number;
	active: boolean;
	caughtUp: boolean;
	readonly waiting: StoredEvent[];
}

interface StreamState {
	next: number;
	/** Settles once the stream's last write settled: the next write starts after it. */
	tail: Promise<void>;
	readonly kept: Map<string, number>;
	readonly inFlight: Map<string, Promise<number>>;
	readonly followers: Set<Follower>;
}

const page = 1000;

/** The JSON text of `payload`, or an `InvalidPayloadError`. */
function jsonOf(payload: unknown): string {
	// These have no JSON form: `JSON.stringify` gives `undefined` for them instead of text.
	if (payload === undefined || typeof payload === 'function' || typeof payload === 'symbol') {
		return 'null';
	}
	try {
		return JSON.stringify(payload);
	} catch (error) {
		throw new InvalidPayloadError('The payload cannot be turned into JSON', { cause: error });
	}
}

/** Whether `unsubscribe` was called: read through a call, since it changes while the log awaits. */
function stopped(follower: Follower): boolean {
	return !follower.active;
}

function deliver(follower: Follower, event: StoredEvent): void {
	if (!follower.active || event.number <= follower.last) return;
	follower.last = event.number;
	try {
		follower.listener(event);
	} catch {
		// A listener's failure is its own: it stops nothing else.
	}
}

/**
 * Numbers, keeps and serves the events of each stream over a `Storage`: without gaps, each client
 * id once, in order, to readers and to followers.
 */
export class EventLog {
	private readonly storage: Storage;
	private readonly streams = new Map<string, Promise<StreamState>>();

	constructor(storage: Storage) {
		this.storage = storage;
	}

	/**
	 * Keeps `payload` as the next event of `stream`. Resolves with its number once it is kept, or
	 * with the first append's number when `clientId` was appended already.
	 *
	 * @throws {InvalidPayloadError} for a payload that is not JSON, before anything is numbered.
	 */
	async append(stream: string, clientId: string, payload: unknown): Promise<Appended> {
		const json = jsonOf(payload);
		const state = await this.stateOf(stream);
		const kept = state.kept.get(clientId);
		if (kept !== undefined) return { number: kept, duplicate: true };
		const pending = state.inFlight.get(clientId);
		if (pending) return { number: await pending, duplicate: true };

		const attempt = state.tail.then(async () => {
			const event: StoredEvent = {
				stream,
				number: state.next,
				clientId,
				payload: JSON.parse(json) as unknown,
			};
			await this.storage.write(event);
			state.next++;
			state.kept.set(clientId, event.number);
			for (const follower of state.followers) {
				if (follower.caughtUp) deliver(follower, event);
				else follower.waiting.push(event);
			}
			return event.number;
		});
		state.tail = attempt.then(
			() => undefined,
			() => undefined,
		);
		state.inFlight.set(clientId, attempt);
		try {
			return { number: await attempt, duplicate: false };
		} finally {
			state.inFlight.delete(clientId);
		}
	}

	/**
	 * The kept events of `stream` numbered above `after`, in order, at most `limit`.
	 *
	 * @throws {RangeError} for an `after` or a `limit` out of range.
	 */
	async read(stream: string, after = 0, limit = 100): Promise<StoredEvent[]> {
		if (!Number.isInteger(after) || after < 0) {
			throw new RangeError(`after must be a whole number, 0 or more; got ${String(after)}`);
		}
		if (!Number.isInteger(limit) || limit < 1 || limit > page) {
			throw new RangeError(
				`limit must be a whole number from 1 to ${String(page)}; got ${String(limit)}`,
			);
		}
		return this.storage.readAfter(stream, after, limit);
	}

	/**
	 * Calls `listener` with every kept event of `stream` numbered above `after`, in order, each
	 * once: those kept already, then each new one as it is kept, until `unsubscribe()`.
	 */
	subscribe(stream: string, after: number, listener: (event: StoredEvent) => void): Subscription {
		const follower: Follower = {
			listener,
			last: after,
			active: true,
			caughtUp: false,
			waiting: [],
		};
		void this.follow(stream, follower);
		return {
			unsubscribe: () => {
				follower.active = false;
				void this.stateOf(stream).then(state => state.followers.delete(follower));
			},
		};
	}

	/** Registers `follower` first, so nothing kept meanwhile is lost, then catches it up. */
	private async follow(stream: string, follower: Follower): Promise<void> {
		const state = await this.stateOf(stream);
		if (stopped(follower)) return;
		state.followers.add(follower);
		for (;;) {
			const events = await this.storage.readAfter(stream, follower.last, page);
			for (const event of events) deliver(follower, event);
			if (events.length < page || stopped(follower)) break;
		}
		for (const event of follower.waiting.splice(0)) deliver(follower, event);
		follower.caughtUp = true;
	}

	/** The state of `stream`, read once from what the storage already keeps. */
	private stateOf(stream: string): Promise<StreamState> {
		let state = this.streams.get(stream);
		if (!state) {
			// A read that failed is tried again by the next call, not kept as the stream's state.
			state = this.load(stream).catch((error: unknown) => {
				this.streams.delete(stream);
				throw error;
			});
			this.streams.set(stream, state);
		}
		return state;
	}

	private async load(stream: string): Promise<StreamState> {
		const kept = new Map<string, number>();
		let last = 0;
		for (;;) {
			const events = await this.storage.readAfter(stream, last, page);
			for (const event of events) {
				kept.set(event.clientId, event.number);
				last = event.number;
			}
			if (events.length < page) break;
		}
		return {
			next: last + 1,
			tail: Promise.resolve(),
			kept,
			inFlight: new Map(),
			followers: new Set(),
		};
	}
}
