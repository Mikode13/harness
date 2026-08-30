import { afterEach, describe, expect, it, vi } from 'vitest';
import { Loop } from '../../src/loopImpl.ts';
import type { Agent, AgentResponse, ProgressEvent } from '../../src/models/agent.ts';
import { UnrecoverableError } from '../../src/models/errors.ts';

type QuestionResult = string | { error: unknown };

function createTerminal(...replies: QuestionResult[]) {
	const terminal = {
		question: vi.fn(() => {
			const reply = replies.shift();
			if (typeof reply === 'string') return Promise.resolve(reply);
			return Promise.reject(
				reply?.error instanceof Error ? reply.error : new Error(String(reply?.error)),
			);
		}),
		onInterrupt: vi.fn(() => () => undefined),
		clearLine: vi.fn(),
		cursorToStart: vi.fn(),
		write: vi.fn(),
		log: vi.fn(),
		error: vi.fn(),
		close: vi.fn(),
	};

	return terminal;
}

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
	return {
		response: 'answer',
		inputTokens: 3,
		outputTokens: 5,
		duration: 2,
		...overrides,
	};
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted', 'AbortError');
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('Loop', () => {
	it('forwards progress and renders usage for a successful response', async () => {
		const terminal = createTerminal('hello', { error: abortError() }, 'yes');
		const progress: ProgressEvent = { type: 'reasoning', message: 'thinking' };
		const callback = vi.fn();
		const agent: Agent = {
			run: vi.fn((...args: Parameters<Agent['run']>) => {
				args[2](progress);
				return Promise.resolve(response());
			}),
		};
		const loop = new Loop(agent, callback, terminal);

		await loop.start();

		expect(callback).toHaveBeenCalledWith(progress);
		expect(terminal.cursorToStart).toHaveBeenCalled();
		expect(terminal.clearLine).toHaveBeenCalled();
		expect(terminal.log).toHaveBeenCalledWith('usage:');
		expect(terminal.log).toHaveBeenCalledWith('duration: 2s');
		expect(terminal.log).toHaveBeenCalledWith('inputTokens: 3');
		expect(terminal.log).toHaveBeenCalledWith('outputTokens: 5');
	});

	it('does not render usage when the agent has no response', async () => {
		const terminal = createTerminal('hello', { error: abortError() }, 'yes');
		const agent: Agent = { run: vi.fn().mockResolvedValue(undefined) };
		const loop = new Loop(agent, vi.fn(), terminal);

		await loop.start();

		expect(terminal.log).not.toHaveBeenCalled();
	});

	it('renders spinner frames in order, wraps after ten frames, and stops after the turn', async () => {
		vi.useFakeTimers();
		const terminal = createTerminal('hello', { error: abortError() }, 'yes');
		let resolveRun!: (agentResponse: AgentResponse) => void;
		const run = vi.fn(
			() =>
				new Promise<AgentResponse>(resolve => {
					resolveRun = resolve;
				}),
		);
		const loop = new Loop({ run }, vi.fn(), terminal);
		const start = loop.start();

		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(80 * 11);

		expect(run).toHaveBeenCalledOnce();
		expect(terminal.write.mock.calls).toEqual([
			['\r⠋'],
			['\r⠙'],
			['\r⠹'],
			['\r⠸'],
			['\r⠼'],
			['\r⠴'],
			['\r⠦'],
			['\r⠧'],
			['\r⠇'],
			['\r⠏'],
			['\r⠋'],
		]);

		resolveRun(response());
		await start;
		const writesAfterTurn = terminal.write.mock.calls.length;
		await vi.advanceTimersByTimeAsync(80 * 11);

		expect(terminal.write.mock.calls).toHaveLength(writesAfterTurn);
	});

	it('confirms an abort before leaving and resumes when the user declines', async () => {
		const terminal = createTerminal({ error: abortError() }, 'no', { error: abortError() }, 'yes');
		const run = vi.fn();
		const agent: Agent = { run };
		const loop = new Loop(agent, vi.fn(), terminal);

		await loop.start();

		expect(terminal.question).toHaveBeenNthCalledWith(1, '> ', expect.any(AbortSignal));
		expect(terminal.question).toHaveBeenNthCalledWith(
			2,
			'Are you sure you want to exit? ',
			expect.any(AbortSignal),
		);
		expect(terminal.question).toHaveBeenNthCalledWith(3, '> ', expect.any(AbortSignal));
		expect(run).not.toHaveBeenCalled();
	});

	it('stops after an unrecoverable agent failure', async () => {
		const terminal = createTerminal('hello');
		const failure = new UnrecoverableError('cannot continue', { cause: 'fatal' });
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new Loop(agent, vi.fn(), terminal);

		await loop.start();

		expect(terminal.log).toHaveBeenCalledWith(failure);
		expect(terminal.error).not.toHaveBeenCalled();
	});

	it('reports unexpected failures before continuing', async () => {
		const terminal = createTerminal('hello', { error: abortError() }, 'yes');
		const failure = new Error('unexpected');
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new Loop(agent, vi.fn(), terminal);

		await loop.start();

		expect(terminal.error).toHaveBeenCalledWith(failure);
	});

	it('closes the terminal and says goodbye', () => {
		const terminal = createTerminal();
		const loop = new Loop({ run: vi.fn() }, vi.fn(), terminal);

		loop.close();

		expect(terminal.close.mock.calls).toHaveLength(1);
		expect(terminal.log).toHaveBeenCalledWith('thanks, bye!');
	});
});
