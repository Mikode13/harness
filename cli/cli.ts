#!/usr/bin/env node

import {
	createHistory,
	createLLMOrchestrator,
	createOrchestrator,
	rememberApprovals,
	type ProgressEvent,
} from '../src/index.ts';
import { ConversationLoop } from './conversationLoop.ts';
import { ProgressEventFormatter } from './progressEventFormatter.ts';
import { appendFileSync } from 'node:fs';
import { clearLine, cursorTo } from 'node:readline';
import { parseArgs } from 'node:util';
import { Output } from './adapters/output.ts';
import { PromptEmitter } from './adapters/promptEmitter.ts';
import { approvalKey, createTerminalApprover } from './terminalApprover.ts';
import { loadUserConfig, userConfigPath } from './userConfig.ts';
import { HistoryCommands } from './historyCommands.ts';
import { formatSpinnerLine } from './spinner.ts';

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame = 0;
let spinnerInterval: NodeJS.Timeout | undefined;
let spinnerDescription: string | undefined;

function startSpinner(description?: string): void {
	spinnerDescription = description;
	spinnerInterval ??= setInterval(() => {
		cursorTo(process.stdout, 0);
		clearLine(process.stdout, 0);
		process.stdout.write(
			formatSpinnerLine(
				spinnerFrames[spinnerFrame % spinnerFrames.length] ?? '',
				spinnerDescription,
				process.stdout.columns,
			),
		);
		spinnerFrame++;
	}, 80);
}

function stopSpinner(): void {
	clearInterval(spinnerInterval);
	spinnerInterval = undefined;
	spinnerDescription = undefined;
	cursorTo(process.stdout, 0);
	clearLine(process.stdout, 0);
}
// The Agent SDK engines ask no one here, so they run with their permission bypass. The model
// API agents ask the terminal before a destructive call, as the harness does by default.
const autoApprove = true;

const output = new Output();

// `--llm` runs all three roles on the model APIs, which need ANTHROPIC_API_KEY and OPENAI_API_KEY.
const { values: flags } = parseArgs({
	options: {
		llm: { type: 'boolean', default: false },
		'thinking-headings': { type: 'boolean', default: false },
		// A file that gets one JSON line per call to the model: what it sent and what it cost.
		steps: { type: 'string' },
	},
});
const stepsFile = flags.steps;
const progressFormatter = new ProgressEventFormatter({
	thinkingHeadings: flags['thinking-headings'],
});

// The commands the agents may run here, and their step limits, from the user's own file.
const { commands, maxSteps } = flags.llm ? await loadUserConfig(process.cwd()) : {};
if (commands) {
	output.print(`Commands from ${userConfigPath()}: ${Object.keys(commands).join(', ')}`);
}

const orchestratorAgent = flags.llm
	? await createLLMOrchestrator({
			// The executor changes files here; every change goes to the history /undo moves through.
			workspace: { roots: [{ path: process.cwd(), access: 'write' }] },
			...(commands ? { commands } : {}),
			...(maxSteps === undefined ? {} : { maxSteps }),
		})
	: createOrchestrator({ autoApprove });
// The history of what the harness's own write tools changed in this folder.
const history = await createHistory({ root: process.cwd() });

// After every await: readline reads its input as soon as it exists, and a line that arrives
// before the first question is asked is lost.
const promptEmitter = new PromptEmitter();

let turnActive = false;

// One memory for the whole session: "always" holds until the CLI exits. The spinner would
// overwrite the question, so it stops while the user answers.
const askInTerminal = createTerminalApprover(promptEmitter, output);
const approve = rememberApprovals(
	async (request, signal) => {
		stopSpinner();
		try {
			return await askInTerminal(request, signal);
		} finally {
			startSpinner();
		}
	},
	{ key: approvalKey },
);

const loop = new ConversationLoop(
	orchestratorAgent,
	(item: ProgressEvent) => {
		if (item.type === 'turnStarted') {
			turnActive = true;
			progressFormatter.reset();
			startSpinner();
			return;
		}
		if (item.type === 'turnEnded') {
			turnActive = false;
			progressFormatter.reset();
			stopSpinner();
			return;
		}

		if (item.type === 'step') {
			if (stepsFile)
				appendFileSync(stepsFile, `${JSON.stringify({ at: new Date().toISOString(), ...item })}\n`);
			return;
		}

		const message = progressFormatter.format(item);
		if (item.type === 'tool' && item.status === 'in_progress') {
			// Starts are state for the spinner, never a completed terminal line.
			startSpinner(progressFormatter.spinnerDescription());
			return;
		}

		stopSpinner();
		if (message) {
			output.print(message);
		}
		startSpinner(progressFormatter.spinnerDescription());
	},
	promptEmitter,
	output,
	approve,
	new HistoryCommands(history, promptEmitter, output),
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
