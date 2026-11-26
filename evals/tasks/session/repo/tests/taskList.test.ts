import { describe, expect, it } from 'vitest';
import { TaskList, UnknownTaskError } from '../src/taskList.ts';

describe('TaskList', () => {
	it('adds tasks and lists them oldest first', () => {
		const list = new TaskList();
		list.add('one');
		list.add('two');
		expect(list.list().map(task => task.title)).toEqual(['one', 'two']);
	});

	it('completes a task, and refuses an unknown id', () => {
		const list = new TaskList();
		const task = list.add('one');
		list.complete(task.id);
		expect(list.list()[0]?.done).toBe(true);
		expect(() => {
			list.complete('nope');
		}).toThrow(UnknownTaskError);
	});

	it('loads what it stored', () => {
		const list = new TaskList();
		list.add('one');
		const again = new TaskList(JSON.parse(JSON.stringify(list)) as ReturnType<TaskList['toJSON']>);
		expect(again.list()).toEqual(list.list());
		expect(again.add('two').id).toBe('t2');
	});
});
