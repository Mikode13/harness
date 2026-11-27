import type { ProgressEvent, RunEntry, Tokens } from '../../src/index.ts';
import { costOf, priceKey } from './prices.ts';

/** The model each agent of a run calls: its role, or `role/explorer` for an explorer it sent. */
export type AgentModels = Record<string, string>;

/** What the calls of one agent spent. */
export interface Usage {
	steps: number;
	tokens: Tokens;
	/** In USD at list prices; `undefined` when the model is not in the price table. */
	cost: number | undefined;
}

/** What the record of one run says about its cost and the way its agents worked together. */
export interface RunMetrics {
	/** By agent: `planner`, `executor`, `reviewer`, and `planner/explorer` for those it sent. */
	byAgent: Record<string, Usage>;
	tokens: Tokens;
	/**
	 * Tokens by the key `priceKey` gives each call: its model, apart from calls at a long-prompt
	 * rate. An agent with no model known is kept under `?agent`.
	 */
	byModel: Record<string, Tokens>;
	/** Calls whose usage the provider did not report: they make the cost unknown, not free. */
	unreportedSteps: number;
	/**
	 * Some usage went unreported: a step without tokens, or a run whose end says so, such as a call
	 * that failed with no `step` of its own. The cost is then unknown, never what was reported.
	 */
	unreported: boolean;
	/** In USD at list prices, or `undefined` when a model's price or a call's usage is unknown. */
	cost: number | undefined;
	/** Of the prompt tokens, the share read from the cache. */
	cacheShare: number;
	/**
	 * Calls of each tool that ended, completed, failed or sent off to subagents such as `explore`,
	 * by its name.
	 */
	toolCalls: Record<string, number>;
	/** Calls of each tool that ended in an error, such as a patch that did not apply. */
	toolErrors: Record<string, number>;
	/** Runs of each configured command, by its program, such as `vitest`, and how many failed. */
	commands: Record<string, { runs: number; failed: number }>;
	/**
	 * Agents that read a file another agent of the run had read before them, counted once per
	 * agent and file: what one agent's handover left another to read again. An agent paging
	 * through a file, or reading its own again, adds nothing.
	 */
	repeatedReads: number;
	/** Files that more than one agent read. */
	sharedReads: number;
	/**
	 * How many times the orchestrator ran each stage of its workflow, from its `workflowStage`
	 * events: `plan`, `execute` and `review` are the roles' rounds, a retry of an answer that did
	 * not validate included. Empty for an agent outside an orchestrator.
	 */
	stages: Record<string, number>;
	questions: number;
	outcome: 'completed' | 'failed' | 'cancelled' | 'none';
	/** The failure's message, for a run that failed. */
	failure?: string;
}

const zero = (): Tokens => ({
	inputTokens: 0,
	readCacheTokens: 0,
	writtenCacheTokens: 0,
	outputTokens: 0,
});

const add = (a: Tokens, b: Tokens): Tokens => ({
	inputTokens: a.inputTokens + b.inputTokens,
	readCacheTokens: a.readCacheTokens + b.readCacheTokens,
	writtenCacheTokens: a.writtenCacheTokens + b.writtenCacheTokens,
	outputTokens: a.outputTokens + b.outputTokens,
});

const plus = (counts: Record<string, number>, key: string): void => {
	counts[key] = (counts[key] ?? 0) + 1;
};

// Claude's text editor reads with its `view` command, which its summary starts with.
const editorView = 'view ';

/** Whether a tool call read files: the read tools, and the text editor's `view`. */
function isRead(name: string, summary: string | undefined): boolean {
	if (name === 'readFile' || name === 'readFiles') return true;
	return name === 'str_replace_based_edit_tool' && summary?.startsWith(editorView) === true;
}

/**
 * The paths a read's summary names: `path:1-200`, several joined by `, `, or the text editor's
 * `view path:1-end`.
 */
function readPaths(summary: string | undefined): string[] {
	if (summary === undefined) return [];
	const listed = summary.startsWith(editorView) ? summary.slice(editorView.length) : summary;
	return listed
		.split(', ')
		.map(part => part.replace(/:\d+-(?:\d+|end)$/u, ''))
		.filter(path => path !== '');
}

/**
 * The metrics of one run from its record, with each agent's model priced from `models`. An
 * agent's calls narrate themselves as `step` events, and an explorer's arrive inside the
 * `subagent` events of the role that sent it.
 */
export function metricsOf(entries: readonly RunEntry[], models: AgentModels): RunMetrics {
	const byAgent: Record<string, Usage> = {};
	const toolCalls: Record<string, number> = {};
	const toolErrors: Record<string, number> = {};
	const commands: Record<string, { runs: number; failed: number }> = {};
	const stages: Record<string, number> = {};
	const readers = new Map<string, Set<string>>();
	const byModel: Record<string, Tokens> = {};
	let unreportedSteps = 0;
	let endUnreported = false;
	let repeatedReads = 0;
	let questions = 0;
	let outcome: RunMetrics['outcome'] = 'none';
	let failure: string | undefined;

	const visit = (event: ProgressEvent, agent: string): void => {
		switch (event.type) {
			case 'step': {
				const usage = (byAgent[agent] ??= { steps: 0, tokens: zero(), cost: 0 });
				usage.steps++;
				if (!event.tokens) {
					// Billed, but not reported: what it cost is unknown, not nothing.
					unreportedSteps++;
					usage.cost = undefined;
					return;
				}
				usage.tokens = add(usage.tokens, event.tokens);
				const model = models[agent];
				const key = model === undefined ? `?${agent}` : priceKey(model, event.tokens);
				byModel[key] = add(byModel[key] ?? zero(), event.tokens);
				const cost = model === undefined ? undefined : costOf(model, event.tokens);
				usage.cost = usage.cost === undefined || cost === undefined ? undefined : usage.cost + cost;
				return;
			}
			case 'tool': {
				// `sent` ends a call that started subagents, such as `explore`: it ran, and its
				// subagents' own calls arrive as theirs.
				if (event.status === 'sent') {
					plus(toolCalls, event.name);
					return;
				}
				if (event.status !== 'completed' && event.status !== 'error') return;
				plus(toolCalls, event.name);
				if (event.status === 'error') plus(toolErrors, event.name);
				if (event.name === 'runCommand' && event.summary !== undefined) {
					// The summary shows the command as it runs: its program, by the last part of its path.
					const program = event.summary.split(' ')[0] ?? event.summary;
					const name = program.split('/').at(-1) ?? program;
					const runs = (commands[name] ??= { runs: 0, failed: 0 });
					runs.runs++;
					if (event.status === 'error' || event.exitCode !== undefined) runs.failed++;
				}
				if (isRead(event.name, event.summary)) {
					for (const path of readPaths(event.summary)) {
						const seen = readers.get(path) ?? new Set<string>();
						if (seen.size > 0 && !seen.has(agent)) repeatedReads++;
						seen.add(agent);
						readers.set(path, seen);
					}
				}
				return;
			}
			case 'workflowStage':
				plus(stages, event.stage);
				return;
			case 'subagent':
				visit(event.event, `${agent}/${event.name}`);
				return;
			default:
				return;
		}
	};

	for (const entry of entries) {
		switch (entry.type) {
			case 'progress':
				visit(entry.event, entry.event.agent ?? 'agent');
				break;
			case 'question':
				questions += entry.questions.length;
				break;
			case 'end':
				outcome = entry.outcome;
				if (entry.outcome === 'failed') {
					failure = entry.failure.message;
					if (entry.failure.usageUnreported) endUnreported = true;
				}
				// A response's tokens are missing when a call of the run reported no usage.
				if (entry.outcome === 'completed' && entry.response.tokens === undefined) {
					endUnreported = true;
				}
				break;
			default:
				break;
		}
	}

	const usages = Object.values(byAgent);
	const tokens = usages.reduce((sum, usage) => add(sum, usage.tokens), zero());
	const prompt = tokens.inputTokens + tokens.readCacheTokens + tokens.writtenCacheTokens;
	const unreported = unreportedSteps > 0 || endUnreported;
	return {
		byAgent,
		tokens,
		byModel,
		unreportedSteps,
		unreported,
		cost: unreported
			? undefined
			: usages.reduce<number | undefined>(
					(sum, usage) =>
						sum === undefined || usage.cost === undefined ? undefined : sum + usage.cost,
					0,
				),
		cacheShare: prompt === 0 ? 0 : tokens.readCacheTokens / prompt,
		toolCalls,
		toolErrors,
		commands,
		repeatedReads,
		sharedReads: [...readers.values()].filter(seen => seen.size > 1).length,
		stages,
		questions,
		outcome,
		...(failure === undefined ? {} : { failure }),
	};
}
