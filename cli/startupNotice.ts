/**
 * What the CLI says when it starts, if anything. Without `--llm`, the Agent SDK agents run with
 * no one to ask, so the mode that needs no flag is the one without a safety net: it says so.
 */
export function startupNotice({ llm }: { llm: boolean }): string | undefined {
	if (llm) return undefined;
	return (
		'The Agent SDK agents run here with their permission checks bypassed, in this folder, ' +
		'and their changes are not in the history, so /undo cannot take them back. ' +
		'Start with --llm to be asked before each destructive call.'
	);
}
