import type { Agent, AgentResponse, RunOptions } from '#src/agent/domain/agent';
import type { CommitReport, RepositoryCommit } from '#src/agent/domain/commitReport';
import { readAnswers, type UserQuestion } from '#src/agent/domain/question';
import { UnrecoverableError } from '#src/shared/domain/errors';
import { classifyHostFailure, classifyLocalFailure } from '#src/shared/domain/providerFailure';
import type { Committer, FrozenChanges, FrozenRepository } from './committer.ts';

export const committerInstructions =
	"You are the committer agent. Write the git commit message for the change you are given, which the reviewer approved. Follow the style of the repository's recent commit subjects when they show one, such as a type prefix. Answer with the message only: a subject line in the imperative mood, at most 72 characters, then, when the change needs it, a blank line and a short body that says what changed and why. No code fences, no quotes around it, no trailers.";

const getCommitterPrompt = (userPrompt: string, plannerPrompt: string, frozen: FrozenRepository) =>
	`Original user request:
---
${userPrompt}
---

Plan the change carried out:
---
${plannerPrompt}
---

Repository: ${frozen.repository}${frozen.branch === undefined ? '' : `, branch ${frozen.branch}`}
${frozen.style.length > 0 ? `\nIts recent commit subjects:\n${frozen.style.map(subject => `- ${subject}`).join('\n')}\n` : ''}
The change to commit:
---
${frozen.diff}
---`;

// The one answer that commits: anything else, the user's own words included, does not.
const commitLabel = 'Commit';

const nothingThere = 'nothing the run changed there can be committed';

/** A repository the committer did not try, reported as left. */
function leftIn({ repository, branch, leftOut, refused }: FrozenRepository): RepositoryCommit {
	return {
		repository,
		...(branch === undefined ? {} : { branch }),
		outcome: 'left',
		reason: refused ?? nothingThere,
		commits: [],
		paths: [],
		leftOut: [...leftOut],
		unreviewed: [],
	};
}

/**
 * The question that asks whether to commit: what would be committed, and what left out, in the
 * repositories nothing would be committed in too.
 */
function describeCommit(
	ready: readonly FrozenRepository[],
	others: readonly FrozenRepository[],
): string {
	const files = (count: number) => `${String(count)} ${count === 1 ? 'file' : 'files'}`;
	const where = ready
		.map(
			({ repository, branch, paths }) =>
				`${files(paths.length)} in ${repository}${branch === undefined ? '' : ` on ${branch}`}`,
		)
		.join('; ');
	const nothing = others
		.map(
			({ repository, refused }) =>
				` Nothing would be committed in ${repository}: ${refused ?? nothingThere}.`,
		)
		.join('');
	const leftOut = [...ready, ...others].flatMap(({ leftOut }) => leftOut);
	const left =
		leftOut.length === 0
			? ''
			: ` ${files(leftOut.length)} the task changed would be left out: ${leftOut.map(({ path, reason }) => `${path} (${reason})`).join(', ')}.`;
	return `The reviewer approved the change. Commit it? It would commit ${where}.${nothing}${left}`;
}

function stripCodeFence(text: string): string {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
	return match?.[1] ?? text;
}

/** What an orchestrator's commit needs of the run it ends. */
export interface CommitRequest {
	/** The user's request and the plan carried out, for the committer's message. */
	prompt: string;
	plan: string;
	/** What the reviewer read, frozen before its review. */
	frozen: FrozenChanges;
	options: RunOptions;
	/** The committer's options: the run's, attributed to it. */
	committerOptions: RunOptions;
	/** Told of every answer the committer gave, which the run paid for. */
	onResponse: (response: AgentResponse) => void;
}

/**
 * Commits what an approved run changed, once the user says so, or without asking with
 * `autoCommit`: freezes the changes before the review, asks, has the committer write each
 * message, and reports what git did.
 */
export class CommitFlow {
	private readonly committer: Committer | undefined;
	private readonly createCommitter: (() => Agent) | undefined;
	private readonly autoCommit: boolean;
	private readonly warn: (message: string) => void;

	constructor({
		committer,
		createCommitter,
		autoCommit = false,
		warn,
	}: {
		/** Commits what an approved run changed; with `createCommitter`, whose agent writes the message. */
		committer?: Committer | undefined;
		/** A new agent for each message, so none carries an earlier commit's diff. */
		createCommitter?: (() => Agent) | undefined;
		/** Commits without asking. Without it, a run with no `ask` commits nothing. */
		autoCommit?: boolean | undefined;
		/** Logs what the run absorbs, such as a repository left uncommitted. */
		warn: (message: string) => void;
	}) {
		this.committer = committer;
		this.createCommitter = createCommitter;
		this.autoCommit = autoCommit;
		this.warn = warn;
	}

	/** Whether an approved run may be committed: by the user's word, or without asking. */
	committing(options: RunOptions): boolean {
		return (
			this.committer !== undefined &&
			this.createCommitter !== undefined &&
			(this.autoCommit || options.ask !== undefined)
		);
	}

	/** What a commit would hold now, taken before the review; `undefined` when nothing would. */
	async freeze(options: RunOptions): Promise<FrozenChanges | undefined> {
		if (!this.committer || !this.committing(options)) return undefined;
		try {
			return await this.committer.freeze(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The committer could not read what the run changed');
		}
	}

	/**
	 * Commits what the approved run changed. The run succeeds whatever git does with the commit:
	 * its files are changed and approved either way, and the report says what was committed. A git
	 * state that cannot be read ends it, as a committer that fails does, like any role.
	 */
	async commit({
		prompt,
		plan,
		frozen,
		options,
		committerOptions,
		onResponse,
	}: CommitRequest): Promise<CommitReport | undefined> {
		const { committer } = this;
		if (!committer) return undefined;
		const ready = frozen.repositories.filter(
			({ paths, refused }) => paths.length > 0 && refused === undefined,
		);
		const others = frozen.repositories.filter(each => !ready.includes(each));
		const unready = others.map(leftIn);
		if (ready.length === 0) {
			this.warnLeft(unready);
			return { outcome: 'nothing', repositories: unready };
		}
		if (!this.autoCommit && !(await this.userCommits(ready, others, options))) {
			return { outcome: 'declined', repositories: [] };
		}

		const messages = new Map<string, string>();
		for (const each of ready) {
			const message = await this.messageFor(prompt, plan, each, committerOptions, onResponse);
			if (message !== undefined) messages.set(each.repository, message);
		}
		let committed: RepositoryCommit[];
		try {
			committed = await committer.commit(frozen, messages, options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The committer could not commit the change');
		}
		const repositories = [...committed, ...unready];
		this.warnLeft(repositories);
		return {
			outcome: committed.some(({ outcome }) => outcome === 'done') ? 'committed' : 'failed',
			repositories,
		};
	}

	/**
	 * Asks whether to commit, as `askUser` asks: a cancellation ends the run however the asker
	 * answers, and an asker that fails or answers wrongly is host code, which ends it too.
	 */
	private async userCommits(
		ready: readonly FrozenRepository[],
		others: readonly FrozenRepository[],
		{ ask, signal }: RunOptions,
	): Promise<boolean> {
		if (!ask) return false;
		const question: UserQuestion = {
			question: describeCommit(ready, others),
			options: [
				{ label: commitLabel, description: 'Commit the files this task changed' },
				{ label: 'Do not commit', description: 'Leave the changes uncommitted' },
			],
			multiSelect: false,
		};
		signal.throwIfAborted();
		let answers: unknown;
		try {
			answers = await ask([question], signal);
		} catch (error) {
			signal.throwIfAborted();
			throw classifyHostFailure(error, 'The asker failed');
		}
		signal.throwIfAborted();
		const read = readAnswers(answers, [question]);
		if (!read) {
			throw new UnrecoverableError('The asker failed', {
				cause: 'It must answer the question with some text.',
			});
		}
		return read[0] === commitLabel;
	}

	/** The committer's message for one repository, or `undefined` when it wrote none. */
	private async messageFor(
		prompt: string,
		plan: string,
		frozen: FrozenRepository,
		options: RunOptions,
		onResponse: (response: AgentResponse) => void,
	): Promise<string | undefined> {
		const { createCommitter } = this;
		if (!createCommitter) return undefined;
		const response = await createCommitter().run(getCommitterPrompt(prompt, plan, frozen), {
			...options,
			// It only writes a message: nothing to ask, nothing to approve.
			ask: undefined,
			approve: undefined,
		});
		onResponse(response);
		const message = stripCodeFence(response.response).trim();
		return message === '' ? undefined : message;
	}

	/** Tells the logger of each repository the committer made no commit in, or not as reviewed. */
	private warnLeft(repositories: readonly RepositoryCommit[]): void {
		for (const { repository, outcome, reason, unreviewed } of repositories) {
			if (outcome !== 'done') {
				this.warn(`The committer made no commit in ${repository}: ${reason ?? 'no reason given'}`);
			} else if (reason !== undefined) {
				this.warn(
					`The committer's commit in ${repository} was made, but git failed after it: ${reason}`,
				);
			}
			if (unreviewed.length > 0) {
				this.warn(
					`The committer's commit in ${repository} holds what the reviewer did not see, changed while git committed it, by a hook, a filter or an edit: ${unreviewed.join(', ')}`,
				);
			}
		}
	}
}
