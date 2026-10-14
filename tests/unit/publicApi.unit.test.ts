import { describe, expect, expectTypeOf, it } from 'vitest';
import * as harness from '../../src/index.ts';
import type {
	Agent,
	ApprovalDecision,
	ApprovalRequest,
	Asker,
	Approver,
	AgentModel,
	AgentProvider,
	AgentResponse,
	Callback,
	CommandArgument,
	CommandDefinition,
	CommandLine,
	CommandParameter,
	CommandRole,
	Commands,
	CreateAgentOptions,
	CreateLLMAgentOptions,
	CreateLLMOrchestratorOptions,
	CreateOrchestratorOptions,
	FileTool,
	History,
	HistoryRun,
	ILogger,
	JSONSchema,
	Move,
	MoveOptions,
	ProgressEvent,
	QuestionOption,
	ReasoningEffort,
	RememberableDecision,
	RoleSteps,
	RunOptions,
	RunStatus,
	SecretRules,
	StepContext,
	TextMatch,
	Tokens,
	Tool,
	ToolDefinition,
	ToolRisk,
	UserQuestion,
	Workspace,
	WorkspaceOptions,
	WorkspaceRoot,
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
			'agentModels',
			'agentProviders',
			'agentReasoningEfforts',
			'createAgent',
			'createFileTools',
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
			'isLLMModelOf',
			'isLLMReasoningEffortOf',
			'isModelOf',
			'isReasoningEffortOf',
			'llmModels',
			'llmReasoningEfforts',
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
				Asker,
				Approver,
				AgentModel,
				AgentProvider,
				AgentResponse,
				Callback,
				CommandArgument,
				CommandDefinition,
				CommandLine,
				CommandParameter,
				CommandRole,
				Commands,
				CreateAgentOptions,
				CreateLLMAgentOptions,
				CreateLLMOrchestratorOptions,
				CreateOrchestratorOptions,
				FileTool,
				History,
				HistoryRun,
				ILogger,
				JSONSchema,
				Move,
				MoveOptions,
				ProgressEvent,
				QuestionOption,
				ReasoningEffort,
				RememberableDecision,
				RoleSteps,
				RunOptions,
				RunStatus,
				SecretRules,
				StepContext,
				TextMatch,
				Tokens,
				Tool,
				ToolDefinition,
				ToolRisk,
				UserQuestion,
				Workspace,
				WorkspaceOptions,
				WorkspaceRoot,
			]
		>().not.toBeNever();

		expectTypeOf(harness.agentModels).toExtend<Record<AgentProvider, readonly AgentModel[]>>();
		expectTypeOf(harness.agentReasoningEfforts).toExtend<
			Record<AgentProvider, readonly ReasoningEffort[]>
		>();
		expectTypeOf(harness.llmModels).toExtend<Record<AgentProvider, readonly AgentModel[]>>();
		expectTypeOf(harness.llmReasoningEfforts).toExtend<
			Record<AgentProvider, readonly ReasoningEffort[]>
		>();

		const model = '' as string;
		if (harness.isModelOf('anthropic', model)) {
			expectTypeOf(model).toEqualTypeOf<(typeof harness.agentModels)['anthropic'][number]>();
		}
		const effort = '' as string;
		if (harness.isReasoningEffortOf('openai', effort)) {
			expectTypeOf(effort).toEqualTypeOf<
				(typeof harness.agentReasoningEfforts)['openai'][number]
			>();
		}
		const llmModel = '' as string;
		if (harness.isLLMModelOf('anthropic', llmModel)) {
			expectTypeOf(llmModel).toEqualTypeOf<(typeof harness.llmModels)['anthropic'][number]>();
		}
		const llmEffort = '' as string;
		if (harness.isLLMReasoningEffortOf('openai', llmEffort)) {
			expectTypeOf(llmEffort).toEqualTypeOf<
				(typeof harness.llmReasoningEfforts)['openai'][number]
			>();
		}
	});
});
