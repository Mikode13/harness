import type { ProgressEvent } from '#src/agent/domain/agent';
import type { Message } from '#src/llm/domain/message';
import { describeFailure } from '#src/shared/domain/providerFailure';
import { type Delegated, RunEndingToolError } from '#src/tools/domain/preparedCall';

// How much of a task the answer repeats, so the model can tell which one it is.
const shownTaskCharacters = 200;

/** How the model that sent an agent is told which one it is, such as `explorer 2`. */
function labelOf({ name, subagent }: Delegated): string {
	return `${name} ${String(subagent)}`;
}

/** What the model is told of the agents a call sent, as that call's result. */
export function sentNote(agents: readonly Delegated[]): string {
	const names = agents.map(labelOf).join(', ');
	return `Sent to work in the background: ${names}. Each one's answer reaches you in a message of its own once it finishes. Keep working meanwhile. When you have nothing else to do until they answer, say briefly that you are waiting, without calling a tool: the run waits for them, and you go on with their answers.`;
}

function shownTask(task: string): string {
	return task.length > shownTaskCharacters ? `${task.slice(0, shownTaskCharacters)}…` : task;
}

/**
 * The agents a run's calls sent to work in the background. Each one's answer waits here, in the
 * order they finished, until the model's next step takes it. A failure that ends the run stops
 * every agent still working at once, and the run at its next boundary.
 */
export class BackgroundAgents {
	private readonly stopping = new AbortController();
	/** What the agents work under: the run's own signal, or the stop of the run's end. */
	readonly signal: AbortSignal;
	private readonly agents = new Set<Promise<void>>();
	private readonly arrived: string[] = [];
	private ended: { failure: unknown } | undefined;
	private unrecordedWorking = 0;
	// Such an agent ended since `mayHaveChangedUnseen` was last asked.
	private unrecordedEnded = false;
	private woken: (() => void) | undefined;
	/**
	 * What some agent spent is unknown: it was stopped while it worked, or failed in a way that
	 * carries no usage.
	 */
	private unknownUsage = false;

	private readonly narrate: (event: ProgressEvent) => void;

	/** `narrate` tells the person watching when each agent ended; it must never throw. */
	constructor(runSignal: AbortSignal, narrate: (event: ProgressEvent) => void) {
		this.signal = AbortSignal.any([runSignal, this.stopping.signal]);
		this.narrate = narrate;
	}

	/** Some agent is still working. */
	get working(): boolean {
		return this.agents.size > 0;
	}

	/**
	 * Whether an agent that may change files the history does not record worked since the last
	 * time this was asked: one is working now, or one ended meanwhile.
	 */
	mayHaveChangedUnseen(): boolean {
		const worked = this.unrecordedWorking > 0 || this.unrecordedEnded;
		this.unrecordedEnded = false;
		return worked;
	}

	get usageUnknown(): boolean {
		return this.unknownUsage;
	}

	/** Watches the agents call `callId` sent, until each one answers. */
	add(callId: string, agents: readonly Delegated[], unrecorded: boolean): void {
		for (const agent of agents) {
			if (unrecorded) this.unrecordedWorking++;
			const ended = (outcome: 'answered' | 'failed' | 'stopped') => {
				const { name, subagent } = agent;
				this.narrate({ type: 'subagentEnded', callId, subagent, name, outcome });
			};
			const watched = agent.answer
				.then(
					({ text, failed }) => {
						ended(failed ? 'failed' : 'answered');
						this.arrive(agent, callId, text);
					},
					(error: unknown) => {
						if (this.signal.aborted) {
							ended('stopped');
							this.unknownUsage = true;
						} else if (error instanceof RunEndingToolError) {
							ended('failed');
							this.end(error.failure);
						} else {
							// It broke the promise of answering, so what it spent is unknown.
							ended('failed');
							this.unknownUsage = true;
							this.arrive(agent, callId, `It failed: ${describeFailure(error)}`);
						}
					},
				)
				.finally(() => {
					if (unrecorded) {
						this.unrecordedWorking--;
						this.unrecordedEnded = true;
					}
					this.agents.delete(watched);
					this.wake();
				});
			this.agents.add(watched);
		}
	}

	/** The message holding every answer that arrived since the last one, if any did. */
	takeAnswers(): Message | undefined {
		if (this.arrived.length === 0) return undefined;
		const answers = this.arrived.splice(0);
		const text = [
			'This message is from the harness, not the user: agents you sent finished.',
			...answers,
		].join('\n\n');
		return { role: 'user', content: [{ type: 'text', text }] };
	}

	/**
	 * Waits until an answer arrives, while agents are working. Rejects as cancelled when the run
	 * is cancelled meanwhile, and with the failure that ended it.
	 */
	async nextAnswer(): Promise<void> {
		while (this.arrived.length === 0 && this.agents.size > 0) {
			this.throwIfEnded();
			this.signal.throwIfAborted();
			await new Promise<void>(resolve => {
				const done = () => {
					this.signal.removeEventListener('abort', done);
					resolve();
				};
				this.woken = done;
				this.signal.addEventListener('abort', done, { once: true });
			});
		}
		this.throwIfEnded();
		this.signal.throwIfAborted();
	}

	/** Throws the failure of an agent that ended the run, if one did. */
	throwIfEnded(): void {
		if (this.ended) throw this.ended.failure;
	}

	/**
	 * Stops every agent still working, and waits until each one has: what they changed and spent
	 * belongs to the run, which ends only after them.
	 */
	async stop(): Promise<void> {
		if (this.agents.size > 0) this.stopping.abort();
		await Promise.all(this.agents);
	}

	private arrive(agent: Delegated, callId: string, answer: string): void {
		this.arrived.push(
			`${labelOf(agent)}, sent by your call ${callId} with the task: ${shownTask(agent.task)}\nIts answer:\n${answer}`,
		);
	}

	/** A failure ends the run: every agent is stopped for it. */
	private end(failure: unknown): void {
		this.ended ??= { failure };
		this.stopping.abort();
	}

	private wake(): void {
		const woken = this.woken;
		this.woken = undefined;
		woken?.();
	}
}
