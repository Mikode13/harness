import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	agentModels,
	agentProviders,
	agentReasoningEfforts,
	isLLMModelOf,
	isLLMReasoningEffortOf,
	isModelOf,
	isReasoningEffortOf,
	llmModels,
	llmReasoningEfforts,
} from '../../src/index.ts';
import {
	claudeModels,
	claudeReasoningEfforts,
} from '../../src/engines/claude/infrastructure/model/claudeAgent.ts';
import {
	codexModels,
	codexReasoningEfforts,
} from '../../src/engines/codex/infrastructure/model/codexAgent.ts';
import {
	claudeLLMModels,
	claudeLLMReasoningEfforts,
} from '../../src/llm/infrastructure/claudeLLMClient.ts';
import {
	openAIModels,
	openAIReasoningEfforts,
} from '../../src/llm/infrastructure/openAILLMClient.ts';

describe('the accepted models and efforts', () => {
	it('are the lists each engine and client validates against', () => {
		expect(agentModels).toEqual({ anthropic: claudeModels, openai: codexModels });
		expect(agentReasoningEfforts).toEqual({
			anthropic: claudeReasoningEfforts,
			openai: codexReasoningEfforts,
		});
		expect(llmModels).toEqual({ anthropic: claudeLLMModels, openai: openAIModels });
		expect(llmReasoningEfforts).toEqual({
			anthropic: claudeLLMReasoningEfforts,
			openai: openAIReasoningEfforts,
		});
	});

	// Both paths take the same names, so one role table serves both. A model or an effort added
	// to one path only has to change this test on purpose.
	it.each(agentProviders)('hold the same names on both paths for %s, but Codex ultra', provider => {
		expect([...llmModels[provider]].sort()).toEqual([...agentModels[provider]].sort());
		expect([...llmReasoningEfforts[provider]].sort()).toEqual(
			agentReasoningEfforts[provider].filter(effort => effort !== 'ultra').sort(),
		);
	});
});

describe('the narrowers', () => {
	it.each([
		['anthropic', 'opus', true],
		['anthropic', 'gpt-5.6-sol', false],
		['openai', 'gpt-5.6-sol', true],
		['openai', 'opus', false],
	] as const)('tell whether %s takes the model %s, on both paths', (provider, model, expected) => {
		expect(isModelOf(provider, model)).toBe(expected);
		expect(isLLMModelOf(provider, model)).toBe(expected);
	});

	it('take ultra only from Codex, on the Agent SDK path', () => {
		expect(isReasoningEffortOf('openai', 'ultra')).toBe(true);
		expect(isLLMReasoningEffortOf('openai', 'ultra')).toBe(false);
		expect(isReasoningEffortOf('anthropic', 'ultra')).toBe(false);
		expect(isLLMReasoningEffortOf('anthropic', 'max')).toBe(true);
	});

	it('narrow an untyped string to what that provider takes, without a cast', () => {
		const untyped = (value: string) => value;

		const model = untyped('opus');
		if (isModelOf('anthropic', model)) {
			expectTypeOf(model).toEqualTypeOf<(typeof claudeModels)[number]>();
		}
		const llmModel = untyped('gpt-5.6-sol');
		if (isLLMModelOf('openai', llmModel)) {
			expectTypeOf(llmModel).toEqualTypeOf<(typeof openAIModels)[number]>();
		}
		const effort = untyped('ultra');
		if (isReasoningEffortOf('openai', effort)) {
			expectTypeOf(effort).toEqualTypeOf<(typeof codexReasoningEfforts)[number]>();
		}
		const llmEffort = untyped('high');
		if (isLLMReasoningEffortOf('anthropic', llmEffort)) {
			expectTypeOf(llmEffort).toEqualTypeOf<(typeof claudeLLMReasoningEfforts)[number]>();
		}
	});
});
