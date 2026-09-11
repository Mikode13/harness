export interface ILogger {
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}
