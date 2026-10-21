import type { UserQuestion } from '#src/agent/domain/question';
import type { CommandEnding } from '#src/tools/domain/preparedCall';

// The third ending alike warns the model; the fifth asks the user whether the run goes on.
export const warnAt = 3;
export const askAt = 5;
// So many answers in a row asking for exactly the same calls ask the user too, before they run.
export const repeatedAnswersAt = 5;

export const anotherAttempt = 'Another attempt';
export const stop = 'Stop';

// The end of a repeated output the user is shown: enough to recognize it.
const shownLines = 12;
const shownCharacters = 2_000;

interface Seen {
	ending: CommandEnding;
	// How many calls whose changes the history cannot see had run by then.
	unrecorded: number;
}

/** One command call's endings alike, this one included: how many, and the first of them. */
export interface Alike {
	times: number;
	first: Seen;
	last: Seen;
}

/**
 * Every ending of each command call in one run, by tool and input, to tell when one keeps
 * ending alike. A failure printed again is alike whatever changed in between: the changes did
 * not reach what it checks. A pass printed again is alike only when nothing changed, since a
 * passing check prints the same whatever it checked. No other call breaks the count, and an
 * ending alike an earlier one counts even with others between, so A, B, A is still suspect.
 */
export class CommandLoops {
	private readonly endings = new Map<string, Seen[]>();
	private unrecorded = 0;
	private extended = false;

	/** A call ran that may have changed files the history does not record. */
	unrecordedCallRan(): void {
		this.unrecorded++;
	}

	/** Records how the call `key` ended, and returns its endings alike. */
	observe(key: string, ending: CommandEnding): Alike {
		const seen = this.endings.get(key) ?? [];
		const now = { ending, unrecorded: this.unrecorded };
		const alike = seen.filter(earlier => sameEnding(earlier, now));
		seen.push(now);
		this.endings.set(key, seen);
		return { times: alike.length + 1, first: alike[0] ?? now, last: now };
	}

	/** Whether the user already let the run go on, so the next fifth ending alike stops it. */
	get wentOn(): boolean {
		return this.extended;
	}

	/**
	 * Whether the user may still let the run go on: once per run, for a command or for repeated
	 * answers alike. Granting it forgets the endings of the calls `keys` names, the ones the user
	 * let run again, so their counts start again and the same loop is not judged twice.
	 */
	extend(keys: readonly string[]): boolean {
		if (this.extended) return false;
		this.extended = true;
		for (const key of keys) this.endings.delete(key);
		return true;
	}
}

function sameEnding(earlier: Seen, now: Seen): boolean {
	const a = earlier.ending;
	const b = now.ending;
	if (a.passed !== b.passed || a.how !== b.how || a.fingerprint !== b.fingerprint) return false;
	if (!b.passed) return true;
	// A state that could not be read, or a call the history cannot see, may hide a change.
	return a.state !== undefined && a.state === b.state && earlier.unrecorded === now.unrecorded;
}

/** What changed between the first ending alike and the last, as the model and the user read it. */
function describeChanges({ first, last }: Alike): string {
	const files = [...new Set(last.ending.changed.slice(first.ending.changed.length))];
	const unseen =
		last.unrecorded > first.unrecorded
			? ' Tools whose changes the history cannot see also ran.'
			: '';
	if (files.length === 0) return `No file the history covers changed between them.${unseen}`;
	const back =
		first.ending.state !== undefined && first.ending.state === last.ending.state
			? ', and went back to what they held'
			: '';
	return `Files changed between them${back}: ${files.join(', ')}.${unseen}`;
}

/**
 * Told to the model with the result that makes the third ending alike. `asks` is whether the
 * fifth will ask the user: not once they let the run go on, nor when no one can be asked.
 */
export function loopWarning(label: string, alike: Alike, asks: boolean): string {
	const again = alike.last.ending.passed
		? 'Running it again with nothing changed tells you nothing new.'
		: 'Find out why your changes do not reach what it reports before you run it again.';
	const then = asks ? 'the user is asked whether the run goes on' : 'the run stops';
	return `"${label}" ${alike.last.ending.how} with the same output ${String(alike.times)} times in this run. ${describeChanges(alike)} ${again} If it ends this way ${String(askAt)} times, ${then}.`;
}

/** The question for the user on the fifth ending alike. */
export function loopQuestion(label: string, alike: Alike): UserQuestion {
	const lines = alike.last.ending.output.trimEnd().split('\n').slice(-shownLines).join('\n');
	const output =
		lines.length > shownCharacters ? `…${lines.slice(-shownCharacters)}` : lines || '(nothing)';
	return {
		question: [
			`Possible loop: "${label}" ${alike.last.ending.how} with the same output ${String(alike.times)} times in this run. ${describeChanges(alike)}`,
			'It may be a check that passes after every change, which is no loop, or the model repeating itself.',
			`What it printed, the last lines:\n${output}`,
		].join('\n'),
		options: loopOptions(`If it ends this way ${String(askAt)} more times`),
		multiSelect: false,
	};
}

function loopOptions(again: string): UserQuestion['options'] {
	return [
		{
			label: anotherAttempt,
			description: `Let the run go on, once. ${again}, or any other loop is found, the run stops without asking.`,
		},
		{
			label: stop,
			description:
				'End the run here. What it did and changed is kept, and your next prompt continues from it.',
		},
	];
}

/** Told to the model when the user let the run go on, with their words if they wrote some. */
export function extensionNote(alike: Alike, words?: string): string {
	const said = words === undefined ? '' : ` They said: ${words}`;
	return `It has ended this way ${String(alike.times)} times. The user let the run go on, once.${said} Change your approach: if it ends this way ${String(askAt)} more times, the run stops.`;
}

/** Why the run stopped, for the failure it ends with. */
export function loopStop(label: string, alike: Alike, reason: string): string {
	return `"${label}" ${alike.last.ending.how} with the same output ${String(alike.times)} times. ${describeChanges(alike)} ${reason} The run is kept in the conversation.`;
}

/** The question for the user when the model asks for the same `calls` again, before they run. */
export function repeatQuestion(calls: string): UserQuestion {
	return {
		question: [
			`Possible loop: the model asked for the same tool calls ${String(repeatedAnswersAt)} times in a row, with nothing else between.`,
			'It may be waiting for something that changes by itself, which is no loop, or repeating itself.',
			`The calls:\n${calls}`,
		].join('\n'),
		options: loopOptions(
			`If it asks for the same calls ${String(repeatedAnswersAt)} more times in a row`,
		),
		multiSelect: false,
	};
}

/** Told to the model, with the results of the calls, when the user let them run again. */
export function repeatNote(words?: string): string {
	const said = words === undefined ? '' : ` They said: ${words}`;
	return `You asked for these same calls ${String(repeatedAnswersAt)} times in a row. The user let the run go on, once.${said} Change your approach: if you ask for the same calls ${String(repeatedAnswersAt)} more times in a row, the run stops.`;
}

/** Why the run stopped on repeated answers, for the failure it ends with. */
export function repeatStop(reason: string): string {
	return `The model asked for the same tool calls ${String(repeatedAnswersAt)} times in a row. ${reason} The run is kept in the conversation.`;
}
