// Reference only — NOT part of the harness, not meant to run. Side-by-side comparison of
// what "one model call" looks like in each low-level API, to design the LanguageModel
// seam (#23) against real shapes instead of guesses.
// Types re-imported (not hand-copied) so this breaks loudly if an SDK changes.

import type Anthropic from '@anthropic-ai/sdk';
import type {
	Response as OpenAIResponse,
	ResponseInputItem as OpenAIInputItem,
	ResponseOutputItem as OpenAIOutputItem,
	ResponseUsage as OpenAIUsage,
} from 'openai/resources/responses/responses';

// ---------------------------------------------------------------------------
// Request: what goes IN
// ---------------------------------------------------------------------------
//
//                  OpenAI Responses                    Anthropic Messages
// system prompt    `instructions` (top-level)          `system` (top-level)
// history          `input: ResponseInputItem[]`        `messages: MessageParam[]`
// unit of history  flat list of ITEMS                  alternating user/assistant MESSAGES
//                  (message, reasoning, function_call,  each with a list of content BLOCKS
//                   function_call_output are siblings)  (text, thinking, tool_use, tool_result)
// output budget    `max_output_tokens` (optional)      `max_tokens` (REQUIRED)
// tools            `{ type:'function', name,           `{ name, input_schema, strict }`
//                     parameters, strict }`
// server state     `store: false` to disable it        none: always stateless
// cancellation     2nd arg `{ signal }`                2nd arg `{ signal }`
export type OpenAIHistory = OpenAIInputItem[];
export type AnthropicHistory = Anthropic.MessageParam[];

// ---------------------------------------------------------------------------
// Response: what comes OUT
// ---------------------------------------------------------------------------
//
//                  OpenAI Responses                    Anthropic Messages
// content          `output: ResponseOutputItem[]`      `content: ContentBlock[]`
// final text       `output_text` (SDK helper)          join the `text` blocks yourself
// tool request     an item `type: 'function_call'`     a block `type: 'tool_use'`
//                  `{ call_id, name, arguments }`      `{ id, name, input }`
//                  arguments: JSON STRING              input: already-parsed OBJECT
// tool result      input item `function_call_output`   `tool_result` block inside a
//                  `{ call_id, output }`               USER message `{ tool_use_id, content, is_error }`
// why it stopped   `status` + `incomplete_details`     `stop_reason` ('end_turn', 'tool_use',
//                  (no "tool_use" status: you look      'max_tokens', 'refusal', 'pause_turn', ...)
//                   for function_call items)
// refusal          an output part `type: 'refusal'`    `stop_reason: 'refusal'`
export type OpenAIOutput = OpenAIResponse['output'];
export type OpenAIItem = OpenAIOutputItem;
export type AnthropicOutput = Anthropic.Message['content'];
export type AnthropicStop = Anthropic.StopReason;

// ---------------------------------------------------------------------------
// Private reasoning state: must be REPLAYED, cannot be READ
// ---------------------------------------------------------------------------
//
// OpenAI     item `type: 'reasoning'` with `encrypted_content` (only when you ask for
//            `include: ['reasoning.encrypted_content']` and use `store: false`).
// Anthropic  block `type: 'thinking'` with an opaque `signature`, or
//            `type: 'redacted_thinking'` with opaque `data`.
//
// Both are useless to the other provider. Both are needed by their own provider to
// continue well. This is the "provider-specific continuation state" of #23.
export type OpenAIReasoning = Extract<OpenAIOutputItem, { type: 'reasoning' }>;
export type AnthropicThinking = Anthropic.ThinkingBlock | Anthropic.RedactedThinkingBlock;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// OpenAI     `{ input_tokens, input_tokens_details: { cached_tokens, cache_write_tokens },
//              output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }`
//            cached tokens are INCLUDED in input_tokens.
// Anthropic  `{ input_tokens, output_tokens, cache_read_input_tokens,
//              cache_creation_input_tokens, ... }`
//            cache tokens are NOT included in input_tokens: they are separate counters.
//
// Same names, different meaning: `input_tokens` does not count the same thing.
export type OpenAITokenUsage = OpenAIUsage;
export type AnthropicTokenUsage = Anthropic.Usage;

// ---------------------------------------------------------------------------
// Questions this raises for ModelRequest / ModelResponse (not answered here):
//
// - Is a conversation entry a MESSAGE with blocks (Anthropic) or an ITEM (OpenAI)?
//   Converting items -> messages loses nothing; the opposite needs grouping.
// - Where does a tool call live: as its own entry, or as a block of an assistant entry?
// - Is "the model wants tools" something the adapter reports explicitly (a stop
//   reason), or something the loop infers from the content?
// - Does `input_tokens` in our usage include cache reads? Pick one meaning and make
//   each adapter convert to it.
// - The opaque reasoning state: where is it stored so it is replayed to its own
//   provider and ignored by the other?
// ---------------------------------------------------------------------------
