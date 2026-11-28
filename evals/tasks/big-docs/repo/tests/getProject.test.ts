import { describe, expect, it } from 'vitest';
import { getProject } from '../src/handlers/getProject.ts';
import { ProjectStore } from '../src/projects.ts';

const projects = new ProjectStore([
	{
		id: 'p1',
		name: 'One',
		createdAt: '2026-01-01T00:00:00.000Z',
		archived: false,
		ownerEmail: 'a@x.test',
	},
]);

describe('GET /projects/:id', () => {
	it('answers a project without its internal fields', () => {
		expect(getProject({ params: { id: 'p1' }, query: {} }, { projects })).toEqual({
			status: 200,
			body: { id: 'p1', name: 'One', createdAt: '2026-01-01T00:00:00.000Z', archived: false },
		});
	});

	it('answers not_found for an unknown id', () => {
		expect(getProject({ params: { id: 'nope' }, query: {} }, { projects })).toMatchObject({
			status: 404,
			body: { error: { code: 'not_found' } },
		});
	});
});
