/**
 * The model each Claude alias names, on the Messages API and through the Agent SDK alike, so both
 * paths run the same model for the same name. Callers name a model by alias; this table pins the
 * ID, and moves by hand when Anthropic releases a newer model.
 */
export const claudeModelIds = {
	opus: 'claude-opus-5-5',
	fable: 'claude-fable-5-1',
	sonnet: 'claude-sonnet-5-5',
	haiku: 'claude-haiku-5-5',
} as const;
