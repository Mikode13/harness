import { describe, expect, it } from 'vitest';
import { InvalidDurationError } from '../../src/errors.ts';
import { formatDuration } from '../../src/format.ts';
import { parseDuration } from '../../src/parse.ts';

describe('the reported bug', () => {
	it.each([
		['250ms', 250],
		['1s500ms', 1500],
		['2m5s250ms', 125_250],
		['1h 30m 15s 5ms', 5_415_005],
		['0.5ms', 1],
	])('reads %s', (text, expected) => {
		expect(parseDuration(text)).toBe(expected);
	});

	it.each([0, 1, 999, 1250, 61_001, 90_061_001])('reads back formatDuration(%d)', milliseconds => {
		expect(parseDuration(formatDuration(milliseconds))).toBe(milliseconds);
	});
});

describe('everything else, unchanged', () => {
	it.each([
		['1m', 60_000],
		['1h30m', 5_400_000],
		['1.5h', 5_400_000],
		['2d', 172_800_000],
	])('reads %s', (text, expected) => {
		expect(parseDuration(text)).toBe(expected);
	});

	it.each(['', '30', '1x', 'h1', '30m1h', '1ms1s', '5m5m', '1mss'])('refuses %j', text => {
		expect(() => parseDuration(text)).toThrow(InvalidDurationError);
	});
});
