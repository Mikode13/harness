// The sequences a terminal acts on instead of showing, each matched whole so nothing of it is left:
// a CSI (`ESC [`, or its one-character form), with its parameters and final character; a string
// command (OSC, DCS, SOS, PM, APC) up to its BEL or ST, or to the end of the text when it has
// none, since a terminal would swallow that much too; and any other escape, `ESC` with its
// intermediates and final character.
const escapeSequence =
	// eslint-disable-next-line no-control-regex -- matching control characters is the point
	/\u001b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|[ -/]*[0-~])|\u009b[0-?]*[ -/]*[@-~]|[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;

// Every other C0 and C1 control character, and DEL, except the line feed and the tab. A carriage
// return goes too: alone, it lets a line overwrite what was printed before it on the same line.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const controlCharacter = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// The color and weight sequences the CLI's own `styleText` writes.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const style = /\u001b\[[0-9;]*m/g;

/**
 * `text` as the terminal should show it, without what would make the terminal act instead: what
 * a model writes could otherwise move the cursor, rewrite or hide earlier lines, such as those
 * before an approval question, or change the window's title. With `keepStyles`, the color and
 * weight sequences survive, for text whose every untrusted part was cleaned before it was styled.
 */
export function withoutControlSequences(text: string, { keepStyles = false } = {}): string {
	if (!keepStyles) return clean(text);

	// Only the text between the styles is cleaned; the styles are written as they are.
	const kept: string[] = [];
	let from = 0;
	for (const match of text.matchAll(style)) {
		kept.push(clean(text.slice(from, match.index)), match[0]);
		from = match.index + match[0].length;
	}
	kept.push(clean(text.slice(from)));
	return kept.join('');
}

function clean(text: string): string {
	return text.replace(escapeSequence, '').replace(controlCharacter, '');
}

/** `value` with every string in it, however deep, cleaned by `withoutControlSequences`. */
export function withoutControlSequencesIn<Value>(value: Value): Value {
	return cleanValue(value) as Value;
}

function cleanValue(value: unknown): unknown {
	if (typeof value === 'string') return clean(value);
	if (Array.isArray(value)) return value.map(cleanValue);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, field]) => [key, cleanValue(field)]),
		);
	}
	return value;
}
