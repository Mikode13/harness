/**
 * A rule as git reads it: trailing spaces dropped unless a backslash escapes them. Nothing else
 * is trimmed, so a trailing tab stays part of the pattern, as it does for git.
 */
function trimTrailingSpaces(line: string): string {
	let lastSpace: number | undefined;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (character === ' ') {
			lastSpace ??= index;
		} else {
			// An escaped character, a space too, is part of the pattern.
			if (character === '\\') index++;
			lastSpace = undefined;
		}
	}
	return line.slice(0, lastSpace);
}

/** The rules of an ignore file, in order, as git reads them: no blank lines, no comments. */
function rulesOf(content: Buffer | undefined): string[] {
	if (!content) return [];
	return (
		content
			.toString('utf8')
			// git skips a UTF-8 byte order mark at the start of the file, and only there.
			.replace(/^\uFEFF/, '')
			.split(/\r?\n/)
			.map(trimTrailingSpaces)
			.filter(line => line !== '' && !line.startsWith('#'))
	);
}

/**
 * Whether changing an ignore file from `before` to `after` can make a path visible that it hid.
 * Only adding plain rules, anywhere, narrows. Any other change can widen:
 *
 * - a rule removed, which a deleted file does to all of them;
 * - a negation added, such as `!.env`;
 * - rules reordered, because the last rule that matches a path decides.
 *
 * It judges the text, not every path, so it errs towards "widens": a change it cannot prove
 * narrowing is treated as widening. `undefined` stands for a file that does not exist.
 */
export function widensIgnoreRules(before: Buffer | undefined, after: Buffer | undefined): boolean {
	const kept = rulesOf(before);
	let next = 0;
	for (const rule of rulesOf(after)) {
		if (rule === kept[next]) {
			next++;
		} else if (rule.startsWith('!')) {
			return true;
		}
	}
	// Every earlier rule must still be there, in the same order.
	return next < kept.length;
}

/** Whether a file is one git reads ignore rules from, by its name. */
export function isIgnoreFile(path: string): boolean {
	return (path.split(/[\\/]/).at(-1) ?? '').toLowerCase() === '.gitignore';
}
