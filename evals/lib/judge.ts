import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { z } from 'zod';

/**
 * The judges grade quality from outside the harness: each calls its provider's SDK directly, so
 * no change to the harness can change how a result is graded. Two families, so a result one of
 * them favors because it is its own kind of answer shows as a disagreement.
 */
export const judges = {
	opus: async (prompt: string): Promise<string> => {
		const message = await new Anthropic().messages.create({
			model: 'claude-opus-5-5',
			max_tokens: 16_000,
			messages: [{ role: 'user', content: prompt }],
		});
		return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
	},
	astra: async (prompt: string): Promise<string> => {
		const response = await new OpenAI().responses.create({
			model: 'gpt-6-astra',
			input: prompt,
			reasoning: { effort: 'medium' },
		});
		return response.output_text;
	},
} as const satisfies Record<string, (prompt: string) => Promise<string>>;

export type JudgeName = keyof typeof judges;

/** One judge's answer, or why it gave none. */
export type Judged<Verdict> =
	{ judge: JudgeName; verdict: Verdict } | { judge: JudgeName; error: string };

/** One item of a rubric or a checklist: `id: what it asks`, one per line of its file. */
export interface Item {
	id: string;
	text: string;
}

/** The items of a rubric or a checklist file. */
export function itemsOf(text: string): Item[] {
	return text.split('\n').flatMap(line => {
		const match = /^([a-z][a-z0-9-]*):\s+(.+)$/u.exec(line.trim());
		return match?.[1] && match[2] ? [{ id: match[1], text: match[2] }] : [];
	});
}

const lastJson = (text: string): unknown => {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end < start) throw new Error(`No JSON in the answer: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(start, end + 1)) as unknown;
};

/** Asks every judge `prompt`, and reads each answer with `schema`. A judge that fails says why. */
async function askAll<Verdict>(
	prompt: string,
	schema: z.ZodType<Verdict>,
	only: readonly JudgeName[],
): Promise<Judged<Verdict>[]> {
	return Promise.all(
		only.map(async (judge): Promise<Judged<Verdict>> => {
			try {
				return { judge, verdict: schema.parse(lastJson(await judges[judge](prompt))) };
			} catch (error) {
				return { judge, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

const allJudges = Object.keys(judges) as JudgeName[];

const scores = z.strictObject({
	items: z.array(
		z.strictObject({ id: z.string(), score: z.number().int().min(0).max(2), reason: z.string() }),
	),
});
export type RubricVerdict = z.infer<typeof scores>;

/** Grades a change against a rubric: 0, 1 or 2 for each item, with a reason. */
export function gradeRubric(
	request: string,
	rubric: readonly Item[],
	diff: string,
	only: readonly JudgeName[] = allJudges,
): Promise<Judged<RubricVerdict>[]> {
	const prompt = [
		'You grade the quality of a code change a coding agent made for a request. You do not know which agent or model made it, and it does not matter. Grade only what the diff shows.',
		`The request:\n---\n${request}\n---`,
		`The change, as a diff from where the task started:\n---\n${diff.slice(0, 150_000)}\n---`,
		`Grade each item of this rubric 0 (not met), 1 (partly met) or 2 (met), with one sentence of reason:\n${rubric.map(item => `- ${item.id}: ${item.text}`).join('\n')}`,
		'Answer with JSON only: {"items":[{"id":"...","score":0,"reason":"..."}]}, one entry per rubric item, with its id.',
	].join('\n\n');
	return askAll(prompt, scores, only);
}

const coverage = z.strictObject({
	items: z.array(z.strictObject({ id: z.string(), covered: z.boolean(), reason: z.string() })),
});
export type PlanVerdict = z.infer<typeof coverage>;

/** Checks a plan against what a good plan for the request covers, item by item. */
export function gradePlan(
	request: string,
	checklist: readonly Item[],
	plan: string,
	only: readonly JudgeName[] = allJudges,
): Promise<Judged<PlanVerdict>[]> {
	const prompt = [
		'You check a plan a planning agent wrote for a coding request, before anyone carried it out. You do not know which agent or model wrote it. A point counts as covered only when the plan says it explicitly enough that an executor reading only the plan would do it.',
		`The request:\n---\n${request}\n---`,
		`The plan:\n---\n${plan}\n---`,
		`For each item, say whether the plan covers it, with one sentence of reason:\n${checklist.map(item => `- ${item.id}: ${item.text}`).join('\n')}`,
		'Answer with JSON only: {"items":[{"id":"...","covered":true,"reason":"..."}]}, one entry per item, with its id.',
	].join('\n\n');
	return askAll(prompt, coverage, only);
}

const finding = z.strictObject({ found: z.boolean(), reason: z.string() });
export type FeedbackVerdict = z.infer<typeof finding>;

/** Whether a reviewer's feedback names a known bug, however it words it. */
export function gradeFeedback(
	key: string,
	feedback: string,
	only: readonly JudgeName[] = allJudges,
): Promise<Judged<FeedbackVerdict>[]> {
	const prompt = [
		'A reviewer rejected a code change with the feedback below. The change has one known bug. Say whether the feedback identifies that bug, as its cause or its effect, so that someone fixing what the feedback says would fix it. Feedback that only names other problems does not.',
		`The known bug:\n---\n${key}\n---`,
		`The feedback:\n---\n${feedback}\n---`,
		'Answer with JSON only: {"found":true,"reason":"one sentence"}.',
	].join('\n\n');
	return askAll(prompt, finding, only);
}
