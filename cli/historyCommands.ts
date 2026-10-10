import {
	HistoryExpiredError,
	historyStart,
	isAbortError,
	NothingToMoveError,
	UnknownRunError,
	WorkspaceBusyError,
	WorkspaceMovedError,
	type History,
	type HistoryRun,
	type Move,
} from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

const usage = [
	'History commands:',
	'  /history [--files]   the runs that wrote to this workspace, and where it is now',
	'  /undo                go back to the run before this one',
	'  /redo                go forward again',
	'  /goto <run | start>  go to a run, by its id or its last characters, or to before any run',
];

/** The end of a run's id, which is enough to tell the runs of one workspace apart. */
function shortId(runId: string): string {
	return runId.slice(-6);
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** When a run started, in local time, to the minute. */
function startTime(run: HistoryRun): string {
	const date = new Date(run.startedAt);
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fileCount(run: HistoryRun): string {
	return run.files.length === 1 ? '1 file' : `${String(run.files.length)} files`;
}

function describe(run: HistoryRun): string {
	return `run ${shortId(run.runId)} (${startTime(run)}, ${fileCount(run)})`;
}

/**
 * The commands that move the workspace through the history of the runs that wrote to it,
 * without the model. Each move says what it will do and waits for a yes, then asks why, and the
 * reason is recorded with the move. The move happens only from where the workspace was when it
 * was described.
 */
export class HistoryCommands {
	private readonly history: History;
	private readonly promptEmitter: IPromptEmitter;
	private readonly output: IOutput;

	constructor(history: History, promptEmitter: IPromptEmitter, output: IOutput) {
		this.history = history;
		this.promptEmitter = promptEmitter;
		this.output = output;
	}

	/** Whether `line` is a command, rather than a prompt for the agent. */
	handles(line: string): boolean {
		return line.trimStart().startsWith('/');
	}

	/**
	 * Runs one command. A failure the user can act on, such as nothing to undo or a busy
	 * workspace, is printed; anything else is thrown.
	 */
	async run(line: string, signal: AbortSignal): Promise<void> {
		const [name, ...args] = line.trim().split(/\s+/);
		try {
			switch (name) {
				case '/history':
					await this.show(args.includes('--files'));
					return;
				case '/undo':
					await this.undo(signal);
					return;
				case '/redo':
					await this.redo(signal);
					return;
				case '/goto':
					await this.goTo(args[0], signal);
					return;
				default:
					for (const text of usage) this.output.print(text);
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			if (
				error instanceof NothingToMoveError ||
				error instanceof UnknownRunError ||
				error instanceof HistoryExpiredError ||
				error instanceof WorkspaceBusyError
			) {
				this.output.print(`${error.message}. Nothing was changed.`);
				return;
			}
			if (error instanceof WorkspaceMovedError) {
				this.output.print(
					`${error.message}: it moved while you were answering, so this move did not run. See /history.`,
				);
				return;
			}
			throw error;
		}
	}

	/** The tree of runs, oldest first on each branch, marking where the workspace is. */
	private async show(withFiles: boolean): Promise<void> {
		const { head, runs } = await this.history.list();
		if (runs.length === 0) {
			this.output.print('No run has written to this workspace yet.');
			return;
		}

		const children = new Map<string | undefined, HistoryRun[]>();
		for (const run of runs) {
			children.set(run.parentRunId, [...(children.get(run.parentRunId) ?? []), run]);
		}
		const here = '  <- you are here';
		this.output.print(`start, before any run${head === undefined ? here : ''}`);

		const branch = (parent: string | undefined, indent: string): void => {
			const below = children.get(parent) ?? [];
			for (const [index, run] of below.entries()) {
				const last = index === below.length - 1;
				const status = run.status === 'completed' ? '' : `, ${run.status}`;
				this.output.print(
					`${indent}${last ? '└─ ' : '├─ '}${describe(run)}${status}${run.runId === head ? here : ''}`,
				);
				const inner = `${indent}${last ? '   ' : '│  '}`;
				if (withFiles) for (const file of run.files) this.output.print(`${inner}  · ${file}`);
				branch(run.runId, inner);
			}
		};
		branch(undefined, '');
	}

	private async undo(signal: AbortSignal): Promise<void> {
		const { head, runs } = await this.history.list();
		const current = runs.find(run => run.runId === head);
		if (!current) throw new NothingToMoveError('undo');
		const parent = runs.find(run => run.runId === current.parentRunId);
		this.output.print(
			`This undoes ${describe(current)}, taking the workspace back to ${parent ? describe(parent) : 'how it was before any run'}.`,
		);
		if (!(await this.confirm(signal))) return;
		const reason = await this.reason('Why are you going back? (optional): ', signal);
		// Only from where the user saw it: a run that ended meanwhile is not the one confirmed.
		this.report(await this.history.undo({ ...reason, from: current.runId }));
	}

	private async redo(signal: AbortSignal): Promise<void> {
		const { head, runs } = await this.history.list();
		const next = runs.filter(run => run.parentRunId === head);
		const [only] = next;
		if (only === undefined) throw new NothingToMoveError('redo');
		this.output.print(
			next.length === 1
				? `This redoes ${describe(only)}.`
				: `This redoes one of the ${String(next.length)} runs after this one: the one the workspace was at most recently, or else the newest.`,
		);
		if (!(await this.confirm(signal))) return;
		const reason = await this.reason('Why? (optional): ', signal);
		this.report(await this.history.redo({ ...reason, from: head ?? historyStart }));
	}

	private async goTo(target: string | undefined, signal: AbortSignal): Promise<void> {
		if (target === undefined) {
			this.output.print('Usage: /goto <run | start>');
			return;
		}
		const { head, runs } = await this.history.list();
		let runId: string;
		if (target === 'start' || target === historyStart) {
			runId = historyStart;
		} else {
			const matches = runs.filter(
				run => run.runId === target || run.runId.endsWith(target) || run.runId.startsWith(target),
			);
			if (matches.length > 1) {
				this.output.print(
					`"${target}" matches ${String(matches.length)} runs; give more of the id. Nothing was changed.`,
				);
				return;
			}
			// No match is the history's to explain: it knows a run retention took.
			runId = matches[0]?.runId ?? target;
		}
		if (runId === (head ?? historyStart)) {
			this.output.print('The workspace is already there. Nothing was changed.');
			return;
		}

		const run = runs.find(candidate => candidate.runId === runId);
		if (runId !== historyStart && !run) {
			// Not listed: reading it, which changes nothing, says whether retention took it.
			await this.history.changes(runId, { maxLines: 0 });
			throw new UnknownRunError(runId);
		}
		this.output.print(
			`This moves the workspace to ${run ? `right after ${describe(run)}` : 'how it was before any run'}.`,
		);
		if (!(await this.confirm(signal))) return;
		const back = runId === historyStart || this.isAncestor(runId, head, runs);
		const reason = await this.reason(
			back ? 'Why are you going back? (optional): ' : 'Why? (optional): ',
			signal,
		);
		this.report(await this.history.goTo(runId, { ...reason, from: head ?? historyStart }));
	}

	/** Whether `runId` comes before `head` on the line from the start. */
	private isAncestor(runId: string, head: string | undefined, runs: HistoryRun[]): boolean {
		const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
		for (let current = head; current !== undefined; current = parents.get(current)) {
			if (current === runId) return true;
		}
		return false;
	}

	private async confirm(signal: AbortSignal): Promise<boolean> {
		const answer = (await this.promptEmitter.emit('Go ahead? [y/N]: ', signal)).trim();
		if (/^y(es)?$/i.test(answer)) return true;
		this.output.print('Nothing was changed.');
		return false;
	}

	private async reason(question: string, signal: AbortSignal): Promise<{ reason?: string }> {
		const reason = (await this.promptEmitter.emit(question, signal)).trim();
		return reason ? { reason } : {};
	}

	private report(move: Move): void {
		const runs = move.to === undefined ? 'how it was before any run' : `run ${shortId(move.to)}`;
		this.output.print(`The workspace is now at ${runs}.`);
		if (move.complete) return;
		this.output.print('Left as they were, because they changed since:');
		for (const conflict of move.conflicts) {
			this.output.print(`  ${conflict.path} (from run ${shortId(conflict.runId)})`);
		}
	}
}
