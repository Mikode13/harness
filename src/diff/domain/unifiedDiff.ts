/**
 * Line diffs in the unified format, with Myers' algorithm. This module imports nothing, so it can
 * move to a package of its own unchanged.
 */

export interface LineDiffOptions {
	/** Unchanged lines shown around each change. Defaults to 3, as in git. */
	context?: number;
	/**
	 * The most lines two texts may differ by before the diff stops looking for the smallest
	 * change and shows the differing middle as removed, then added. Memory grows with its square.
	 */
	maxDistance?: number;
}

interface Operation {
	kind: 'equal' | 'delete' | 'insert';
	line: string;
}

const noNewline = '\\ No newline at end of file';

/**
 * The hunks that turn `before` into `after`, each with its `@@` header, or `''` when the texts
 * are equal. Lines are compared whole, a `\r` included, and a last line without a newline
 * differs from the same line with one, as git shows it.
 */
export function unifiedDiff(before: string, after: string, options: LineDiffOptions = {}): string {
	const { context = 3, maxDistance = 1000 } = options;
	const operations = diffLines(lines(before), lines(after), maxDistance);
	return hunks(operations, context).join('\n');
}

/**
 * Each line keeps its newline, so the last line of a text that does not end in one compares
 * as different from the same line followed by a newline.
 */
function lines(text: string): string[] {
	if (text === '') return [];
	const parts = text.split('\n');
	const last = parts.pop() ?? '';
	const result = parts.map(part => `${part}\n`);
	if (last !== '') result.push(last);
	return result;
}

function diffLines(a: string[], b: string[], maxDistance: number): Operation[] {
	// The shared start and end need no search, and most edits leave most of a file alone.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const middle =
		shortestEdit(a.slice(start, endA), b.slice(start, endB), maxDistance) ??
		replaceAll(a.slice(start, endA), b.slice(start, endB));

	return [
		...a.slice(0, start).map(line => ({ kind: 'equal' as const, line })),
		...middle,
		...a.slice(endA).map(line => ({ kind: 'equal' as const, line })),
	];
}

function replaceAll(a: string[], b: string[]): Operation[] {
	return [
		...a.map(line => ({ kind: 'delete' as const, line })),
		...b.map(line => ({ kind: 'insert' as const, line })),
	];
}

/**
 * Myers' greedy search for the fewest deletions and insertions, or `undefined` when that number
 * exceeds `maxDistance`. After round `d`, `trace[d][k + d]` is the furthest point reached on
 * diagonal `k` (x − y) with `d` edits; walking back through the rounds recovers the edits.
 */
function shortestEdit(a: string[], b: string[], maxDistance: number): Operation[] | undefined {
	const n = a.length;
	const m = b.length;
	const limit = Math.min(n + m, maxDistance);
	const offset = limit + 1;
	const furthest = new Int32Array(2 * limit + 3);
	const trace: Int32Array[] = [];

	for (let d = 0; d <= limit; d++) {
		for (let k = -d; k <= d; k += 2) {
			// Down from diagonal k + 1 is an insertion, right from k − 1 a deletion.
			const down =
				k === -d || (k !== d && (furthest[offset + k - 1] ?? 0) < (furthest[offset + k + 1] ?? 0));
			let x = down ? (furthest[offset + k + 1] ?? 0) : (furthest[offset + k - 1] ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			furthest[offset + k] = x;
			if (x >= n && y >= m) {
				trace.push(furthest.slice(offset - d, offset + d + 1));
				return backtrack(a, b, trace);
			}
		}
		trace.push(furthest.slice(offset - d, offset + d + 1));
	}
	return undefined;
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): Operation[] {
	const operations: Operation[] = [];
	let x = a.length;
	let y = b.length;

	for (let d = trace.length - 1; d > 0; d--) {
		const previous = trace[d - 1] ?? new Int32Array();
		const at = (k: number): number => previous[k + d - 1] ?? 0;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const previousK = down ? k + 1 : k - 1;
		const previousX = at(previousK);
		const previousY = previousX - previousK;

		// The matching run that followed this round's one edit.
		while (x > previousX && y > previousY) {
			operations.push({ kind: 'equal', line: a[--x] ?? '' });
			y--;
		}
		if (down) operations.push({ kind: 'insert', line: b[--y] ?? '' });
		else operations.push({ kind: 'delete', line: a[--x] ?? '' });
	}
	while (x > 0 && y > 0) {
		operations.push({ kind: 'equal', line: a[--x] ?? '' });
		y--;
	}

	return operations.reverse();
}

/** Groups the changes, each with `context` lines around it, into `@@` hunks. */
function hunks(operations: Operation[], context: number): string[] {
	const output: string[] = [];
	const changed = operations.flatMap((operation, index) =>
		operation.kind === 'equal' ? [] : [index],
	);
	if (changed.length === 0) return output;

	// Line numbers before and after each operation, counted from 0.
	const positions: { a: number; b: number }[] = [];
	let a = 0;
	let b = 0;
	for (const operation of operations) {
		positions.push({ a, b });
		if (operation.kind !== 'insert') a++;
		if (operation.kind !== 'delete') b++;
	}

	let first = 0;
	while (first < changed.length) {
		// Two changes closer than twice the context share their context, so they share a hunk.
		let last = first;
		while (
			last + 1 < changed.length &&
			(changed[last + 1] ?? 0) - (changed[last] ?? 0) <= 2 * context + 1
		) {
			last++;
		}
		const from = Math.max(0, (changed[first] ?? 0) - context);
		const to = Math.min(operations.length, (changed[last] ?? 0) + context + 1);
		const slice = operations.slice(from, to);
		const oldCount = slice.filter(operation => operation.kind !== 'insert').length;
		const newCount = slice.filter(operation => operation.kind !== 'delete').length;
		const start = positions[from] ?? { a: 0, b: 0 };

		output.push(`@@ -${range(start.a, oldCount)} +${range(start.b, newCount)} @@`);
		for (const operation of slice) {
			const sign = operation.kind === 'equal' ? ' ' : operation.kind === 'delete' ? '-' : '+';
			if (operation.line.endsWith('\n')) output.push(sign + operation.line.slice(0, -1));
			else output.push(sign + operation.line, noNewline);
		}
		first = last + 1;
	}
	return output;
}

/** A hunk's side as git writes it: a side with no lines names the line before it. */
function range(start: number, count: number): string {
	if (count === 0) return `${String(start)},0`;
	if (count === 1) return String(start + 1);
	return `${String(start + 1)},${String(count)}`;
}
