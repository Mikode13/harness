export interface IConversationLoop {
	start(): Promise<void>;
	cancel(): void;
	close(): void;
}
