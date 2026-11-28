import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	compare,
	describeAcceptance,
	type Measurement,
	minimumRuns,
	type Side,
	sideOf,
} from './lib/compare.ts';

const usage = `pnpm run evals:compare -- <before> <after>
pnpm run evals:compare -- <before> [<before>...] vs <after> [<after>...]

Each is a folder evals/results/<time>-<profile>-<path>. A side of several folders joins them: they
must have run the same src/ with the same roles, path and judges, and a task in a later folder
replaces the same task of an earlier one.
`;

// pnpm passes a `--` before the arguments through as one of them.
const folders = process.argv.slice(2).filter(argument => argument !== '--');
const split = folders.indexOf('vs');
const [beforeFolders, afterFolders] =
	split === -1
		? [folders.slice(0, 1), folders.slice(1)]
		: [folders.slice(0, split), folders.slice(split + 1)];
if (
	beforeFolders.length === 0 ||
	afterFolders.length === 0 ||
	(split === -1 && folders.length !== 2)
) {
	process.stderr.write(usage);
	process.exit(1);
}

const read = (folder: string): Measurement => ({
	folder,
	meta: JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8')) as Measurement['meta'],
	summaries: JSON.parse(
		readFileSync(join(folder, 'summary.json'), 'utf8'),
	) as Measurement['summaries'],
});

// Two commits hold the same harness when git sees no change to src/ between them.
const sameSource = (first: string, second: string): boolean => {
	if (first === second) return true;
	try {
		execFileSync('git', ['diff', '--quiet', first, second, '--', 'src'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const sides: Side[] = [beforeFolders, afterFolders].map(list => sideOf(list.map(read), sameSource));
const problems = sides.flatMap(side => side.problems);
if (problems.length > 0) {
	process.stderr.write(`Nothing was compared:\n- ${problems.join('\n- ')}\n`);
	process.exit(1);
}
const [before, after] = sides as [Side, Side];
for (const [name, side] of [
	['Before', before],
	['After', after],
] as const) {
	if (new Set(Object.values(side.sources)).size > 1) {
		const lines = Object.entries(side.sources).map(([task, folder]) => `  ${task}: ${folder}`);
		process.stdout.write(`${name}, by task:\n${lines.join('\n')}\n`);
	}
}

const result = compare(before.summaries, after.summaries);
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
