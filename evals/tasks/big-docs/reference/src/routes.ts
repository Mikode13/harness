import { getProject } from './handlers/getProject.ts';
import { listProjects } from './handlers/listProjects.ts';
import type { Handler } from './http.ts';

/** Every route, by method and path. */
export const routes: Readonly<Record<string, Handler>> = {
	'GET /projects': listProjects,
	'GET /projects/:id': getProject,
};
