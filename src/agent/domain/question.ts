/** One choice the model offers for a question. */
export interface QuestionOption {
	label: string;
	description: string;
}

/** A decision the model leaves to the user, with the choices it sees. */
export interface UserQuestion {
	question: string;
	/** Two to four. The user may always answer in their own words instead. */
	options: QuestionOption[];
	/** Whether more than one option may be chosen. */
	multiSelect: boolean;
}

/**
 * Answers the questions a model-backed agent asks, one answer per question and in order: the
 * label of each option chosen, or the user's own words. A throw ends the run as an
 * `UnrecoverableError`, as a failing approver does.
 */
export type Asker = (
	questions: UserQuestion[],
	signal: AbortSignal,
) => string[] | Promise<string[]>;
