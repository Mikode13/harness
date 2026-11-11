import { describe, expect, it } from 'vitest';
import { startupNotice } from '../../startupNotice.ts';

describe('startupNotice', () => {
	it('warns, without --llm, that the agents run unchecked and /undo cannot take their changes back', () => {
		const notice = startupNotice({ llm: false });

		expect(notice).toContain('permission checks bypassed');
		expect(notice).toContain('in this folder');
		expect(notice).toContain('/undo cannot take them back');
		expect(notice).toContain('--llm to be asked before each destructive call');
		expect(notice).not.toContain('\n');
	});

	it('says nothing with --llm, which asks before each destructive call', () => {
		expect(startupNotice({ llm: true })).toBeUndefined();
	});
});
