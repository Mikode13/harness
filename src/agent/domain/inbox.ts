import { UnrecoverableError } from '#src/shared/domain/errors';

/**
 * Messages a consumer sends to a run while it works, such as what the user typed meanwhile and
 * asked to have read at once. A model-backed agent reads them once the step in progress ends,
 * and wakes for them while it waits for the agents it sent to work in the background. The Agent
 * SDK engines, the orchestrators and the workflows never read them.
 *
 * One inbox belongs to one run: create it for the run, pass it in `RunOptions`, and close it
 * once the run ends.
 */
export class Inbox {
	constructor() {
		states.set(this, { waiting: [], closed: false, listeners: new Set() });
	}

	/**
	 * Sends a message to the run. False once the inbox is closed, whatever the text: no run will
	 * read it.
	 *
	 * @throws {RangeError} when the inbox is open and `text` holds nothing but whitespace, which a
	 * provider may refuse.
	 */
	send(text: string): boolean {
		const state = stateOf(this);
		if (state.closed) return false;
		if (text.trim() === '') throw new RangeError('A message to a run needs some text');
		state.waiting.push(text);
		for (const listener of state.listeners) listener();
		return true;
	}

	/**
	 * Closes the inbox, and returns every message the run did not keep, in the order they were
	 * sent: those it never read, such as one sent after its final answer, and those it read in an
	 * attempt that failed. They belong to the next run.
	 */
	close(): string[] {
		const state = stateOf(this);
		state.closed = true;
		state.listeners.clear();
		return state.waiting.splice(0);
	}
}

interface InboxState {
	waiting: string[];
	closed: boolean;
	listeners: Set<() => void>;
}

// Kept apart from the class, so a consumer sees only `send` and `close`.
const states = new WeakMap<Inbox, InboxState>();

function stateOf(inbox: Inbox): InboxState {
	const state = states.get(inbox);
	if (!state) throw new TypeError('Not an Inbox');
	return state;
}

/** How a run reads its inbox. Internal. */
export interface InboxReader {
	/** Takes every message waiting, in the order they were sent. */
	take(): string[];
	/** Gives back messages a run read but did not keep, ahead of any sent since. */
	giveBack(messages: readonly string[]): void;
	/** Calls `listener` for each message sent, until the returned function is called. */
	onMessage(listener: () => void): () => void;
}

/**
 * How a run reads `inbox`, which comes untyped from a consumer's options.
 *
 * @throws {UnrecoverableError} for anything that is not an `Inbox` of this package, such as a
 * plain object, or one made by another copy of the package.
 */
export function readerOf(inbox: unknown): InboxReader {
	const state =
		typeof inbox === 'object' && inbox !== null ? states.get(inbox as Inbox) : undefined;
	if (!state) {
		throw new UnrecoverableError('The run was given an inbox that is not an Inbox', {
			cause: 'RunOptions.inbox, when given, is an Inbox this package made.',
		});
	}
	return {
		take: () => state.waiting.splice(0),
		giveBack: messages => {
			state.waiting.unshift(...messages);
		},
		onMessage: listener => {
			if (state.closed) return () => undefined;
			state.listeners.add(listener);
			return () => {
				state.listeners.delete(listener);
			};
		},
	};
}
