import type { ProgressEvent, RunEntry, Tokens } from '../../src/index.ts';
import { costOf } from './prices.ts';

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
	/** In USD at list prices, or `undefined` when a model's price is unknown. */
	cost: number | undefined;
	/** Of the prompt tokens, the share read from the cache. */
	cacheShare: number;
	/** Completed or failed calls of each tool, by its name. */
	toolCalls: Record<string, number>;
	/** Calls of each tool that ended in an error, such as a patch that did not apply. */
	toolErrors: Record<string, number>;
	/** Runs of each configured command, by its program, such as `vitest`, and how many failed. */
	commands: Record<string, { runs: number; failed: number }>;
	/** Reads of a file that some agent of the run had already read, by any agent. */
	repeatedReads: number;
	/** Files that more than one agent read. */
	sharedReads: number;
	/** How many times each agent was given work: a role's rounds. */
	turns: Record<string, number>;
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

/** The paths a read tool's summary names: `path:1-200`, or several joined by `, `. */
function readPaths(summary: string | undefined): string[] {
	if (summary === undefined) return [];
	return summary
		.split(', ')
		.map(part => part.replace(/:\d+-\d+$/u, ''))
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
	const turns: Record<string, number> = {};
	const readers = new Map<string, Set<string>>();
	let repeatedReads = 0;
	let questions = 0;
	let outcome: RunMetrics['outcome'] = 'none';
	let failure: string | undefined;

	const visit = (event: ProgressEvent, agent: string): void => {
		switch (event.type) {
			case 'step': {
				const usage = (byAgent[agent] ??= { steps: 0, tokens: zero(), cost: 0 });
				usage.steps++;
				if (event.tokens) {
					usage.tokens = add(usage.tokens, event.tokens);
					const model = models[agent];
					const cost = model === undefined ? undefined : costOf(model, event.tokens);
					usage.cost =
						usage.cost === undefined || cost === undefined ? undefined : usage.cost + cost;
				}
				return;
			}
			case 'tool': {
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
				if (event.name === 'readFile' || event.name === 'readFiles') {
					for (const path of readPaths(event.summary)) {
						const seen = readers.get(path) ?? new Set<string>();
						if (seen.size > 0) repeatedReads++;
						seen.add(agent);
						readers.set(path, seen);
					}
				}
				return;
			}
			case 'turnStarted':
				plus(turns, agent);
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
				if (entry.outcome === 'failed') failure = entry.failure.message;
				break;
			default:
				break;
		}
	}

	const usages = Object.values(byAgent);
	const tokens = usages.reduce((sum, usage) => add(sum, usage.tokens), zero());
	const prompt = tokens.inputTokens + tokens.readCacheTokens + tokens.writtenCacheTokens;
	return {
		byAgent,
		tokens,
		cost: usages.reduce<number | undefined>(
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
		turns,
		questions,
		outcome,
		...(failure === undefined ? {} : { failure }),
	};
}
