#!/usr/bin/env node

import {
	CodexAgent,
	ClaudeAgent,
	RetryingAgent,
	OrchestratorAgent,
	ReviewerDecisionValidator,
	handleEvents,
	type ProgressEvent,
} from '../src/index.ts';
import { ConversationLoop } from './conversationLoop.ts';
import { Codex } from '@openai/codex-sdk';
import { clearLine, cursorTo } from 'node:readline';
import { Logger } from './adapters/logger.ts';
import { PromptEmitter } from './adapters/promptEmitter.ts';

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame = 0;
let spinnerInterval: NodeJS.Timeout | undefined;

function startSpinner(): void {
	spinnerInterval ??= setInterval(() => {
		cursorTo(process.stdout, 0);
		process.stdout.write(spinnerFrames[spinnerFrame % spinnerFrames.length] ?? '');
		spinnerFrame++;
	}, 80);
}

function stopSpinner(): void {
	clearInterval(spinnerInterval);
	spinnerInterval = undefined;
	cursorTo(process.stdout, 0);
	clearLine(process.stdout, 0);
}

const codex = new Codex();
const autoApprove = true;
const plannerReasoningEffort = 'high';
const executorReasoningEffort = 'high';
const reviewerReasoningEffort = 'high';

const logger = new Logger();
const promptEmitter = new PromptEmitter();

const orchestratorAgent = new OrchestratorAgent(
	new RetryingAgent(
		new CodexAgent({
			sdk: codex,
			model: 'gpt-5.6-sol',
			logger,
			autoApprove,
			reasoningEffort: plannerReasoningEffort,
		}),
	),
	new RetryingAgent(
		new CodexAgent({
			sdk: codex,
			model: 'gpt-5.6-luna',
			logger,
			autoApprove,
			reasoningEffort: executorReasoningEffort,
		}),
	),
	new RetryingAgent(new ClaudeAgent('opus', true, reviewerReasoningEffort)),
	new ReviewerDecisionValidator(),
);

let turnActive = false;

const loop = new ConversationLoop(
	orchestratorAgent,
	(item: ProgressEvent) => {
		if (item.type === 'turnStarted') {
			turnActive = true;
			startSpinner();
			return;
		}
		if (item.type === 'turnEnded') {
			turnActive = false;
			stopSpinner();
			return;
		}

		stopSpinner();
		const message = handleEvents(item);
		if (message) {
			logger.log(message);
		}
		startSpinner();
	},
	promptEmitter,
	logger,
);

const exitConfirmationWindowMs = 3000;
let cancelRequestedAt: number | undefined;

function onCancel(): void {
	if (turnActive) {
		loop.cancel();
		return;
	}

	const now = Date.now();
	if (cancelRequestedAt !== undefined && now - cancelRequestedAt < exitConfirmationWindowMs) {
		cancelRequestedAt = undefined;
		loop.cancel();
		return;
	}

	cancelRequestedAt = now;
	logger.log('Press Ctrl+C again to exit.');
}

promptEmitter.onInterrupt(onCancel);

await loop.start();
loop.close();
