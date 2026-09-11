import type { ILogger } from '../domain/logger.ts';

export class Logger implements ILogger {
	warn(...args: unknown[]): void {
		console.warn(...args);
	}
}
