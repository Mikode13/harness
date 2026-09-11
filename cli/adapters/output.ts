import type { IOutput } from '../output.ts';

export class Output implements IOutput {
	print(message: string): void {
		process.stdout.write(`${message}\n`);
	}
}
