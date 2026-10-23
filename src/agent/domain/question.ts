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

/**
 * The asker's answers, one non-empty string per question, or nothing: an asker is host code, so
 * an answer of any other shape is its bug, not the model's.
 */
export function readAnswers(answers: unknown, questions: UserQuestion[]): string[] | undefined {
	if (!Array.isArray(answers) || answers.length !== questions.length) return undefined;
	return answers.every(answer => typeof answer === 'string' && answer.trim() !== '')
		? (answers as string[])
		: undefined;
}

/** What one run's user answered, as `rememberAnswers` keeps it. */
export interface AnsweredQuestion {
	question: string;
	answer: string;
}

/**
 * Wraps `ask` so a question asked again with the same words gets the answer the user already
 * gave, and only the others are asked. `answered` holds every answer, in the order given. The
 * memory lives as long as the returned asker: one per run, so a retry never asks again.
 */
export function rememberAnswers(ask: Asker): { ask: Asker; answered: AnsweredQuestion[] } {
	const answered: AnsweredQuestion[] = [];
	const known = new Map<string, string>();

	return {
		answered,
		ask: async (questions, signal) => {
			const unknown = questions.filter(({ question }) => !known.has(question));
			const fresh = unknown.length > 0 ? await ask(unknown, signal) : [];
			// The agent checks the asker's answers; a short or odd list is its to refuse.
			if (!Array.isArray(fresh)) return fresh;
			for (const [index, { question }] of unknown.entries()) {
				const answer = fresh[index];
				if (typeof answer !== 'string') return fresh;
				known.set(question, answer);
				answered.push({ question, answer });
			}
			return questions.map(({ question }) => known.get(question) ?? '');
		},
	};
}

/** The user's earlier answers, for a prompt that must not ask them again. */
export function describeAnswered(answered: AnsweredQuestion[]): string {
	return [
		'The user already answered these questions in an earlier attempt; do not ask them again:',
		...answered.map(
			({ question, answer }, index) => `${String(index + 1)}. ${question}\n   ${answer}`,
		),
	].join('\n');
}
