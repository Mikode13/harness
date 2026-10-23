import type { CommandLine, ToolRisk } from '#src/agent/domain/approval';
import type { ToolDefinition } from '#src/llm/domain/tool';
import type { ToolCallContext } from './readRegistry.ts';
import type { Tool, ToolSummarizer } from './tool.ts';

/** How a configured command ended, for telling a command run again for nothing. */
export interface CommandEnding {
	/** It exited with code 0. */
	passed: boolean;
	/** How it ended, such as "exited with code 1" or "ran past its time limit". */
	how: string;
	/** What it printed, or the end of it, without colors, as the user is shown it. */
	output: string;
	/**
	 * A hash of everything it printed, line by line, without colors or the times a known test
	 * runner adds: what tells two endings apart.
	 */
	fingerprint: string;
	/**
	 * What the files the run changed held when it ended, as `RunJournal.contentState` gives it.
	 * Missing when it changed something the history could not record.
	 */
	state?: string;
	/** The file of every change the run had applied by then, in order, as the model names it. */
	changed: readonly string[];
}

/**
 * A tool call checked and fixed before anyone approves it: its risk is judged on what will
 * really happen, and `run` does exactly that, nothing worked out again.
 */
export interface PreparedCall {
	readonly risk: ToolRisk;
	/** For a change to a file, what it will change as a unified diff, fixed when prepared. */
	readonly diff?: string;
	/** For a call that runs a configured command, what it will run, fixed when prepared. */
	readonly command?: CommandLine;
	/**
	 * For a call that runs a configured command, how it ended once it has. `undefined` before it
	 * runs, and when it never did.
	 */
	readonly ending?: () => CommandEnding | undefined;
	/** A consumer's call: whatever it changes, the history does not record. */
	readonly unrecorded?: true;
	run(signal: AbortSignal): Promise<string>;
}

/**
 * A tool ran and produced a result the model should see as an error. Internal tools use this
 * instead of a plain error when the result also carries narrative metadata, such as a command's
 * non-zero exit code.
 */
export class ToolExecutionError extends Error {
	readonly exitCode: number | undefined;

	constructor(message: string, { exitCode }: { exitCode?: number } = {}) {
		super(message);
		this.exitCode = exitCode;
	}
}

/**
 * A failure inside a call that ends the run instead of the call, such as an approver that failed
 * while an agent the call started was asking it: host code failed, and the model must not carry
 * on as if a tool had. Internal.
 */
export class RunEndingToolError extends Error {
	readonly failure: unknown;

	constructor(failure: unknown) {
		super('A failure inside a tool call ends the run');
		this.failure = failure;
	}
}

/**
 * A tool built by the harness, such as a write tool, which prepares each call against the
 * state of the run before it is approved. Internal: consumers build a `Tool`.
 */
export interface PreparingTool extends ToolDefinition {
	/** Describes the model's input without exposing preparation details to the provider. */
	summarize?: ToolSummarizer;
	/** Rejects with a message for the model when the call cannot run. */
	prepare(input: unknown, signal: AbortSignal, call: ToolCallContext): Promise<PreparedCall>;
}

/** What an agent a call handed a task to answered, for the model that sent it. */
export interface DelegatedAnswer {
	readonly text: string;
	/** It failed, and `text` says why. */
	readonly failed?: true;
}

/** An agent a call handed a task to, working in the background until it answers. */
export interface Delegated {
	/** Which agent it is, as its `subagent` events name it: `explorer`, or the tool's name. */
	readonly name: string;
	/** Its number among the agents of its call, from 1, as its `subagent` events carry it. */
	readonly subagent: number;
	/** The task it was given, as the model wrote it. */
	readonly task: string;
	/**
	 * Its answer for the model that sent it, or why it failed. It rejects only when the run was
	 * cancelled, or with a `RunEndingToolError`.
	 */
	readonly answer: Promise<DelegatedAnswer>;
}

/**
 * A call that hands tasks to agents, checked before anyone approves it. Once approved, `start`
 * sends them and the call answers at once: they work in the background, and each one's answer
 * reaches the model when it finishes.
 */
export interface PreparedDelegation {
	readonly risk: ToolRisk;
	/** The agents may run a consumer's tools, whose changes the history does not record. */
	readonly unrecorded?: true;
	start(signal: AbortSignal): readonly Delegated[];
}

/**
 * A tool built by the harness whose calls hand tasks to agents working in the background, such
 * as `explore`. Internal.
 */
export interface DelegatingTool extends ToolDefinition {
	summarize?: ToolSummarizer;
	/** Rejects with a message for the model when the tasks cannot be handed over. */
	delegate(input: unknown, signal: AbortSignal, call: ToolCallContext): Promise<PreparedDelegation>;
}

/** What an agent can run: a consumer's `Tool`, or one the harness built. */
export type AgentTool = Tool | PreparingTool | DelegatingTool;

export function isDelegating(tool: AgentTool): tool is DelegatingTool {
	return 'delegate' in tool;
}

function isPreparing(tool: AgentTool): tool is PreparingTool {
	return 'prepare' in tool;
}

/**
 * Brings any tool into the one lifecycle of prepare, approve, run. A consumer's `Tool` has its
 * risk judged now, and later runs on the input as the model sent it.
 */
export async function prepareCall(
	tool: Tool | PreparingTool,
	input: unknown,
	signal: AbortSignal,
	call: ToolCallContext,
): Promise<PreparedCall> {
	if (isPreparing(tool)) return tool.prepare(input, signal, call);

	const risk = tool.risk(input);
	return { risk, unrecorded: true, run: runSignal => tool.execute(input, runSignal) };
}
