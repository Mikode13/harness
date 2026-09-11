#!/usr/bin/env node

import { createOrchestrator, type ProgressEvent } from '../src/index.ts';
import { ConversationLoop } from './conversationLoop.ts';
import { formatProgressEvent } from './progressEventFormatter.ts';
import { clearLine, cursorTo } from 'node:readline';
import { Output } from './adapters/output.ts';
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
const autoApprove = true;

const output = new Output();
const promptEmitter = new PromptEmitter();

const orchestratorAgent = createOrchestrator({ autoApprove });

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
		const message = formatProgressEvent(item);
		if (message) {
			output.print(message);
		}
		startSpinner();
	},
	promptEmitter,
	output,
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
	output.print('Press Ctrl+C again to exit.');
}

promptEmitter.onInterrupt(onCancel);

await loop.start();
loop.close();
