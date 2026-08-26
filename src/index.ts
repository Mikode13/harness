import { Loop } from './loopImpl.ts';
import type { ILoop } from './models/loopInterface.ts';
import { CodexAgent } from './codexAgent.ts';
import { Codex } from '@openai/codex-sdk';
import { handleEvents, type Agent } from './models/agent.ts';
import { RetryingAgent } from './retryingAgent.ts';
import { OrchestratorAgent } from './orchestratorAgent.ts';
import { ClaudeAgent } from './claudeAgent.ts';

const codex = new Codex();
const autoApprove = true;

const orchestratorAgent: Agent = new OrchestratorAgent(
	new RetryingAgent(new CodexAgent({ sdk: codex, model: 'gpt-5.6-sol', autoApprove })),
	new RetryingAgent(new CodexAgent({ sdk: codex, model: 'gpt-5.6-luna', autoApprove })),
	new RetryingAgent(new ClaudeAgent('opus', true)),
);

const loop: ILoop = new Loop(orchestratorAgent, item => {
	const message = handleEvents(item);
	if (message) {
		console.log(message);
	}
});

await loop.start();
loop.close();
