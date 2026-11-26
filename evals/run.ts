import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type JudgeName, judges } from './lib/judge.ts';
import {
	paths,
	type Profile,
	profiles,
	rolesFromArguments,
	runFolder,
	runPlan,
	runReview,
	runTask,
	type RunSettings,
} from './lib/runners.ts';
import { acceptanceOf, describeAcceptance } from './lib/compare.ts';
import { type EvalResult, type RunSummary, summaryOf } from './lib/summary.ts';
import { loadTask, taskNames } from './lib/tasks.ts';
import { removeWorkspace } from './lib/workspace.ts';

const usage = `pnpm run evals -- [--task <name>]... [--runs 3] [--profile default|anthropic|openai]
                  [--path workflow|agent] [--model provider:model:effort]
                  [--role role=provider:model:effort]... [--judges opus,astra|none]
                  [--pause-minutes <n>] [--keep-workspaces]

Runs each task --runs times against the harness in this checkout, and writes every result to
evals/results/<time>-<profile>-<path>/. --path agent carries a whole task out with one agent on
the executor's model instead of the workflow, and skips the plan and review tasks. --model puts
every role, and that agent, on one model; --role puts one role on its own, after --model.
Needs ANTHROPIC_API_KEY and OPENAI_API_KEY. Tasks: ${taskNames().join(', ')}.`;

// pnpm passes a `--` before the arguments through as one of them.
const given = process.argv.slice(2);
const { values } = parseArgs({
	args: given[0] === '--' ? given.slice(1) : given,
	options: {
		task: { type: 'string', multiple: true },
		runs: { type: 'string', default: '3' },
		profile: { type: 'string', default: 'default' },
		path: { type: 'string', default: 'workflow' },
		model: { type: 'string' },
		role: { type: 'string', multiple: true },
		judges: { type: 'string', default: 'opus,astra' },
		'pause-minutes': { type: 'string' },
		'keep-workspaces': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

const fail = (message: string): never => {
	process.stderr.write(`${message}\n\n${usage}\n`);
	process.exit(1);
};

if (values.help) {
	process.stdout.write(`${usage}\n`);
	process.exit(0);
}
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) fail(`--runs must be a whole number, 1 or more`);
const profile =
	profiles.find(each => each === values.profile) ?? fail(`Unknown profile ${values.profile}`);
const chosenJudges: JudgeName[] =
	values.judges === 'none'
		? []
		: values.judges
				.split(',')
				.map(name => (name in judges ? (name as JudgeName) : fail(`Unknown judge ${name}`)));
const pauseMinutes =
	values['pause-minutes'] === undefined ? undefined : Number(values['pause-minutes']);
if (pauseMinutes !== undefined && !(pauseMinutes >= 0)) fail('--pause-minutes must be 0 or more');
const path = paths.find(each => each === values.path) ?? fail(`Unknown path ${values.path}`);
let roles: ReturnType<typeof rolesFromArguments>;
try {
	roles = rolesFromArguments(values.model, values.role);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
const chosenTasks = (values.task ?? taskNames()).map(name =>
	taskNames().includes(name) ? loadTask(name) : fail(`Unknown task ${name}`),
);
// One agent carries out a whole task; planning and reviewing alone are the workflow's roles.
const tasks = path === 'agent' ? chosenTasks.filter(task => task.kind === 'task') : chosenTasks;
for (const task of chosenTasks.filter(each => !tasks.includes(each))) {
	process.stdout.write(`Skipping ${task.name}: --path agent runs whole tasks only\n`);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const root = join(import.meta.dirname, 'results', `${stamp}-${profile}-${path}`);
mkdirSync(root, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty =
	execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }) !== '';
writeFileSync(
	join(root, 'meta.json'),
	JSON.stringify(
		{
			commit,
			dirty,
			profile,
			path,
			...(roles ? { roles } : {}),
			runs,
			judges: chosenJudges,
			tasks: tasks.map(task => task.name),
			started: stamp,
		},
		null,
		'\t',
	),
);
process.stdout.write(
	`Results in ${root}\nHarness at ${commit}${dirty ? ' with changes in src/' : ''}\n`,
);

const summaries: Record<string, RunSummary[]> = {};
for (const task of tasks) {
	for (let run = 1; run <= runs; run++) {
		const folder = runFolder(root, task.name, run);
		const settings: RunSettings = {
			profile: profile satisfies Profile,
			path,
			...(roles ? { roles } : {}),
			folder,
			judges: chosenJudges,
			...(pauseMinutes === undefined ? {} : { pauseMinutes }),
		};
		const result: EvalResult =
			task.kind === 'task'
				? await runTask(task, settings)
				: task.kind === 'plan'
					? await runPlan(task, settings)
					: await runReview(task, settings);
		writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, '\t'));
		const summary = summaryOf(result);
		(summaries[task.name] ??= []).push(summary);
		writeFileSync(join(root, 'summary.json'), JSON.stringify(summaries, null, '\t'));
		process.stdout.write(`${task.name} #${String(run)}: ${JSON.stringify(summary)}\n`);
		if (!values['keep-workspaces'] && 'workspace' in result) {
			removeWorkspace(result.workspace);
		}
	}
}

process.stdout.write('\n');
for (const [task, summary] of Object.entries(summaries)) {
	process.stdout.write(`${task}: ${describeAcceptance(acceptanceOf(summary))}\n`);
}
