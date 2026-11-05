import {
	HistoryExpiredError,
	historyStart,
	isAbortError,
	NothingToMoveError,
	UnknownRunError,
	WorkspaceBusyError,
	WorkspaceMovedError,
	type BranchMove,
	type CommitsPolicy,
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

function commitList(
	commits: readonly { sha: string; subject: string; original?: string }[],
): string {
	return commits
		.map(({ sha, subject, original }) =>
			original === undefined
				? `${sha.slice(0, 7)} ${subject}`
				: `${sha.slice(0, 7)} (again, was ${original.slice(0, 7)}) ${subject}`,
		)
		.join('; ');
}

/** What a move did, or could not do, with the commits of the runs it went over. */
const done: Record<BranchMove['action'], string> = {
	keep: 'kept on the branch',
	revert: 'reverted',
	reset: 'reset off the branch',
	reapply: 'put back',
};
const notDone: Record<BranchMove['action'], string> = {
	keep: 'could not keep',
	revert: 'could not revert',
	reset: 'could not reset',
	reapply: 'could not put back',
};

/**
 * One branch of a move's `git`. Commits kept while their run is undone hold what the files no
 * longer do, which git then shows as changes.
 */
function gitLine(
	{ repository, branch, action, outcome, reason, commits }: BranchMove,
	undone: ReadonlySet<string>,
): string {
	const where = `git: ${repository} (${branch})`;
	const list = commitList(commits);
	if (outcome === 'done') {
		const against =
			action === 'keep' && commits.some(({ runId }) => undone.has(runId))
				? ', so git shows what was undone as changes against them'
				: '';
		return `${where}: ${done[action]}${against}: ${list}`;
	}
	return `${where}: ${notDone[action]} ${list}, which stay as they were: ${reason ?? 'no reason given'}`;
}

/** The answers to what undoing does with the runs' commits; nothing given keeps them. */
const policies: Record<string, CommitsPolicy> = {
	'': 'keep',
	k: 'keep',
	keep: 'keep',
	r: 'revert',
	revert: 'revert',
	s: 'reset',
	reset: 'reset',
};

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
		const committed = this.listCommits([current]);
		if (!(await this.confirm(signal))) return;
		const commits = committed ? await this.commitsPolicy(signal) : undefined;
		if (commits === null) return;
		const reason = await this.reason('Why are you going back? (optional): ', signal);
		// Only from where the user saw it: a run that ended meanwhile is not the one confirmed.
		this.report(
			await this.history.undo({ ...reason, from: current.runId, ...(commits ? { commits } : {}) }),
			[current],
		);
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
		this.report(await this.history.redo({ ...reason, from: head ?? historyStart }), []);
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
		const undone = this.undoneBy(runId, head, runs);
		const committed = this.listCommits(undone);
		if (!(await this.confirm(signal))) return;
		const commits = committed ? await this.commitsPolicy(signal) : undefined;
		if (commits === null) return;
		const back = runId === historyStart || this.isAncestor(runId, head, runs);
		const reason = await this.reason(
			back ? 'Why are you going back? (optional): ' : 'Why? (optional): ',
			signal,
		);
		this.report(
			await this.history.goTo(runId, {
				...reason,
				from: head ?? historyStart,
				...(commits ? { commits } : {}),
			}),
			undone,
		);
	}

	/** Whether `runId` comes before `head` on the line from the start. */
	private isAncestor(runId: string, head: string | undefined, runs: HistoryRun[]): boolean {
		const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
		for (let current = head; current !== undefined; current = parents.get(current)) {
			if (current === runId) return true;
		}
		return false;
	}

	/**
	 * The runs a move from `head` to `target` undoes, newest first: those from `head` back to
	 * where its line meets the line to `target`.
	 */
	private undoneBy(target: string, head: string | undefined, runs: HistoryRun[]): HistoryRun[] {
		const byId = new Map(runs.map(run => [run.runId, run]));
		const towards = new Set<string>();
		for (
			let at = byId.get(target);
			at;
			at = at.parentRunId ? byId.get(at.parentRunId) : undefined
		) {
			towards.add(at.runId);
		}
		const undone: HistoryRun[] = [];
		for (let at = head ? byId.get(head) : undefined; at && !towards.has(at.runId);) {
			undone.push(at);
			at = at.parentRunId ? byId.get(at.parentRunId) : undefined;
		}
		return undone;
	}

	/** Prints the commits of `runs`, which a move that undoes them may take back: whether any. */
	private listCommits(runs: readonly HistoryRun[]): boolean {
		const lines = runs.flatMap(run =>
			(run.commits ?? []).map(
				({ repository, branch, commits }) =>
					`  ${repository} (${branch}): ${commitList(commits)}${runs.length > 1 ? ` (run ${shortId(run.runId)})` : ''}`,
			),
		);
		if (lines.length === 0) return false;
		this.output.print(`${runs.length > 1 ? 'They' : 'It'} made these commits:`);
		for (const line of lines) this.output.print(line);
		return true;
	}

	/** What to do with the commits of the runs undone, or `null` for an answer that is none. */
	private async commitsPolicy(signal: AbortSignal): Promise<CommitsPolicy | null> {
		const answer = (
			await this.promptEmitter.emit('Those commits: [k]eep, [r]evert or re[s]et? (keep): ', signal)
		)
			.trim()
			.toLowerCase();
		const policy = Object.hasOwn(policies, answer) ? policies[answer] : undefined;
		if (policy !== undefined) return policy;
		this.output.print('That is not keep, revert or reset. Nothing was changed.');
		return null;
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

	/** What `move` did, which undid `undone`. */
	private report(move: Move, undone: readonly HistoryRun[]): void {
		const runs = move.to === undefined ? 'how it was before any run' : `run ${shortId(move.to)}`;
		this.output.print(`The workspace is now at ${runs}.`);
		// A commit names the run that made it, which may be one retention chained into a run undone.
		const ids = new Set(undone.flatMap(run => [run.runId, ...(run.absorbed ?? [])]));
		for (const branch of move.git ?? []) this.output.print(gitLine(branch, ids));
		if (move.complete) return;
		this.output.print('Left as they were, because they changed since:');
		for (const conflict of move.conflicts) {
			this.output.print(`  ${conflict.path} (from run ${shortId(conflict.runId)})`);
		}
	}
}
