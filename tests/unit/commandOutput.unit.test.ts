import { describe, expect, it } from 'vitest';
import { normalizedLine, OutputFingerprint } from '../../src/tools/infrastructure/commandOutput.ts';

function fingerprint(...chunks: ['stdout' | 'stderr', string][]): string {
	const output = new OutputFingerprint();
	for (const [stream, text] of chunks) output.push(stream, Buffer.from(text));
	return output.digest();
}

describe('normalizedLine', () => {
	it.each([
		[' Start at  10:12:53', ' Start at  <time>'],
		[
			'   Duration  1.65s (transform 1.2s, setup 0ms)',
			'   Duration  <time> (transform <time>, setup <time>)',
		],
		['Time:        1.234 s, estimated 2 s', 'Time:        <time>, estimated <time>'],
		[' ✓ |unit| tests/a.test.ts (5 tests) 12ms', ' ✓ |unit| tests/a.test.ts (5 tests) <time>'],
		['   × waits 1s 312ms', '   × waits 1s <time>'],
		['PASS src/a.test.ts (5.1 s)', 'PASS src/a.test.ts <time>'],
		['  ✓ adds (5 ms)', '  ✓ adds <time>'],
		['--- FAIL: TestA (0.00s)', '--- FAIL: TestA <time>'],
		['  5 passing (12ms)', '  5 passing (<time>)'],
		['# duration_ms 12.345', '# duration_ms <time>'],
		['==== 5 passed in 0.12s ====', '==== 5 passed in <time> ===='],
		['Done in 1.2s.', 'Done in <time>.'],
		['[10:12:53 AM] Starting compilation', '<time> Starting compilation'],
		['src/a.ts 12ms (unchanged)', 'src/a.ts <time> (unchanged)'],
		['\u001b[31m×\u001b[0m fails 4ms', '× fails <time>'],
	])('takes the time out of %j', (line, expected) => {
		expect(normalizedLine(line)).toBe(expected);
	});

	it.each([
		'AssertionError: expected timeout to equal 1s, received 2s',
		'expected 1s, received 2s',
		'   ✓ waits 2s before retrying',
		'src/a.ts:12:34 - error TS2322',
		'Error at 10:12:53: connection refused',
	])('keeps the times of %j', line => {
		expect(normalizedLine(line)).toBe(line);
	});
});

describe('OutputFingerprint', () => {
	it('gives the same hash however the output was cut into chunks', () => {
		expect(fingerprint(['stdout', 'one\ntw'], ['stdout', 'o\n'])).toBe(
			fingerprint(['stdout', 'one\ntwo\n']),
		);
	});

	it('reads a character cut between chunks as one', () => {
		const bytes = Buffer.from('✓ ok\n');
		const split = new OutputFingerprint();
		split.push('stdout', bytes.subarray(0, 1));
		split.push('stdout', bytes.subarray(1));
		expect(split.digest()).toBe(fingerprint(['stdout', '✓ ok\n']));
	});

	it('keeps standard output and error apart, so their order between them does not count', () => {
		expect(fingerprint(['stdout', 'a\n'], ['stderr', 'b\n'])).toBe(
			fingerprint(['stderr', 'b\n'], ['stdout', 'a\n']),
		);
		expect(fingerprint(['stdout', 'a\n'])).not.toBe(fingerprint(['stderr', 'a\n']));
	});

	it('tells apart outputs that differ anywhere, and not in the times of a runner', () => {
		const run = (first: string, time: string) =>
			fingerprint(['stdout', `${first}\n${'x'.repeat(100_000)}\n Duration  ${time}\n`]);
		expect(run('a.ts failed', '1.2s')).toBe(run('a.ts failed', '3.4s'));
		expect(run('a.ts failed', '1.2s')).not.toBe(run('b.ts failed', '1.2s'));
	});

	it('hashes a long colored or timed line the same, whole or in chunks', () => {
		const lines = [
			`\u001b[31m×\u001b[0m ${'y'.repeat(70_000)} 12ms\n`,
			`   Duration  ${'z'.repeat(70_000)} 1.2s\r\n`,
		];
		for (const line of lines) {
			const whole = fingerprint(['stdout', `a\n${line}b\n`]);
			expect(
				fingerprint(
					['stdout', `a\n${line.slice(0, 66_000)}`],
					['stdout', `${line.slice(66_000)}b\n`],
				),
			).toBe(whole);
			expect(
				fingerprint(
					['stdout', `a\n${line.slice(0, 30_000)}`],
					['stdout', line.slice(30_000, 69_000)],
					['stdout', line.slice(69_000)],
					['stdout', 'b\n'],
				),
			).toBe(whole);
		}
		// Without a final newline too.
		const last = `${'w'.repeat(70_000)} 3s`;
		expect(fingerprint(['stdout', last.slice(0, 66_000)], ['stdout', last.slice(66_000)])).toBe(
			fingerprint(['stdout', last]),
		);
	});

	it('hashes a line longer than it keeps in pieces, the same however it arrived', () => {
		const long = 'y'.repeat(200_000);
		expect(fingerprint(['stdout', long.slice(0, 70_000)], ['stdout', long.slice(70_000)])).toBe(
			fingerprint(['stdout', long]),
		);
		expect(fingerprint(['stdout', long])).not.toBe(fingerprint(['stdout', `${long}z`]));
	});
});
