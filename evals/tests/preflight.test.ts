import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { problemsWith, providersOf } from '../lib/preflight.ts';

// The SDKs are faked: the check never reaches a provider here.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const listing = (answer: () => Promise<unknown>) => ({ models: { list: vi.fn(answer) } });

describe('providersOf', () => {
	it("names the roles' providers and the judges'", () => {
		expect(providersOf({ profile: 'default', path: 'workflow' }, ['opus', 'astra'])).toEqual([
			'anthropic',
			'openai',
		]);
		expect(providersOf({ profile: 'openai', path: 'workflow' }, [])).toEqual(['openai']);
		expect(providersOf({ profile: 'default', path: 'agent' }, [])).toEqual(['openai']);
		expect(providersOf({ profile: 'openai', path: 'workflow' }, ['opus'])).toEqual([
			'anthropic',
			'openai',
		]);
	});
});

describe('problemsWith', () => {
	const saved = { ...process.env };

	beforeEach(() => {
		process.env.OPENAI_API_KEY = 'sk-proj-new-key-1234';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-key-5678';
	});

	afterEach(() => {
		process.env = { ...saved };
		vi.clearAllMocks();
	});

	it('finds nothing when every provider lists its models', async () => {
		vi.mocked(OpenAI).mockImplementation(function () {
			return listing(() => Promise.resolve({ data: [] })) as unknown as OpenAI;
		});
		vi.mocked(Anthropic).mockImplementation(function () {
			return listing(() => Promise.resolve({ data: [] })) as unknown as Anthropic;
		});

		expect(await problemsWith(['anthropic', 'openai'])).toEqual([]);
	});

	it('names a key that is missing, and one the provider refuses, by how it ends', async () => {
		delete process.env.ANTHROPIC_API_KEY;
		vi.mocked(OpenAI).mockImplementation(function () {
			return listing(() =>
				Promise.reject(new Error('401 Incorrect API key provided')),
			) as unknown as OpenAI;
		});

		const problems = await problemsWith(['anthropic', 'openai']);

		expect(problems).toHaveLength(2);
		expect(problems[0]).toBe('ANTHROPIC_API_KEY is not set in this shell');
		expect(problems[1]).toContain('"1234"');
		expect(problems[1]).toContain('401 Incorrect API key provided');
	});
});
