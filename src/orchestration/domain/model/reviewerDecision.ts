export type ReviewerDecision =
	{ decision: 'approved' } | { decision: 'rejected'; feedback: string };
