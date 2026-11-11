import { describe, expect, it } from 'vitest';
import { withoutControlSequences, withoutControlSequencesIn } from '../../terminalText.ts';

const esc = '\u001b';
const bel = '\u0007';

describe('withoutControlSequences', () => {
	it('keeps plain text, line feeds, tabs and non-ASCII text as they are', () => {
		expect(withoutControlSequences('one\n\ttwo · ✓ ñ')).toBe('one\n\ttwo · ✓ ñ');
	});

	it.each([
		['a color', `${esc}[31mred${esc}[0m`, 'red'],
		['a cursor move up and a line erase', `ok${esc}[2A${esc}[2Kfake`, 'okfake'],
		['a private mode change', `${esc}[?25lhidden cursor`, 'hidden cursor'],
		['a title set ended by BEL', `${esc}]0;owned${bel}text`, 'text'],
		['a hyperlink ended by ST', `${esc}]8;;https://x.test${esc}\\link${esc}]8;;${esc}\\`, 'link'],
		['a device control string', `${esc}Pq#0${esc}\\after`, 'after'],
		['a two-byte escape', `${esc}cclear ${esc}7saved`, 'clear saved'],
		['a charset designation', `${esc}(Bascii`, 'ascii'],
		['a one-character CSI', '\u009b31mred', 'red'],
		['a one-character OSC', `\u009d0;owned${bel}text`, 'text'],
	])('removes %s whole', (_case, text, shown) => {
		expect(withoutControlSequences(text)).toBe(shown);
	});

	it('removes an unterminated string command to the end, as the terminal would swallow it', () => {
		expect(withoutControlSequences(`before${esc}]0;never ends`)).toBe('before');
	});

	it('removes a lone escape at the end and any other control character', () => {
		expect(withoutControlSequences(`a\u0000b\u0008c\u007fd\u0085e${esc}`)).toBe('abcde');
	});

	it('drops a carriage return, so a line cannot overwrite what it follows', () => {
		expect(withoutControlSequences('Allow? yes\rAllow? no\r\n')).toBe('Allow? yesAllow? no\n');
	});

	it('keeps colors and weights with keepStyles, and removes everything else', () => {
		expect(
			withoutControlSequences(`${esc}[1mbold${esc}[22m ${esc}[2Aup${esc}]0;t${bel}`, {
				keepStyles: true,
			}),
		).toBe(`${esc}[1mbold${esc}[22m up`);
	});
});

describe('withoutControlSequencesIn', () => {
	it('cleans every string, however deep, and leaves other values alone', () => {
		expect(
			withoutControlSequencesIn({
				type: 'subagent',
				count: 2,
				done: false,
				event: { message: `${esc}[2Khi`, items: [{ text: `a\rb` }] },
			}),
		).toEqual({
			type: 'subagent',
			count: 2,
			done: false,
			event: { message: 'hi', items: [{ text: 'ab' }] },
		});
	});
});
