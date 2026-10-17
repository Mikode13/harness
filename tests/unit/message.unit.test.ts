import { describe, expect, it } from 'vitest';
import { type Message, sentContext } from '../../src/llm/domain/message.ts';

const compaction = (source: string, id: string) =>
	({ type: 'compaction', source, data: { id } }) as const;

describe('sentContext', () => {
	it('starts at the latest compaction of the source, within its message', () => {
		const context: Message[] = [
			{ role: 'user', content: [{ type: 'text', text: 'task' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'before' },
					compaction('openai', 'first'),
					{ type: 'text', text: 'between' },
				],
			},
			{ role: 'user', content: [{ type: 'text', text: 'more' }] },
			{
				role: 'assistant',
				content: [compaction('openai', 'second'), { type: 'text', text: 'after' }],
			},
			{ role: 'user', content: [{ type: 'text', text: 'last' }] },
		];

		expect(sentContext(context, 'openai')).toEqual([
			{
				role: 'assistant',
				content: [compaction('openai', 'second'), { type: 'text', text: 'after' }],
			},
			{ role: 'user', content: [{ type: 'text', text: 'last' }] },
		]);
	});

	it("keeps the whole context when only another provider's compaction is in it", () => {
		const context: Message[] = [
			{ role: 'user', content: [{ type: 'text', text: 'task' }] },
			{ role: 'assistant', content: [compaction('claude', 'theirs')] },
		];

		expect(sentContext(context, 'openai')).toBe(context);
		expect(sentContext(context, undefined)).toBe(context);
	});
});
