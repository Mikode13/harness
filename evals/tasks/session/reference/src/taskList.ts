/** How much a task matters. */
export type Priority = 'low' | 'medium' | 'high';

const priorities: readonly Priority[] = ['high', 'medium', 'low'];

/** A task as `TaskList.toJSON` stores it. A list stored before priorities, or before `medium`, loads too. */
export interface StoredTask {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
	readonly priority?: Priority | 'normal';
}

/** A task. */
export interface Task {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
	readonly priority: Priority;
}

/** Thrown for an id no task has. */
export class UnknownTaskError extends Error {
	override name = 'UnknownTaskError';
}

/** Thrown for a priority that is not `low`, `medium` or `high`. */
export class InvalidPriorityError extends Error {
	override name = 'InvalidPriorityError';
}

function checked(priority: unknown): Priority {
	const found = priorities.find(each => each === priority);
	if (found === undefined) {
		throw new InvalidPriorityError(`A priority is low, medium or high; got ${String(priority)}`);
	}
	return found;
}

/** A list of tasks, which can be stored as JSON and loaded again. */
export class TaskList {
	private readonly tasks: Task[];
	private nextId: number;

	constructor(stored: readonly StoredTask[] = []) {
		this.tasks = stored.map(task => ({
			id: task.id,
			title: task.title,
			done: task.done,
			priority:
				task.priority === undefined || task.priority === 'normal' ? 'medium' : task.priority,
		}));
		this.nextId = stored.length + 1;
	}

	/**
	 * Adds a task, not done, `medium` unless `priority` says otherwise, and returns it.
	 *
	 * @throws {InvalidPriorityError} for a priority that is not one of the three.
	 */
	add(title: string, priority: Priority = 'medium'): Task {
		const task: Task = {
			id: `t${String(this.nextId++)}`,
			title,
			done: false,
			priority: checked(priority),
		};
		this.tasks.push(task);
		return task;
	}

	/**
	 * Marks a task done.
	 *
	 * @throws {UnknownTaskError} for an id no task has.
	 */
	complete(id: string): void {
		const index = this.tasks.findIndex(task => task.id === id);
		const task = this.tasks[index];
		if (task === undefined) throw new UnknownTaskError(`No task has the id "${id}"`);
		this.tasks[index] = { ...task, done: true };
	}

	/**
	 * The tasks, high priority first and oldest first within one, only those of `priority` if given.
	 *
	 * @throws {InvalidPriorityError} for a priority that is not one of the three.
	 */
	list(filter: { priority?: Priority } = {}): Task[] {
		const only = filter.priority === undefined ? undefined : checked(filter.priority);
		return priorities
			.filter(priority => only === undefined || priority === only)
			.flatMap(priority => this.tasks.filter(task => task.priority === priority))
			.map(task => ({ ...task }));
	}

	/** The tasks as JSON data, in the order they were added, which the constructor loads again. */
	toJSON(): StoredTask[] {
		return this.tasks.map(task => ({ ...task }));
	}
}
