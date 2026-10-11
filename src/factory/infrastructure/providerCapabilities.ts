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
 * Models accepted by the model API client for each provider. The lists are kept apart from the
 * Agent SDK's, so `src/llm` never imports the engines; today they hold the same names, and a test
 * fails if they drift apart. See "Providers are named after the company" in decisions.md.
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

type AgentModelOf<Provider extends AgentProvider> = (typeof agentModels)[Provider][number];
type AgentReasoningEffortOf<Provider extends AgentProvider> =
	(typeof agentReasoningEfforts)[Provider][number];
type LLMModelOf<Provider extends AgentProvider> = (typeof llmModels)[Provider][number];
type LLMReasoningEffortOf<Provider extends AgentProvider> =
	(typeof llmReasoningEfforts)[Provider][number];

/**
 * Whether `value` is a model `createAgent` accepts for `provider`, on the Agent SDK path. It
 * narrows an untyped string, such as a command-line flag, without a cast.
 */
export function isModelOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is AgentModelOf<Provider> {
	return isOneOf<string>(agentModels[provider], value);
}

/** Whether `value` is a reasoning effort `createAgent` accepts for `provider`. */
export function isReasoningEffortOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is AgentReasoningEffortOf<Provider> {
	return isOneOf<string>(agentReasoningEfforts[provider], value);
}

/** Whether `value` is a model `createLLMAgent` accepts for `provider`, on the model API path. */
export function isLLMModelOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is LLMModelOf<Provider> {
	return isOneOf<string>(llmModels[provider], value);
}

/** Whether `value` is a reasoning effort `createLLMAgent` accepts for `provider`. */
export function isLLMReasoningEffortOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is LLMReasoningEffortOf<Provider> {
	return isOneOf<string>(llmReasoningEfforts[provider], value);
}
