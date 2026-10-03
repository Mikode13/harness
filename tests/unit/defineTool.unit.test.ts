import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import { defineTool } from '../../src/tools/infrastructure/defineTool.ts';

const signal = new AbortController().signal;

function weatherTool(execute = vi.fn(() => Promise.resolve('sunny'))) {
	const tool = defineTool({
		name: 'weather',
		description: 'Weather in a city.',
		input: z.object({ city: z.string(), unit: z.enum(['c', 'f']).nullable() }),
		risk: 'safe',
		execute,
	});
	return { tool, execute };
}

describe('defineTool', () => {
	// Both providers take tools in strict mode: every property required, nothing extra.
	it('describes its input once, as the strict JSON Schema the providers take', () => {
		const { tool } = weatherTool();

		expect(tool.name).toBe('weather');
		expect(tool.description).toBe('Weather in a city.');
		expect(tool.inputSchema).toEqual({
			type: 'object',
			properties: {
				city: { type: 'string' },
				unit: { anyOf: [{ type: 'string', enum: ['c', 'f'] }, { type: 'null' }] },
			},
			required: ['city', 'unit'],
			additionalProperties: false,
		});
	});

	// A schema a provider rejects would fail every request with a 400, so it fails here instead.
	it.each([
		['an optional field, which OpenAI rejects', z.object({ city: z.string().optional() })],
		['a numeric bound, which Claude rejects', z.object({ days: z.number().min(1) })],
		['a length bound, which Claude rejects', z.object({ city: z.string().max(20) })],
		[
			'an optional field inside a nested object',
			z.object({ place: z.object({ city: z.string().optional() }) }),
		],
		['an object open to any key, which strict mode rejects', z.looseObject({ city: z.string() })],
		[
			'a record, whose keys strict mode cannot know',
			z.object({ tags: z.record(z.string(), z.string()) }),
		],
	])('refuses to define a tool with %s', (_, input) => {
		expect(() =>
			defineTool({
				name: 'weather',
				description: '',
				input,
				risk: 'safe',
				execute: () => Promise.resolve(''),
			}),
		).toThrow(InvalidAgentConfigError);
	});

	// Only schemas are checked: these are the names of fields, not keywords.
	it('accepts fields named like the keywords it refuses', () => {
		expect(() =>
			defineTool({
				name: 'limits',
				description: '',
				input: z.object({ maxLength: z.number().nullable(), minimum: z.string() }),
				risk: 'safe',
				execute: () => Promise.resolve(''),
			}),
		).not.toThrow();
	});

	it('runs with the validated input and the signal it was given', async () => {
		const { tool, execute } = weatherTool();

		await expect(tool.execute({ city: 'Madrid', unit: null }, signal)).resolves.toBe('sunny');

		expect(execute).toHaveBeenCalledWith({ city: 'Madrid', unit: null }, signal);
	});

	// The rejection goes back to the model as an error result, so it must say what to fix.
	it.each([
		['a missing field', { unit: null }],
		['a field of the wrong type', { city: 42, unit: null }],
		['a value outside an enum', { city: 'Madrid', unit: 'kelvin' }],
		['arguments that never parsed', '{"city":'],
		['nothing', undefined],
	])('rejects %s without running, naming the problem', async (_, input) => {
		const { tool, execute } = weatherTool();

		await expect(tool.execute(input, signal)).rejects.toThrow(/city|unit|object/i);

		expect(execute).not.toHaveBeenCalled();
	});

	it('lets a failure of the tool itself through as it is', async () => {
		const failure = new Error('station offline');
		const { tool } = weatherTool(vi.fn(() => Promise.reject(failure)));

		await expect(tool.execute({ city: 'Oslo', unit: null }, signal)).rejects.toBe(failure);
	});

	it('judges every call with a fixed risk', () => {
		expect(weatherTool().tool.risk({ city: 'Madrid', unit: null })).toBe('safe');
	});

	it('judges each call from its validated input', () => {
		const judge = vi.fn((input: { path: string }) =>
			input.path === 'README.md' ? ('destructive' as const) : ('mutating' as const),
		);
		const tool = defineTool({
			name: 'write',
			description: '',
			input: z.object({ path: z.string() }),
			risk: judge,
			execute: () => Promise.resolve(''),
		});

		expect(tool.risk({ path: 'README.md' })).toBe('destructive');
		expect(tool.risk({ path: 'new.md' })).toBe('mutating');
	});

	// `execute` rejects such input before doing anything, so it cannot do harm.
	it('counts input that fails validation as safe, without judging it', () => {
		const judge = vi.fn(() => 'destructive' as const);
		const tool = defineTool({
			name: 'write',
			description: '',
			input: z.object({ path: z.string() }),
			risk: judge,
			execute: () => Promise.resolve(''),
		});

		expect(tool.risk({ path: 42 })).toBe('safe');
		expect(judge).not.toHaveBeenCalled();
	});
});
