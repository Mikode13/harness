#!/usr/bin/env node

import { Loop, CodexAgent, ClaudeAgent, RetryingAgent, OrchestratorAgent, handleEvents, createReadlineTerminal, type ProgressEvent } from '../src/index.ts';
import { Codex } from '@openai/codex-sdk';

const codex = new Codex();
const autoApprove = true;
const plannerReasoningEffort = 'high';
const executorReasoningEffort = 'high';
const reviewerReasoningEffort = 'high';

const orchestratorAgent = new OrchestratorAgent(
	new RetryingAgent(
		new CodexAgent({
			sdk: codex,
			model: 'gpt-5.6-sol',
			autoApprove,
			reasoningEffort: plannerReasoningEffort,
		}),
	),
	new RetryingAgent(
		new CodexAgent({
			sdk: codex,
			model: 'gpt-5.6-luna',
			autoApprove,
			reasoningEffort: executorReasoningEffort,
		}),
	),
	new RetryingAgent(new ClaudeAgent('opus', true, reviewerReasoningEffort)),
);

const terminal = createReadlineTerminal();
const loop = new Loop(orchestratorAgent, (item: ProgressEvent) => {
	const message = handleEvents(item);
	if (message) {
		terminal.log(message);
	}
}, terminal);

await loop.start();
loop.close();
