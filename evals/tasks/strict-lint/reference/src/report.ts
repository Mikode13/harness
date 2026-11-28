import { CsvError, parseCsv } from './csv.ts';

export interface RegionSummary {
	region: string;
	total: number;
	count: number;
}

/** Each region's total and count, largest total first, then by region name. */
export function summarize(csv: string): RegionSummary[] {
	const rows = parseCsv(csv);
	const byRegion = new Map<string, RegionSummary>();
	rows.forEach((row, index) => {
		const raw = row.amount ?? '';
		const amount = Number(raw);
		if (raw.trim() === '' || Number.isNaN(amount)) {
			throw new CsvError(`"${raw}" is not an amount`, index + 2);
		}
		const region = (row.region ?? '').trim();
		let summary = byRegion.get(region);
		if (summary === undefined) {
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
export function renderReport(summaries: readonly RegionSummary[]): string {
	return summaries
		.map(
			summary => `${summary.region}: ${summary.total.toFixed(2)} (${String(summary.count)} sales)`,
		)
		.join('\n');
}

/** Writes the report of `csv` with `write`, which may be slow, and resolves once it is written. */
export async function writeReport(
	csv: string,
	write: (text: string) => Promise<void>,
): Promise<string> {
	const text = renderReport(summarize(csv));
	await write(text);
	return text;
}
