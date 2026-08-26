import { Loop } from './loopImpl.ts';
import type { ILoop } from './models/loopInterface.ts';
// import { CodexAgent } from './codexAgent.ts';
// import { Codex } from '@openai/codex-sdk';
import { handleEvents, type Agent } from './models/agent.ts';
import { ClaudeAgent } from './claudeAgent.ts';
import { RetryingAgent } from './retryingAgent.ts';
import { OrchestratorAgent } from './orchestratorAgent.ts';

// const engine = process.env.AGENT_ENGINE ?? 'codex';

// const codex = new Codex();

// const orchestratorAgent: Agent = new OrchestratorAgent(
// 	new RetryingAgent(new CodexAgent({ sdk: codex, model: 'gpt-5.6-sol' })),
// 	new RetryingAgent(new CodexAgent({ sdk: codex, model: 'gpt-5.6-luna' })),
// 	new RetryingAgent(new ClaudeAgent('opus')),
// );

const orchestratorAgent: Agent = new OrchestratorAgent(
	new RetryingAgent(new ClaudeAgent('claude-fable-5')),
	new RetryingAgent(new ClaudeAgent('haiku')),
	new RetryingAgent(new ClaudeAgent('opus')),
);

const loop: ILoop = new Loop(orchestratorAgent, item => {
	const message = handleEvents(item);
	if (message) {
		console.log(message);
	}
});

await loop.start();
loop.close();
