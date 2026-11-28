import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, splitLine } from '../../src/csv.ts';
import { renderReport, summarize, writeReport } from '../../src/report.ts';

// The behavior as it was before the types and the lint were fixed, which must not change.

describe('splitLine', () => {
	it.each([
		['a,b,c', ['a', 'b', 'c']],
		['a,,c', ['a', '', 'c']],
		['"a,b",c', ['a,b', 'c']],
		['"say ""hi""",x', ['say "hi"', 'x']],
		['', ['']],
		['a,', ['a', '']],
	])('splits %j', (line, fields) => {
		expect(splitLine(line, 1)).toEqual(fields);
	});

	it('refuses an unclosed quote, with its line', () => {
		expect(() => splitLine('"open', 7)).toThrow(new CsvError('a quoted field is not closed', 7));
	});
});

describe('parseCsv', () => {
	it('keys rows by the header and skips blank lines, CRLF included', () => {
		expect(parseCsv('x,y\r\n1,2\r\n\r\n3,4')).toEqual([
			{ x: '1', y: '2' },
			{ x: '3', y: '4' },
		]);
	});

	it('names the line of a row with too many fields', () => {
		const run = () => parseCsv('a,b\n1,2\n\n1,2,3');
		expect(run).toThrow(CsvError);
		expect(run).toThrow('Line 4: expected 2 fields, got 3');
	});

	it('reads a header alone as no rows', () => {
		expect(parseCsv('a,b')).toEqual([]);
	});
});

describe('summarize', () => {
	const csv = 'date,region,amount,note\nd,East,1.25,\nd, West ,3,\nd,East,1.75,\nd,Alpha,3,';

	it('sums by trimmed region, largest total first, ties by name', () => {
		expect(summarize(csv)).toEqual([
			{ region: 'Alpha', total: 3, count: 1 },
			{ region: 'East', total: 3, count: 2 },
			{ region: 'West', total: 3, count: 1 },
		]);
	});

	it.each(['abc', '', ' '])('refuses the amount %j with its line', amount => {
		const run = () => summarize(`date,region,amount,note\nd,East,1,\nd,East,${amount},`);
		expect(run).toThrow(CsvError);
		expect(run).toThrow(/^Line 3: /);
	});
});

describe('the rendered report', () => {
	it('writes two decimals and the count', () => {
		expect(renderReport([{ region: 'North', total: 1.005, count: 3 }])).toBe(
			'North: 1.00 (3 sales)',
		);
		expect(renderReport([])).toBe('');
	});

	it('resolves only once the write is done, with the text', async () => {
		let done = false;
		const text = await writeReport('date,region,amount,note\nd,N,1,', async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			done = true;
		});
		expect(done).toBe(true);
		expect(text).toBe('N: 1.00 (1 sales)');
	});
});
