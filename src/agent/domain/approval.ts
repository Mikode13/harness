/**
 * How much one tool call can hurt, judged by the tool from that call's input:
 * - `safe` changes nothing, as with a read.
 * - `mutating` makes a change git can undo, as with creating a file.
 * - `destructive` loses something, as with overwriting or deleting a file.
 */
export type ToolRisk = 'safe' | 'mutating' | 'destructive';

/** A program a tool call will run, exactly as it will run: no shell reads it. */
export interface CommandLine {
	executable: string;
	args: string[];
	/** Where it runs, as a real path. */
	cwd: string;
}

/** A worktree a tool call will remove, and what is lost with it. */
export interface WorktreeRemoval {
	/** Its folder, as a real path. */
	path: string;
	/** The branch it has checked out, which stays with its commits; absent when detached. */
	branch?: string;
	/** How many files hold changes no commit has, untracked ones included: they are lost. */
	uncommitted: number;
	/**
	 * How many paths `.gitignore` excludes, such as `.env` or `node_modules`, a folder excluded
	 * whole counting once: they are lost too.
	 */
	ignored: number;
	/** With a detached HEAD, how many of its commits no branch, tag or remote holds: lost too. */
	commitsOnlyHere: number;
}

/** A tool call waiting for someone to allow it. */
export interface ApprovalRequest {
	tool: string;
	/** What the model sent, unvalidated: the tool validates it only if the call is allowed. */
	input: unknown;
	risk: ToolRisk;
	/** For a call that runs a configured command: the program, worked out from the input. */
	command?: CommandLine;
	/** For a call that removes a worktree: which one, and what is lost with it. */
	worktree?: WorktreeRemoval;
}

/** A denial's `reason` reaches the model, so it can try something else. */
export type ApprovalDecision =
	{ approved: true } | { approved: false; reason?: string | undefined };

/**
 * Decides one tool call at a time. A consumer that wants "don't ask again" remembers its own
 * answers, so the harness keeps no session state. A throw ends the run as an
 * `UnrecoverableError`.
 */
export type Approver = (
	request: ApprovalRequest,
	signal: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;

/** What `rememberApprovals` asks for: `remember` allows the same call again without asking. */
export type RememberableDecision =
	| { approved: true; remember?: boolean | undefined }
	| { approved: false; reason?: string | undefined };

/**
 * Wraps `ask` so a call the user allowed with `remember` is not asked about again. `key` decides
 * what counts as the same call; it defaults to the tool's name, so "always" allows every
 * destructive call to that tool. The memory lives in the returned approver, so its lifetime is
 * the consumer's choice: one per session, one per user, or one per run. Calls made at once are
 * each asked; a call that waits its turn in front of it finds an "always" given meanwhile.
 */
export function rememberApprovals(
	ask: (
		request: ApprovalRequest,
		signal: AbortSignal,
	) => RememberableDecision | Promise<RememberableDecision>,
	{ key = request => request.tool }: { key?: (request: ApprovalRequest) => string } = {},
): Approver {
	const allowed = new Set<string>();

	return async (request, signal) => {
		const id = key(request);
		if (allowed.has(id)) return { approved: true };

		const answer = await ask(request, signal);
		// The agent discards an answer that arrives after a cancellation, so it must not be kept.
		signal.throwIfAborted();
		// Read before keeping anything: a truthy `'false'` would otherwise be allowed and remembered.
		const decision = readDecision(answer);
		if (!decision.approved) return decision;
		if (readRemember(answer)) allowed.add(id);
		return decision;
	};
}

/**
 * Reads an approver's answer without trusting its type, since a JavaScript consumer can return
 * anything: only an `approved` that is a boolean decides, and anything else throws.
 */
export function readDecision(answer: unknown): ApprovalDecision {
	if (typeof answer !== 'object' || answer === null) {
		throw new TypeError('The approver answered without a decision');
	}
	const { approved, reason } = answer as { approved?: unknown; reason?: unknown };
	if (typeof approved !== 'boolean') {
		throw new TypeError('The approver answered without a boolean `approved`');
	}

	return approved
		? { approved }
		: { approved, reason: typeof reason === 'string' ? reason : undefined };
}

function readRemember(answer: unknown): boolean {
	const { remember } = answer as { remember?: unknown };
	if (remember !== undefined && typeof remember !== 'boolean') {
		throw new TypeError('The approver answered without a boolean `remember`');
	}
	return remember === true;
}
