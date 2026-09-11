/** Terminal output meant for the user, as opposed to the harness's diagnostic `ILogger`. */
export interface IOutput {
	print(message: string): void;
	/** A failure the user should see, such as a turn that could not complete. */
	printError(error: unknown): void;
}
