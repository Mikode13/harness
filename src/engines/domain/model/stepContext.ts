import type { StepContext } from '#src/agent/domain/agent';
import type { Message, ToolCallPart } from '#src/llm/domain/message';
import type { ToolDefinition } from '#src/llm/domain/tool';

// Enough to name what fills a context without listing every result of a long run.
const largestResults = 5;

/**
 * What one call to the model sends, in characters, by where it comes from. Characters, not
 * tokens: the harness does not tokenize, and the provider's count arrives with the answer.
 * `summarize` names a tool call as its tool does, or gives nothing.
 */
export function measureContext({
	instructions,
	tools,
	context,
	summarize,
}: {
	instructions: string | undefined;
	tools: ToolDefinition[];
	context: Message[];
	summarize: (call: ToolCallPart) => string | undefined;
}): StepContext {
	const measured: StepContext = {
		instructions: instructions?.length ?? 0,
		tools: JSON.stringify(tools).length,
		messages: 0,
		reasoning: 0,
		toolCalls: 0,
		toolResults: [],
		largestResults: [],
	};
	const calls = new Map<string, ToolCallPart>();
	const byTool = new Map<string, { characters: number; calls: number }>();
	const results: StepContext['largestResults'] = [];

	for (const part of context.flatMap(message => message.content)) {
		switch (part.type) {
			case 'text':
				measured.messages += part.text.length;
				break;
			case 'reasoning':
				measured.reasoning += part.text.length;
				break;
			case 'providerData':
				measured.reasoning += JSON.stringify(part.data).length;
				break;
			case 'toolCall':
				calls.set(part.id, part);
				measured.toolCalls += JSON.stringify(part.input).length;
				break;
			case 'toolResult': {
				const characters = part.output.length;
				const tool = byTool.get(part.name) ?? { characters: 0, calls: 0 };
				tool.characters += characters;
				tool.calls += 1;
				byTool.set(part.name, tool);
				const call = calls.get(part.callId);
				const summary = call && summarize(call);
				results.push({ tool: part.name, characters, ...(summary ? { summary } : {}) });
				break;
			}
		}
	}

	measured.toolResults = [...byTool]
		.map(([tool, { characters, calls }]) => ({ tool, characters, calls }))
		.sort((a, b) => b.characters - a.characters);
	measured.largestResults = results
		.sort((a, b) => b.characters - a.characters)
		.slice(0, largestResults);
	return measured;
}
