import type { ProgressEvent } from '../src/index.ts';

/** Renders a progress event as one terminal line; `undefined` means nothing worth showing. */
export function formatProgressEvent(item: ProgressEvent): string | undefined {
	switch (item.type) {
		case 'agentMessage':
		case 'reasoning':
			return item.message;
		case 'command':
			if (!item.command) return undefined;

			return `command: ${item.command}, exit ${String(item.exitCode ?? '?')}`;
		case 'mcpTool':
			if (!item.server || !item.status) return undefined;
			return `tool: ${item.tool}, server: ${item.server}, status: ${item.status}`;
		case 'search':
			if (!item.query) return undefined;
			return `searching... query:${item.query}`;
		case 'fileChange':
			if (!item.changes.length) return undefined;

			return item.changes.map(change => `${change.path} - ${change.kind}`).join('\n');
		case 'todoList':
			if (!item.items.length) return undefined;

			return item.items
				.map(todoItem => `${todoItem.text} - status:${todoItem.completed ? '✔' : 'X'}`)
				.join('\n');
		case 'turnStarted':
		case 'turnEnded':
			return undefined;
		default:
			// The harness can add event types in a minor release; skip the ones this
			// formatter does not know yet.
			return undefined;
	}
}
