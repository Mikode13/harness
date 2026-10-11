import { describe, expect, it } from 'vitest';
import { cutLine, maxLineLength } from '../../src/tools/domain/lineLength.ts';

describe('maxLineLength', () => {
	it.each([
		['docs/architecture.md', 5000],
		['README.MD', 5000],
		['notes.txt', 5000],
		['guide.mdx', 5000],
		['src/index.ts', 300],
		['dist/bundle.min.js', 300],
		['data.json', 300],
		// A dotfile has no extension: `.md` is a name, not Markdown.
		['.md', 300],
		['docs.md/readme', 300],
	])('lets a line of %s be %d characters', (path, max) => {
		expect(maxLineLength(path)).toBe(max);
	});
});

describe('cutLine', () => {
	it('keeps a long Markdown line whole, and cuts the same line in code', () => {
		const row = `| ${'x'.repeat(3200)} |`;

		expect(cutLine('docs/architecture.md', row)).toBe(row);
		expect(cutLine('src/a.ts', row)).toBe(`${row.slice(0, 300)}…`);
	});

	it('still cuts a prose line past its limit', () => {
		expect(cutLine('notes.txt', 'y'.repeat(6000))).toBe(`${'y'.repeat(5000)}…`);
	});
});
