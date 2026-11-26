import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare, describeAcceptance, minimumRuns } from './lib/compare.ts';
import type { RunSummary } from './lib/summary.ts';

// pnpm passes a `--` before the arguments through as one of them.
const [before, after] = process.argv.slice(2).filter(argument => argument !== '--');
if (before === undefined || after === undefined) {
	process.stderr.write(
		'pnpm run evals:compare -- <results before> <results after>\n\nEach is a folder evals/results/<time>-<profile>.\n',
	);
	process.exit(1);
}

const read = (folder: string): Record<string, RunSummary[]> =>
	JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8')) as Record<string, RunSummary[]>;

const result = compare(read(before), read(after));
const usd = (value: number | undefined): string =>
	value === undefined ? '?' : `$${value.toFixed(3)}`;
for (const task of result.tasks) {
	process.stdout.write(
		`${task.task}: cost ${usd(task.cost.before)} → ${usd(task.cost.after)} (${task.cost.move})\n`,
	);
	process.stdout.write(
		`  accepted: ${describeAcceptance(task.accepted.before)} → ${describeAcceptance(task.accepted.after)}\n`,
	);
	for (const [name, measure] of Object.entries(task.measures)) {
		process.stdout.write(
			`  ${name}: ${measure.before.toFixed(2)} → ${measure.after.toFixed(2)} (${measure.move})\n`,
		);
	}
}
process.stdout.write(
	`\nCheaper past the spread in: ${result.cheaper.join(', ') || 'none'}\nWorse in: ${result.worse.join(', ') || 'none'}\n${result.tooFewRuns.length > 0 ? `Left out, with fewer than ${String(minimumRuns)} runs a side: ${result.tooFewRuns.join(', ')}\n` : ''}Verdict: ${result.verdict}\n`,
);
