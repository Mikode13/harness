import { describe, expect, it } from 'vitest';
import { handleEvents, type ProgressEvent } from '../../src/agent/domain/agent.ts';

describe('handleEvents', () => {
	it.each([
		[{ type: 'agentMessage', message: 'hello' }, 'hello'],
		[{ type: 'reasoning', message: 'thinking' }, 'thinking'],
		[{ type: 'command', command: 'echo hello', exitCode: 0 }, 'command: echo hello, exit 0'],
		[{ type: 'command', command: 'echo hello' }, 'command: echo hello, exit ?'],
		[
			{ type: 'mcpTool', server: 'catalog', tool: 'lookup', status: 'completed' },
			'tool: lookup, server: catalog, status: completed',
		],
		[{ type: 'search', query: 'Codex SDK' }, 'searching... query:Codex SDK'],
		[
			{
				type: 'fileChange',
				changes: [
					{ path: 'src/a.ts', kind: 'add' },
					{ path: 'src/b.ts', kind: 'delete' },
				],
			},
			'src/a.ts - add\nsrc/b.ts - delete',
		],
		[
			{
				type: 'todoList',
				items: [
					{ text: 'Implement', completed: false },
					{ text: 'Review', completed: true },
				],
			},
			'Implement - status:X\nReview - status:✔',
		],
	] satisfies [ProgressEvent, string][])('formats %s', (event, expected) => {
		expect(handleEvents(event)).toBe(expected);
	});

	it.each([
		[{ type: 'command', command: '' }, undefined],
		[{ type: 'mcpTool', server: '', tool: 'lookup', status: 'completed' }, undefined],
		[{ type: 'mcpTool', server: 'catalog', tool: 'lookup', status: '' }, undefined],
		[{ type: 'search', query: '' }, undefined],
		[{ type: 'fileChange', changes: [] }, undefined],
		[{ type: 'todoList', items: [] }, undefined],
		[{ type: 'turnStarted' }, undefined],
		[{ type: 'turnEnded' }, undefined],
	] satisfies [ProgressEvent, string | undefined][])(
		'handles missing event data: %s',
		(event, expected) => {
			expect(handleEvents(event)).toBe(expected);
		},
	);
});
