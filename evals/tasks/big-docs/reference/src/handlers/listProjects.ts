import { errorResponse, type Handler, type HttpResponse } from '../http.ts';
import { type Project, toPublicProject } from '../projects.ts';

const defaultLimit = 25;
const maxLimit = 100;

/** Where an item sits in a list: what a cursor holds. */
interface Position {
	readonly createdAt: string;
	readonly id: string;
}

/** Newest first, then by id: negative when `a` comes first. */
function compare(a: Position, b: Position): number {
	if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

function encodeCursor({ createdAt, id }: Position): string {
	return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): Position | undefined {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
	if (
		typeof value === 'object' &&
		value !== null &&
		'createdAt' in value &&
		'id' in value &&
		typeof value.createdAt === 'string' &&
		typeof value.id === 'string'
	) {
		return { createdAt: value.createdAt, id: value.id };
	}
	return undefined;
}

const invalidQuery = (message: string): HttpResponse =>
	errorResponse(400, 'invalid_query', message);

/** `GET /projects`: a page of projects, newest first, as the handbook lists collections. */
export const listProjects: Handler = (request, { projects }) => {
	const { limit: rawLimit, cursor, includeArchived } = request.query;
	const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
	if (rawLimit !== undefined && (!/^\d+$/u.test(rawLimit) || limit < 1 || limit > maxLimit)) {
		return invalidQuery(`limit must be a whole number from 1 to ${String(maxLimit)}`);
	}
	if (includeArchived !== undefined && includeArchived !== 'true' && includeArchived !== 'false') {
		return invalidQuery('includeArchived must be true or false');
	}
	let after: Position | undefined;
	if (cursor !== undefined) {
		after = decodeCursor(cursor);
		if (after === undefined) {
			return errorResponse(400, 'invalid_cursor', 'The cursor is not one this endpoint gave');
		}
	}
	const listed: Project[] = projects
		.all()
		.filter(project => includeArchived === 'true' || !project.archived)
		.sort(compare);
	const from = after === undefined ? 0 : listed.findIndex(project => compare(project, after) > 0);
	const page = from === -1 ? [] : listed.slice(from, from + limit);
	const last = page.at(-1);
	const more = from !== -1 && from + limit < listed.length;
	return {
		status: 200,
		body: {
			items: page.map(toPublicProject),
			nextCursor: more && last !== undefined ? encodeCursor(last) : null,
		},
	};
};
