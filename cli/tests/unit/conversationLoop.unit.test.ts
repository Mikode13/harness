import { describe, expect, it, vi } from 'vitest';
import { ConversationLoop } from '../../conversationLoop.ts';
import type { Agent, AgentResponse, ProgressEvent } from '../../../src/agent/domain/agent.ts';
import { UnrecoverableError } from '../../../src/agent/domain/errors.ts';

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

function createLogger() {
	return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

describe('ConversationLoop', () => {
	it('forwards progress and logs usage for a successful response', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const logger = createLogger();
		const progress: ProgressEvent = { type: 'reasoning', message: 'thinking' };
		const callback = vi.fn();
		const agent: Agent = {
			run: vi.fn((...args: Parameters<Agent['run']>) => {
				args[2](progress);
				return Promise.resolve(response());
			}),
		};
		const loop = new ConversationLoop(agent, callback, promptEmitter, logger);

		await loop.start();

		expect(callback).toHaveBeenCalledWith(progress);
		expect(logger.log).toHaveBeenCalledWith('usage:');
		expect(logger.log).toHaveBeenCalledWith('duration: 2s');
		expect(logger.log).toHaveBeenCalledWith('inputTokens: 3');
		expect(logger.log).toHaveBeenCalledWith('outputTokens: 5');
	});

	it('emits turnStarted before running the agent and turnEnded after it settles', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const logger = createLogger();
		const callback = vi.fn();
		const agent: Agent = { run: vi.fn().mockResolvedValue(response()) };
		const loop = new ConversationLoop(agent, callback, promptEmitter, logger);

		await loop.start();

		const eventTypes = callback.mock.calls.map(call => (call[0] as ProgressEvent).type);
		expect(eventTypes).toEqual(['turnStarted', 'turnEnded']);
	});

	it('still emits turnEnded when the agent run fails', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const logger = createLogger();
		const callback = vi.fn();
		const agent: Agent = { run: vi.fn().mockRejectedValue(new Error('boom')) };
		const loop = new ConversationLoop(agent, callback, promptEmitter, logger);

		await loop.start();

		const eventTypes = callback.mock.calls.map(call => (call[0] as ProgressEvent).type);
		expect(eventTypes).toEqual(['turnStarted', 'turnEnded']);
	});

	it('does not log usage when the agent has no response', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const logger = createLogger();
		const agent: Agent = { run: vi.fn().mockResolvedValue(undefined) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(logger.log).not.toHaveBeenCalled();
	});

	it('exits immediately on an interrupt while idle at the prompt', async () => {
		const promptEmitter = createPromptEmitter({ error: abortError() });
		const logger = createLogger();
		const run = vi.fn();
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(promptEmitter.emit).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();
	});

	it('cancels only the current turn on an interrupt while the agent is running, then asks for the next prompt', async () => {
		const promptEmitter = createPromptEmitter('hello', 'world', { error: abortError() });
		const logger = createLogger();
		const run = vi.fn().mockRejectedValueOnce(abortError()).mockResolvedValueOnce(response());
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(run).toHaveBeenCalledTimes(2);
		expect(promptEmitter.emit).toHaveBeenCalledTimes(3);
	});

	it('stops after an unrecoverable agent failure', async () => {
		const promptEmitter = createPromptEmitter('hello');
		const logger = createLogger();
		const failure = new UnrecoverableError('cannot continue', { cause: 'fatal' });
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(logger.log).toHaveBeenCalledWith(failure);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('reports an unexpected prompt failure and asks again', async () => {
		const promptEmitter = createPromptEmitter(
			{ error: new Error('unexpected') },
			{ error: abortError() },
		);
		const logger = createLogger();
		const run = vi.fn();
		const loop = new ConversationLoop({ run }, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(logger.error).toHaveBeenCalledWith(new Error('unexpected'));
		expect(run).not.toHaveBeenCalled();
	});

	it('reports unexpected agent failures before continuing', async () => {
		const promptEmitter = createPromptEmitter('hello', { error: abortError() });
		const logger = createLogger();
		const failure = new Error('unexpected');
		const agent: Agent = { run: vi.fn().mockRejectedValue(failure) };
		const loop = new ConversationLoop(agent, vi.fn(), promptEmitter, logger);

		await loop.start();

		expect(logger.error).toHaveBeenCalledWith(failure);
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
		const logger = createLogger();
		const loop = new ConversationLoop({ run: vi.fn() }, vi.fn(), promptEmitter, logger);

		void loop.start();
		await Promise.resolve();

		loop.cancel();

		expect(capturedSignal?.aborted).toBe(true);
	});

	it('closes the prompt emitter and says goodbye', () => {
		const promptEmitter = createPromptEmitter();
		const logger = createLogger();
		const loop = new ConversationLoop({ run: vi.fn() }, vi.fn(), promptEmitter, logger);

		loop.close();

		expect(promptEmitter.close).toHaveBeenCalledOnce();
		expect(logger.log).toHaveBeenCalledWith('thanks, bye!');
	});
});
