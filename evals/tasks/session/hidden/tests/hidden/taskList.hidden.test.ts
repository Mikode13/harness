import { describe, expect, it } from 'vitest';
import * as library from '../../src/index.ts';
import { InvalidPriorityError, TaskList } from '../../src/taskList.ts';

const titles = (tasks: { title: string }[]): string[] => tasks.map(task => task.title);

describe('priorities, after the three prompts', () => {
	it('defaults to medium', () => {
		expect(new TaskList().add('one').priority).toBe('medium');
	});

	it('lists high first, oldest first within one priority', () => {
		const list = new TaskList();
		list.add('low one', 'low');
		list.add('medium one');
		list.add('high one', 'high');
		list.add('medium two', 'medium');
		list.add('high two', 'high');

		expect(titles(list.list())).toEqual([
			'high one',
			'high two',
			'medium one',
			'medium two',
			'low one',
		]);
	});

	it('filters by priority, in the same order', () => {
		const list = new TaskList();
		list.add('a', 'high');
		list.add('b', 'low');
		list.add('c', 'high');

		expect(titles(list.list({ priority: 'high' }))).toEqual(['a', 'c']);
		expect(list.list({ priority: 'medium' })).toEqual([]);
	});

	it('refuses normal and any other priority, in add and in list', () => {
		const list = new TaskList();
		for (const priority of ['normal', 'urgent', '']) {
			expect(() => list.add('x', priority as never)).toThrow(InvalidPriorityError);
			expect(() => list.list({ priority: priority as never })).toThrow(InvalidPriorityError);
		}
		expect(new InvalidPriorityError('x').name).toBe('InvalidPriorityError');
	});

	it('exports InvalidPriorityError from the package', () => {
		expect(library.InvalidPriorityError).toBe(InvalidPriorityError);
	});
});

describe('stored lists', () => {
	it('round-trip with their priorities, written as medium', () => {
		const list = new TaskList();
		list.add('a', 'high');
		list.add('b');
		const stored: unknown = JSON.parse(JSON.stringify(list));

		expect(stored).toEqual([
			{ id: 't1', title: 'a', done: false, priority: 'high' },
			{ id: 't2', title: 'b', done: false, priority: 'medium' },
		]);
		expect(new TaskList(stored as never).list()).toEqual(list.list());
	});

	it('load a list stored with normal, or with no priority, as medium', () => {
		const list = new TaskList([
			{ id: 't1', title: 'old', done: false },
			{ id: 't2', title: 'normal', done: true, priority: 'normal' },
			{ id: 't3', title: 'high', done: false, priority: 'high' },
		] as never);

		expect(list.list().map(task => [task.title, task.priority])).toEqual([
			['high', 'high'],
			['old', 'medium'],
			['normal', 'medium'],
		]);
		expect(JSON.stringify(list)).not.toContain('"priority":"normal"');
		expect(list.add('next').id).toBe('t4');
	});
});
