import { describe, expect, it } from 'vitest';
import {
	clearedOutput,
	compacted,
	emptyCompaction,
	findClearing,
} from '../../src/engines/domain/model/compaction.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import type { FileAccess } from '../../src/tools/domain/preparedCall.ts';

const prompt = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const reasoning = (data: string): Message => ({
	role: 'assistant',
	content: [{ type: 'providerData', source: 'openai', data }],
});
const call = (id: string, name: string, input: unknown, output: string): Message[] => [
	{ role: 'assistant', content: [{ type: 'toolCall', id, name, input }] },
	{ role: 'tool', content: [{ type: 'toolResult', callId: id, name, output, isError: false }] },
];
const big = 'x'.repeat(40_000);
const noFiles = () => undefined;

describe('findClearing', () => {
	it('clears a result a later identical call replaced, keys in any order', () => {
		const context = [
			prompt('fix it'),
			...call('a', 'runCommand', { command: { name: 'check', x: 1 } }, big),
			...call('b', 'runCommand', { command: { x: 1, name: 'check' } }, 'passed'),
			...call('c', 'readFile', { path: 'one' }, 'one'),
			...call('d', 'readFile', { path: 'two' }, 'two'),
			...call('e', 'readFile', { path: 'three' }, 'three'),
		];

		const clearing = findClearing(context, emptyCompaction(), noFiles);

		expect([...clearing.cleared]).toEqual([['a', 'a later identical call replaced it']]);
		expect(clearing.estimatedTokens).toBeGreaterThan(9_000);
	});

	it('clears a result about a file written since, but never one of the last three calls', () => {
		const files: Record<string, FileAccess> = {
			read: { path: '/repo/a.ts', access: 'read' },
			write: { path: '/repo/a.ts', access: 'write' },
			other: { path: '/repo/b.ts', access: 'read' },
		};
		const context = [
			prompt('fix it'),
			...call('read', 'readFile', { path: 'a.ts' }, big),
			...call('other', 'readFile', { path: 'b.ts' }, big),
			...call('write', 'apply_patch', { path: 'a.ts' }, 'done'),
			...call('x', 'listFiles', {}, ''),
			...call('y', 'listFiles', { glob: '*' }, ''),
		];

		const clearing = findClearing(context, emptyCompaction(), id => files[id]);

		expect([...clearing.cleared]).toEqual([['read', 'the file changed after it']]);
	});

	it('keeps the last three calls, even when a later one replaced them', () => {
		const context = [
			prompt('fix it'),
			...call('a', 'runCommand', { name: 'test' }, big),
			...call('b', 'runCommand', { name: 'test' }, big),
			...call('c', 'runCommand', { name: 'test' }, big),
		];

		expect(findClearing(context, emptyCompaction(), noFiles).cleared.size).toBe(0);
	});

	it('drops the reasoning of turns before the last prompt, never of the turn in progress', () => {
		const context = [
			prompt('first'),
			reasoning('e'.repeat(150_000)),
			prompt('second'),
			reasoning('kept'),
		];

		const clearing = findClearing(context, emptyCompaction(), noFiles);

		expect(clearing.reasoningFromPrompt).toBe(1);
		expect(clearing.estimatedTokens).toBe(10_000);
		expect(compacted(context, { cleared: new Map(), reasoningFromPrompt: 1 })).toEqual([
			prompt('first'),
			{ role: 'assistant', content: [] },
			prompt('second'),
			reasoning('kept'),
		]);
	});

	it('finds nothing new in what is already cleared', () => {
		const context = [
			prompt('fix it'),
			...call('a', 'readFile', { path: 'one' }, big),
			...call('b', 'readFile', { path: 'one' }, big),
			...call('c', 'listFiles', {}, ''),
			...call('d', 'listFiles', { glob: '*' }, ''),
			...call('e', 'listFiles', { glob: '**' }, ''),
		];
		const compaction = { cleared: new Map([['a', 'replaced']]), reasoningFromPrompt: 0 };

		expect(findClearing(context, compaction, noFiles)).toEqual({
			cleared: new Map(),
			reasoningFromPrompt: 0,
			estimatedTokens: 0,
		});
	});
});

describe('compacted', () => {
	it('sends a cleared result as a note, and leaves the original context untouched', () => {
		const context = [prompt('fix it'), ...call('a', 'readFile', { path: 'one' }, big)];
		const original = structuredClone(context);

		const sent = compacted(context, {
			cleared: new Map([['a', 'the file changed after it']]),
			reasoningFromPrompt: 0,
		});

		expect(sent[2]?.content).toEqual([
			{
				type: 'toolResult',
				callId: 'a',
				name: 'readFile',
				output: clearedOutput('the file changed after it'),
				isError: false,
			},
		]);
		expect(context).toEqual(original);
	});
});
