import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/format.ts';

describe('formatDuration', () => {
	it.each([
		[5_400_000, '1h30m'],
		[0, '0ms'],
		[1250, '1s250ms'],
		[90_061_001, '1d1h1m1s1ms'],
	])('formats %d as %s', (milliseconds, expected) => {
		expect(formatDuration(milliseconds)).toBe(expected);
	});

	it('refuses a negative duration', () => {
		expect(() => formatDuration(-1)).toThrow(RangeError);
	});
});
