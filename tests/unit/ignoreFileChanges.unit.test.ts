import { describe, expect, it } from 'vitest';
import {
	isIgnoreFile,
	widensIgnoreRules,
} from '../../src/tools/infrastructure/ignoreFileChanges.ts';

const file = (...lines: string[]) => Buffer.from(lines.map(line => `${line}\n`).join(''));

describe('widensIgnoreRules', () => {
	it.each([
		['adds a rule at the end', file('node_modules'), file('node_modules', 'dist')],
		['adds a rule at the start', file('node_modules'), file('dist', 'node_modules')],
		['adds a comment and a blank line', file('node_modules'), file('# deps', '', 'node_modules')],
		['creates a file of plain rules', undefined, file('dist', '*.log')],
		['deletes a file with no rules', file('# nothing yet'), undefined],
		['changes nothing but line endings', file('a', 'b'), Buffer.from('a\r\nb\r\n')],
		['only adds unescaped trailing spaces', file('secret'), file('secret  ')],
		['keeps an escaped space and drops the plain one after it', file('a \\ '), file('a \\  ')],
	])('treats a change that %s as narrowing', (_, before, after) => {
		expect(widensIgnoreRules(before, after)).toBe(false);
	});

	it.each([
		['removes a rule', file('node_modules', '.env'), file('node_modules')],
		['adds a negation', file('.env*'), file('.env*', '!.env.local')],
		['creates a file with a negation', undefined, file('!.env')],
		['deletes a file with rules', file('dist'), undefined],
		['reorders rules', file('*.log', '!keep.log'), file('!keep.log', '*.log')],
		['edits a rule', file('build/'), file('build/tmp/')],
		// git keeps an escaped trailing space: `secret\ ` ignores the file `secret `.
		['drops an escaped trailing space', file('secret\\ '), file('secret\\')],
		// git trims spaces only: `secret<tab>` no longer ignores `secret`.
		['adds a trailing tab', file('secret'), file('secret\t')],
	])('treats a change that %s as widening', (_, before, after) => {
		expect(widensIgnoreRules(before, after)).toBe(true);
	});
});

describe('isIgnoreFile', () => {
	it.each(['.gitignore', 'src/.gitignore', '/repo/.GITIGNORE'])('recognizes %s', path => {
		expect(isIgnoreFile(path)).toBe(true);
	});

	it.each(['gitignore', '.gitignore.bak', '.ignore', 'src/.gitignore/x'])('ignores %s', path => {
		expect(isIgnoreFile(path)).toBe(false);
	});
});
