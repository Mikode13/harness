import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isText } from '#src/recovery/domain/runChanges';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import type { PreparingTool } from '../domain/preparedCall.ts';
import { definePreparingTool } from './defineTool.ts';
import { readFileDescription, readFileInput, readRange, renderLines } from './workspaceTools.ts';

// The same bound as an edit: a file too large to change need not be read whole to track it.
const maxFileBytes = 5 * 1024 * 1024;

function lines(text: string): string[] {
	if (text === '') return [];
	const all = text.split(/\r\n|\r|\n/);
	// A final newline ends the last line; it does not start another.
	if (all.at(-1) === '') all.pop();
	return all;
}

/**
 * `readFile` for an agent that edits: the same tool for the model, through the access policy,
 * and it records the version of the file the model saw, so an edit starts only from it. The file
 * is read once, so the version recorded is the content shown.
 */
export function createTrackedReadFile(policy: AccessPolicy): PreparingTool {
	return definePreparingTool({
		name: 'readFile',
		description: readFileDescription,
		input: readFileInput,
		prepare: async ({ path, fromLine, lineCount }, signal, { reads }) => {
			const { from, count } = readRange({ fromLine, lineCount });
			const target = await policy.check(path, 'read', signal);
			return {
				risk: 'safe',
				run: async runSignal => {
					runSignal.throwIfAborted();
					const stats = await lstat(target.absolute).catch(() => undefined);
					// One answer for every file it cannot show, as the read tools give.
					if (!stats?.isFile()) throw new Error(`No such file: ${path}`);
					if (stats.size > maxFileBytes) {
						throw new Error(
							`${path} is larger than ${String(maxFileBytes / 1024 / 1024)} MB, too large to read`,
						);
					}
					const content = await readFile(target.absolute, { signal: runSignal });
					if (!isText(content)) throw new Error(`Not a text file: ${path}`);

					const all = lines(content.toString('utf8'));
					const shown = all.slice(from - 1, from - 1 + count);
					// A partial read counts: the model saw this version, and can read the rest.
					reads.record(target.absolute, createHash('sha256').update(content).digest('hex'));
					return renderLines({
						lines: shown,
						from,
						totalLines: all.length,
						truncated: from - 1 + shown.length < all.length,
					});
				},
			};
		},
	});
}
