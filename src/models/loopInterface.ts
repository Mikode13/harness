export interface ILoop {
	start(): Promise<void>;
	close(): void;
}
