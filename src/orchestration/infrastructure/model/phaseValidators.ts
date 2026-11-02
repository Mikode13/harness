import { z } from 'zod';
import type { Validator } from '#src/shared/domain/validator';
import type { PhaseReport, PhaseReview, Plan } from '../../domain/model/phases.ts';

const text = z.string().trim().min(1);

const phaseReportSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('done'), summary: text }),
	z.object({ status: z.literal('replan'), reason: text }),
]);

const phaseReviewSchema = z.discriminatedUnion('decision', [
	z.object({ decision: z.literal('approved') }),
	z.object({ decision: z.literal('rejected'), feedback: text }),
	z.object({ decision: z.literal('replan'), feedback: text }),
]);

function validator<Output>(schema: z.ZodType<Output>): Validator<Output> {
	return { validate: input => schema.safeParse(input).data };
}

/** A plan of one to `maxPhases` phases, each with a goal and what makes it done. */
export function planValidator(maxPhases: number): Validator<Plan> {
	return validator(
		z.object({
			summary: text,
			phases: z
				.array(z.object({ goal: text, files: z.array(z.string()), done: text }))
				.min(1)
				.max(maxPhases),
		}),
	);
}

export const phaseReportValidator: Validator<PhaseReport> = validator(phaseReportSchema);

export const phaseReviewValidator: Validator<PhaseReview> = validator(phaseReviewSchema);
