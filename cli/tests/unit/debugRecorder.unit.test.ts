import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugRecorder } from '../../debugRecorder.ts';

let parent: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-debug-')));
});

afterEach(() => {
	chmodSync(parent, 0o700);
	rmSync(parent, { recursive: true, force: true });
});

const startedAt = new Date('2026-10-20T10:00:00.000Z');
// Permissions do not stop root.
const asRoot = process.getuid?.() === 0;

describe('DebugRecorder', () => {
	it('keeps every event and each transcript in order, in a folder for the session', () => {
		const recorder = new DebugRecorder(parent, vi.fn(), startedAt);

		recorder.event({
			type: 'tool',
			id: 'c1',
			name: 'apply_patch',
			status: 'error',
			error: 'no match',
		});
		recorder.transcript({ agent: 'explorer', outcome: 'completed', content: { messages: [] } });
		recorder.transcript({ agent: 'planner', outcome: 'failed', content: { error: 'limit' } });
		recorder.transcript({
			delegation: { tool: 'commit', callId: 'c2', subagent: 1 },
			outcome: 'completed',
			content: {},
		});

		expect(recorder.folder).toBe(join(parent, '2026-10-20T10-00-00.000Z'));
		expect(readdirSync(recorder.folder).sort()).toEqual([
			'001-explorer-completed.json',
			'002-planner-failed.json',
			'003-commit-completed.json',
			'events.jsonl',
		]);
		const events = readFileSync(join(recorder.folder, 'events.jsonl'), 'utf8').trim().split('\n');
		expect(events.map(line => JSON.parse(line) as unknown)).toEqual([
			expect.objectContaining({ type: 'tool', status: 'error', error: 'no match' }),
		]);
		expect(
			JSON.parse(readFileSync(join(recorder.folder, '002-planner-failed.json'), 'utf8')),
		).toEqual({ agent: 'planner', outcome: 'failed', content: { error: 'limit' } });
	});

	it('keeps everything readable by this user only, whatever the umask', () => {
		const umask = process.umask(0o022);
		try {
			const recorder = new DebugRecorder(join(parent, 'debug'), vi.fn(), startedAt);
			recorder.event({ type: 'turnStarted' });
			recorder.transcript({ agent: 'executor', outcome: 'completed', content: {} });

			expect(statSync(recorder.folder).mode & 0o777).toBe(0o700);
			expect(statSync(join(parent, 'debug')).mode & 0o777).toBe(0o700);
			for (const file of ['events.jsonl', '001-executor-completed.json']) {
				expect(statSync(join(recorder.folder, file)).mode & 0o777).toBe(0o600);
			}
		} finally {
			process.umask(umask);
		}
	});

	it.skipIf(asRoot)('fails at once on a folder it cannot create', () => {
		chmodSync(parent, 0o500);

		expect(() => new DebugRecorder(join(parent, 'debug'), vi.fn(), startedAt)).toThrow();
	});

	it.skipIf(asRoot)('reports once that it cannot write, and stops recording', () => {
		const reportFailure = vi.fn();
		const recorder = new DebugRecorder(parent, reportFailure, startedAt);
		chmodSync(recorder.folder, 0o500);

		recorder.transcript({ outcome: 'completed', content: {} });
		recorder.transcript({ outcome: 'completed', content: {} });
		recorder.event({ type: 'turnEnded' });

		expect(reportFailure).toHaveBeenCalledOnce();
		expect(String(reportFailure.mock.calls[0]?.[0])).toContain(
			'nothing more is recorded for debugging',
		);
		chmodSync(recorder.folder, 0o700);
	});
});
