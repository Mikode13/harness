import { afterEach, describe, expect, it, vi } from 'vitest';
import { Output } from '../../adapters/output.ts';

const esc = '\u001b';

function written(stream: NodeJS.WriteStream): () => string {
	const write = vi.spyOn(stream, 'write').mockImplementation(() => true);
	return () => write.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('Output', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints a message without the sequences that would drive the terminal', () => {
		const stdout = written(process.stdout);

		new Output().print(`model text${esc}[1A${esc}[2K${esc}[31m\rApprove? y`);

		expect(stdout()).toBe('model textApprove? y\n');
	});

	it("keeps the CLI's own styles in styled progress, and nothing else", () => {
		const stdout = written(process.stdout);

		new Output().printStyled(`${esc}[2mdim${esc}[22m${esc}]0;title\u0007`);

		expect(stdout()).toBe(`${esc}[2mdim${esc}[22m\n`);
	});

	it('prints an error with its message and cause, without control sequences', () => {
		const stderr = written(process.stderr);

		new Output().printError(
			new Error(`turn failed${esc}[2J`, { cause: new Error(`no credit${esc}]0;x\u0007`) }),
		);

		const shown = stderr();
		expect(shown).toContain('turn failed');
		expect(shown).toContain('no credit');
		expect(shown).not.toContain(esc);
	});
});
