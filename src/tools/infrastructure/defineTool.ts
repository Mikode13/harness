import { z } from 'zod';
import { InvalidAgentConfigError } from '#src/agent/domain/errors';
import type { JSONSchema } from '#src/llm/domain/tool';
import type { Tool } from '../domain/tool.ts';

// Both providers take tools in strict mode, which supports only part of JSON Schema. Claude
// rejects these bounds; a tool that needs one checks it in its own code instead.
const unsupportedKeywords = [
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minLength',
	'maxLength',
];

// Keywords whose value is one schema, or a list or map of them. Anything else, such as the
// keys of `properties`, is a name or a value, never a schema to check.
const schemaKeywords = ['items', 'not', 'additionalProperties'];
const schemaListKeywords = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const schemaMapKeywords = ['properties', '$defs', 'definitions'];

function isSchema(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks the whole schema, nested objects included, and visits only schemas: a property named
 * `maxLength` is a name, not the keyword. A schema the providers reject would fail every
 * request with a 400, so it fails here, when the tool is defined.
 */
function assertStrict(schema: unknown, toolName: string): void {
	if (!isSchema(schema)) {
		return;
	}

	const keyword = unsupportedKeywords.find(candidate => candidate in schema);
	if (keyword) {
		throw new InvalidAgentConfigError(
			`Tool "${toolName}" uses "${keyword}", which strict mode does not support; check it in the tool's code`,
		);
	}

	if (schema.type === 'object') {
		// A record or a loose object takes keys strict mode cannot know in advance.
		if (schema.additionalProperties !== false) {
			throw new InvalidAgentConfigError(
				`Tool "${toolName}" has an object open to any key; strict mode needs every key declared`,
			);
		}

		const required = (schema.required ?? []) as string[];
		// OpenAI requires every property: an optional one is a union with `null`.
		const optional = Object.keys(schema.properties ?? {}).filter(
			property => !required.includes(property),
		);
		if (optional.length > 0) {
			throw new InvalidAgentConfigError(
				`Tool "${toolName}" has optional fields (${optional.join(', ')}); make them .nullable() instead`,
			);
		}
	}

	for (const key of schemaKeywords) assertStrict(schema[key], toolName);
	for (const key of schemaListKeywords) {
		const list = schema[key];
		if (Array.isArray(list)) for (const item of list) assertStrict(item, toolName);
	}
	for (const key of schemaMapKeywords) {
		const map = schema[key];
		if (isSchema(map)) for (const item of Object.values(map)) assertStrict(item, toolName);
	}
}

/**
 * Builds a `Tool` from one Zod schema, which gives the model its JSON Schema, validates what the
 * model sends, and types the input `execute` receives. Invalid input is rejected with a message
 * naming what is wrong, which the agent hands back to the model as an error result.
 *
 * @throws {InvalidAgentConfigError} when the schema falls outside what strict mode supports.
 */
export function defineTool<Schema extends z.ZodObject>({
	name,
	description,
	input,
	execute,
}: {
	name: string;
	description: string;
	input: Schema;
	execute: (input: z.infer<Schema>, signal: AbortSignal) => Promise<string>;
}): Tool {
	const inputSchema: Record<string, unknown> = { ...z.toJSONSchema(input) };
	// The dialect marker is noise to both APIs.
	delete inputSchema.$schema;
	assertStrict(inputSchema, name);

	return {
		name,
		description,
		inputSchema: inputSchema as JSONSchema,
		execute: (raw, signal) => {
			const parsed = input.safeParse(raw);
			if (!parsed.success) {
				return Promise.reject(new Error(z.prettifyError(parsed.error)));
			}

			return execute(parsed.data, signal);
		},
	};
}
