import type { Conversation } from '#src/llm/domain/conversation';
import type { Message } from '#src/llm/domain/message';
import type { RecoveryStore, Revision } from '#src/recovery/domain/recoveryStore';

/** What an agent reads of its workspace's history. */
export type HistoryReader = Pick<RecoveryStore, 'listRuns' | 'listRevisions' | 'readRun'>;

/** Where the conversation goes on after the workspace moved, and what the moves left behind. */
export interface Followed {
	/** The turn the next one follows. */
	turn: number | undefined;
	/**
	 * The turns on the path to the last turn recorded whose run the workspace no longer holds:
	 * what the moves since undid.
	 */
	undone: number[];
	/** The moves since the conversation last looked, oldest first. */
	revisions: Revision[];
	/** The latest move, so the next look starts after it. */
	latestRevision: number;
	/** Where the workspace is: `undefined` for the start of its history. */
	head: string | undefined;
}

// A prompt is named, not repeated: enough to recognise it.
const promptChars = 300;

/**
 * Picks the turn a conversation goes on from, given where the workspace is now. A turn belongs
 * to the run it wrote in; a turn that wrote nothing belongs to the run of the turn it followed.
 * Of the turns whose run is on the line from the start to the head, it picks the one nearest
 * the head, and of those the newest. A run retention chained into a later one counts as that
 * one, and a run retention removed is off every line.
 */
export async function followHistory(
	conversation: Conversation,
	history: HistoryReader,
	seenRevision: number,
): Promise<Followed> {
	const { head, runs } = await history.listRuns();
	const revisions = await history.listRevisions();

	const keeper = new Map<string, string>();
	for (const run of runs) {
		keeper.set(run.runId, run.runId);
		for (const absorbed of run.absorbed ?? []) keeper.set(absorbed, run.runId);
	}
	const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
	const line: string[] = [];
	for (let runId = head; runId !== undefined; runId = parents.get(runId)) line.unshift(runId);

	// -1 is the start of the history; `undefined` is a turn off the line.
	const depths: (number | undefined)[] = [];
	const runsOf: (string | undefined)[] = [];
	let best: number | undefined;
	for (const { index, parent, runId } of conversation.describeTurns()) {
		const run = runId ?? (parent === undefined ? undefined : runsOf[parent]);
		runsOf.push(run);
		const kept = run === undefined ? undefined : keeper.get(run);
		const position = kept === undefined ? -1 : line.indexOf(kept);
		// -1 for the start, -2 for a run off the line or no longer kept.
		const own = run === undefined ? -1 : position === -1 ? -2 : position;
		const onLine = own >= -1 && (parent === undefined || depths[parent] !== undefined);
		depths.push(onLine ? own : undefined);
		const bestDepth = best === undefined ? -2 : (depths[best] ?? -2);
		if (onLine && own >= bestDepth) best = index;
	}

	const kept = new Set(conversation.path(best));
	return {
		turn: best,
		// A turn left on another branch whose run is still on the line was not undone: a redo
		// passed it by. Only a turn whose run left the line was.
		undone: conversation
			.path(conversation.currentTurn)
			.filter(index => !kept.has(index) && depths[index] === undefined),
		revisions: revisions.filter(revision => revision.revision > seenRevision),
		latestRevision: revisions.at(-1)?.revision ?? seenRevision,
		head,
	};
}

/**
 * What the model is told when the workspace was moved back past some of its turns: that they
 * were undone and no longer show, what they asked, or a summary of what they tried, the files
 * those runs had changed, the files a move left as they were, and the user's reasons.
 */
export async function undoNote({
	conversation,
	history,
	followed,
	summary,
}: {
	conversation: Conversation;
	history: HistoryReader;
	followed: Followed;
	summary?: string;
}): Promise<string> {
	const lines = [
		followed.head === undefined
			? 'Note from the harness: the user moved the workspace back to how it was before any change an agent made. What the turns below asked for was undone, and those turns are no longer in this conversation.'
			: 'Note from the harness: the user moved the workspace back to an earlier run. What the turns below asked for was undone, and those turns are no longer in this conversation.',
	];

	if (summary) {
		lines.push('', 'What was tried, and what went wrong:', summary);
	} else {
		lines.push('', 'What they asked:');
		for (const turn of followed.undone) {
			const prompt = promptOf(conversation.messagesOf(turn)[0]);
			if (prompt !== undefined) lines.push(`- «${shorten(prompt, promptChars)}»`);
		}
	}

	let root: string | undefined;
	const files = new Set<string>();
	const runs = new Set(
		conversation
			.describeTurns()
			.filter(turn => followed.undone.includes(turn.index))
			.flatMap(turn => (turn.runId ? [turn.runId] : [])),
	);
	for (const runId of runs) {
		// A run retention took no longer names its files; the others still do.
		const record = await history.readRun(runId).catch(() => undefined);
		if (!record) continue;
		root = record.record.root;
		for (const entry of record.entries) files.add(entry.path);
	}
	if (files.size > 0) {
		lines.push(
			'',
			`Files those runs had changed: ${[...files].map(path => relativeTo(root, path)).join(', ')}`,
		);
	}

	const conflicts = [
		...new Set(
			followed.revisions.flatMap(revision => revision.conflicts.map(conflict => conflict.path)),
		),
	];
	if (conflicts.length > 0) {
		lines.push(
			'',
			`Files left as they were, because they had changed since: ${conflicts.map(path => relativeTo(root, path)).join(', ')}`,
		);
	}
	const reasons = followed.revisions.flatMap(revision =>
		revision.reason ? [revision.reason] : [],
	);
	if (reasons.length > 0) {
		lines.push('', `The user's reason: ${reasons.map(reason => `«${reason}»`).join(' ')}`);
	}

	lines.push(
		'',
		'Check the current state of a file before relying on what an earlier turn saw of it.',
	);
	return lines.join('\n');
}

/** The undone turns as plain text, for a model to summarize. Bounded, and marked when cut. */
export function transcriptOf(
	conversation: Conversation,
	turns: number[],
	maxChars = 30_000,
): string {
	const lines: string[] = [];
	for (const turn of turns) {
		for (const message of conversation.messagesOf(turn)) {
			for (const part of message.content) {
				if (part.type === 'text') lines.push(`${message.role}: ${part.text}`);
				if (part.type === 'toolCall') {
					lines.push(
						`${message.role} called ${part.name} ${shorten(JSON.stringify(part.input), 300)}`,
					);
				}
				if (part.type === 'toolResult') {
					lines.push(
						`${part.name} ${part.isError ? 'failed' : 'returned'}: ${shorten(part.output, 300)}`,
					);
				}
			}
		}
	}
	const text = lines.join('\n');
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[the rest was cut]`;
}

/** The prompt of a turn: its first message's last text, after any note the harness put first. */
function promptOf(message: Message | undefined): string | undefined {
	const texts = message?.content.flatMap(part => (part.type === 'text' ? [part.text] : []));
	return texts?.at(-1);
}

function shorten(text: string, chars: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`;
}

function relativeTo(root: string | undefined, path: string): string {
	return root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
