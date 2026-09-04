export interface IPromptEmitter {
	emit(prompt: string, signal: AbortSignal): Promise<string>;
	close(): void;
}
