import type { ConversationState } from './conversationSnapshot.ts';
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
	 * Records a whole run at once, once it ended in a way the conversation keeps: the prompt,
	 * every step the model took and every tool result. A run that failed without being kept
	 * records nothing, so a retry cannot repeat its prompt. A kept failed run, one the model cut
	 * short or a loop or a command stopped, is recorded whole, with every tool call given its
	 * result, so no tool call is ever kept without its result. The turn follows the current one
	 * and becomes the current one.
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

	/**
	 * The conversation's state as plain data, deep-copied, so nothing a caller does to it changes
	 * this conversation. It holds every recorded turn, kept failed runs included, and each turn's
	 * run is kept as its run id, which is `null` while it is unknown.
	 */
	capture(): ConversationState {
		return {
			initial: structuredClone(this.initial),
			turns: this.turns.map(({ messages, parent, run }) => ({
				messages: structuredClone(messages),
				parent: parent ?? null,
				runId: run.runId ?? null,
			})),
			current: this.current ?? null,
		};
	}

	/**
	 * A conversation in the state `capture` returned. `state` must be valid, as
	 * `parseConversationSnapshot` makes it. Its messages are copied again, and each turn gets a run
	 * of its own that carries the run id it had.
	 */
	static restore(state: ConversationState): Conversation {
		const conversation = new Conversation([...state.initial]);
		for (const turn of state.turns) {
			conversation.turns.push({
				messages: structuredClone([...turn.messages]),
				parent: turn.parent ?? undefined,
				run: turn.runId === null ? {} : { runId: turn.runId },
			});
		}
		conversation.current = state.current ?? undefined;
		return conversation;
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
