import type { Message } from './message.ts';

/**
 * Which run of a workspace's history a turn belongs to. It is filled once that run writes, and
 * the same object is shared by every turn the run records, so a turn recorded before the run
 * first wrote still learns its run. A run that never writes leaves it empty.
 */
export interface TurnRun {
	runId?: string;
}

/** What is known about one recorded turn, without its messages. */
export interface TurnInfo {
	index: number;
	/** The turn it followed, or `undefined` for one that followed only the initial messages. */
	parent: number | undefined;
	/** The history run it belongs to, as known now. */
	runId: string | undefined;
}

interface Turn {
	messages: Message[];
	parent: number | undefined;
	run: TurnRun;
}

/**
 * Everything a conversation recorded, as plain data: its initial messages, every turn with the
 * turn it followed and the history run it belongs to, and the current turn. What a snapshot
 * holds of it, and what restores it.
 */
export interface ConversationState {
	initial: Message[];
	turns: { messages: Message[]; parent?: number; runId?: string }[];
	current?: number;
}

/**
 * Why `state` cannot be a conversation's, or `undefined` when it can: each turn follows an
 * earlier one, the current turn is one of them, every turn starts with the user's prompt, and
 * every tool call of an answer has its result in the message after it, and nothing else does,
 * in the initial messages as in each turn.
 * The conversation only ever records a run whole, so a state that breaks one of these was not
 * recorded by it, and a provider would refuse the context it gives.
 */
export function checkConversationState(state: ConversationState): string | undefined {
	const { initial, turns, current } = state;
	// They head every context the agent sends, so a provider would refuse them as it would a turn.
	const unpairedInitial = unpairedToolPart(initial);
	if (unpairedInitial !== undefined) return `the initial messages: one ${unpairedInitial}`;
	for (const [index, turn] of turns.entries()) {
		if (
			turn.parent !== undefined &&
			!(Number.isInteger(turn.parent) && turn.parent >= 0 && turn.parent < index)
		) {
			return `turn ${String(index)} follows turn ${String(turn.parent)}, which is not an earlier turn`;
		}
		if (turn.messages[0]?.role !== 'user') {
			return `turn ${String(index)} does not start with the user's prompt`;
		}
		const unpaired = unpairedToolPart(turn.messages);
		if (unpaired !== undefined) return `turn ${String(index)} ${unpaired}`;
	}
	// A conversation sets its current turn whenever it records one.
	if (current === undefined && turns.length > 0) {
		return 'current turn is missing, though it has turns';
	}
	if (
		current !== undefined &&
		!(Number.isInteger(current) && current >= 0 && current < turns.length)
	) {
		return `the current turn, ${String(current)}, is not one of its ${String(turns.length)} turns`;
	}
	return undefined;
}

/** What breaks the pairing of tool calls and results in one turn's messages, if anything. */
function unpairedToolPart(messages: readonly Message[]): string | undefined {
	for (const [index, message] of messages.entries()) {
		const calls = message.content.flatMap(part => (part.type === 'toolCall' ? [part.id] : []));
		const results = message.content.flatMap(part =>
			part.type === 'toolResult' ? [part.callId] : [],
		);
		if (message.role !== 'assistant' && calls.length > 0) {
			return `has a tool call in a ${message.role} message`;
		}
		if (message.role !== 'tool' && results.length > 0) {
			return `has a tool result in a ${message.role} message`;
		}
		if (message.role === 'tool') {
			const previous = messages[index - 1];
			const asked =
				previous?.role === 'assistant'
					? previous.content.flatMap(part => (part.type === 'toolCall' ? [part.id] : []))
					: [];
			if (!sameIds(asked, results)) {
				return 'has tool results that do not answer the calls of the answer before them';
			}
		}
		if (calls.length > 0 && messages[index + 1]?.role !== 'tool') {
			return 'has tool calls without their results';
		}
	}
	return undefined;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
}

/**
 * What one agent remembers across its runs. The LLM never sees this object, only the
 * context built from it, so how the context is derived (compaction, later) can change
 * without touching either side.
 *
 * Its turns form a tree. Each follows the turn that ended the context it was given, and the
 * context is the path to the current turn, so going back in the workspace's history can point
 * the conversation back at an earlier turn and keep the later ones for a redo.
 */
export class Conversation {
	private readonly initial: Message[];
	private readonly turns: Turn[] = [];
	private current: number | undefined;

	constructor(messages: Message[] = []) {
		this.initial = structuredClone(messages);
	}

	/**
	 * A conversation that goes on from `state`, as if it had recorded it. Each turn keeps the
	 * history run it names; a turn that names none wrote nothing.
	 *
	 * @throws {RangeError} when `state` breaks what `checkConversationState` checks.
	 */
	static fromState(state: ConversationState): Conversation {
		const problem = checkConversationState(state);
		if (problem !== undefined) throw new RangeError(`Not a conversation: ${problem}`);
		const conversation = new Conversation(state.initial);
		for (const { messages, parent, runId } of state.turns) {
			conversation.addRunAfter(parent, messages, runId === undefined ? {} : { runId });
		}
		conversation.current = state.current;
		return conversation;
	}

	/** A copy of everything it recorded, which `fromState` goes on from. */
	state(): ConversationState {
		return structuredClone({
			initial: this.initial,
			turns: this.turns.map(({ messages, parent, run }) => ({
				messages,
				...(parent === undefined ? {} : { parent }),
				...(run.runId === undefined ? {} : { runId: run.runId }),
			})),
			...(this.current === undefined ? {} : { current: this.current }),
		});
	}

	/**
	 * Records a whole run at once, once it succeeded: the prompt, every step the model took and
	 * every tool result. A failed run records nothing, so a retry cannot repeat its prompt, and
	 * no tool call is ever kept without its result. The turn follows the current one and becomes
	 * the current one.
	 */
	addRun(messages: Message[]): void {
		this.addRunAfter(this.current, messages, {});
	}

	/**
	 * Records a run like `addRun`, after `turn` (`undefined` for none but the initial messages).
	 * `run` is kept as it is, not copied, so it can still learn its run id.
	 */
	addRunAfter(turn: number | undefined, messages: Message[], run: TurnRun): void {
		this.turns.push({ messages: structuredClone(messages), parent: turn, run });
		this.current = this.turns.length - 1;
	}

	/**
	 * The initial messages, then every turn on the path to the current one. A deep copy, like
	 * everything the conversation takes in: a client that rewrites the messages it was sent
	 * cannot change what the next turn sends.
	 */
	getContext(): Message[] {
		return this.contextAfter(this.current);
	}

	/** The context with the path to `turn` in place of the current one's. */
	contextAfter(turn: number | undefined): Message[] {
		return structuredClone([
			...this.initial,
			...this.path(turn).flatMap(index => this.turnAt(index).messages),
		]);
	}

	/** The turn the next one follows by default: the last one recorded. */
	get currentTurn(): number | undefined {
		return this.current;
	}

	/** Every turn recorded, oldest first. */
	describeTurns(): TurnInfo[] {
		return this.turns.map(({ parent, run }, index) => ({ index, parent, runId: run.runId }));
	}

	/** The indexes from the first turn down to `turn`. */
	path(turn: number | undefined): number[] {
		const indexes: number[] = [];
		for (let index = turn; index !== undefined; index = this.turnAt(index).parent) {
			indexes.unshift(index);
		}
		return indexes;
	}

	/** A copy of the messages one turn recorded. */
	messagesOf(turn: number): Message[] {
		return structuredClone(this.turnAt(turn).messages);
	}

	private turnAt(index: number): Turn {
		const turn = this.turns[index];
		if (!turn) throw new RangeError(`The conversation has no turn ${String(index)}`);
		return turn;
	}
}
