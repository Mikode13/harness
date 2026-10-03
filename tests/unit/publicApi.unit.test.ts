import { describe, expect, it } from 'vitest';
import * as harness from '../../src/index.ts';

describe('public API', () => {
	// Everything src/index.ts exports is public: removing a value is a breaking change, and
	// adding one is a feature. Type-only exports are checked by the compiler, not here.
	it('exports exactly these values', () => {
		expect(Object.keys(harness).sort()).toEqual([
			'InvalidAgentConfigError',
			'RecoverableError',
			'UnrecoverableError',
			'agentProviders',
			'createAgent',
			'createLLMAgent',
			'createLLMOrchestrator',
			'createOrchestrator',
			'createWorkspace',
			'createWorkspaceTools',
			'defineTool',
			'isAbortError',
			'isAgentProvider',
		]);
	});
});
