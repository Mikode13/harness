// Reference script — NOT part of the harness. Run with: node examples/openai-responses-example.ts
// Needs OPENAI_API_KEY. OPENAI_MODEL overrides the model.
//
// Demonstrates the raw shape of the OpenAI Responses API through the `openai` client SDK,
// so the LanguageModel seam (#23) is designed against real behaviour instead of guesses.
// Source: the SDK's own types in `openai/resources/responses/responses.d.ts`.
//
// Unlike the Codex SDK, there is no Thread and no agent loop here: one call is one model
// response. Tools are only described to the model; running them is our job.

import OpenAI from 'openai';
import type {
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseOutputItem,
} from 'openai/resources/responses/responses';

const client = new OpenAI();
const model = process.env.OPENAI_MODEL ?? 'gpt-5.6-sol';

// ---------------------------------------------------------------------------
// 1. One turn. `input` can be a plain string, but a list of items is what makes
//    multi-turn possible, so start with the list form.
// ---------------------------------------------------------------------------
const history: ResponseInputItem[] = [
	{ role: 'user', content: 'My name is Miki. Reply with exactly the word: pong' },
];

const first = await client.responses.create({
	model,
	instructions: 'You are a terse assistant.', // the system prompt lives outside `input`
	input: history,
	// store: false => OpenAI keeps nothing server-side, so WE must resend the history.
	// That is the whole point of #23: the conversation is ours, not the provider's.
	store: false,
	// With store: false, reasoning items can only be replayed if they come back
	// encrypted. Without this, a reasoning model loses its reasoning between turns.
	include: ['reasoning.encrypted_content'],
});

// Response shape (see Response in responses.d.ts):
// {
//   id, model, status: 'completed' | 'incomplete' | 'failed' | ...,
//   output: ResponseOutputItem[],   // ordered items, NOT just text
//   output_text: string,            // SDK convenience: all output_text parts joined
//   usage: { input_tokens, input_tokens_details: { cached_tokens, cache_write_tokens },
//            output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens },
//   incomplete_details: { reason: 'max_output_tokens' | 'content_filter' | ... } | null,
//   error: ResponseError | null,
// }
console.log('status:', first.status, first.incomplete_details);
console.log('output_text:', first.output_text);
console.log('usage:', first.usage);
for (const item of first.output) describe(item);

// ---------------------------------------------------------------------------
// 2. Second turn, rebuilt entirely from our own state. Output items are valid
//    input items, so the assistant turn is appended as-is — reasoning included.
//    Flattening it to `output_text` would drop the encrypted reasoning.
// ---------------------------------------------------------------------------
history.push(...(first.output as ResponseInputItem[]));
history.push({ role: 'user', content: 'What is my name?' });

const second = await client.responses.create({
	model,
	input: history,
	store: false,
	include: ['reasoning.encrypted_content'],
});
console.log('second turn:', second.output_text);

// ---------------------------------------------------------------------------
// 3. One tool round trip. The model asks; we execute; we answer with the SAME call_id.
// ---------------------------------------------------------------------------
const toolHistory: ResponseInputItem[] = [
	{ role: 'user', content: 'What time is it in Madrid? Use the tool.' },
];
const tools: OpenAI.Responses.FunctionTool[] = [
	{
		type: 'function',
		name: 'get_time',
		description: 'Current time in a city',
		parameters: {
			type: 'object',
			properties: { city: { type: 'string' } },
			required: ['city'],
			additionalProperties: false,
		},
		strict: true,
	},
];

const asking = await client.responses.create({
	model,
	input: toolHistory,
	tools,
	store: false,
	include: ['reasoning.encrypted_content'],
});

// A tool request is an output ITEM of type 'function_call', not a stop reason.
// `arguments` is a JSON string we must parse and validate ourselves.
const calls = asking.output.filter(
	(item): item is ResponseFunctionToolCall => item.type === 'function_call',
);
toolHistory.push(...(asking.output as ResponseInputItem[]));
for (const call of calls) {
	const args = JSON.parse(call.arguments) as { city: string };
	toolHistory.push({
		type: 'function_call_output',
		call_id: call.call_id, // links the result to the request
		output: `It is 10:00 in ${args.city}`, // always a string (or content parts)
	});
}

const answered = await client.responses.create({
	model,
	input: toolHistory,
	tools,
	store: false,
	include: ['reasoning.encrypted_content'],
});
console.log('after tool:', answered.output_text);

// ---------------------------------------------------------------------------
// 4. Cancellation and errors.
// ---------------------------------------------------------------------------
// Request options are the SECOND argument, apart from the API body.
const controller = new AbortController();
const pending = client.responses.create(
	{ model, input: 'Count to 1000' },
	{ signal: controller.signal },
);
controller.abort();

try {
	await pending;
} catch (error) {
	// Most specific first. APIUserAbortError is OUR cancellation, not a provider failure.
	if (error instanceof OpenAI.APIUserAbortError) console.log('cancelled by us');
	else if (error instanceof OpenAI.RateLimitError) console.log('429: retryable');
	else if (error instanceof OpenAI.AuthenticationError) console.log('401: not retryable');
	else if (error instanceof OpenAI.APIConnectionError) console.log('network: retryable');
	else if (error instanceof OpenAI.APIError) console.log('HTTP', error.status);
	else throw error;
}
// The SDK already retries 408/409/429/5xx and connection errors (maxRetries, default 2)
// before any of these reach us.

function describe(item: ResponseOutputItem): void {
	switch (item.type) {
		case 'message': // role 'assistant', content: (output_text | refusal)[]
			console.log('message:', item.content);
			break;
		case 'reasoning': // summary[] + encrypted_content (opaque, replay only)
			console.log('reasoning:', item.summary, Boolean(item.encrypted_content));
			break;
		case 'function_call': // { call_id, name, arguments: string }
			console.log('function_call:', item.name, item.arguments);
			break;
		default:
			console.log('other item:', item.type);
	}
}
