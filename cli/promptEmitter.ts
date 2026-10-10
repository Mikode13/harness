export interface IPromptEmitter {
	/**
	 * Whether a person answers, at a terminal. Piped input is not one: its lines were written
	 * before any question was asked. Missing counts as not interactive.
	 */
	readonly interactive?: boolean;
	emit(prompt: string, signal: AbortSignal): Promise<string>;
	close(): void;
}
