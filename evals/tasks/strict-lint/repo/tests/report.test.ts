import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, splitLine } from '../src/csv.ts';
import { renderReport, summarize, writeReport } from '../src/report.ts';

const csv = [
	'date,region,amount,note',
	'2026-01-02,North,10.50,',
	'2026-01-03,South,4,"big, early"',
	'',
	'2026-01-04,North,2,"said ""hi"""',
].join('\n');

describe('the CSV', () => {
	it('splits quoted fields, commas and doubled quotes included', () => {
		expect(splitLine('a,"b, c","d ""e"""', 1)).toEqual(['a', 'b, c', 'd "e"']);
	});

	it('reads rows by column, skipping blank lines', () => {
		expect(parseCsv(csv)).toHaveLength(3);
		expect(parseCsv(csv)[1]).toMatchObject({ region: 'South', note: 'big, early' });
	});

	it('refuses a line with the wrong number of fields, naming it', () => {
		expect(() => parseCsv('a,b\n1,2\n3')).toThrow(new CsvError('expected 2 fields, got 1', 3));
	});
});

describe('the report', () => {
	it('sums each region, largest first', () => {
		expect(summarize(csv)).toEqual([
			{ region: 'North', total: 12.5, count: 2 },
			{ region: 'South', total: 4, count: 1 },
		]);
	});

	it('renders one line per region', () => {
		expect(renderReport(summarize(csv))).toBe('North: 12.50 (2 sales)\nSouth: 4.00 (1 sales)');
	});

	it('writes the report', async () => {
		const written: string[] = [];
		await writeReport(csv, async text => {
			written.push(text);
		});
		expect(written).toHaveLength(1);
	});
});
