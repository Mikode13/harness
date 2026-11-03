/** One part of a task, which the executor carries out and the reviewer approves on its own. */
export interface Phase {
	readonly goal: string;
	/** The files it is expected to change or create. */
	readonly files: readonly string[];
	/** What must hold for it to be done, as the reviewer checks it. */
	readonly done: string;
}

/** The planner's answer: what the task is, for the user, and its phases in order. */
export interface Plan {
	readonly summary: string;
	readonly phases: readonly Phase[];
}

/** The executor's answer for a phase: done, or the plan cannot be carried out as it is. */
export type PhaseReport =
	| { readonly status: 'done'; readonly summary: string }
	| { readonly status: 'replan'; readonly reason: string };

/**
 * The reviewer's decision on a phase. `rejected` sends the work back to the executor; `replan`
 * says the plan itself is wrong, and sends it to the planner.
 */
export type PhaseReview =
	| { readonly decision: 'approved' }
	| { readonly decision: 'rejected'; readonly feedback: string }
	| { readonly decision: 'replan'; readonly feedback: string };

/** How far a phased run goes before it ends with the task unfinished. */
export interface PhaseLimits {
	/** Rejections in a row of one phase, by the checks or the reviewer, before it goes to the planner. */
	readonly rejections: number;
	/** Times one phase may go back to the planner. */
	readonly replans: number;
	/** The most phases a plan may hold: only there to stop a planner that never finishes. */
	readonly phases: number;
	/**
	 * The user's corrections of the plan before it is carried out: past them, an answer that
	 * neither approves nor stops ends the run, so an asker that never approves cannot keep the
	 * planner planning.
	 */
	readonly corrections: number;
}

export const defaultPhaseLimits: PhaseLimits = {
	rejections: 2,
	replans: 2,
	phases: 50,
	corrections: 3,
};
