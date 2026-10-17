import { z } from 'zod';
import type { Validator } from '#src/shared/domain/validator';
import type { ReviewerDecision } from '../../domain/model/reviewerDecision.ts';

const reviewerDecisionSchema = z.discriminatedUnion('decision', [
	z.object({ decision: z.literal('approved') }),
	z.object({ decision: z.literal('rejected'), feedback: z.string().trim().min(1) }),
]);

export class ReviewerDecisionValidator implements Validator<ReviewerDecision> {
	validate(input: unknown): ReviewerDecision | undefined {
		const result = reviewerDecisionSchema.safeParse(input);
		return result.success ? result.data : undefined;
	}
}
