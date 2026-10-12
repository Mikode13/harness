/**
 * Builds one spinner frame without writing to the terminal.
 *
 * An unknown terminal width is left unbounded because there is no safe limit to apply. When a
 * width is available, the icon and its separating space count towards it.
 */
export function formatSpinnerLine(
	icon: string,
	description: string | undefined,
	columns: number | undefined,
): string {
	const line = description ? `${icon} ${description}` : icon;
	if (columns === undefined) return line;

	const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
	return Array.from(line).slice(0, width).join('');
}
