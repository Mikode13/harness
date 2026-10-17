import { describe, expect, it } from 'vitest';
import { isAbortError } from '../../src/index.ts';

describe('isAbortError', () => {
	it('recognizes a cancellation and a timeout, and nothing else', () => {
		expect(isAbortError(AbortSignal.abort().reason)).toBe(true);
		expect(isAbortError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
		expect(isAbortError(new Error('failed'))).toBe(false);
		expect(isAbortError('AbortError')).toBe(false);
		expect(isAbortError({ name: 'AbortError' })).toBe(false);
	});
});
