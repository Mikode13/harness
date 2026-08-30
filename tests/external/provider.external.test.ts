import { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeAgent } from '../../src/claudeAgent.ts';
import { CodexAgent } from '../../src/codexAgent.ts';

const prompt = 'Reply with the single word READY and do not use any tools.';
const skipExternalTests = process.env.EXTERNAL_TESTS === 'skip';

if (!skipExternalTests) {
	const missingCredentials = ['CODEX_API_KEY', 'ANTHROPIC_API_KEY'].filter(
		name => !process.env[name],
	);
	if (missingCredentials.length) {
		throw new Error(
			`External provider tests require credentials: ${missingCredentials.join(', ')}. Set EXTERNAL_TESTS=skip only for an intentional local opt-out.`,
		);
	}
}

describe.skipIf(skipExternalTests)('CodexAgent external', () => {
	it('completes a real provider turn and reports usage', async () => {
		const response = await new CodexAgent({
			sdk: new Codex(),
			model: 'gpt-5.6-sol',
		}).run(prompt, new AbortController().signal, () => undefined);

		expect(response?.response).toBeTruthy();
		expect(response?.inputTokens).toBeGreaterThan(0);
		expect(response?.outputTokens).toBeGreaterThan(0);
		expect(response?.duration).toBeGreaterThanOrEqual(0);
	}, 120_000);
});

describe.skipIf(skipExternalTests)('ClaudeAgent external', () => {
	it('completes a real provider turn and reports usage', async () => {
		const response = await new ClaudeAgent('haiku').run(
			prompt,
			new AbortController().signal,
			() => undefined,
		);

		expect(response?.response).toBeTruthy();
		expect(response?.inputTokens).toBeGreaterThan(0);
		expect(response?.outputTokens).toBeGreaterThan(0);
		expect(response?.duration).toBeGreaterThanOrEqual(0);
	}, 120_000);
});
