import type { ProjectStore } from './projects.ts';

/** A request as the router gives it to a handler. */
export interface HttpRequest {
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string | undefined>>;
}

/** What a handler answers. */
export interface HttpResponse {
	readonly status: number;
	readonly body: unknown;
}

/** What every handler can reach. */
export interface Context {
	readonly projects: ProjectStore;
}

export type Handler = (request: HttpRequest, context: Context) => HttpResponse;

/** An error answer, in the shape the handbook gives every error. */
export function errorResponse(status: number, code: string, message: string): HttpResponse {
	return { status, body: { error: { code, message } } };
}
