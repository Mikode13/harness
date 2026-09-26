// Reference script — NOT part of the harness. Run with: node examples/anthropic-messages-example.ts
// Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). ANTHROPIC_MODEL overrides the model.
//
// Demonstrates the raw shape of the Anthropic Messages API through `@anthropic-ai/sdk`,
// so the LanguageModel seam (#23) is designed against real behaviour instead of guesses.
// Source: the SDK's own types in `@anthropic-ai/sdk/resources/messages/messages.d.ts`.
//
// Unlike the Claude Agent SDK, there is no session and no agent loop here: one call is one
// model response. The API is always stateless, so resending history is the only option.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

// ---------------------------------------------------------------------------
// 1. One turn. `system` is a top-level field, not a message.
// ---------------------------------------------------------------------------
const history: Anthropic.MessageParam[] = [
	{ role: 'user', content: 'My name is Miki. Reply with exactly the word: pong' },
];

const first = await client.messages.create({
	model,
	max_tokens: 16000, // required, unlike OpenAI
	system: 'You are a terse assistant.',
	messages: history,
	thinking: { type: 'adaptive', display: 'summarized' },
});

// Message shape (see Message in messages.d.ts):
// {
//   id, model, role: 'assistant',
//   content: ContentBlock[],        // ordered blocks: text | thinking | tool_use | ...
//   stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
//              | 'pause_turn' | 'refusal' | 'model_context_window_exceeded' | null,
//   usage: { input_tokens, output_tokens,
//            cache_creation_input_tokens, cache_read_input_tokens, ... },
// }
// There is no `output_text`: the text is spread across `text` blocks.
console.log('stop_reason:', first.stop_reason);
console.log('usage:', first.usage);
for (const block of first.content) describe(block);

// ---------------------------------------------------------------------------
// 2. Second turn, rebuilt entirely from our own state. The WHOLE content array goes
//    back, not only the text: thinking blocks carry a `signature` and must be
//    replayed unchanged on the same model, above all in turns with tool calls.
// ---------------------------------------------------------------------------
history.push({ role: 'assistant', content: first.content });
history.push({ role: 'user', content: 'What is my name?' });

const second = await client.messages.create({
	model,
	max_tokens: 16000,
	messages: history,
	thinking: { type: 'adaptive' },
});
console.log('second turn:', textOf(second));

// ---------------------------------------------------------------------------
// 3. One tool round trip. Here a tool request IS a stop reason ('tool_use'),
//    and the result goes back inside a USER message, with the same id.
// ---------------------------------------------------------------------------
const toolHistory: Anthropic.MessageParam[] = [
	{ role: 'user', content: 'What time is it in Madrid? Use the tool.' },
];
const tools: Anthropic.Tool[] = [
	{
		name: 'get_time',
		description: 'Current time in a city',
		input_schema: {
			type: 'object',
			properties: { city: { type: 'string' } },
			required: ['city'],
			additionalProperties: false,
		},
		strict: true,
	},
];

const asking = await client.messages.create({
	model,
	max_tokens: 16000,
	tools,
	messages: toolHistory,
	thinking: { type: 'adaptive' },
});

if (asking.stop_reason === 'tool_use') {
	toolHistory.push({ role: 'assistant', content: asking.content });

	// `input` is already a parsed object (typed `unknown`), not a JSON string.
	const results: Anthropic.ToolResultBlockParam[] = asking.content
		.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
		.map(block => ({
			type: 'tool_result',
			tool_use_id: block.id, // links the result to the request
			content: `It is 10:00 in ${(block.input as { city: string }).city}`,
			// is_error: true, // how a failed tool is reported back to the model
		}));
	// All results of one assistant turn go back in ONE user message.
	toolHistory.push({ role: 'user', content: results });
}

const answered = await client.messages.create({
	model,
	max_tokens: 16000,
	tools,
	messages: toolHistory,
	thinking: { type: 'adaptive' },
});
console.log('after tool:', textOf(answered));

// ---------------------------------------------------------------------------
// 4. Cancellation and errors. Same pattern as the OpenAI SDK: both are generated
//    from the same toolkit, so the class names match.
// ---------------------------------------------------------------------------
const controller = new AbortController();
const pending = client.messages.create(
	{ model, max_tokens: 1000, messages: [{ role: 'user', content: 'Count to 1000' }] },
	{ signal: controller.signal },
);
controller.abort();

try {
	await pending;
} catch (error) {
	if (error instanceof Anthropic.APIUserAbortError) console.log('cancelled by us');
	else if (error instanceof Anthropic.RateLimitError) console.log('429: retryable');
	else if (error instanceof Anthropic.AuthenticationError) console.log('401: not retryable');
	// APIConnectionError extends APIError here, so it must be checked first.
	else if (error instanceof Anthropic.APIConnectionError) console.log('network: retryable');
	else if (error instanceof Anthropic.APIError) console.log('HTTP', error.status);
	else throw error;
}
// A refusal is NOT an error: it is HTTP 200 with stop_reason 'refusal'.

function describe(block: Anthropic.ContentBlock): void {
	switch (block.type) {
		case 'text':
			console.log('text:', block.text);
			break;
		case 'thinking': // { thinking, signature } — signature is opaque, replay only
			console.log('thinking:', block.thinking, Boolean(block.signature));
			break;
		case 'redacted_thinking': // { data } — opaque, replay only
			console.log('redacted_thinking');
			break;
		case 'tool_use': // { id, name, input: unknown }
			console.log('tool_use:', block.name, block.input);
			break;
		default:
			console.log('other block:', block.type);
	}
}

function textOf(message: Anthropic.Message): string {
	return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');
}
