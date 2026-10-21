import { createHash, type Hash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// eslint-disable-next-line no-control-regex -- the escape that starts every terminal color
const colors = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const duration = String.raw`\d+(?:\.\d+)?\s?(?:ms|s|m|h)`;
const clock = String.raw`\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s?[AP]M)?`;
const anyTime = new RegExp(String.raw`\b(?:${clock}|${duration})\b`, 'g');

/**
 * The lines a known runner prints only to say when or for how long it ran, each with what of it
 * is a time. Anything else keeps its times: in `expected 1s, received 2s` they are what failed.
 */
const runnerTimes: { line: RegExp; time: RegExp }[] = [
	// Vitest's and Jest's summaries, and the last line of yarn, cargo or a build.
	{ line: /^\s*(?:Start at|Duration|Time:|Done in|Finished|finished in)\s/, time: anyTime },
	// cargo test's result, and pytest's summary between rules of `=`.
	{ line: /^\s*test result:|^=+ .* =+$/, time: anyTime },
	// Mocha's counts, such as "5 passing (12ms)".
	{ line: /^\s*\d+ (?:passing|failing|pending) \(/, time: anyTime },
	// A test or file reported with a mark or a status, such as Vitest's "✓ a.test.ts (3 tests)
	// 12ms", Jest's "PASS a.test.ts (5.1 s)" or Go's "--- FAIL: TestA (0.00s)": the time at its end.
	{
		line: /^\s*(?:[✓✔√×✗✕✘↓]|PASS\b|FAIL\b|ok\b|not ok\b|--- (?:PASS|FAIL|SKIP):)/,
		time: new RegExp(String.raw`\(?\b${duration}\)?\s*$`),
	},
	// Node's test runner, whose durations have no unit.
	{ line: /^\s*(?:[#ℹ] duration_ms|duration_ms:)\s/, time: /\d+(?:\.\d+)?\s*$/ },
	// `tsc --watch`, which starts each line with the time.
	{ line: new RegExp(String.raw`^\[?${clock}\]?\s`), time: new RegExp(`^\\[?${clock}\\]?`) },
	// `prettier --write`, such as "src/a.ts 12ms (unchanged)".
	{
		line: new RegExp(String.raw`^\S*[/.]\S*\s${duration}(?:\s\(unchanged\))?$`),
		time: new RegExp(String.raw`\b${duration}\b`),
	},
];

/** What a command printed without its colors, as the user is shown it. */
export function withoutColors(output: string): string {
	return output.replace(colors, '');
}

/** One line as two runs that ended alike print it: no colors, and no time a known runner adds. */
export function normalizedLine(line: string): string {
	const plain = withoutColors(line);
	const rule = runnerTimes.find(({ line: pattern }) => pattern.test(plain));
	return rule ? plain.replace(rule.time, '<time>') : plain;
}

// A line longer than this is hashed in pieces, unchanged: no runner prints its time in one.
const longestLine = 65_536;

/** One stream's lines, hashed as they arrive. */
class StreamFingerprint {
	private readonly decoder = new StringDecoder('utf8');
	private readonly hash: Hash = createHash('sha256');
	private partial = '';

	push(chunk: Buffer): void {
		this.add(this.decoder.write(chunk));
	}

	digest(): string {
		this.add(this.decoder.end());
		if (this.partial !== '') this.line(this.partial);
		return this.hash.digest('hex');
	}

	private add(text: string): void {
		const lines = (this.partial + text).split('\n');
		this.partial = lines.pop() ?? '';
		for (const line of lines) this.line(line);
		while (this.partial.length > longestLine) {
			this.hash.update(this.partial.slice(0, longestLine));
			this.partial = this.partial.slice(longestLine);
		}
	}

	private line(line: string): void {
		this.hash.update(`${normalizedLine(line.replace(/\r$/, ''))}\n`);
	}
}

/**
 * Everything a command printed, as one hash: every line, normalized, of its standard output and
 * its error apart, since their order between them can differ from one run to the next. Not only
 * the end its result keeps, so two failures that end alike but differ before are told apart.
 */
export class OutputFingerprint {
	private readonly streams = { stdout: new StreamFingerprint(), stderr: new StreamFingerprint() };

	push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
		this.streams[stream].push(chunk);
	}

	digest(): string {
		return createHash('sha256')
			.update(`${this.streams.stdout.digest()}\n${this.streams.stderr.digest()}`)
			.digest('hex');
	}
}
