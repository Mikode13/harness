import { z } from 'zod';
import { InvalidToolInputError, type ToolSummarizer } from '../domain/tool.ts';

/**
 * Keeps tool narration on the same validated-input boundary as execution. A provider can send
 * anything to a tool, so a summarizer must never receive the unvalidated value it describes.
 */
export function validatedSummarizer<Schema extends z.ZodType>(
	schema: Schema,
	summarize: (input: z.infer<Schema>) => string,
): ToolSummarizer {
	return (raw: unknown) => {
		const parsed = schema.safeParse(raw);
		if (!parsed.success) throw new InvalidToolInputError(z.prettifyError(parsed.error));
		return summarize(parsed.data);
	};
}
