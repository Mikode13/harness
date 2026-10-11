import {
	claudeModels,
	claudeReasoningEfforts,
} from '#src/engines/claude/infrastructure/model/claudeAgent';
import {
	codexModels,
	codexReasoningEfforts,
} from '#src/engines/codex/infrastructure/model/codexAgent';
import {
	claudeLLMModels,
	claudeLLMReasoningEfforts,
} from '#src/llm/infrastructure/claudeLLMClient';
import { openAIModels, openAIReasoningEfforts } from '#src/llm/infrastructure/openAILLMClient';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { AgentProvider } from './types.ts';

/**
 * Models accepted by the Agent SDK engine for each provider. The values are the same tuples the
 * engines validate, so their literal types stay available to consumers.
 */
export const agentModels = {
	anthropic: claudeModels,
	openai: codexModels,
} as const satisfies Record<AgentProvider, readonly string[]>;

/**
 * Reasoning efforts accepted by the Agent SDK engine for each provider.
 */
export const agentReasoningEfforts = {
	anthropic: claudeReasoningEfforts,
	openai: codexReasoningEfforts,
} as const satisfies Record<AgentProvider, readonly string[]>;

/**
 * Models accepted by the model API client for each provider. Model API and Agent SDK lists are
 * kept separate because their providers do not necessarily expose the same catalog.
 */
export const llmModels = {
	anthropic: claudeLLMModels,
	openai: openAIModels,
} as const satisfies Record<AgentProvider, readonly string[]>;

/**
 * Reasoning efforts accepted by the model API client for each provider.
 */
export const llmReasoningEfforts = {
	anthropic: claudeLLMReasoningEfforts,
	openai: openAIReasoningEfforts,
} as const satisfies Record<AgentProvider, readonly string[]>;

/** Narrows an untyped string to a model in one provider/path capability entry. */
export function isModelOf<const Models extends readonly string[]>(
	models: Models,
	value: string,
): value is Models[number] {
	return isOneOf(models, value);
}

/** Narrows an untyped string to a reasoning effort in one provider/path capability entry. */
export function isReasoningEffortOf<const Efforts extends readonly string[]>(
	efforts: Efforts,
	value: string,
): value is Efforts[number] {
	return isOneOf(efforts, value);
}
