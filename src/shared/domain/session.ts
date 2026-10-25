/**
 * One conversation with an agent, as the consumer knows it: the API's session, a TUI's chat.
 * Each run that writes records it in the workspace's history, so a host can tell which session
 * the change it is about to undo came from. Not a provider's session, which stays inside its
 * engine.
 */
export interface Session {
	/** What tells it apart. Stays the same across the session's runs. */
	id: string;
	/** What a host shows for it. Without one, or with a blank one, a host shows its `id`. */
	name?: string;
}
