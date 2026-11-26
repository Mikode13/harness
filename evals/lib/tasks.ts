import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Where the tasks live, each in a folder of its own beside `_base`, which every repository starts from. */
export const tasksDirectory = join(import.meta.dirname, '..', 'tasks');

/** The checks a task's repository has, which a run of the orchestrator must pass. */
export const checkNames = ['test', 'typecheck', 'lint'] as const;
export type CheckName = (typeof checkNames)[number];

const reviewCase = z.strictObject({
	/** A folder of the task whose files are laid over the repository: the change under review. */
	change: z.string().min(1),
	/** What a good reviewer does with it. */
	expected: z.enum(['approved', 'rejected']),
	/** For a change with a bug: the bug, in one sentence, which a judge looks for in the feedback. */
	key: z.string().min(1).optional(),
});

const definition = z.strictObject({
	/**
	 * - `task`: the orchestrator carries out the prompts, and the result is checked.
	 * - `plan`: the orchestrator plans the prompt and stops before any phase; the plan is graded.
	 * - `review`: the reviewer role alone reviews known changes; its decisions are graded.
	 */
	kind: z.enum(['task', 'plan', 'review']),
	description: z.string().min(1),
	/** The folder of the repository the task starts from, relative to the task: `repo` by default. */
	repo: z.string().min(1).default('repo'),
	/** Folders laid over the repository before every run, such as another task's reference. */
	overlays: z.array(z.string().min(1)).default([]),
	/** Files of the task, one per prompt, sent in order to the same session. */
	prompts: z.array(z.string().min(1)).min(1),
	/** Minutes to wait between two prompts, so a provider's cache expires as a user's pause lets it. */
	pauseMinutes: z.number().nonnegative().default(0),
	/** Between two prompts, the session is saved and restored in a fresh orchestrator. */
	restoreBetween: z.boolean().default(false),
	/** The checks the orchestrator must pass before each review. */
	checks: z.array(z.enum(checkNames)).default([...checkNames]),
	/** A folder of tests the agent never sees, run on its result. */
	hidden: z.string().min(1).optional(),
	/** Patterns no file the agent leaves in `src/` or `tests/` may hold, such as `eslint-disable`. */
	forbidden: z.array(z.string().min(1)).default([]),
	/**
	 * Versions of one file, each with one bug, swapped in one at a time and run against the tests
	 * the agent wrote: a version they fail is killed.
	 */
	mutants: z.strictObject({ target: z.string().min(1), directory: z.string().min(1) }).optional(),
	/** The rubric the judges grade the result's quality with. */
	rubric: z.string().min(1).optional(),
	/** For `plan`: what a good plan covers, one item per line, which the judges check. */
	checklist: z.string().min(1).optional(),
	/** A folder laid over the repository that solves the task: only the checks of `evals/` use it. */
	reference: z.string().min(1).optional(),
	/** For `review`: the phase under review, as the orchestrator would have planned it. */
	review: z
		.strictObject({
			plan: z.strictObject({
				summary: z.string().min(1),
				phases: z
					.array(
						z.strictObject({
							goal: z.string().min(1),
							files: z.array(z.string()),
							done: z.string().min(1),
						}),
					)
					.min(1),
			}),
			summary: z.string().min(1),
			cases: z.record(z.string(), reviewCase),
		})
		.optional(),
});

export type ReviewCase = z.infer<typeof reviewCase>;

/** A task, read and checked, with the folder it lives in. */
export type Task = z.infer<typeof definition> & { name: string; directory: string };

/** Every task's name, in the order they are listed. */
export function taskNames(): string[] {
	return readdirSync(tasksDirectory, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
		.map(entry => entry.name)
		.sort();
}

/**
 * The task `name`, from its `task.json`.
 *
 * @throws {Error} naming what is wrong in it.
 */
export function loadTask(name: string): Task {
	const directory = join(tasksDirectory, name);
	const parsed = definition.safeParse(
		JSON.parse(readFileSync(join(directory, 'task.json'), 'utf8')),
	);
	if (!parsed.success) {
		throw new Error(`evals/tasks/${name}/task.json: ${parsed.error.message}`);
	}
	const task = { ...parsed.data, name, directory };
	if (task.kind === 'review' && task.review === undefined) {
		throw new Error(`evals/tasks/${name}/task.json: a review task needs "review"`);
	}
	if (task.kind === 'plan' && task.checklist === undefined) {
		throw new Error(`evals/tasks/${name}/task.json: a plan task needs "checklist"`);
	}
	return task;
}

/** A file of the task, as text. */
export function taskFile(task: Task, file: string): string {
	return readFileSync(join(task.directory, file), 'utf8');
}
