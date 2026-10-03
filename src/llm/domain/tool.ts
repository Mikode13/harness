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
