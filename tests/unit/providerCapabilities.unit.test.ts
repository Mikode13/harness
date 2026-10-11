import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	agentModels,
	agentReasoningEfforts,
	isModelOf,
	isReasoningEffortOf,
	llmModels,
	llmReasoningEfforts,
} from '../../src/index.ts';
import {
	claudeModels,
	claudeReasoningEfforts,
	type ClaudeModel,
	type ClaudeReasoningEffort,
} from '../../src/engines/claude/infrastructure/model/claudeAgent.ts';
import {
	claudeLLMModels,
	claudeLLMReasoningEfforts,
	type ClaudeLLMModel,
	type ClaudeLLMReasoningEffort,
} from '../../src/llm/infrastructure/claudeLLMClient.ts';
import {
	codexModels,
	codexReasoningEfforts,
	type CodexModel,
	type CodexReasoningEffort,
} from '../../src/engines/codex/infrastructure/model/codexAgent.ts';
import {
	openAIModels,
	openAIReasoningEfforts,
	type OpenAIModel,
	type OpenAIReasoningEffort,
} from '../../src/llm/infrastructure/openAILLMClient.ts';

describe('provider capabilities', () => {
	it('exposes the Agent SDK tuples for each provider', () => {
		expect(agentModels.anthropic).toBe(claudeModels);
		expect(agentModels.openai).toBe(codexModels);
		expect(agentReasoningEfforts.anthropic).toBe(claudeReasoningEfforts);
		expect(agentReasoningEfforts.openai).toBe(codexReasoningEfforts);
		expect(agentModels).toEqual({
			anthropic: ['haiku', 'sonnet', 'opus', 'fable'],
			openai: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
		});
		expect(agentReasoningEfforts).toEqual({
			anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
			openai: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		});
	});

	it('exposes the model API tuples for each provider', () => {
		expect(llmModels.anthropic).toBe(claudeLLMModels);
		expect(llmModels.openai).toBe(openAIModels);
		expect(llmReasoningEfforts.anthropic).toBe(claudeLLMReasoningEfforts);
		expect(llmReasoningEfforts.openai).toBe(openAIReasoningEfforts);
		expect(llmModels).toEqual({
			anthropic: ['opus', 'fable', 'sonnet', 'haiku'],
			openai: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
		});
		expect(llmReasoningEfforts).toEqual({
			anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
			openai: ['low', 'medium', 'high', 'xhigh', 'max'],
		});
	});

	it('keeps the Codex ultra effort out of the OpenAI model API list', () => {
		expect(isReasoningEffortOf(agentReasoningEfforts.openai, 'ultra')).toBe(true);
		expect(isReasoningEffortOf(llmReasoningEfforts.openai, 'ultra')).toBe(false);
	});

	it.each([
		[agentModels.anthropic, 'opus', true],
		[agentModels.anthropic, 'gpt-5.6-sol', false],
		[agentModels.openai, 'gpt-5.6-sol', true],
		[agentModels.openai, 'opus', false],
		[llmModels.anthropic, 'fable', true],
		[llmModels.anthropic, 'gpt-5.6-sol', false],
		[llmModels.openai, 'gpt-5.6-sol', true],
		[llmModels.openai, 'fable', false],
	] as const)('checks model %s in the selected path', (models, value, expected) => {
		expect(isModelOf(models, value)).toBe(expected);
	});

	it.each([
		[agentReasoningEfforts.anthropic, 'max', true],
		[agentReasoningEfforts.anthropic, 'ultra', false],
		[agentReasoningEfforts.openai, 'ultra', true],
		[agentReasoningEfforts.openai, 'unknown', false],
		[llmReasoningEfforts.anthropic, 'max', true],
		[llmReasoningEfforts.anthropic, 'ultra', false],
		[llmReasoningEfforts.openai, 'max', true],
		[llmReasoningEfforts.openai, 'ultra', false],
	] as const)('checks effort %s in the selected path', (efforts, value, expected) => {
		expect(isReasoningEffortOf(efforts, value)).toBe(expected);
	});

	it('narrows a string to the selected model and effort tuple', () => {
		const untyped = (value: string) => value;
		const anthropicAgentModel = untyped('opus');
		if (isModelOf(agentModels.anthropic, anthropicAgentModel)) {
			expectTypeOf(anthropicAgentModel).toEqualTypeOf<ClaudeModel>();
		}

		const openAIAgentModel = untyped('gpt-5.6-sol');
		if (isModelOf(agentModels.openai, openAIAgentModel)) {
			expectTypeOf(openAIAgentModel).toEqualTypeOf<CodexModel>();
		}

		const anthropicLLMModel = untyped('fable');
		if (isModelOf(llmModels.anthropic, anthropicLLMModel)) {
			expectTypeOf(anthropicLLMModel).toEqualTypeOf<ClaudeLLMModel>();
		}

		const openAILLMModel = untyped('gpt-5.6-sol');
		if (isModelOf(llmModels.openai, openAILLMModel)) {
			expectTypeOf(openAILLMModel).toEqualTypeOf<OpenAIModel>();
		}

		const anthropicAgentEffort = untyped('high');
		if (isReasoningEffortOf(agentReasoningEfforts.anthropic, anthropicAgentEffort)) {
			expectTypeOf(anthropicAgentEffort).toEqualTypeOf<ClaudeReasoningEffort>();
		}

		const openAIAgentEffort = untyped('ultra');
		if (isReasoningEffortOf(agentReasoningEfforts.openai, openAIAgentEffort)) {
			expectTypeOf(openAIAgentEffort).toEqualTypeOf<CodexReasoningEffort>();
		}

		const anthropicLLMEffort = untyped('high');
		if (isReasoningEffortOf(llmReasoningEfforts.anthropic, anthropicLLMEffort)) {
			expectTypeOf(anthropicLLMEffort).toEqualTypeOf<ClaudeLLMReasoningEffort>();
		}

		const openAILLMEffort = untyped('high');
		if (isReasoningEffortOf(llmReasoningEfforts.openai, openAILLMEffort)) {
			expectTypeOf(openAILLMEffort).toEqualTypeOf<OpenAIReasoningEffort>();
		}
	});
});
