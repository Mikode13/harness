/** Milliseconds in one of each unit. */
export const unitMilliseconds = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
	s: 1000,
	ms: 1,
} as const;

export type Unit = keyof typeof unitMilliseconds;

/** The units, largest first, as a duration lists them. */
export const unitsBySize: readonly Unit[] = ['d', 'h', 'm', 's', 'ms'];
