import { InvalidDurationError } from './errors.ts';
import { type Unit, unitMilliseconds, unitsBySize } from './units.ts';

// One part: a number, then its unit, then any spaces before the next part.
const part = /(\d+(?:\.\d+)?)(d|h|ms|m|s)\s*/y;

/**
 * The milliseconds `text` stands for: parts such as `1h30m` or `1h 30m`, largest unit first.
 *
 * @throws {InvalidDurationError} for text that is not a duration, saying where it stopped.
 */
export function parseDuration(text: string): number {
	const trimmed = text.trim();
	if (trimmed === '') throw new InvalidDurationError('A duration cannot be empty');
	let total = 0;
	let position = 0;
	let smallest = -1;
	while (position < trimmed.length) {
		part.lastIndex = position;
		const match = part.exec(trimmed);
		const amount = match?.[1];
		const unit = match?.[2] as Unit | undefined;
		if (match === null || amount === undefined || unit === undefined) {
			throw new InvalidDurationError(
				`Cannot read "${trimmed.slice(position)}" at position ${String(position)}`,
			);
		}
		const size = unitsBySize.indexOf(unit);
		if (size <= smallest) {
			throw new InvalidDurationError(`"${unit}" comes after a smaller or equal unit`);
		}
		smallest = size;
		total += Number(amount) * unitMilliseconds[unit];
		position = part.lastIndex;
	}
	return Math.round(total);
}
