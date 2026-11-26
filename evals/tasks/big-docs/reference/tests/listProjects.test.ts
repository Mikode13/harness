import { describe, expect, it } from 'vitest';
import { listProjects } from '../src/handlers/listProjects.ts';
import type { HttpResponse } from '../src/http.ts';
import { type Project, ProjectStore } from '../src/projects.ts';
import { routes } from '../src/routes.ts';

// 40 projects: some created at the same moment, every fifth archived.
const all: Project[] = Array.from({ length: 40 }, (_, index) => ({
	id: `p${String(index).padStart(2, '0')}`,
	name: `Project ${String(index)}`,
	createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 3) * 60_000).toISOString(),
	archived: index % 5 === 0,
	ownerEmail: `owner${String(index)}@example.test`,
}));
const projects = new ProjectStore(all);
const context = { projects };

const expected = (includeArchived: boolean): string[] =>
	all
		.filter(project => includeArchived || !project.archived)
		.sort((a, b) =>
			a.createdAt === b.createdAt
				? a.id.localeCompare(b.id)
				: b.createdAt.localeCompare(a.createdAt),
		)
		.map(project => project.id);

interface Page {
	items: { id: string }[];
	nextCursor: string | null;
}

const list = (query: Record<string, string>): HttpResponse =>
	listProjects({ params: {}, query }, context);
const page = (query: Record<string, string>): Page => {
	const response = list(query);
	expect(response.status).toBe(200);
	return response.body as Page;
};

describe('GET /projects', () => {
	it('is registered', () => {
		expect(routes['GET /projects']).toBe(listProjects);
	});

	it('gives 25 by default, newest first, ties by id, archived ones left out', () => {
		const first = page({});
		expect(first.items.map(item => item.id)).toEqual(expected(false).slice(0, 25));
		expect(first.nextCursor).not.toBeNull();
	});

	it('pages through everything with the cursors, each item once', () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const next: Page = page(cursor === null ? { limit: '7' } : { limit: '7', cursor });
			seen.push(...next.items.map(item => item.id));
			cursor = next.nextCursor;
		} while (cursor !== null);
		expect(seen).toEqual(expected(false));
	});

	it('gives a null cursor on the last page only, an exact last page included', () => {
		const count = expected(false).length;
		const whole = page({ limit: String(count) });
		expect(whole.items).toHaveLength(count);
		expect(whole.nextCursor).toBeNull();
		expect(page({ limit: String(count - 1) }).nextCursor).not.toBeNull();
	});

	it('includes archived projects with includeArchived=true', () => {
		expect(page({ limit: '100', includeArchived: 'true' }).items.map(item => item.id)).toEqual(
			expected(true),
		);
		expect(page({ limit: '100', includeArchived: 'false' }).items.map(item => item.id)).toEqual(
			expected(false),
		);
	});

	it('answers items in their public shape', () => {
		const [item] = page({ limit: '1' }).items;
		expect(Object.keys(item ?? {}).sort()).toEqual(['archived', 'createdAt', 'id', 'name']);
	});

	it('uses the cursor the handbook describes', () => {
		const first = page({ limit: '3' });
		const decoded: unknown = JSON.parse(
			Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'),
		);
		const last = all.find(project => project.id === first.items.at(-1)?.id);
		expect(decoded).toEqual({ createdAt: last?.createdAt, id: last?.id });
		const handmade = Buffer.from(
			JSON.stringify({ createdAt: last?.createdAt, id: last?.id }),
		).toString('base64url');
		expect(page({ limit: '3', cursor: handmade }).items.map(item => item.id)).toEqual(
			expected(false).slice(3, 6),
		);
	});

	it.each([['0'], ['101'], ['abc'], ['2.5'], ['-1'], ['']])(
		'refuses the limit %j as invalid_query',
		limit => {
			expect(list({ limit })).toMatchObject({
				status: 400,
				body: { error: { code: 'invalid_query' } },
			});
		},
	);

	it('refuses an includeArchived other than true or false', () => {
		expect(list({ includeArchived: 'yes' })).toMatchObject({
			status: 400,
			body: { error: { code: 'invalid_query' } },
		});
	});

	it.each([
		['not base64 JSON', 'abc'],
		['JSON without the fields', Buffer.from('{"id":"p01"}').toString('base64url')],
		['fields of the wrong type', Buffer.from('{"createdAt":1,"id":"p01"}').toString('base64url')],
	])('refuses a cursor that is %s as invalid_cursor', (_, cursor) => {
		expect(list({ cursor })).toMatchObject({
			status: 400,
			body: { error: { code: 'invalid_cursor' } },
		});
	});

	it('gives every error a message', () => {
		const body = list({ limit: '0' }).body as { error: { message: unknown } };
		expect(typeof body.error.message).toBe('string');
	});
});
