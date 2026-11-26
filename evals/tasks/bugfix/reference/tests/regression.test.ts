import { expect, it } from 'vitest';
import { formatDuration } from '../src/format.ts';
import { parseDuration } from '../src/parse.ts';

it.each([
	['250ms', 250],
	['1s500ms', 1500],
	['1m', 60_000],
])('reads %s, milliseconds before minutes', (text, expected) => {
	expect(parseDuration(text)).toBe(expected);
});

it('reads back what formatDuration writes', () => {
	expect(parseDuration(formatDuration(1250))).toBe(1250);
});
