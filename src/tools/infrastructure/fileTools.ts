import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolDefinition } from '#src/llm/domain/tool';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import {
	defaultStateDirectory,
	FileRecoveryStore,
} from '#src/recovery/infrastructure/fileRecoveryStore';
import { InvalidAgentConfigError, UnrecoverableError } from '#src/shared/domain/errors';
import type { ILogger } from '#src/shared/domain/logger';
import { describeFailure } from '#src/shared/domain/providerFailure';
import type { AccessPolicy, WorkspaceRoot } from '../domain/accessPolicy.ts';
import type { AgentTool } from '../domain/preparedCall.ts';
import type { Workspace } from '../domain/workspace.ts';
import { createWorkspace } from './createWorkspace.ts';
import { createApplyPatchTool, createDeleteFileTool, createTextEditorTool } from './editFormats.ts';
import { GitIgnoreRules } from './gitIgnoreRules.ts';
import { PolicyWorkspace } from './policyWorkspace.ts';
import { RootsAccessPolicy, type SecretRules } from './rootsAccessPolicy.ts';
import { createTrackedReadFile } from './trackedReadFile.ts';
import { createWorkspaceTools } from './workspaceTools.ts';
import { WorkspaceWrites } from './workspaceWrites.ts';

/** The folders an agent works on, and what it may do in each. */
export interface WorkspaceOptions {
	/**
	 * Each folder `read` or `write`. The first is where a relative path starts, and the one whose
	 * history of runs is kept; a write to another root is recorded in it too.
	 */
	roots: WorkspaceRoot[];
	/** More files to keep closed as secrets, and exact files to open. */
	secrets?: SecretRules;
	/**
	 * Where the history of runs is kept, relative to the working directory if not absolute.
	 * Defaults to the platform's state directory. No tool may reach it, even inside a root.
	 */
	stateDirectory?: string;
}

declare const fileToolBrand: unique symbol;

/**
 * A tool the harness builds for files, from `createFileTools`. It goes to an agent from
 * `createLLMAgent` beside the consumer's own tools; what it does inside is the harness's.
 */
export type FileTool = ToolDefinition & { readonly [fileToolBrand]: true };

/** What the file tools of one workspace share: one policy, one history, one record of writes. */
export interface OpenedWorkspace {
	readonly roots: WorkspaceRoot[];
	readonly policy: AccessPolicy;
	readonly store: RecoveryStore;
	/** The read side, with the policy's word on every path. */
	readonly read: Workspace;
	readonly writes: WorkspaceWrites;
	readonly writable: boolean;
}

/**
 * Where a workspace's history is kept, as one real path: made if missing, then resolved, links
 * included. The store and the access policy must name the same folder, or a tool could reach the
 * history the policy means to protect. A relative path is from the working directory.
 *
 * @throws {UnrecoverableError} when the folder cannot be made or reached.
 */
export async function stateDirectoryOf({ stateDirectory }: WorkspaceOptions): Promise<string> {
	const directory = resolve(stateDirectory ?? defaultStateDirectory());
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return await realpath(directory);
	} catch (error) {
		throw new UnrecoverableError('The folder for the workspace history could not be made', {
			cause: describeFailure(error),
		});
	}
}

/**
 * The recovery store of a workspace, at its first root.
 *
 * @throws {InvalidAgentConfigError} when the workspace has no root.
 * @throws {UnrecoverableError} when the store cannot be opened.
 */
export async function openStore(
	workspace: WorkspaceOptions,
	directory: string,
): Promise<RecoveryStore> {
	const [first] = workspace.roots;
	if (!first) throw new InvalidAgentConfigError('A workspace needs at least one root');
	try {
		return await FileRecoveryStore.open({ root: resolve(first.path), directory });
	} catch (error) {
		throw new UnrecoverableError('The workspace history could not be opened', {
			cause: describeFailure(error),
		});
	}
}

export async function openWorkspace(
	workspace: WorkspaceOptions,
	logger: ILogger,
): Promise<OpenedWorkspace> {
	const { roots, secrets } = workspace;
	const stateDirectory = await stateDirectoryOf(workspace);
	const policy = await RootsAccessPolicy.create({
		roots,
		...(secrets ? { secrets } : {}),
		ignoreRules: new GitIgnoreRules(),
		// The history holds the source a run replaced: no tool may read or write it.
		protectedPaths: [stateDirectory],
	});
	const store = await openStore(workspace, stateDirectory);
	const root = resolve(roots[0]?.path ?? '.');
	const read = new PolicyWorkspace({ inner: await createWorkspace({ root, logger }), policy });
	return {
		roots,
		policy,
		store,
		read,
		writes: new WorkspaceWrites({ policy, store }),
		writable: roots.some(({ access }) => access === 'write'),
	};
}

/**
 * The file tools of a provider's executor, over one workspace. Every one reads through the access
 * policy, and an edit starts only from a version the conversation read.
 *
 * - OpenAI: `listFiles`, `searchText`, `readFile`, and its native `apply_patch`.
 * - Anthropic: `listFiles`, `searchText`, its native text editor, whose `view` reads, and
 *   `delete_file`.
 *
 * Without a `write` root they only read: `readFile` in place of the editor and the patch.
 */
export function fileToolsFor(
	provider: 'anthropic' | 'openai',
	workspace: OpenedWorkspace,
): AgentTool[] {
	const { policy, read, writes, writable } = workspace;
	const [listFiles, searchText] = createWorkspaceTools(read).filter(
		tool => tool.name === 'listFiles' || tool.name === 'searchText',
	);
	const finding: AgentTool[] = [listFiles, searchText].filter(tool => tool !== undefined);
	const readFile = createTrackedReadFile(policy);
	if (!writable) return [...finding, readFile];
	if (provider === 'openai') return [...finding, readFile, createApplyPatchTool(writes)];
	return [
		...finding,
		createTextEditorTool({ writes, policy, workspace: read }),
		createDeleteFileTool(writes),
	];
}
