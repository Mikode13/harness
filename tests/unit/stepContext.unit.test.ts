import { describe, expect, it } from 'vitest';
import { measureContext } from '../../src/engines/domain/model/stepContext.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import type { ToolDefinition } from '../../src/llm/domain/tool.ts';

const read = (id: string, path: string, output: string): Message[] => [
	{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'readFile', input: { path } }] },
	{
		role: 'tool',
		content: [{ type: 'toolResult', callId: id, name: 'readFile', output, isError: false }],
	},
];

describe('measureContext', () => {
	it('counts the characters a call sends, by where they come from', () => {
		const tools: ToolDefinition[] = [
			{ name: 'readFile', description: 'Reads', inputSchema: { type: 'object' } },
		];
		const context: Message[] = [
			{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: 'think' },
					{ type: 'providerData', source: 'openai', data: { id: 'r' } },
					// Another provider's block, which this client drops.
					{ type: 'providerData', source: 'claude', data: { signature: 'never sent' } },
					{ type: 'text', text: 'hi' },
				],
			},
			...read('1', 'a.md', 'x'.repeat(10)),
		];

		expect(
			measureContext({
				instructions: 'Be brief.',
				providerDataSource: 'openai',
				tools,
				context,
				summarize: () => undefined,
			}),
		).toEqual({
			instructions: 9,
			tools: JSON.stringify(tools).length,
			messages: 'hello'.length + 'hi'.length,
			// The readable text is not sent back: the client's own block is, and it holds it.
			reasoning: JSON.stringify({ id: 'r' }).length,
			toolCalls: JSON.stringify({ path: 'a.md' }).length,
			toolResults: [{ tool: 'readFile', characters: 10, calls: 1 }],
			largestResults: [{ tool: 'readFile', characters: 10 }],
		});
	});

	it('sums each tool, largest first, and names the five largest results by their call', () => {
		const context: Message[] = [
			...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((path, index) =>
				read(path, `${path}.ts`, 'x'.repeat((index + 1) * 10)),
			),
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'g', name: 'test', input: {} }] },
			{
				role: 'tool',
				content: [
					{ type: 'toolResult', callId: 'g', name: 'test', output: 'y'.repeat(500), isError: true },
				],
			},
		];
		const summaries = new Map([['f', 'f.ts:1-200']]);

		const measured = measureContext({
			instructions: undefined,
			providerDataSource: undefined,
			tools: [],
			context,
			summarize: call => summaries.get(call.id),
		});

		expect(measured.instructions).toBe(0);
		expect(measured.toolResults).toEqual([
			{ tool: 'test', characters: 500, calls: 1 },
			{ tool: 'readFile', characters: 210, calls: 6 },
		]);
		expect(measured.largestResults).toEqual([
			{ tool: 'test', characters: 500 },
			{ tool: 'readFile', characters: 60, summary: 'f.ts:1-200' },
			{ tool: 'readFile', characters: 50 },
			{ tool: 'readFile', characters: 40 },
			{ tool: 'readFile', characters: 30 },
		]);
	});
});
