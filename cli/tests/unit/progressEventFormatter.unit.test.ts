import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '../../../src/index.ts';
import { ProgressEventFormatter, type ProgressStyler } from '../../progressEventFormatter.ts';

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (value: string | undefined) => value?.replace(ansi, '');

describe('ProgressEventFormatter', () => {
	it('keeps a tool start in spinner state and prints one line when it ends', () => {
		let now = 100;
		const formatter = new ProgressEventFormatter({ now: () => now });
		const start: ProgressEvent = {
			type: 'tool',
			id: 'call-1',
			name: 'readFile',
			agent: 'planner',
			status: 'in_progress',
			summary: 'AGENTS.md:1-200',
		};

		expect(formatter.format(start)).toBeUndefined();
		expect(formatter.spinnerDescription()).toBe('planner readFile AGENTS.md:1-200');

		now = 108;
		expect(plain(formatter.format({ ...start, status: 'completed' }))).toBe(
			'\nplanner\n  ✓ planner | readFile | AGENTS.md:1-200 | 8 ms',
		);
		expect(formatter.spinnerDescription()).toBeUndefined();
	});

	it('prints a completed tool diff below its summary', () => {
		let now = 10;
		const formatter = new ProgressEventFormatter({ now: () => now });
		formatter.format({
			type: 'tool',
			id: 'edit',
			name: 'editFile',
			agent: 'executor',
			status: 'in_progress',
			summary: 'src/index.ts',
		});
		now = 10;
		const line = plain(
			formatter.format({
				type: 'tool',
				id: 'edit',
				name: 'editFile',
				agent: 'executor',
				status: 'completed',
				summary: 'src/index.ts',
				diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new',
			}),
		);

		expect(line).toBe(
			'\nexecutor\n  ✓ executor | editFile | src/index.ts | 0 ms\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new',
		);
	});

	it('uses separate icons for errors and denials, without appending a denied diff', () => {
		const formatter = new ProgressEventFormatter({ now: () => 10 });

		const errorLine = plain(
			formatter.format({
				type: 'tool',
				id: 'error',
				name: 'runCommand',
				agent: 'executor',
				status: 'error',
				summary: 'pnpm run check',
				diff: 'must not be printed in an error',
			}),
		);
		expect(errorLine).toContain('✗ executor | runCommand | pnpm run check | error');
		expect(errorLine).toMatch(/error$/);
		expect(errorLine).not.toContain('must not be printed in an error');
		expect(
			plain(
				formatter.format({
					type: 'tool',
					id: 'denied',
					name: 'runCommand',
					agent: 'executor',
					status: 'denied',
					summary: 'pnpm run format',
					diff: 'must not be printed',
				}),
			),
		).toBe('  ⊘ executor | runCommand | pnpm run format | denied');
	});

	it('shows command exit codes and tolerates missing command text', () => {
		const formatter = new ProgressEventFormatter();

		expect(
			plain(
				formatter.format({
					type: 'command',
					command: 'pnpm run check',
					exitCode: 1,
					agent: 'executor',
				}),
			),
		).toBe('\nexecutor\n  executor  command  pnpm run check  exit 1');
		expect(formatter.format({ type: 'command', command: '' })).toBeUndefined();
	});

	it('keeps long tool names visible and truncates only long summaries', () => {
		let now = 10;
		const formatter = new ProgressEventFormatter({ now: () => now });
		const start: ProgressEvent = {
			type: 'tool',
			id: 'long',
			name: 'str_replace_based_edit_tool',
			agent: 'executor',
			status: 'in_progress',
			summary: 'a very long summary that should be shortened to one column',
		};

		formatter.format(start);
		now = 1010;
		const line = plain(formatter.format({ ...start, status: 'completed' }));
		expect(line).toContain('str_replace_based_edit_tool');
		expect(line).toContain('| a very long summary that shou… | 1 s');
	});

	it('separates a command exit code and duration from the other columns', () => {
		let now = 10;
		const formatter = new ProgressEventFormatter({ now: () => now });
		const start: ProgressEvent = {
			type: 'tool',
			id: 'command',
			name: 'runCommand',
			agent: 'executor',
			status: 'in_progress',
			summary: 'pnpm run check',
		};

		formatter.format(start);
		now = 2010;
		expect(
			plain(
				formatter.format({
					...start,
					status: 'error',
					exitCode: 1,
				}),
			),
		).toContain('| pnpm run check | exit 1 · 2 s');
	});

	it('separates role headings, messages, and reasoning styles', () => {
		const formatter = new ProgressEventFormatter();

		const message = formatter.format({
			type: 'agentMessage',
			agent: 'planner',
			message: 'Plan',
		});
		expect(plain(message)).toBe('\nplanner\nPlan');

		const reasoning = formatter.format({
			type: 'reasoning',
			agent: 'planner',
			message: 'thinking',
		});
		expect(plain(reasoning)).toBe('thinking');
		// `styleText` intentionally follows the process color policy, so a non-TTY test
		// environment may return the same text without ANSI escapes.
		expect(reasoning).toBeDefined();
	});

	it('allows tests to verify role, message, tool and reasoning styles', () => {
		const style: ProgressStyler = (format, text) =>
			`<${String(format)}>${text}</${String(format)}>`;
		const formatter = new ProgressEventFormatter({ style });

		expect(formatter.format({ type: 'agentMessage', agent: 'planner', message: 'Plan' })).toBe(
			'\n<bold>planner</bold>\nPlan',
		);
		expect(
			formatter.format({
				type: 'reasoning',
				agent: 'planner',
				message: 'Thinking',
			}),
		).toBe('<dim><italic>Thinking</italic></dim>');

		formatter.format({
			type: 'tool',
			id: 'style',
			agent: 'planner',
			name: 'readFile',
			summary: 'README.md',
			status: 'in_progress',
		});
		expect(
			formatter.format({
				type: 'tool',
				id: 'style',
				agent: 'planner',
				name: 'readFile',
				summary: 'README.md',
				status: 'completed',
			}),
		).toBe('<dim>  ✓ planner | readFile | README.md | 0 ms</dim>');
	});

	it('shows reasoning in full by default and only headings in abbreviated mode', () => {
		const full = new ProgressEventFormatter();
		expect(
			plain(
				full.format({
					type: 'reasoning',
					message: '**Planning inspection steps**\nThe body is omitted in short mode.',
				}),
			),
		).toBe('**Planning inspection steps**\nThe body is omitted in short mode.');

		const headings = new ProgressEventFormatter({ thinkingHeadings: true });
		expect(
			plain(
				headings.format({
					type: 'reasoning',
					message: '**Planning inspection steps**\nThe body is omitted in short mode.',
				}),
			),
		).toBe('∴ Planning inspection steps');
		expect(
			headings.format({
				type: 'reasoning',
				agent: 'planner',
				message: 'No Markdown heading here.',
			}),
		).toBeUndefined();
	});

	it('clears pending calls when a turn is cancelled or ended', () => {
		let now = 100;
		const formatter = new ProgressEventFormatter({ now: () => now });
		const start: ProgressEvent = {
			type: 'tool',
			id: 'call-1',
			name: 'readFile',
			agent: 'executor',
			status: 'in_progress',
			summary: 'src/index.ts:1-20',
		};

		expect(formatter.format(start)).toBeUndefined();
		expect(formatter.spinnerDescription()).toBe('executor readFile src/index.ts:1-20');
		formatter.reset();
		now = 200;
		const completed = plain(formatter.format({ ...start, status: 'completed' }));
		expect(completed).toContain('✓ executor | readFile');
		expect(completed).not.toContain('100 ms');
		expect(formatter.spinnerDescription()).toBeUndefined();
	});

	it('ignores event types and optional fields it does not know', () => {
		const formatter = new ProgressEventFormatter();

		expect(formatter.format({ type: 'turnStarted' })).toBeUndefined();
		expect(formatter.format({ type: 'turnEnded' })).toBeUndefined();
		expect(
			formatter.format({
				type: 'routingDecision',
				flow: 'single-agent',
			} as unknown as ProgressEvent),
		).toBeUndefined();
	});
});
