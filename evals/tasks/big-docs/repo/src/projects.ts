/** A project as it is stored. */
export interface Project {
	readonly id: string;
	readonly name: string;
	/** When it was created, as an ISO 8601 timestamp in UTC. */
	readonly createdAt: string;
	readonly archived: boolean;
	/** Internal: never sent to clients. */
	readonly ownerEmail: string;
}

/** A project as clients see it. */
export interface PublicProject {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly archived: boolean;
}

/** The fields of `project` a client may see. */
export function toPublicProject(project: Project): PublicProject {
	return {
		id: project.id,
		name: project.name,
		createdAt: project.createdAt,
		archived: project.archived,
	};
}

/** The projects, in memory. */
export class ProjectStore {
	private readonly projects: readonly Project[];

	constructor(projects: readonly Project[]) {
		this.projects = projects;
	}

	/** Every project, in no particular order. */
	all(): readonly Project[] {
		return this.projects;
	}

	get(id: string): Project | undefined {
		return this.projects.find(project => project.id === id);
	}
}
