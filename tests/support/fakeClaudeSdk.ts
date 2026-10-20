import type Anthropic from '@anthropic-ai/sdk';

/**
 * A fake SDK whose `beta.messages.stream` answers, through `finalMessage()`, with what `create`
 * returns for the same request and options. A failure comes before the stream connects, as an
 * error response does; the tests that break a stream off halfway use the real SDK.
 */
export function fakeClaudeSdk(create: (params: unknown, options: unknown) => unknown): Anthropic {
	const stream = (params: unknown, options: unknown) => {
		let connected = false;
		const final = Promise.resolve(create(params, options)).then((message: unknown) => {
			connected = true;
			return message;
		});
		const sent = {
			get response() {
				return connected ? new Response() : undefined;
			},
			// No stream events: the final message is the whole answer.
			on: () => sent,
			finalMessage: () => final,
		};
		return sent;
	};
	return { beta: { messages: { stream } } } as unknown as Anthropic;
}
