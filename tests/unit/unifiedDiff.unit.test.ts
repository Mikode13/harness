import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/diff/domain/unifiedDiff.ts';

/** Applies `patch` to `before` the way `patch` would, trusting its line numbers. */
function apply(before: string, patch: string): string {
	const source = before === '' ? [] : before.split(/(?<=\n)/);
	const result: string[] = [];
	let next = 0;
	const patchLines = patch.split('\n');

	for (let index = 0; index < patchLines.length; index++) {
		const line = patchLines[index] ?? '';
		const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(line);
		if (header) {
			const start = Number(header[1]);
			const count = header[2] === undefined ? 1 : Number(header[2]);
			const firstLine = count === 0 ? start : start - 1;
			result.push(...source.slice(next, firstLine));
			next = firstLine;
			continue;
		}
		const ending = patchLines[index + 1] === '\\ No newline at end of file' ? '' : '\n';
		if (line.startsWith('\\')) continue;
		if (line.startsWith(' ')) {
			result.push(line.slice(1) + ending);
			next++;
		} else if (line.startsWith('-')) {
			next++;
		} else if (line.startsWith('+')) {
			result.push(line.slice(1) + ending);
		}
	}
	return [...result, ...source.slice(next)].join('');
}

/** The fewest removed plus added lines that turn `a` into `b`. */
function minimalEdits(a: string[], b: string[]): number {
	const common = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = common[i] ?? [];
			row[j] =
				a[i] === b[j]
					? (common[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(common[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	return a.length + b.length - 2 * (common[0]?.[0] ?? 0);
}

function changedLines(patch: string): number {
	return patch.split('\n').filter(line => /^[-+]/.test(line)).length;
}

describe('unifiedDiff', () => {
	it('is empty for equal texts', () => {
		expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
		expect(unifiedDiff('', '')).toBe('');
	});

	it('shows a changed line with three lines of context, as git does', () => {
		const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
		const after = '1\n2\n3\n4\nfive\n6\n7\n8\n9\n';

		expect(unifiedDiff(before, after)).toBe(
			['@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'].join('\n'),
		);
	});

	it('shows a whole new file and a whole removed one', () => {
		expect(unifiedDiff('', 'a\nb\n')).toBe(['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'));
		expect(unifiedDiff('a\n', '')).toBe(['@@ -1 +0,0 @@', '-a'].join('\n'));
	});

	it('names the line before an insertion that removes nothing', () => {
		expect(unifiedDiff('a\nb\n', 'a\nnew\nb\n', { context: 0 })).toBe(
			['@@ -1,0 +2 @@', '+new'].join('\n'),
		);
	});

	it('joins changes whose context overlaps and splits the ones that do not', () => {
		const before = Array.from({ length: 30 }, (_, index) => `${String(index)}\n`).join('');
		const after = before.replace('2\n', 'two\n').replace('5\n', 'five\n').replace('25\n', 'x\n');

		const headers = unifiedDiff(before, after)
			.split('\n')
			.filter(line => line.startsWith('@@'));
		expect(headers).toEqual(['@@ -1,9 +1,9 @@', '@@ -23,7 +23,7 @@']);
	});

	it('marks a last line that has no newline, on either side', () => {
		expect(unifiedDiff('a\nb', 'a\nb\n')).toBe(
			['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b'].join('\n'),
		);
		expect(unifiedDiff('a\n', 'a')).toBe(
			['@@ -1 +1 @@', '-a', '+a', '\\ No newline at end of file'].join('\n'),
		);
	});

	it('keeps a carriage return as part of its line', () => {
		expect(unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n', { context: 0 })).toBe(
			['@@ -2 +2 @@', '-b\r', '+c\r'].join('\n'),
		);
	});

	it('shows the differing middle as removed, then added, beyond the distance it searches', () => {
		const patch = unifiedDiff('a\nx\ny\nb\n', 'a\np\nx\nq\nb\n', { context: 0, maxDistance: 1 });

		expect(patch).toBe(['@@ -2,2 +2,3 @@', '-x', '-y', '+p', '+x', '+q'].join('\n'));
		expect(apply('a\nx\ny\nb\n', patch)).toBe('a\np\nx\nq\nb\n');
	});

	it('finds the smallest change, and its patch rebuilds the new text', () => {
		// A fixed seed, so a failure can be replayed.
		let seed = 52;
		const random = (below: number): number => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			// The high bits: an LCG's low bits repeat with a short period.
			return Math.floor(seed / 2 ** 16) % below;
		};
		const text = (): string => {
			const count = random(12);
			const words = Array.from({ length: count }, () => 'abcd'[random(4)] ?? 'a');
			return words.map(word => `${word}\n`).join('') + (random(4) === 0 ? 'end' : '');
		};

		for (let round = 0; round < 500; round++) {
			const before = text();
			const after = text();
			const patch = unifiedDiff(before, after, { context: random(4) });

			expect(apply(before, patch)).toBe(after);
			expect(changedLines(patch)).toBe(
				minimalEdits(
					before.split(/(?<=\n)/).filter(Boolean),
					after.split(/(?<=\n)/).filter(Boolean),
				),
			);
		}
	});
});
