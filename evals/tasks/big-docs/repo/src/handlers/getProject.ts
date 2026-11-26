import { errorResponse, type Handler } from '../http.ts';
import { toPublicProject } from '../projects.ts';

/** `GET /projects/:id`: one project, or `not_found`. */
export const getProject: Handler = (request, { projects }) => {
	const id = request.params.id ?? '';
	const project = projects.get(id);
	if (project === undefined) {
		return errorResponse(404, 'not_found', `No project has the id "${id}"`);
	}
	return { status: 200, body: toPublicProject(project) };
};
