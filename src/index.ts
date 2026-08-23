import { Loop } from './loopImpl.ts';
import type { ILoop } from './models/loopInterface.ts';
import { CodexAgent } from './codexAgent.ts';
import { Codex } from '@openai/codex-sdk';
import type { Agent } from './models/agent.ts';
import { ClaudeAgent } from './claudeAgent.ts';
import { RetryingAgent } from './retryingAgent.ts';

const engine = process.env.AGENT_ENGINE ?? 'codex';

const codex = new Codex();
const agent: Agent =
	engine === 'codex'
		? new CodexAgent({ sdk: codex, model: 'gpt-5.6-luna' })
		: new ClaudeAgent('haiku');

const retryAgent: Agent = new RetryingAgent(agent);
const loop: ILoop = new Loop(retryAgent);

await loop.start();
loop.close();
