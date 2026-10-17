import { Logger } from '#src/shared/infrastructure/logger';
import { WorkflowRunner, type RunnableStage } from '#src/workflow/domain/workflowRunner';
import type {
	CreateWorkflowOptions,
	Workflow,
	WorkflowStageName,
} from '#src/workflow/domain/workflow';

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
	const actual = value ?? fallback;
	if (!Number.isInteger(actual) || actual < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return actual;
}

/**
 * Builds a workflow from the consumer's stages. The types already check every `go` against the
 * stage it names; this checks the same for JavaScript callers, at construction rather than in the
 * middle of a paid run.
 */
export function createWorkflow<Inputs, Result, Initial extends WorkflowStageName<Inputs>>({
	initialStage,
	stages,
	maxAttempts,
	maxTransitions,
	logger = new Logger(),
}: CreateWorkflowOptions<Inputs, Result, Initial>): Workflow<Inputs[Initial], Result> {
	const runnable = new Map<string, RunnableStage>();
	for (const [name, stage] of Object.entries<RunnableStage>(stages)) {
		if (name.trim() === '') throw new RangeError('workflow stage names must be non-empty');
		if (stage.name !== name) {
			throw new RangeError(`workflow stage "${stage.name}" is listed as "${name}"`);
		}
		if (stage.maxAttempts !== undefined) positiveInteger(stage.maxAttempts, 'maxAttempts', 1);
		runnable.set(name, stage);
	}
	if (runnable.size === 0) throw new RangeError('stages must not be empty');
	if (!runnable.has(initialStage)) {
		throw new RangeError(`initial workflow stage is not among the stages: "${initialStage}"`);
	}

	return new WorkflowRunner<Inputs[Initial], Result>({
		initialStage,
		stages: runnable,
		maxAttempts: positiveInteger(maxAttempts, 'maxAttempts', 3),
		maxTransitions: positiveInteger(maxTransitions, 'maxTransitions', 100),
		logger,
	});
}
