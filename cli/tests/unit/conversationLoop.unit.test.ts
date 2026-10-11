import { describe, expect, it, vi } from 'vitest';
import { ConversationLoop } from '../../conversationLoop.ts';
import type {
	Agent,
	AgentResponse,
	ProgressEvent,
	RunOptions,
} from '../../../src/agent/domain/agent.ts';
import { UnrecoverableError } from '../../../src/shared/domain/errors.ts';

type EmitResult = string | { error: unknown };

function createPromptEmitter(...replies: EmitResult[]) {
	return {
		emit: vi.fn(() => {
			const reply = replies.shift();
			if (typeof reply === 'string') return Promise.resolve(reply);
			return Promise.reject(
				reply?.error instanceof Error ? reply.error : new Error(String(reply?.error)),
			);
		}),
		close: vi.fn(),
	};
}

function createOutput() {
	return { print: vi.fn(), printError: vi.fn() };
}

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
	return {
		response: 'answer',
		tokens: { inputTokens: 3, readCacheTokens: 7, writtenCacheTokens: 11, outputTokens: 5 },
		duration: 2,
		...overrides,
	};
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted', 'AbortError');
}

describe('ConversationLoop', () => {
	it("passes the CLI's approver to every run", async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const run = vi.fn<Agent['run']>(() => Promise.resolve(response()));
		const approve = vi.fn(() => ({ approved: true as const }));

		await new ConversationLoop({ run }, vi.fn(), promptEmitter, createOutput(), approve).start();

		expect(run.mock.calls[0]?.[1].approve).toBe(approve);
	});

	it('forwards progress and prints usage for a successful response', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const output = createOutput();
		const progress: ProgressEvent = { type: 'reasoning', message: 'thinking' };
		const callback = vi.fn();
		const agent: Agent = {
			run: vi.fn((_prompt: string, { onProgress }: RunOptions) => {
				onProgress?.(progress);
				return Promise.resolve(response());
			}),
		};
		const loop = new ConversationLoop(agent, callback, promptEmitter, output);

		await loop.start();

		expect(callback).toHaveBeenCalledWith(progress);
		expect(output.print).toHaveBeenCalledWith('usage:');
		expect(output.print).toHaveBeenCalledWith('duration: 2s');
		expect(output.print).toHaveBeenCalledWith('inputTokens: 3');
		expect(output.print).toHaveBeenCalledWith('readCacheTokens: 7');
		expect(output.print).toHaveBeenCalledWith('writtenCacheTokens: 11');
		expect(output.print).toHaveBeenCalledWith('outputTokens: 5');
	});

	it('emits turnStarted before running the agent and turnEnded after it settles', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const callback = vi.fn();
		const agent: Agent = { run: vi.fn().mockResolvedValue(response()) };
		const loop = new ConversationLoop(agent, callback, promptEmitter, createOutput());

		await loop.start();

		const eventTypes = callback.mock.calls.map(call => (call[0] as ProgressEvent).type);
		expect(eventTypes).toEqual(['turnStarted', 'turnEnded']);
	});

	it('still emits turnEnded when the agent run fails', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const callback = vi.fn();
		const agent: Agent = { run: vi.fn().mockRejectedValue(new Error('boom')) };
		const loop = new ConversationLoop(agent, callback, promptEmitter, createOutput());

		await loop.start();

		const eventTypes = callback.mock.calls.map(call => (call[0] as ProgressEvent).type);
		expect(eventTypes).toEqual(['turnStarted', 'turnEnded']);
	});

	it('says the tokens are unknown when a call did not report its usage', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const output = createOutput();
		const agent: Agent = { run: vi.fn().mockResolvedValue(response({ tokens: undefined })) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, output);

		await loop.start();

		expect(output.print).toHaveBeenCalledWith('tokens: unknown, a call did not report its usage');
	});

	it('says the tokens of a failed run are unknown when a call did not report its usage', async () => {
		const promptEmitter = createPromptEmitter('hello');
		const output = createOutput();
		const failure = new UnrecoverableError('broken', { cause: 'fatal', usageUnreported: true });
		const loop = new ConversationLoop(
			{ run: vi.fn().mockRejectedValue(failure) },
			vi.fn(),
			promptEmitter,
			output,
		);

		await loop.start();

		expect(output.print).toHaveBeenCalledWith('usage before the failure:');
		expect(output.print).toHaveBeenCalledWith('tokens: unknown, a call did not report its usage');
	});

	it('prints the tokens a failed run spent before failing', async () => {
		const promptEmitter = createPromptEmitter('hello');
		const output = createOutput();
		const failure = new UnrecoverableError('Max attempts exhausted', {
			cause: 'quota',
			tokens: { inputTokens: 3, readCacheTokens: 2, writtenCacheTokens: 1, outputTokens: 4 },
		});
		const loop = new ConversationLoop(
			{ run: vi.fn().mockRejectedValue(failure) },
			vi.fn(),
			promptEmitter,
			output,
		);

		await loop.start();

		expect(output.print).toHaveBeenCalledWith('usage before the failure:');
		expect(output.print).toHaveBeenCalledWith('inputTokens: 3');
		expect(output.print).toHaveBeenCalledWith('outputTokens: 4');
		expect(output.printError).toHaveBeenCalledWith(failure);
	});

	it('exits immediately on an interrupt while idle at the prompt', async () => {
		const promptEmitter = createPromptEmitter({ error: abortError() });
		const run = vi.fn();
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, createOutput());

		await loop.start();

		expect(promptEmitter.emit).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();
	});

	it('cancels only the current turn on an interrupt while the agent is running, then asks for the next prompt', async () => {
		const promptEmitter = createPromptEmitter('hello', 'world', { error: abortError() });
		const run = vi.fn().mockRejectedValueOnce(abortError()).mockResolvedValueOnce(response());
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, createOutput());

		await loop.start();

		expect(run).toHaveBeenCalledTimes(2);
		expect(promptEmitter.emit).toHaveBeenCalledTimes(3);
	});

	it('stops after an unrecoverable agent failure', async () => {
		const promptEmitter = createPromptEmitter('hello');
		const output = createOutput();
		const failure = new UnrecoverableError('cannot continue', { cause: 'fatal' });
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, output);

		await loop.start();

		expect(output.printError).toHaveBeenCalledWith(failure);
		expect(promptEmitter.emit).toHaveBeenCalledOnce();
	});

	it('reports an unexpected prompt failure and asks again', async () => {
		const promptEmitter = createPromptEmitter(
			{ error: new Error('unexpected') },
			{ error: abortError() },
		);
		const output = createOutput();
		const run = vi.fn();
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, output);

		await loop.start();

		expect(output.printError).toHaveBeenCalledWith(new Error('unexpected'));
		expect(run).not.toHaveBeenCalled();
	});

	it('reports unexpected agent failures before continuing', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const output = createOutput();
		const failure = new Error('unexpected');
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, output);

		await loop.start();

		expect(output.printError).toHaveBeenCalledWith(failure);
	});

	it('cancel() aborts the signal passed to the active operation', async () => {
		let capturedSignal: AbortSignal | undefined;
		const promptEmitter = {
			emit: vi.fn((_prompt: string, signal: AbortSignal) => {
				capturedSignal = signal;
				return new Promise<string>(() => undefined);
			}),
			close: vi.fn(),
		};
		const loop = new ConversationLoop({ run: vi.fn() }, vi.fn(), promptEmitter, createOutput());

		void loop.start();
		await Promise.resolve();

		loop.cancel();

		expect(capturedSignal?.aborted).toBe(true);
	});

	it('sends a command to the commands, not to the agent, and carries on', async () => {
		const promptEmitter = createPromptEmitter('/undo', 'hello', { error: abortError() });
		const run = vi.fn<Agent['run']>(() => Promise.resolve(response()));
		const commands = {
			handles: (line: string) => line.startsWith('/'),
			run: vi.fn(() => Promise.resolve()),
		};

		await new ConversationLoop(
			{ run },
			vi.fn(),
			promptEmitter,
			createOutput(),
			undefined,
			commands,
		).start();

		expect(commands.run).toHaveBeenCalledWith('/undo', expect.any(AbortSignal));
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]?.[0]).toBe('hello');
	});

	it('prints a command that fails and carries on, and stops when the user cancels it', async () => {
		const promptEmitter = createPromptEmitter('/history', '/undo');
		const output = createOutput();
		const failure = new Error('the disk is gone');
		const commands = {
			handles: () => true,
			run: vi
				.fn<(line: string, signal: AbortSignal) => Promise<void>>()
				.mockRejectedValueOnce(failure)
				.mockRejectedValueOnce(abortError()),
		};

		await new ConversationLoop(
			{ run: vi.fn() },
			vi.fn(),
			promptEmitter,
			output,
			undefined,
			commands,
		).start();

		expect(output.printError).toHaveBeenCalledWith(failure);
		expect(commands.run).toHaveBeenCalledTimes(2);
	});

	it('names the run a response recorded', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const output = createOutput();
		const run = vi.fn<Agent['run']>(() =>
			Promise.resolve(response({ runId: '20261010T120000000Z-abc123' })),
		);

		await new ConversationLoop({ run }, vi.fn(), promptEmitter, output).start();

		expect(output.print).toHaveBeenCalledWith('run: 20261010T120000000Z-abc123');
	});

	it('closes the prompt emitter and says goodbye', () => {
		const promptEmitter = createPromptEmitter();
		const output = createOutput();
		const loop = new ConversationLoop({ run: vi.fn() }, vi.fn(), promptEmitter, output);

		loop.close();

		expect(promptEmitter.close).toHaveBeenCalledOnce();
		expect(output.print).toHaveBeenCalledWith('thanks, bye!');
	});
});
