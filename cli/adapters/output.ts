import { inspect } from 'node:util';
import type { IOutput } from '../output.ts';
import { withoutControlSequences } from '../terminalText.ts';

// What reaches the terminal may carry text a model wrote, which must not drive the terminal.
export class Output implements IOutput {
	print(message: string): void {
		process.stdout.write(`${withoutControlSequences(message)}\n`);
	}
	/**
	 * Progress the CLI styled itself, after cleaning every string of its event: its colors and
	 * weights stay, and anything else that would drive the terminal still goes.
	 */
	printStyled(message: string): void {
		process.stdout.write(`${withoutControlSequences(message, { keepStyles: true })}\n`);
	}
	printError(error: unknown): void {
		// What `console.error` showed, with the message, the cause and the stack, without colors.
		process.stderr.write(`${withoutControlSequences(inspect(error))}\n`);
	}
}
