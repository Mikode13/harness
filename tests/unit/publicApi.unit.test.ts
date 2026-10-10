import { describe, expect, expectTypeOf, it } from 'vitest';
import * as harness from '../../src/index.ts';
import type {
	Agent,
	ApprovalDecision,
	ApprovalRequest,
	Approver,
	AgentModel,
	AgentProvider,
	AgentResponse,
	Callback,
	CreateAgentOptions,
	CreateLLMAgentOptions,
	CreateOrchestratorOptions,
	History,
	HistoryRun,
	ILogger,
	JSONSchema,
	Move,
	MoveOptions,
	ProgressEvent,
	ReasoningEffort,
	RememberableDecision,
	RunOptions,
	RunStatus,
	TextMatch,
	Tokens,
	Tool,
	ToolDefinition,
	ToolRisk,
	Workspace,
} from '../../src/index.ts';

// Everything src/index.ts exports is public: removing an export is a breaking change, and
// adding one is a feature.
describe('public API', () => {
	it('exports exactly these values', () => {
		expect(Object.keys(harness).sort()).toEqual([
			'HistoryExpiredError',
			'InvalidAgentConfigError',
			'NothingToMoveError',
			'RecoverableError',
			'UnknownRunError',
			'UnrecoverableError',
			'WorkspaceBusyError',
			'WorkspaceMovedError',
			'agentProviders',
			'createAgent',
			'createHistory',
			'createLLMAgent',
			'createLLMOrchestrator',
			'createOrchestrator',
			'createWorkspace',
			'createWorkspaceTools',
			'defineTool',
			'historyStart',
			'isAbortError',
			'isAgentProvider',
			'rememberApprovals',
		]);
	});

	// Types leave nothing at runtime, so the import above is the check: `tsc -p tests` fails
	// when one of them stops being exported. A new type export belongs in that list too.
	it('exports these types', () => {
		expectTypeOf<
			[
				Agent,
				ApprovalDecision,
				ApprovalRequest,
				Approver,
				AgentModel,
				AgentProvider,
				AgentResponse,
				Callback,
				CreateAgentOptions,
				CreateLLMAgentOptions,
				CreateOrchestratorOptions,
				History,
				HistoryRun,
				ILogger,
				JSONSchema,
				Move,
				MoveOptions,
				ProgressEvent,
				ReasoningEffort,
				RememberableDecision,
				RunOptions,
				RunStatus,
				TextMatch,
				Tokens,
				Tool,
				ToolDefinition,
				ToolRisk,
				Workspace,
			]
		>().not.toBeNever();
	});
});
