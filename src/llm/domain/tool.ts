export interface JSONSchema {
	type: 'object';
	[keyword: string]: unknown;
}

/** What a client describes to the model. Running the tool is not the model's concern. */
export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: JSONSchema;
}

/**
 * A tool whose shape the provider defines, and its models were trained on: OpenAI's
 * `apply_patch`, which sends V4A diffs, or Claude's text editor. The client declares it the
 * provider's way, and the agent still runs it like any other tool.
 */
export type NativeTool = 'applyPatch' | 'textEditor';

const nativeKey = Symbol('mikode-harness.nativeTool');

/**
 * The same definition, declared as a native tool. Internal: the mark travels under a symbol, so
 * `ToolDefinition` stays as consumers know it and no consumer tool can claim to be native.
 */
export function asNative<Definition extends ToolDefinition>(
	definition: Definition,
	tool: NativeTool,
): Definition {
	return Object.assign(definition, { [nativeKey]: tool });
}

/** Which native tool a definition declares, if any. */
export function nativeOf(definition: ToolDefinition): NativeTool | undefined {
	return (definition as { [nativeKey]?: NativeTool })[nativeKey];
}
