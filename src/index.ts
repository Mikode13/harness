import { Codex } from '@openai/codex-sdk';
import { Loop } from './loopImpl.ts';
import type { ILoop } from './loopInterface.ts';

const codex = new Codex();
type models = 'gpt-5.6-sol' | 'gpt-5.6-luna';
const defaultModel: models = 'gpt-5.6-luna';

const thread = codex.startThread({
	model: defaultModel,
	modelReasoningEffort: 'high',
});

const loop: ILoop = new Loop(thread);

await loop.start();
loop.close();
