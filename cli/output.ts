/** Terminal output meant for the user, as opposed to the harness's diagnostic `ILogger`. */
export interface IOutput {
	print(message: string): void;
}
