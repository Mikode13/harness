/** The rules of an ignore file, in order: no blank lines, no comments. */
function rulesOf(content: Buffer | undefined): string[] {
	if (!content) return [];
	return content
		.toString('utf8')
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(line => line !== '' && !line.startsWith('#'));
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
