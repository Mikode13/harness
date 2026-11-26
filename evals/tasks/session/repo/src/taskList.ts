/** A task as `TaskList.toJSON` stores it. */
export interface StoredTask {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
}

/** A task. */
export interface Task {
	readonly id: string;
	readonly title: string;
	readonly done: boolean;
}

/** Thrown for an id no task has. */
export class UnknownTaskError extends Error {
	override name = 'UnknownTaskError';
}

/** A list of tasks, which can be stored as JSON and loaded again. */
export class TaskList {
	private readonly tasks: Task[];
	private nextId: number;

	constructor(stored: readonly StoredTask[] = []) {
		this.tasks = stored.map(task => ({ ...task }));
		this.nextId = stored.length + 1;
	}

	/** Adds a task, not done, and returns it. */
	add(title: string): Task {
		const task: Task = { id: `t${String(this.nextId++)}`, title, done: false };
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

	/** Every task, oldest first. */
	list(): Task[] {
		return this.tasks.map(task => ({ ...task }));
	}

	/** The tasks as JSON data, which the constructor loads again. */
	toJSON(): StoredTask[] {
		return this.list();
	}
}
