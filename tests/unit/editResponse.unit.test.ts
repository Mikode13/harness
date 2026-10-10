import { describe, expect, it } from 'vitest';
import {
	describeCreation,
	describeDeletion,
	describeModification,
} from '../../src/tools/domain/editResponse.ts';

const numbered = (count: number, prefix = 'line') =>
	Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`);

describe('what an edit returns', () => {
	it('numbers the lines around each of several changes, as the file now reads', () => {
		const before = numbered(20);
		const after = [...before];
		after[2] = 'CHANGED 3';
		after.splice(15, 0, 'INSERTED');

		expect(describeModification('a.txt', `${before.join('\n')}\n`, `${after.join('\n')}\n`)).toBe(
			[
				'Changed a.txt. It now reads, around the change:',
				'1: line 1',
				'2: line 2',
				'3: CHANGED 3',
				'4: line 4',
				'5: line 5',
				'…',
				'14: line 14',
				'15: line 15',
				'16: INSERTED',
				'17: line 16',
				'18: line 17',
			].join('\n'),
		);
	});

	it('shows CRLF lines without their \\r', () => {
		expect(describeModification('a.txt', 'a\r\nb\r\n', 'a\r\nB\r\n')).toBe(
			'Changed a.txt. It now reads, around the change:\n1: a\n2: B',
		);
	});

	it('shows a last line that lost or gained its newline', () => {
		expect(describeModification('a.txt', 'a\nb\n', 'a\nb')).toBe(
			'Changed a.txt. It now reads, around the change:\n1: a\n2: b',
		);
	});

	it('says when the file is now empty', () => {
		expect(describeModification('a.txt', 'a\n', '')).toBe('Changed a.txt. The file is now empty.');
	});

	it('shows the whole of a file that was empty', () => {
		expect(describeModification('a.txt', '', 'a\nb\n')).toBe(
			'Changed a.txt. It now reads, around the change:\n1: a\n2: b',
		);
	});

	it('confirms a creation with its size, and a deletion', () => {
		expect(describeCreation('a.txt', Buffer.from(''))).toBe('Created a.txt (0 lines, 0 bytes).');
		expect(describeCreation('a.txt', Buffer.from('one'))).toBe('Created a.txt (1 line, 3 bytes).');
		expect(describeDeletion('a.txt')).toBe('Deleted a.txt.');
	});
});
