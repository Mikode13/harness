import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The router's golden cases: what choosing a route among a consumer's agents and workflows
 * (harness#17) must get right, written before the router exists. Each case gives a request, the
 * conversation before it and the routes on offer, and says which decisions are acceptable. No
 * runner reads them yet: one comes with the router, and runs selection alone first, which costs
 * one call per case, then `bugfix` and `complex` end to end through the route it chose.
 */

const route = z.strictObject({
	name: z.string().regex(/^[a-z][a-z0-9-]*$/u),
	kind: z.enum(['agent', 'workflow']),
	description: z.string().min(1),
	/** Whether the route may change the repository. */
	writes: z.boolean(),
});

const decision = z.discriminatedUnion('decision', [
	/** Any of these routes is right. */
	z.strictObject({ decision: z.literal('route'), routes: z.array(z.string()).min(1) }),
	/**
	 * The request fits more than one job: the router asks a question that tells them apart, and
	 * once answered, starts one run, on a route of the job chosen.
	 */
	z.strictObject({
		decision: z.literal('ask'),
		jobs: z
			.array(z.strictObject({ job: z.string().min(1), routes: z.array(z.string()).min(1) }))
			.min(2),
	}),
	/** No route on offer fits: the router says so, and nothing runs after it. */
	z.strictObject({ decision: z.literal('not_applicable') }),
]);

const routeCase = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
	/** Two cases that differ in one detail share a pair: a router that tells them apart reads intent. */
	pair: z.string().optional(),
	/** What the case tests, for whoever reads a failure. */
	why: z.string().min(1),
	catalog: z.string(),
	/** The conversation before the request, oldest first. */
	context: z
		.array(z.strictObject({ from: z.enum(['user', 'assistant']), text: z.string().min(1) }))
		.default([]),
	request: z.string().min(1),
	expected: decision,
	/** `none`: whatever is chosen must leave the repository as it was. */
	writes: z.enum(['none', 'allowed']),
	/** Kept out of tuning the router's prompt, and run only to check it at the end. */
	heldOut: z.boolean().default(false),
});

const file = z.strictObject({
	catalogs: z.record(z.string(), z.array(route).min(1)),
	cases: z.array(routeCase).min(1),
});

export type RouteCase = z.infer<typeof routeCase>;
export type RouterCases = z.infer<typeof file>;

/** Where the cases are. */
export const routerCasesPath = join(import.meta.dirname, '..', 'router', 'cases.json');

/** The cases, read and checked whole. */
export function loadRouterCases(path = routerCasesPath): RouterCases {
	return file.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * What makes the cases unusable, each a sentence; none when they hold together: every route a
 * case names is in its catalog, a case that may not write accepts only routes that do not, ids
 * are unique, every pair has two cases, and some cases, fewer than half, are held out.
 */
export function problemsOf({ catalogs, cases }: RouterCases): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const pairs = new Map<string, number>();
	for (const each of cases) {
		if (ids.has(each.id)) problems.push(`${each.id} is used twice`);
		ids.add(each.id);
		if (each.pair !== undefined) pairs.set(each.pair, (pairs.get(each.pair) ?? 0) + 1);
		const catalog = catalogs[each.catalog];
		if (catalog === undefined) {
			problems.push(`${each.id} names a catalog that does not exist: ${each.catalog}`);
			continue;
		}
		const named =
			each.expected.decision === 'route'
				? each.expected.routes
				: each.expected.decision === 'ask'
					? each.expected.jobs.flatMap(job => job.routes)
					: [];
		for (const name of named) {
			const found = catalog.find(candidate => candidate.name === name);
			if (found === undefined)
				problems.push(`${each.id} names a route not in its catalog: ${name}`);
			else if (each.writes === 'none' && found.writes) {
				problems.push(`${each.id} may not write, yet accepts ${name}, which writes`);
			}
		}
	}
	for (const [pair, count] of pairs) {
		if (count !== 2) problems.push(`the pair ${pair} has ${String(count)} cases, not 2`);
	}
	const heldOut = cases.filter(each => each.heldOut).length;
	if (heldOut === 0 || heldOut * 2 >= cases.length) {
		problems.push(
			`${String(heldOut)} of ${String(cases.length)} cases are held out: some, fewer than half`,
		);
	}
	return problems;
}
