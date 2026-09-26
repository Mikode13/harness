import { UnrecoverableError } from '../../agent/domain/errors.ts';

/** The context no longer fits the model's window; the agent must compact before sending again. */
export class MaxContextError extends UnrecoverableError {}
