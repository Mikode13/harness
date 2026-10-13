import type { UserQuestion } from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

/** What the model reads when no one can answer, so it decides and says what it assumed. */
export const nobodyToAnswer =
	'Nobody was at a terminal to answer. Decide yourself, and say in your answer what you assumed.';

/**
 * Asks the user in the terminal what the model asked, one question at a time. Each option is
 * numbered: the user answers with its number, several separated by commas where the question
 * allows more than one, or in their own words. Without a person at a terminal, such as with
 * piped input, nothing is read: a line written beforehand must never answer a question.
 */
export function createTerminalAsker(promptEmitter: IPromptEmitter, output: IOutput) {
	return async (questions: UserQuestion[], signal: AbortSignal): Promise<string[]> => {
		if (promptEmitter.interactive !== true) {
			output.print('The agent asked a question, but nobody is at a terminal to answer it.');
			return questions.map(() => nobodyToAnswer);
		}

		const answers: string[] = [];
		for (const { question, options, multiSelect } of questions) {
			output.print(`\nThe agent asks: ${question}`);
			for (const [index, option] of options.entries()) {
				output.print(`  ${String(index + 1)}. ${option.label}: ${option.description}`);
			}
			const how = multiSelect ? 'numbers, separated by commas' : 'a number';
			for (;;) {
				const line = (
					await promptEmitter.emit(`Answer with ${how}, or in your own words: `, signal)
				).trim();
				if (!line) continue;
				answers.push(chosen(line, options, multiSelect) ?? line);
				break;
			}
		}
		return answers;
	};
}

/** The labels a line of option numbers picks, or nothing when it is the user's own words. */
function chosen(line: string, options: UserQuestion['options'], multiSelect: boolean) {
	const numbers = line.split(',').map(part => part.trim());
	if (!numbers.every(part => /^\d+$/u.test(part))) return undefined;
	if (!multiSelect && numbers.length > 1) return undefined;
	const labels = numbers.map(part => options[Number(part) - 1]?.label);
	if (labels.some(label => label === undefined)) return undefined;
	return labels.join(', ');
}
