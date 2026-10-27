import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunContext } from '../../src/agent/domain/runContext.ts';
import { createFileTools } from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { EditRefusedError } from '../../src/tools/domain/fileEdits.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry, type ToolCallContext } from '../../src/tools/domain/readRegistry.ts';
import { createRemoveWorktreeTool } from '../../src/tools/infrastructure/removeWorktreeTool.ts';
import { delegateCeiling } from '../../src/tools/infrastructure/writeCeiling.ts';

const signal = new AbortController().signal;
const logger = { warn: () => undefined };

let parent: string;
let repo: string;

beforeEach(() => {
	// macOS hands out a symlinked temporary folder; ceilings are real paths.
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-ceiling-')));
	repo = join(parent, 'repo');
	mkdirSync(join(repo, 'src'), { recursive: true });
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

function callUnder(writeCeiling: readonly string[] | undefined): ToolCallContext {
	return {
		run: new RunContext({ id: 'ceiling' }),
		reads: new ReadRegistry().begin(),
		callId: 'call-1',
		onProgress: () => undefined,
		spend: () => undefined,
		depth: 1,
		...(writeCeiling ? { writeCeiling } : {}),
	};
}

async function toolsOver(path: string) {
	const workspace = {
		roots: [{ path, access: 'write' as const }],
		stateDirectory: join(parent, 'state'),
	};
	return createFileTools('openai', workspace, {
		logger,
		commands: { mark: { description: 'Marks', executable: 'touch', args: ['marked'] } },
	});
}

function named(tools: unknown[], name: string): PreparingTool {
	const tool = (tools as PreparingTool[]).find(each => each.name === name);
	if (!tool) throw new Error(`No tool named ${name}`);
	return tool;
}

describe('a write ceiling', () => {
	it('refuses an edit and a command under a caller that only reads, before anyone is asked', async () => {
		const tools = await toolsOver(repo);
		const call = callUnder([]);
		const editing = named(tools, 'apply_patch').prepare(
			{ type: 'create_file', path: 'a.txt', diff: '+a' },
			signal,
			call,
		);

		await expect(editing).rejects.toThrow(EditRefusedError);
		await expect(editing).rejects.toThrow(`only reads, and your tools may write in ${repo}`);
		await expect(
			named(tools, 'runCommand').prepare({ command: { name: 'mark' } }, signal, call),
		).rejects.toThrow('only reads');
		expect(existsSync(join(repo, 'a.txt'))).toBe(false);
	});

	it('refuses tools that may write beyond the folders the caller may', async () => {
		const tools = await toolsOver(repo);

		await expect(
			named(tools, 'apply_patch').prepare(
				{ type: 'create_file', path: 'src/a.txt', diff: '+a' },
				signal,
				callUnder([join(repo, 'src')]),
			),
		).rejects.toThrow(`may write only in ${join(repo, 'src')}`);
	});

	it('lets tools write within the folders the caller may, or with no ceiling', async () => {
		const within = await toolsOver(join(repo, 'src'));
		const unlimited = await toolsOver(repo);

		const first = await named(within, 'apply_patch').prepare(
			{ type: 'create_file', path: 'a.txt', diff: '+a' },
			signal,
			callUnder([repo]),
		);
		await first.run(signal);
		const second = await named(unlimited, 'apply_patch').prepare(
			{ type: 'create_file', path: 'b.txt', diff: '+b' },
			signal,
			callUnder(undefined),
		);
		await second.run(signal);

		expect(existsSync(join(repo, 'src', 'a.txt'))).toBe(true);
		expect(existsSync(join(repo, 'b.txt'))).toBe(true);
	});

	it('refuses to remove a worktree outside it', async () => {
		const remove = createRemoveWorktreeTool({
			base: repo,
			roots: [{ path: repo, access: 'write' }],
			stateDirectory: join(parent, 'state'),
		});
		const elsewhere = join(parent, 'elsewhere');
		mkdirSync(elsewhere);

		await expect(remove.prepare({ path: elsewhere }, signal, callUnder([repo]))).rejects.toThrow(
			`your tools may also write in ${elsewhere}`,
		);
	});
});

describe('delegateCeiling', () => {
	it('is the narrower of the call’s ceiling and the calling agent’s write roots, as real paths', async () => {
		const src = join(repo, 'src');
		const docs = join(parent, 'docs');
		mkdirSync(docs);

		await expect(delegateCeiling({})).resolves.toBeUndefined();
		await expect(delegateCeiling({ writeCeiling: [repo] })).resolves.toEqual([repo]);
		await expect(delegateCeiling({ agentWriteRoots: [] })).resolves.toEqual([]);
		await expect(delegateCeiling({ agentWriteRoots: [src, docs] })).resolves.toEqual([src, docs]);
		await expect(
			delegateCeiling({ writeCeiling: [repo], agentWriteRoots: [src, docs] }),
		).resolves.toEqual([src]);
		await expect(
			delegateCeiling({ writeCeiling: [src], agentWriteRoots: [repo] }),
		).resolves.toEqual([src]);
		await expect(delegateCeiling({ writeCeiling: [], agentWriteRoots: [repo] })).resolves.toEqual(
			[],
		);
	});
});
