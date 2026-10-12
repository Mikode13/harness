import { describe, expect, it } from 'vitest';
import { formatSpinnerLine } from '../../spinner.ts';

describe('formatSpinnerLine', () => {
	it('does not truncate when the terminal width is unavailable', () => {
		expect(formatSpinnerLine('⠋', 'a long tool description', undefined)).toBe(
			'⠋ a long tool description',
		);
	});

	it('counts the icon and separating space within a narrow terminal width', () => {
		expect(formatSpinnerLine('⠋', 'abcdefgh', 5)).toBe('⠋ abc');
		expect(formatSpinnerLine('⠋', 'abcdefgh', 2)).toBe('⠋ ');
		expect(formatSpinnerLine('⠋', 'abcdefgh', 1)).toBe('⠋');
	});

	it('handles the minimum widths and a spinner without a description', () => {
		expect(formatSpinnerLine('⠋', 'abcdefgh', 0)).toBe('');
		expect(formatSpinnerLine('⠋', undefined, 1)).toBe('⠋');
		expect(formatSpinnerLine('⠋', undefined, 0)).toBe('');
	});

	it('uses the current width for each frame calculation', () => {
		const description = 'a changing terminal width';

		expect(formatSpinnerLine('⠋', description, 30)).toBe('⠋ a changing terminal width');
		expect(formatSpinnerLine('⠋', description, 10)).toBe('⠋ a changi');
	});
});
