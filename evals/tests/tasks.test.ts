import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { itemsOf } from '../lib/judge.ts';
import { runHidden, runMutants } from '../lib/runners.ts';
import { checkNames, loadTask, type Task, taskFile, taskNames } from '../lib/tasks.ts';
import { applyOverlay, forbiddenMatches, prepareWorkspace, runCheck } from '../lib/workspace.ts';

// Each task is checked offline, with no model: it cannot be passed as it starts, its reference
// passes every check, and each seeded bug is real. An eval that any of these fails measures nothing.

const made: string[] = [];
const workspace = (task: Task, overlays: string[] = []): string => {
	const root = prepareWorkspace(task, overlays);
	made.push(root);
	return root;
};
const folder = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'eval-check-'));
	made.push(root);
	return root;
};

afterEach(() => {
	for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tasks = taskNames().map(loadTask);

describe.each(tasks.filter(task => task.kind === 'task'))('the task $name', task => {
	it('cannot be passed as it starts', () => {
		const root = workspace(task);
		const hidden = runHidden(task, root, folder());
		const checks = checkNames.map(check => runCheck(root, check).passed);

		expect(
			hidden === undefined
				? checks.every(Boolean)
				: hidden.passed === hidden.total && checks.every(Boolean),
		).toBe(false);
	});

	it('is passed by its reference, every check and hidden test included', () => {
		expect(task.reference).toBeDefined();
		const root = workspace(task, [task.reference ?? '']);
		const hidden = runHidden(task, root, folder());
		for (const check of checkNames) {
			expect(runCheck(root, check), check).toMatchObject({ passed: true });
		}
		expect(hidden?.failed ?? []).toEqual([]);
		expect(forbiddenMatches(root, task.forbidden)).toEqual([]);
	});

	it.runIf(task.mutants !== undefined)(
		'has mutants that are real bugs, each caught by the hidden tests and by the reference tests',
		() => {
			const root = workspace(task, [task.reference ?? '']);
			// The reference's own tests: the most an agent's tests can catch.
			expect(runMutants(task, root)).toMatchObject({ survived: [] });
			applyOverlay(task, root, task.hidden ?? '');
			expect(runMutants(task, root, ['tests/hidden'])).toMatchObject({ survived: [] });
		},
	);
});

describe.each(tasks.filter(task => task.kind === 'review'))('the review task $name', task => {
	const review = task.review;

	it.each(Object.entries(review?.cases ?? {}))(
		'has a case %s whose bug, or lack of one, is real',
		(_, known) => {
			const root = workspace(task);
			applyOverlay(task, root, known.change);
			// The reviewer is shown these checks: a bug must hide from the visible tests.
			expect(runCheck(root, 'test')).toMatchObject({ passed: true });
			const hidden = runHidden(task, root, folder());
			expect(runCheck(root, 'typecheck')).toMatchObject({ passed: true });
			expect(runCheck(root, 'lint')).toMatchObject({ passed: true });
			if (known.expected === 'approved') {
				expect(hidden?.failed ?? []).toEqual([]);
			} else {
				expect(hidden?.failed.length ?? 0).toBeGreaterThan(0);
				expect(known.key).toBeDefined();
			}
		},
	);

	// Each change with a bug has the correct one's tests but one, weakened to miss the bug: the
	// correct change's tests catch it, so only that test, read closely, gives it away.
	const [correct] = Object.values(review?.cases ?? {}).filter(each => each.expected === 'approved');
	it.each(Object.entries(review?.cases ?? {}).filter(([, known]) => known.expected === 'rejected'))(
		"has a case %s whose bug the correct change's tests catch",
		(_, known) => {
			const root = workspace(task);
			applyOverlay(task, root, known.change);
			cpSync(join(task.directory, correct?.change ?? '', 'tests'), join(root, 'tests'), {
				recursive: true,
			});
			expect(runCheck(root, 'test')).toMatchObject({ passed: false });
		},
	);
});

describe.each(tasks.filter(task => task.kind === 'plan'))('the plan task $name', task => {
	it('has a prompt and a checklist of at least five items', () => {
		expect(taskFile(task, task.prompts[0] ?? '').length).toBeGreaterThan(0);
		expect(itemsOf(taskFile(task, task.checklist ?? '')).length).toBeGreaterThanOrEqual(5);
	});
});

describe.each(tasks.filter(task => task.rubric !== undefined))('the rubric of $name', task => {
	it('has at least five items', () => {
		expect(itemsOf(taskFile(task, task.rubric ?? '')).length).toBeGreaterThanOrEqual(5);
	});
});
