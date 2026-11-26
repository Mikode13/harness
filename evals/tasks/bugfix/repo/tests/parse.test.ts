import { describe, expect, it } from 'vitest';
import { InvalidDurationError } from '../src/errors.ts';
import { parseDuration } from '../src/parse.ts';

describe('parseDuration', () => {
	it.each([
		['1h30m', 5_400_000],
		['1h 30m', 5_400_000],
		['2d', 172_800_000],
		['1.5h', 5_400_000],
		['45s', 45_000],
	])('reads %s', (text, expected) => {
		expect(parseDuration(text)).toBe(expected);
	});

	it.each(['', '30', '1x', 'h1', '30m1h'])('refuses %j', text => {
		expect(() => parseDuration(text)).toThrow(InvalidDurationError);
	});
});
