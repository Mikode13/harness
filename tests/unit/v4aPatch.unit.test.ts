import { describe, expect, it } from 'vitest';
import { applyUpdate, createdContent } from '../../src/tools/domain/v4aPatch.ts';

const greet = [
	'export function greet(name: string): string {',
	"\treturn 'Hello, ' + name;",
	'}',
	'',
	"export const defaultName = 'world';",
	'',
].join('\n');

// What gpt-5.6-luna sent for this file in examples/edit-tools-wire-smoke.ts.
const rename = [
	'@@',
	'-export function greet(name: string): string {',
	"-\treturn 'Hello, ' + name;",
	'+export function welcome(name: string): string {',
	'+\treturn `Hello, ${name}`;',
	' }',
	'',
].join('\n');

const lines = (count: number) =>
	`${Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`).join('\n')}\n`;

describe('applying a V4A update', () => {
	it('applies a hunk the model sent', () => {
		expect(applyUpdate(greet, rename, 'src/greet.ts')).toBe(
			[
				'export function welcome(name: string): string {',
				'\treturn `Hello, ${name}`;',
				'}',
				'',
				"export const defaultName = 'world';",
				'',
			].join('\n'),
		);
	});

	it('applies several hunks in order, each after the one before', () => {
		const diff = [
			'@@',
			' line 2',
			'-line 3',
			'+LINE 3',
			'@@',
			' line 8',
			'-line 9',
			'+LINE 9',
		].join('\n');

		expect(applyUpdate(lines(10), diff, 'a.txt')).toBe(
			lines(10).replace('line 3\n', 'LINE 3\n').replace('line 9\n', 'LINE 9\n'),
		);
	});

	it('finds a change after the line its @@ names, when the same lines appear twice', () => {
		const text = [
			'function a() {',
			'\treturn 1;',
			'}',
			'function b() {',
			'\treturn 1;',
			'}',
			'',
		].join('\n');
		const diff = ['@@ function b() {', '-\treturn 1;', '+\treturn 2;'].join('\n');

		expect(applyUpdate(text, diff, 'a.ts')).toBe(text.replace(/return 1;\n}\n$/, 'return 2;\n}\n'));
	});

	describe('when the same lines appear after the anchor', () => {
		const classes = ['A', 'B', 'C']
			.flatMap(name => [`class ${name}:`, '    def __init__(self):', '        self.x = 1', ''])
			.join('\n');
		const inB = (text: string) => {
			const lines = classes.split('\n');
			lines[6] = text;
			return lines.join('\n');
		};

		it('finds the change after nested anchors, at the first match', () => {
			const diff = [
				'@@ class B:',
				'@@     def __init__(self):',
				'-        self.x = 1',
				'+        self.x = 2',
			];

			expect(applyUpdate(classes, diff.join('\n'), 'a.py')).toBe(inB('        self.x = 2'));
		});

		it('finds the change at the first match after one anchor', () => {
			const diff = [
				'@@ class B:',
				'     def __init__(self):',
				'-        self.x = 1',
				'+        self.x = 2',
			];

			expect(applyUpdate(classes, diff.join('\n'), 'a.py')).toBe(inB('        self.x = 2'));
		});

		it('refuses a first anchor that appears more than once, and says to name what holds it', () => {
			expect(() =>
				applyUpdate(
					classes,
					'@@     def __init__(self):\n-        self.x = 1\n+        self.x = 2',
					'a.py',
				),
			).toThrow(
				'Hunk 1 of the patch for "a.py" names "@@ def __init__(self):", which appears 3 times; name a line that appears once, or put an "@@" line before it naming what holds it',
			);
		});
	});

	it('writes every line it does not change back with its own ending, in a file that mixes them', () => {
		expect(applyUpdate('a\nb\r\nc\nd\n', '@@\n-a\n+A', 'a.txt')).toBe('A\nb\r\nc\nd\n');
		// An added line ends like the line before it.
		expect(applyUpdate('a\nb\r\nc\n', '@@\n b\n+added\n c', 'a.txt')).toBe('a\nb\r\nadded\r\nc\n');
	});

	it("gives a line that takes a removed one's place that line's ending", () => {
		expect(applyUpdate('x\na\r\nb\n', '@@\n-a\n+A', 'a.txt')).toBe('x\nA\r\nb\n');
		expect(applyUpdate('x\na\r\nb\n', '@@\n-a\n+A\n+A2', 'a.txt')).toBe('x\nA\r\nA2\r\nb\n');
	});

	it('refuses lines after *** End of File', () => {
		expect(() => applyUpdate('a\n', '@@\n-a\n+b\n*** End of File\n+c', 'a.txt')).toThrow(
			'Line 5 of the patch for "a.txt" follows "*** End of File", which ends its hunk; start another hunk with "@@"',
		);
	});

	it('applies lines that appear twice without an anchor at their first match, as Codex does', () => {
		const text = ['a', 'same', 'b', 'same', ''].join('\n');

		expect(applyUpdate(text, '@@\n-same\n+other', 'a.txt')).toBe(
			['a', 'other', 'b', 'same', ''].join('\n'),
		);
	});

	it('tells two alike places apart by the order of the hunks', () => {
		// What gpt-5.6-luna sends: the same closing lines once for each block, in the file's order.
		const text = ['{', '\tfirst,', '},', '{', '\tsecond,', '},', ''].join('\n');
		const diff = [
			'@@',
			' \tfirst,',
			'-},',
			'+} satisfies A,',
			'@@',
			' \tsecond,',
			'-},',
			'+} satisfies B,',
		];

		expect(applyUpdate(text, diff.join('\n'), 'a.ts')).toBe(
			['{', '\tfirst,', '} satisfies A,', '{', '\tsecond,', '} satisfies B,', ''].join('\n'),
		);
	});

	it('says what a hunk expected, and what the file has near it', () => {
		expect(() =>
			applyUpdate(
				greet,
				['@@', " \treturn 'Hi, ' + name;", '-}', '+};'].join('\n'),
				'src/greet.ts',
			),
		).toThrow(
			[
				'Hunk 1 of the patch for "src/greet.ts" does not match the file. It expected:',
				"  \treturn 'Hi, ' + name;",
				'  }',
			].join('\n'),
		);
		expect(() =>
			applyUpdate(
				greet,
				['@@', ' export function greet(name: string): string {', "-\treturn 'Hi';", '+x'].join(
					'\n',
				),
				'src/greet.ts',
			),
		).toThrow(/The file has, near line 1:\n {2}1: export function greet/);
	});

	it('shows the lines most like a hunk whose first line the file does not have', () => {
		const diff = [
			'@@',
			' export function hello(name: string): string {',
			"-\treturn 'Hello, ' + name;",
			'+x',
			' }',
		];

		expect(() => applyUpdate(greet, diff.join('\n'), 'src/greet.ts')).toThrow(
			[
				'The file has, near line 2:',
				'  1: export function greet(name: string): string {',
				"  2: \treturn 'Hello, ' + name;",
				'  3: }',
				'  4: ',
			].join('\n'),
		);
	});

	it('shows the lines after the hunk before, when the file has them twice', () => {
		const text = ['a', 'b', 'c', 'a', 'b', 'c', ''].join('\n');
		const diff = ['@@', '-a', '+A', '@@', ' b', '-x', '+y'];

		expect(() => applyUpdate(text, diff.join('\n'), 'a.txt')).toThrow(
			/The file has, near line 2:\n {2}1: A\n {2}2: b\n {2}3: c$/,
		);
	});

	it('says when the lines most like a hunk come before the hunk before it', () => {
		const diff = ['@@', '-line 8', '+LINE 8', '@@', ' line 2', '-line 3', '+LINE 3'];

		expect(() => applyUpdate(lines(10), diff.join('\n'), 'a.txt')).toThrow(
			[
				'The file has, near line 2:',
				'  1: line 1',
				'  2: line 2',
				'  3: line 3',
				'  4: line 4',
				'Those lines come before where the hunk was looked for: each hunk is found after the one before it, and after its "@@" lines.',
			].join('\n'),
		);
	});

	it("forgives trailing spaces the model lost, and keeps the file's CRLF endings", () => {
		const text = 'a  \r\nb\r\nc\r\n';

		expect(applyUpdate(text, '@@\n a\n-b\n+B', 'a.txt')).toBe('a  \r\nB\r\nc\r\n');
	});

	it('keeps a missing final newline missing', () => {
		expect(applyUpdate('a\nb', '@@\n a\n-b\n+B', 'a.txt')).toBe('a\nB');
	});

	it('puts a change at the end of the file when it says so', () => {
		const text = ['x', 'end', 'y', 'end', ''].join('\n');

		expect(applyUpdate(text, '@@\n-end\n+END\n*** End of File', 'a.txt')).toBe(
			['x', 'end', 'y', 'END', ''].join('\n'),
		);
	});

	it('adds lines with no context after their anchor, or at the end', () => {
		expect(applyUpdate('a\nb\n', '@@ a\n+inserted', 'a.txt')).toBe('a\ninserted\nb\n');
		expect(applyUpdate('a\nb\n', '@@\n+last', 'a.txt')).toBe('a\nb\nlast\n');
	});

	it('refuses an anchor that is not in the file', () => {
		expect(() => applyUpdate('a\n', '@@ missing\n-a\n+b', 'a.txt')).toThrow(
			'Hunk 1 of the patch for "a.txt" names "@@ missing", which is not in the file after the hunks before it',
		);
	});

	it('refuses a line it cannot read, a patch that changes nothing, and one too large', () => {
		expect(() => applyUpdate('a\n', '@@\n*a', 'a.txt')).toThrow(/starts with "\*"/);
		expect(() => applyUpdate('a\n', '@@\n a', 'a.txt')).toThrow(
			'The patch for "a.txt" changes nothing',
		);
		expect(() => applyUpdate('a\n', `@@\n-a\n+${'x'.repeat(600 * 1024)}`, 'a.txt')).toThrow(
			/larger than 512 KB/,
		);
	});
});

describe('the content a V4A create makes', () => {
	it('is every added line, ending with a newline', () => {
		expect(createdContent('+# Greeting\n+\n+Says hello.\n', 'docs/greet.md')).toBe(
			'# Greeting\n\nSays hello.\n',
		);
	});

	it('refuses a line that is not added', () => {
		expect(() => createdContent('+a\nb', 'a.txt')).toThrow(
			'Line 2 of the patch creating "a.txt" does not start with "+"; every line of a new file does',
		);
	});
});
