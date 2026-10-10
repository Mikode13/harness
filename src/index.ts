export type { ILogger } from './shared/domain/logger.ts';
export {
	createAgent,
	createOrchestrator,
	isAgentProvider,
	type CreateAgentOptions,
} from './factory/infrastructure/agentFactory.ts';
export {
	createFileTools,
	createLLMAgent,
	createLLMOrchestrator,
	type CreateLLMAgentOptions,
	type CreateLLMOrchestratorOptions,
} from './factory/infrastructure/agentLLMFactory.ts';
export type { FileTool, WorkspaceOptions } from './tools/infrastructure/fileTools.ts';
export type { WorkspaceRoot } from './tools/domain/accessPolicy.ts';
export type { SecretRules } from './tools/infrastructure/rootsAccessPolicy.ts';
export {
	agentProviders,
	type AgentModel,
	type AgentProvider,
	type CreateOrchestratorOptions,
	type ReasoningEffort,
} from './factory/infrastructure/types.ts';
export {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
	type RunOptions,
} from './agent/domain/agent.ts';
export {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from './shared/domain/errors.ts';
export { isAbortError } from './shared/domain/isAbortError.ts';
export type { Tokens } from './shared/domain/tokens.ts';
export {
	rememberApprovals,
	type ApprovalDecision,
	type ApprovalRequest,
	type Approver,
	type RememberableDecision,
	type ToolRisk,
} from './agent/domain/approval.ts';
export type { JSONSchema, ToolDefinition } from './llm/domain/tool.ts';
export type { Tool } from './tools/domain/tool.ts';
export type { TextMatch, Workspace } from './tools/domain/workspace.ts';
export { defineTool } from './tools/infrastructure/defineTool.ts';
export { createWorkspace } from './tools/infrastructure/createWorkspace.ts';
export { createWorkspaceTools } from './tools/infrastructure/workspaceTools.ts';
export { createHistory } from './recovery/infrastructure/createHistory.ts';
export type { History, HistoryRun, Move } from './recovery/domain/history.ts';
export {
	historyStart,
	NothingToMoveError,
	WorkspaceBusyError,
	WorkspaceMovedError,
	type MoveOptions,
	type RunStatus,
} from './recovery/domain/recoveryStore.ts';
export { HistoryExpiredError, UnknownRunError } from './recovery/domain/runTree.ts';
