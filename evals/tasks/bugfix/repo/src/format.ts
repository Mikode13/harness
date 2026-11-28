import { unitMilliseconds, unitsBySize } from './units.ts';

/** `milliseconds` as a duration, largest unit first, leaving out units that are zero: `1h30m`. */
export function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) {
		throw new RangeError(`Cannot format ${String(milliseconds)} milliseconds`);
	}
	let left = Math.round(milliseconds);
	const parts: string[] = [];
	for (const unit of unitsBySize) {
		const size = unitMilliseconds[unit];
		const amount = Math.floor(left / size);
		if (amount > 0) parts.push(`${String(amount)}${unit}`);
		left -= amount * size;
	}
	return parts.length === 0 ? '0ms' : parts.join('');
}
