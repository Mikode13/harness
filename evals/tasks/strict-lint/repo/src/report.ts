import { CsvError, parseCsv, Row } from './csv.ts';

export type RegionSummary = { region: string; total: number; count: number };

/** Each region's total and count, largest total first, then by region name. */
export function summarize(csv: string): RegionSummary[] {
	const rows = parseCsv(csv);
	const byRegion = new Map<string, RegionSummary>();
	rows.forEach((row: any, index) => {
		const amount = Number(row.amount);
		if (row.amount.trim() === '' || Number.isNaN(amount)) {
			throw new CsvError(`"${row.amount}" is not an amount`, index + 2);
		}
		const region = row.region.trim();
		let summary = byRegion.get(region);
		if (summary === undefined || summary === null) {
			summary = { region, total: 0, count: 0 };
			byRegion.set(region, summary);
		}
		summary.total += amount;
		summary.count++;
	});
	return [...byRegion.values()].sort(
		(a, b) => b.total - a.total || a.region.localeCompare(b.region),
	);
}

/** The summary as text, one line per region, totals with two decimals. */
export function renderReport(summaries: RegionSummary[]): string {
	const unused = summaries.length;
	return summaries
		.map(summary => `${summary.region}: ${summary.total.toFixed(2)} (${summary.count} sales)`)
		.join('\n');
}

/** Writes the report of `csv` with `write`, which may be slow. */
export async function writeReport(csv: string, write: (text: string) => Promise<void>) {
	const text = renderReport(summarize(csv));
	write(text);
	return text;
}
