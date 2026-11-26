/** Thrown for a CSV line that cannot be read, with its line number from 1. */
export class CsvError extends Error {
	override name = 'CsvError';
	readonly line: number;

	constructor(message: string, line: number) {
		super(`Line ${String(line)}: ${message}`);
		this.line = line;
	}
}

export type Row = Record<string, string>;

/** The fields of one CSV line: quoted fields may hold commas and doubled quotes. */
export function splitLine(line: string, lineNumber: number): string[] {
	const fields: string[] = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const char = line.charAt(index);
		if (quoted) {
			if (char === '"' && line.charAt(index + 1) === '"') {
				field += '"';
				index++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			fields.push(field);
			field = '';
		} else {
			field += char;
		}
	}
	if (quoted) throw new CsvError('a quoted field is not closed', lineNumber);
	fields.push(field);
	return fields;
}

/** The rows of a CSV text, keyed by the header's columns. Blank lines are skipped. */
export function parseCsv(text: string): Row[] {
	const [first = '', ...lines] = text.split(/\r?\n/u);
	const header = splitLine(first, 1);
	const rows: Row[] = [];
	lines.forEach((line, index) => {
		if (line.trim() === '') return;
		const fields = splitLine(line, index + 2);
		if (fields.length !== header.length) {
			throw new CsvError(
				`expected ${String(header.length)} fields, got ${String(fields.length)}`,
				index + 2,
			);
		}
		const row: Row = {};
		header.forEach((column, at) => {
			row[column] = fields[at] ?? '';
		});
		rows.push(row);
	});
	return rows;
}
