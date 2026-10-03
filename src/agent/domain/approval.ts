/**
 * How much one tool call can hurt, judged by the tool from that call's input:
 * - `safe` changes nothing, as with a read.
 * - `mutating` makes a change git can undo, as with creating a file.
 * - `destructive` loses something, as with overwriting or deleting a file.
 */
export type ToolRisk = 'safe' | 'mutating' | 'destructive';

/** A tool call waiting for someone to allow it. */
export interface ApprovalRequest {
	tool: string;
	/** What the model sent, unvalidated: the tool validates it only if the call is allowed. */
	input: unknown;
	risk: ToolRisk;
}

/** A denial's `reason` reaches the model, so it can try something else. */
export type ApprovalDecision =
	{ approved: true } | { approved: false; reason?: string | undefined };

/**
 * Decides one tool call at a time. A consumer that wants "don't ask again" remembers its own
 * answers, so the harness keeps no session state. A throw ends the run as an
 * `UnrecoverableError`.
 */
export type Approver = (
	request: ApprovalRequest,
	signal: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;
