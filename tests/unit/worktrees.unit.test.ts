import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, Approver } from '../../src/agent/domain/approval.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { createFileTools } from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type {
	AgentTool,
	PreparedCall,
	PreparingTool,
} from '../../src/tools/domain/preparedCall.ts';
import type { ToolCallContext } from '../../src/tools/domain/readRegistry.ts';
import { createRemoveWorktreeTool } from '../../src/tools/infrastructure/removeWorktreeTool.ts';
import { createWorktree } from '../../src/tools/infrastructure/worktrees.ts';
import type * as Worktrees from '../../src/tools/infrastructure/worktrees.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

// Lets a test have git answer `rev-list` with nothing, as when it cannot read an object.
const revList = vi.hoisted(() => ({ empty: false }));
vi.mock('../../src/tools/infrastructure/worktrees.ts', async importOriginal => {
	const actual = await importOriginal<typeof Worktrees>();
	return {
		...actual,
		git: (args: string[], cwd: string, gitSignal?: AbortSignal) =>
			revList.empty && args[0] === 'rev-list'
				? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
				: actual.git(args, cwd, gitSignal),
	};
});
const logger = { warn: vi.fn() };

let parent: string;
let repository: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
		{
			cwd,
			stdio: 'pipe',
		},
	).toString();
}

beforeEach(() => {
	// macOS hands out a symlinked temporary folder; the worktrees are named by their real path.
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-worktrees-')));
	repository = join(parent, 'app');
	mkdirSync(repository);
	git(repository, 'init', '-q', '-b', 'main');
	writeFileSync(join(repository, 'README.md'), 'first\n');
	git(repository, 'add', '.');
	git(repository, 'commit', '-q', '-m', 'first');
	writeFileSync(join(repository, 'README.md'), 'second\n');
	git(repository, 'commit', '-q', '-am', 'second');
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

const branches = (cwd: string) =>
	git(cwd, 'branch', '--format=%(refname:short)').trim().split('\n').sort();

describe('createWorktree', () => {
	it('checks out a new branch from the revision, beside the main folder by default', async () => {
		const created = await createWorktree({ repository, branch: 'feat/export', from: 'main~1' });

		expect(created).toEqual({
			path: join(parent, 'app-worktrees', 'feat-export'),
			branch: 'feat/export',
		});
		expect(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/export');
		expect(git(created.path, 'show', 'HEAD:README.md')).toBe('first\n');
		expect(branches(repository)).toEqual(['feat/export', 'main']);
	});

	it('goes where it is told, and names the main folder from any worktree', async () => {
		const first = await createWorktree({ repository, branch: 'one', from: 'main' });
		const path = join(parent, 'elsewhere');

		const second = await createWorktree({
			repository: first.path,
			branch: 'two',
			from: 'main',
			path,
		});

		expect(second.path).toBe(path);
		const third = await createWorktree({ repository: first.path, branch: 'three', from: 'main' });
		expect(third.path).toBe(join(parent, 'app-worktrees', 'three'));
	});

	it('refuses a branch that exists, a revision that names nothing, and one that looks like an option', async () => {
		await expect(createWorktree({ repository, branch: 'main', from: 'main' })).rejects.toThrow(
			UnrecoverableError,
		);
		await expect(createWorktree({ repository, branch: 'new', from: 'nowhere' })).rejects.toThrow(
			'"nowhere" names no commit',
		);
		await expect(createWorktree({ repository, branch: 'new', from: '--orphan' })).rejects.toThrow(
			'"--orphan" names no commit',
		);
		await expect(createWorktree({ repository, branch: 'a..b', from: 'main' })).rejects.toThrow(
			'"a..b" is not a valid branch name',
		);
		expect(branches(repository)).toEqual(['main']);
	});

	it('refuses a folder that holds files, before it makes the branch', async () => {
		const path = join(parent, 'full');
		mkdirSync(path);
		writeFileSync(join(path, 'a.txt'), 'a\n');

		await expect(createWorktree({ repository, branch: 'new', from: 'main', path })).rejects.toThrow(
			'already exists',
		);
		expect(branches(repository)).toEqual(['main']);
	});

	it('leaves no branch or folder of its own when git fails', async () => {
		const locked = join(parent, 'locked');
		mkdirSync(locked);
		chmodSync(locked, 0o555);

		try {
			await expect(
				createWorktree({ repository, branch: 'new', from: 'main', path: join(locked, 'x') }),
			).rejects.toThrow('git refused it');
		} finally {
			chmodSync(locked, 0o755);
		}
		expect(branches(repository)).toEqual(['main']);
	});

	it('refuses a folder in no repository', async () => {
		const plain = join(parent, 'plain');
		mkdirSync(plain);

		await expect(
			createWorktree({ repository: plain, branch: 'new', from: 'main' }),
		).rejects.toThrow(UnrecoverableError);
	});
});

const call = {} as ToolCallContext;

const state = () => ({ stateDirectory: join(parent, 'state'), logger });

function removeTool(roots = [{ path: repository, access: 'write' as const }]): PreparingTool {
	return createRemoveWorktreeTool({ base: repository, roots, ...state() });
}

describe('removeWorktree', () => {
	it('says what is lost, and removes the folder but not its branch', async () => {
		const { path } = await createWorktree({ repository, branch: 'feat/export', from: 'main' });
		writeFileSync(join(path, 'README.md'), 'changed\n');
		writeFileSync(join(path, 'new.txt'), 'new\n');

		const prepared = await removeTool().prepare({ path }, signal, call);

		expect(prepared).toMatchObject({
			risk: 'destructive',
			worktree: { path, branch: 'feat/export', uncommitted: 2, ignored: 0, commitsOnlyHere: 0 },
		});
		await expect(prepared.run(signal)).resolves.toBe(
			`Removed the worktree at ${path}. Its branch feat/export stays, with its commits.`,
		);
		expect(existsSync(path)).toBe(false);
		expect(branches(repository)).toEqual(['feat/export', 'main']);
	});

	it('counts what .gitignore excludes, a folder once', async () => {
		writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n');
		git(repository, 'add', '.');
		git(repository, 'commit', '-q', '-m', 'ignore');
		const { path } = await createWorktree({ repository, branch: 'feat', from: 'main' });
		writeFileSync(join(path, '.env'), 'KEY=1\n');
		mkdirSync(join(path, 'node_modules', 'pkg'), { recursive: true });
		writeFileSync(join(path, 'node_modules', 'pkg', 'a.js'), '');
		writeFileSync(join(path, 'node_modules', 'pkg', 'b.js'), '');

		const prepared = await removeTool().prepare({ path }, signal, call);

		expect(prepared.worktree).toMatchObject({ uncommitted: 0, ignored: 2 });
	});

	it('removes nothing when the worktree changed while the user was asked', async () => {
		const { path } = await createWorktree({ repository, branch: 'feat', from: 'main' });
		const prepared = await removeTool().prepare({ path }, signal, call);
		writeFileSync(join(path, 'late.txt'), 'written meanwhile\n');

		await expect(prepared.run(signal)).rejects.toThrow(
			'changed since the user was asked, so nothing was removed',
		);
		expect(existsSync(join(path, 'late.txt'))).toBe(true);
	});

	it('removes nothing while another run writes in the worktree', async () => {
		const { path } = await createWorktree({ repository, branch: 'feat', from: 'main' });
		const prepared = await removeTool().prepare({ path }, signal, call);
		const store = await FileRecoveryStore.open({ root: path, directory: join(parent, 'state') });
		const journal = await store.startRun();

		await expect(prepared.run(signal)).rejects.toThrow(
			'Another run, or a move through its history',
		);
		expect(existsSync(path)).toBe(true);

		await journal.finish('completed');
		await expect(prepared.run(signal)).resolves.toContain('Removed the worktree');
	});

	it('prepares nothing when git cannot count the commits at risk', async () => {
		const { path } = await createWorktree({ repository, branch: 'spike', from: 'main' });
		git(path, 'checkout', '-q', '--detach');
		revList.empty = true;

		try {
			await expect(removeTool().prepare({ path }, signal, call)).rejects.toThrow(
				'git could not count the commits only',
			);
		} finally {
			revList.empty = false;
		}
	});

	it('counts the commits only a detached HEAD holds', async () => {
		const { path } = await createWorktree({ repository, branch: 'spike', from: 'main' });
		git(path, 'checkout', '-q', '--detach');
		writeFileSync(join(path, 'spike.txt'), 'spike\n');
		git(path, 'add', '.');
		git(path, 'commit', '-q', '-m', 'spike');

		const prepared: PreparedCall = await removeTool().prepare({ path }, signal, call);

		expect(prepared.worktree).toEqual({ path, uncommitted: 0, ignored: 0, commitsOnlyHere: 1 });
	});

	it('finds a worktree from a path relative to the first root', async () => {
		await createWorktree({ repository, branch: 'feat', from: 'main' });

		const prepared = await removeTool().prepare({ path: '../app-worktrees/feat' }, signal, call);

		expect(prepared.worktree?.path).toBe(join(parent, 'app-worktrees', 'feat'));
	});

	it('refuses the main folder, a folder that is no worktree, and one that is missing', async () => {
		const plain = join(parent, 'plain');
		mkdirSync(plain);

		await expect(removeTool().prepare({ path: repository }, signal, call)).rejects.toThrow(
			"is the repository's main folder",
		);
		await expect(removeTool().prepare({ path: plain }, signal, call)).rejects.toThrow(
			'is not a worktree of this repository',
		);
		await expect(
			removeTool().prepare({ path: join(parent, 'gone') }, signal, call),
		).rejects.toThrow('There is no folder at');
	});

	it('refuses the worktree the agent works in', async () => {
		const { path } = await createWorktree({ repository, branch: 'mine', from: 'main' });
		const tool = createRemoveWorktreeTool({
			base: path,
			roots: [{ path: join(path, 'src'), access: 'write' }],
			...state(),
		});

		await expect(tool.prepare({ path }, signal, call)).rejects.toThrow('You work in');
		expect(existsSync(path)).toBe(true);
	});

	it('reads a relative root from the working directory', async () => {
		const { path } = await createWorktree({ repository, branch: 'mine', from: 'main' });
		vi.spyOn(process, 'cwd').mockReturnValue(path);
		// The first root's folder is not where a relative root starts.
		const tool = createRemoveWorktreeTool({
			base: repository,
			roots: [{ path: '.', access: 'write' }],
			...state(),
		});

		await expect(tool.prepare({ path }, signal, call)).rejects.toThrow('You work in');
		vi.restoreAllMocks();
	});

	it('refuses a locked worktree', async () => {
		const { path } = await createWorktree({ repository, branch: 'kept', from: 'main' });
		git(repository, 'worktree', 'lock', path);

		await expect(removeTool().prepare({ path }, signal, call)).rejects.toThrow('is locked');
	});

	it('asks the approver with what is lost, and removes nothing it denies', async () => {
		const { path } = await createWorktree({ repository, branch: 'feat', from: 'main' });
		const tools = await createFileTools(
			'openai',
			{ roots: [{ path: repository, access: 'write' }], stateDirectory: join(parent, 'state') },
			{ removeWorktree: true, logger },
		);
		const approve = vi.fn<Approver>(() => ({ approved: false, reason: 'keep it' }));
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'removeWorktree', { path })]),
			textResponse('kept'),
		);
		const agent = new LLMAgent({
			llmClient,
			// Only this one: the fake client cannot declare the native edit tools.
			tools: tools.filter(tool => tool.name === 'removeWorktree') as unknown as AgentTool[],
		});

		await agent.run('remove the feat worktree', { signal, approve });

		expect(approve).toHaveBeenCalledWith(
			{
				tool: 'removeWorktree',
				input: { path },
				risk: 'destructive',
				worktree: { path, branch: 'feat', uncommitted: 0, ignored: 0, commitsOnlyHere: 0 },
			} satisfies ApprovalRequest,
			expect.any(AbortSignal),
		);
		expect(existsSync(path)).toBe(true);
	});
});

describe('createFileTools with removeWorktree', () => {
	const workspace = () => ({
		roots: [{ path: repository, access: 'write' as const }],
		stateDirectory: join(parent, 'state'),
	});

	it('gives the tool only when asked', async () => {
		const names = async (removeWorktree?: boolean) =>
			(
				await createFileTools('anthropic', workspace(), {
					logger,
					...(removeWorktree === undefined ? {} : { removeWorktree }),
				})
			).map(tool => tool.name);

		expect(await names()).not.toContain('removeWorktree');
		expect(await names(true)).toContain('removeWorktree');
	});

	it('refuses it for a first root in no repository', async () => {
		const plain = join(parent, 'plain');
		mkdirSync(plain);

		await expect(
			createFileTools(
				'openai',
				{ roots: [{ path: plain, access: 'write' }], stateDirectory: join(parent, 'state') },
				{ removeWorktree: true, logger },
			),
		).rejects.toThrow(InvalidAgentConfigError);
	});
});
