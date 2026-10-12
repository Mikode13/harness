import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidToolInputError } from '../../src/tools/domain/tool.ts';
import { definePreparingTool, defineTool } from '../../src/tools/infrastructure/defineTool.ts';
import { validatedSummarizer } from '../../src/tools/infrastructure/validatedSummarizer.ts';

const input = z.object({ city: z.string(), unit: z.enum(['c', 'f']).nullable() });
const prettified = '✖ Invalid input: expected string, received number\n  → at city';

describe('validatedSummarizer', () => {
	it('gives the summarizer the parsed input, not the raw value', () => {
		const trimmed = z.object({ city: z.string().transform(city => city.trim()) });
		const summarize = vi.fn(({ city }: { city: string }) => `weather in ${city}`);

		expect(validatedSummarizer(trimmed, summarize)({ city: ' Madrid ' })).toBe('weather in Madrid');
		expect(summarize).toHaveBeenCalledWith({ city: 'Madrid' });
	});

	it('refuses invalid input with the prettified InvalidToolInputError, before summarizing', () => {
		const summarize = vi.fn(() => 'unreachable');
		const summary = validatedSummarizer(input, summarize);

		expect(() => summary({ city: 42, unit: null })).toThrow(InvalidToolInputError);
		expect(() => summary({ city: 42, unit: null })).toThrow(prettified);
		expect(summarize).not.toHaveBeenCalled();
	});
});

// The native edit tools are covered in nativeEditFormats.unit.test.ts.
describe('tools that summarize their input', () => {
	const summarize = ({ city }: { city: string }) => city;

	it.each([
		[
			'defineTool',
			defineTool({
				name: 'weather',
				description: 'Weather in a city.',
				input,
				risk: 'safe',
				summarize,
				execute: () => Promise.resolve('sunny'),
			}),
		],
		[
			'definePreparingTool',
			definePreparingTool({
				name: 'weather',
				description: 'Weather in a city.',
				input,
				summarize,
				prepare: () => Promise.reject(new Error('not called')),
			}),
		],
	])('%s validates through it', (_, tool) => {
		expect(tool.summarize?.({ city: 'Madrid', unit: null })).toBe('Madrid');
		expect(() => tool.summarize?.({ city: 42, unit: null })).toThrow(InvalidToolInputError);
		expect(() => tool.summarize?.({ city: 42, unit: null })).toThrow(prettified);
	});
});
