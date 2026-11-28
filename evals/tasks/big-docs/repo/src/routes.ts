import { getProject } from './handlers/getProject.ts';
import type { Handler } from './http.ts';

/** Every route, by method and path. */
export const routes: Readonly<Record<string, Handler>> = {
	'GET /projects/:id': getProject,
};
