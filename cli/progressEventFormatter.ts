import { styleText } from 'node:util';
import type { ProgressEvent } from '../src/index.ts';

type StyleFormat = Parameters<typeof styleText>[0];
export type ProgressStyler = (format: StyleFormat, text: string) => string;

export interface ProgressEventFormatterOptions {
	/** Injected in tests and otherwise the wall clock. */
	now?: () => number;
	/** Show only bold Markdown headings from reasoning events. */
	thinkingHeadings?: boolean;
	/** Styles terminal text; defaults to Node's `styleText`. */
	style?: ProgressStyler;
}

interface PendingTool {
	startedAt: number;
	description: string;
}

type SubagentEnded = Extract<ProgressEvent, { type: 'subagentEnded' }>;

const statusIcon = {
	completed: '✓',
	error: '✗',
	denied: '⊘',
	// It sent agents to work in the background; each one's end is a line of its own.
	sent: '↗',
} as const;
const endIcon = {
	answered: '✓',
	failed: '✗',
	stopped: '⊘',
} as const;
const summaryWidth = 30;
// Each subagent's lines in a color of their own, so agents working at once read as threads.
const threadColors = ['cyan', 'magenta', 'yellow', 'green', 'blue'] as const;

/**
 * Presents progress without making the terminal consumer part of the published package.
 *
 * Tool starts are deliberately state, not output: the active call belongs in the spinner and its
 * one terminal line is produced only when the call ends.
 */
export class ProgressEventFormatter {
	private readonly now: () => number;
	private readonly thinkingHeadings: boolean;
	private readonly style: ProgressStyler;
	private readonly pending = new Map<string, PendingTool>();
	private readonly threads = new Map<string, StyleFormat>();
	// The subagents at work, by thread, from their first event until they end.
	private readonly working = new Map<string, { label: string; startedAt: number }>();
	private lastAgent: ProgressEvent['agent'];

	constructor({
		now = Date.now,
		thinkingHeadings = false,
		style = styleText,
	}: ProgressEventFormatterOptions = {}) {
		this.now = now;
		this.thinkingHeadings = thinkingHeadings;
		this.style = style;
	}

	format(item: ProgressEvent): string | undefined {
		switch (item.type) {
			case 'agentMessage':
				return this.withRole(item.agent, item.message);
			case 'reasoning':
				return this.formatReasoning(item);
			case 'command':
				if (!item.command) return undefined;
				return this.withRole(item.agent, this.operational(this.commandLine(item)));
			case 'tool':
				return this.formatTool(item);
			case 'mcpTool':
				if (!item.server || !item.status) return undefined;
				return this.withRole(
					item.agent,
					this.operational(`tool: ${item.tool}, server: ${item.server}, status: ${item.status}`),
				);
			case 'search':
				if (!item.query) return undefined;
				return this.withRole(item.agent, this.operational(`searching... query:${item.query}`));
			case 'fileChange':
				if (!item.changes.length) return undefined;
				return this.withRole(
					item.agent,
					this.operational(
						item.changes.map(change => `${change.path} - ${change.kind}`).join('\n'),
					),
				);
			case 'todoList':
				if (!item.items.length) return undefined;
				return this.withRole(
					item.agent,
					this.operational(
						item.items
							.map(todoItem => `${todoItem.text} - status:${todoItem.completed ? '✔' : 'X'}`)
							.join('\n'),
					),
				);
			case 'subagent':
				return this.formatSubagent(item);
			case 'subagentEnded':
				return this.formatSubagentEnded(item);
			case 'turnStarted':
			case 'turnEnded':
				return undefined;
			default:
				// The harness can add event types in a minor release; skip the ones this
				// formatter does not know yet.
				return undefined;
		}
	}

	/**
	 * A description for the current spinner: a running tool, or else a subagent at work, or
	 * undefined when there is neither.
	 */
	spinnerDescription(): string | undefined {
		return (
			this.pending.values().next().value?.description ?? this.working.values().next().value?.label
		);
	}

	/** Ends a turn's presentation state, including a call interrupted by cancellation. */
	reset(): void {
		this.pending.clear();
		this.threads.clear();
		this.working.clear();
		this.lastAgent = undefined;
	}

	/**
	 * A subagent's tool calls and messages, as a thread of its own: in its color, under the role
	 * that sent it, labelled with the path of agents that led to it and its number. Several run
	 * at once, and their reasoning would bury the role's own.
	 */
	private formatSubagent(
		item: Extract<ProgressEvent, { type: 'subagent' }>,
		// The thread of the subagent that started this one, for a subagent's own subagents.
		outer?: { key: string; label: string },
	): string | undefined {
		const { key, label } = this.threadOf(item, outer);
		if (!this.working.has(key)) this.working.set(key, { label, startedAt: this.now() });
		const { event } = item;
		switch (event.type) {
			case 'subagent':
				return this.formatSubagent({ ...event, agent: item.agent }, { key, label });
			case 'subagentEnded':
				return this.formatSubagentEnded({ ...event, agent: item.agent }, { key, label });
			case 'tool':
				return this.formatTool({ ...event, agent: item.agent }, key, label, this.colorOf(key));
			case 'agentMessage':
				return this.withRole(
					item.agent,
					this.style(this.colorOf(key), `  ${label}: ${event.message.replace(/\n/g, '\n    ')}`),
				);
			default:
				return undefined;
		}
	}

	/** The thread of a subagent: its key, and its label, the path of agents that led to it. */
	private threadOf(
		item: { callId: string; subagent: number; name: string; agent?: ProgressEvent['agent'] },
		outer?: { key: string; label: string },
	): { key: string; label: string } {
		return {
			key: `${outer?.key ?? ''}/${item.callId}:${String(item.subagent)}`,
			label: `${outer?.label ?? item.agent ?? 'agent'} › ${item.name} ${String(item.subagent)}`,
		};
	}

	/** One line, in the subagent's color, once it ended: how, and after how long at work. */
	private formatSubagentEnded(
		item: SubagentEnded,
		outer?: { key: string; label: string },
	): string | undefined {
		const { key, label } = this.threadOf(item, outer);
		const working = this.working.get(key);
		this.working.delete(key);
		const ending = [
			item.outcome === 'answered' ? 'ended' : item.outcome,
			working ? formatDuration(Math.max(0, this.now() - working.startedAt)) : undefined,
		]
			.filter(Boolean)
			.join(' · ');
		const line = `  ${endIcon[item.outcome]} ${label} | ${ending}`;
		return this.withRole(item.agent, this.style(this.colorOf(key), line));
	}

	private colorOf(thread: string): StyleFormat {
		let color = this.threads.get(thread);
		if (color === undefined) {
			color = threadColors[this.threads.size % threadColors.length] ?? 'cyan';
			this.threads.set(thread, color);
		}
		return color;
	}

	private formatTool(
		item: Extract<ProgressEvent, { type: 'tool' }>,
		// A subagent's calls have ids of their own conversation, so they are kept apart by it.
		scope = '',
		label: string | undefined = item.agent,
		color?: StyleFormat,
	): string | undefined {
		const key = `${item.agent ?? ''}:${scope}:${item.id}`;
		if (item.status === 'in_progress') {
			this.pending.set(key, {
				startedAt: this.now(),
				description: this.toolDescription(item, label),
			});
			return undefined;
		}

		const pending = this.pending.get(key);
		this.pending.delete(key);
		const duration = pending
			? formatDuration(Math.max(0, this.now() - pending.startedAt))
			: undefined;
		const icon = statusIcon[item.status];
		const role = label ?? 'agent';
		const summary = truncate(compact(item.summary ?? ''), summaryWidth);
		const ending =
			item.status === 'denied' || item.status === 'sent'
				? item.status
				: [
						item.status === 'error'
							? item.exitCode === undefined
								? 'error'
								: `exit ${String(item.exitCode)}`
							: undefined,
						duration,
					]
						.filter(Boolean)
						.join(' · ');
		const columns = [`  ${icon} ${role}`, item.name, summary];
		if (ending) columns.push(ending);
		const line = columns.join(' | ');
		const formatted = this.withRole(
			item.agent,
			color === undefined ? this.operational(line) : this.style(color, line),
		);
		if (item.status === 'completed' && item.diff !== undefined) {
			if (formatted === undefined) return this.style('dim', item.diff);
			return `${formatted}\n${this.style('dim', item.diff)}`;
		}
		return formatted;
	}

	private commandLine(item: Extract<ProgressEvent, { type: 'command' }>): string {
		return `  ${item.agent ?? 'agent'}  command  ${item.command || '?'}  exit ${String(item.exitCode ?? '?')}`;
	}

	private toolDescription(
		item: Extract<ProgressEvent, { type: 'tool' }>,
		label: string | undefined,
	): string {
		return [label, item.name, compact(item.summary ?? '')]
			.filter((value): value is string => Boolean(value))
			.join(' ');
	}

	private formatReasoning(item: Extract<ProgressEvent, { type: 'reasoning' }>): string | undefined {
		if (!this.thinkingHeadings) {
			return this.withRole(item.agent, this.thinking(item.message));
		}

		const headings = [...item.message.matchAll(/^\s*\*\*([^*\n]+)\*\*\s*$/gm)].map(
			match => `∴ ${match[1] ?? ''}`,
		);
		// Heading mode is a filter, not a role announcement: a reasoning part without a
		// Markdown heading must not produce any other text.
		return headings.length > 0
			? this.withRole(item.agent, this.thinking(headings.join('\n')))
			: undefined;
	}

	private thinking(text: string): string {
		return this.style('dim', this.style('italic', text));
	}

	private operational(text: string): string {
		return this.style('dim', text);
	}

	private withRole(agent: ProgressEvent['agent'], text: string | undefined): string | undefined {
		if (!agent) return text;
		const changed = agent !== this.lastAgent;
		this.lastAgent = agent;
		if (!text) return changed ? `\n${this.style('bold', agent)}` : undefined;
		return changed ? `\n${this.style('bold', agent)}\n${text}` : text;
	}
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1000) return `${String(Math.round(milliseconds))} ms`;
	const seconds = milliseconds / 1000;
	return `${seconds.toFixed(1).replace(/\.0$/, '')} s`;
}

/** A consumer summary is narration, so it must not turn the one-call line into a paragraph. */
function compact(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(0, width - 1))}…`;
}
