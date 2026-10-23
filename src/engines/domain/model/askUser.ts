import type { UserQuestion } from '#src/agent/domain/question';
import type { ToolDefinition } from '#src/llm/domain/tool';

export const askUserName = 'askUser';

const maxQuestions = 4;
const minOptions = 2;
const maxOptions = 4;

// Strict mode allows no length bounds, so the counts live in the description and in `readQuestions`.
export const askUserDefinition: ToolDefinition = {
	name: askUserName,
	description: [
		'Asks the user to decide something that is theirs to decide, and waits for the answer.',
		'Ask before you build on a choice, not after. The user decides: the shape of a public API or of anything other code depends on; a new dependency; behaviour the request does not ask for; and any choice between options with real trade-offs.',
		'Do not ask what the repository, the request or a reasonable default already answers; find it out instead.',
		`Ask everything you need in one call: 1 to ${String(maxQuestions)} questions, each with ${String(minOptions)} to ${String(maxOptions)} options. Say in each option's description what choosing it means. The user may answer in their own words instead.`,
	].join(' '),
	inputSchema: {
		type: 'object',
		properties: {
			questions: {
				type: 'array',
				description: `1 to ${String(maxQuestions)} questions.`,
				items: {
					type: 'object',
					properties: {
						question: { type: 'string', description: 'The whole question, ending with "?".' },
						options: {
							type: 'array',
							description: `${String(minOptions)} to ${String(maxOptions)} choices.`,
							items: {
								type: 'object',
								properties: {
									label: { type: 'string', description: 'A few words.' },
									description: {
										type: 'string',
										description: 'What choosing it means, and what it costs.',
									},
								},
								required: ['label', 'description'],
								additionalProperties: false,
							},
						},
						multiSelect: {
							type: 'boolean',
							description: 'Whether more than one option may be chosen.',
						},
					},
					required: ['question', 'options', 'multiSelect'],
					additionalProperties: false,
				},
			},
		},
		required: ['questions'],
		additionalProperties: false,
	},
};

/** The questions in a call's input, or why they cannot be asked, which the model reads. */
export function readQuestions(input: unknown): UserQuestion[] | string {
	const questions = isRecord(input) ? input.questions : undefined;
	if (!Array.isArray(questions) || questions.length === 0 || questions.length > maxQuestions) {
		return `Ask 1 to ${String(maxQuestions)} questions.`;
	}
	const read: UserQuestion[] = [];
	for (const [index, question] of questions.entries()) {
		const at = `Question ${String(index + 1)}`;
		if (!isRecord(question) || !isText(question.question)) return `${at} has no text.`;
		const { options, multiSelect } = question;
		if (!Array.isArray(options) || options.length < minOptions || options.length > maxOptions) {
			return `${at} needs ${String(minOptions)} to ${String(maxOptions)} options.`;
		}
		if (typeof multiSelect !== 'boolean') return `${at} must say whether it is multiSelect.`;
		const choices = [];
		for (const option of options) {
			if (!isRecord(option) || !isText(option.label) || typeof option.description !== 'string') {
				return `Every option of ${at.toLowerCase()} needs a label and a description.`;
			}
			choices.push({ label: option.label, description: option.description });
		}
		read.push({ question: question.question, options: choices, multiSelect });
	}
	return read;
}

/** What the model reads back: each question with its answer. */
export function describeAnswers(questions: UserQuestion[], answers: string[]): string {
	return [
		'The user answered:',
		...questions.map(
			({ question }, index) => `${String(index + 1)}. ${question}\n   ${answers[index] ?? ''}`,
		),
	].join('\n');
}

export function summarizeQuestions(questions: UserQuestion[]): string {
	return questions.length === 1 ? '1 question' : `${String(questions.length)} questions`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}
