#!/usr/bin/env node

import {
	createHistory,
	createLLMOrchestrator,
	createOrchestrator,
	rememberApprovals,
	type ProgressEvent,
} from '../src/index.ts';
import { ConversationLoop } from './conversationLoop.ts';
import { formatProgressEvent } from './progressEventFormatter.ts';
import { clearLine, cursorTo } from 'node:readline';
import { parseArgs } from 'node:util';
import { Output } from './adapters/output.ts';
import { PromptEmitter } from './adapters/promptEmitter.ts';
import { createTerminalApprover } from './terminalApprover.ts';
import { HistoryCommands } from './historyCommands.ts';

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

// `--llm` plans and reviews on the model APIs, which need ANTHROPIC_API_KEY and OPENAI_API_KEY.
const { values: flags } = parseArgs({ options: { llm: { type: 'boolean', default: false } } });

const orchestratorAgent = flags.llm
	? await createLLMOrchestrator({ autoApprove })
	: createOrchestrator({ autoApprove });

let turnActive = false;

// One memory for the whole session: "always" holds until the CLI exits. The spinner would
// overwrite the question, so it stops while the user answers.
const askInTerminal = createTerminalApprover(promptEmitter, output);
const approve = rememberApprovals(async (request, signal) => {
	stopSpinner();
	try {
		return await askInTerminal(request, signal);
	} finally {
		startSpinner();
	}
});

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
	approve,
	// The history of what the harness's own write tools changed in this folder.
	new HistoryCommands(await createHistory({ root: process.cwd() }), promptEmitter, output),
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
