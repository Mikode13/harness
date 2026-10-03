import { describe, expect, expectTypeOf, it } from 'vitest';
import * as harness from '../../src/index.ts';
import type {
	Agent,
	AgentModel,
	AgentProvider,
	AgentResponse,
	Callback,
	CreateAgentOptions,
	CreateLLMAgentOptions,
	CreateOrchestratorOptions,
	ILogger,
	JSONSchema,
	ProgressEvent,
	ReasoningEffort,
	TextMatch,
	Tokens,
	Tool,
	ToolDefinition,
	Workspace,
} from '../../src/index.ts';

// Everything src/index.ts exports is public: removing an export is a breaking change, and
// adding one is a feature.
describe('public API', () => {
	it('exports exactly these values', () => {
		expect(Object.keys(harness).sort()).toEqual([
			'InvalidAgentConfigError',
			'RecoverableError',
			'UnrecoverableError',
			'agentProviders',
			'createAgent',
			'createLLMAgent',
			'createLLMOrchestrator',
			'createOrchestrator',
			'createWorkspace',
			'createWorkspaceTools',
			'defineTool',
			'isAbortError',
			'isAgentProvider',
		]);
	});

	// Types leave nothing at runtime, so the import above is the check: `tsc -p tests` fails
	// when one of them stops being exported. A new type export belongs in that list too.
	it('exports these types', () => {
		expectTypeOf<
			[
				Agent,
				AgentModel,
				AgentProvider,
				AgentResponse,
				Callback,
				CreateAgentOptions,
				CreateLLMAgentOptions,
				CreateOrchestratorOptions,
				ILogger,
				JSONSchema,
				ProgressEvent,
				ReasoningEffort,
				TextMatch,
				Tokens,
				Tool,
				ToolDefinition,
				Workspace,
			]
		>().not.toBeNever();
	});
});
