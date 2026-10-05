import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryStore, RunJournal } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { AccessDeniedError } from '../../src/tools/domain/accessPolicy.ts';
import {
	EditRefusedError,
	EditUnconfirmedError,
	type FileChange,
} from '../../src/tools/domain/fileEdits.ts';
import { FileEditor } from '../../src/tools/infrastructure/fileEditor.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { WriteSession } from '../../src/tools/infrastructure/writeSession.ts';

/**
 * ```text
 * parent/repo/
 *   .gitignore     ignores node_modules
 *   tracked.ts     committed, then changed and not committed: the user's work in progress
 *   clean.ts       committed and unchanged
 *   untracked.ts   never added
 *   AGENTS.md, CLAUDE.md -> AGENTS.md
 * parent/state/    the recovery store
 * ```
 */
let parent: string;
let repo: string;
let store: FileRecoveryStore;
let session: WriteSession;
// Every session a test opened, so each one's journal is finished and its lock released.
let sessions: WriteSession[] = [];
let editor: FileEditor;
const signal = new AbortController().signal;

const file = (path: string) => join(repo, path);
const read = (path: string) => readFileSync(file(path), 'utf8');

function write(path: string, content: string) {
	mkdirSync(dirname(file(path)), { recursive: true });
	writeFileSync(file(path), content);
}

async function makeEditor(recovery: RecoveryStore = store) {
	session = new WriteSession({ store: recovery });
	sessions.push(session);
	const policy = await RootsAccessPolicy.create({
		roots: [{ path: repo, access: 'write' }],
		ignoreRules: new GitIgnoreRules(),
	});
	return new FileEditor({ policy, session });
}

/** Prepares and applies a change, as a tool does once nothing stops it. */
async function change(request: FileChange, run = editor) {
	await run.apply(await run.prepare(request, signal), signal);
}

const text = (content: string) => Buffer.from(content);

async function entries() {
	const runId = await session.runId();
	if (!runId) return [];
	return (await store.readRun(runId)).entries;
}

async function refusal(promise: Promise<unknown>) {
	const error: unknown = await promise.then(
		() => undefined,
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(Error);
	// The model only ever sees the path it sent.
	expect((error as Error).message).not.toContain(parent);
	return error as Error;
}

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-editor-')));
	repo = join(parent, 'repo');
	mkdirSync(repo);
	write('.gitignore', 'node_modules\n');
	write('tracked.ts', 'committed\n');
	write('clean.ts', 'clean\n');
	write('AGENTS.md', '# agents\n');
	symlinkSync('AGENTS.md', file('CLAUDE.md'));
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.st', ...args], {
			cwd: repo,
			stdio: 'pipe',
		});
	git('init', '--quiet');
	git('add', '--all');
	git('commit', '--quiet', '--message', 'fixture');
	write('tracked.ts', 'work in progress\n');
	write('untracked.ts', 'not added yet\n');

	store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
	editor = await makeEditor();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const opened of sessions) await opened.finish('completed');
	sessions = [];
	rmSync(parent, { recursive: true, force: true });
});

describe('FileEditor', () => {
	describe('changes it makes, and what it keeps to undo them', () => {
		it('creates a file and the folders it needs, and records both', async () => {
			await change({ kind: 'create', path: 'src/new/a.ts', content: text('export {};\n') });

			expect(read('src/new/a.ts')).toBe('export {};\n');
			const [entry] = await entries();
			expect(entry).toMatchObject({
				path: file('src/new/a.ts'),
				before: { exists: false },
				after: { exists: true },
				createdFolders: [file('src'), file('src/new')],
				status: 'applied',
			});
		});

		// The point of the store: the user's uncommitted work survives the agent's edit.
		it('keeps the uncommitted content a replaced file held, not the committed one', async () => {
			await change({ kind: 'replace', path: 'tracked.ts', content: text('agent version\n') });

			expect(read('tracked.ts')).toBe('agent version\n');
			const [entry] = await entries();
			expect(entry?.status).toBe('applied');
			const before = entry?.before;
			expect(before?.exists).toBe(true);
			if (before?.exists) {
				await expect(store.readContent(before.hash)).resolves.toEqual(text('work in progress\n'));
			}
		});

		it('keeps the content of an untracked file it replaces', async () => {
			await change({ kind: 'replace', path: 'untracked.ts', content: text('changed\n') });

			const [entry] = await entries();
			if (entry?.before.exists) {
				await expect(store.readContent(entry.before.hash)).resolves.toEqual(
					text('not added yet\n'),
				);
			} else {
				expect.unreachable('the replaced file existed');
			}
		});

		it('deletes a file and keeps what it held', async () => {
			await change({ kind: 'delete', path: 'untracked.ts' });

			expect(existsSync(file('untracked.ts'))).toBe(false);
			const [entry] = await entries();
			expect(entry).toMatchObject({ after: { exists: false }, status: 'applied' });
			if (entry?.before.exists) {
				await expect(store.readContent(entry.before.hash)).resolves.toEqual(
					text('not added yet\n'),
				);
			}
		});

		it('writes through a symlink to the file it leads to, and leaves the link alone', async () => {
			await change({ kind: 'replace', path: 'CLAUDE.md', content: text('# changed\n') });

			expect(read('AGENTS.md')).toBe('# changed\n');
			expect(read('CLAUDE.md')).toBe('# changed\n');
			const [entry] = await entries();
			expect(entry?.path).toBe(file('AGENTS.md'));
		});

		it('keeps the mode of a file it replaces', async () => {
			chmodSync(file('clean.ts'), 0o755);

			await change({ kind: 'replace', path: 'clean.ts', content: text('changed\n') });

			expect(statSync(file('clean.ts')).mode & 0o777).toBe(0o755);
		});

		it('records the mode a new file really gets', async () => {
			await change({ kind: 'create', path: 'b.ts', content: text('b\n') });

			const [entry] = await entries();
			expect(entry?.after).toMatchObject({ mode: statSync(file('b.ts')).mode & 0o7777 });
		});

		it('leaves no temporary file behind', async () => {
			await change({ kind: 'replace', path: 'clean.ts', content: text('changed\n') });
			await change({ kind: 'create', path: 'c.ts', content: text('c\n') });

			const listing = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
				cwd: repo,
				encoding: 'utf8',
			});
			expect(listing).not.toContain('mikode-tmp');
		});
	});

	describe('changes it refuses without writing anything', () => {
		it('refuses to create a file that exists', async () => {
			const error = await refusal(change({ kind: 'create', path: 'clean.ts', content: text('x') }));

			expect(error).toBeInstanceOf(EditRefusedError);
			expect(error.message).toContain('already exists');
			expect(read('clean.ts')).toBe('clean\n');
			expect(await session.runId()).toBeUndefined();
		});

		it.each([
			{ kind: 'replace', path: 'missing.ts', content: text('x') },
			{ kind: 'delete', path: 'missing.ts' },
		] as const)('refuses to $kind a file that does not exist', async request => {
			expect((await refusal(change(request))).message).toContain('does not exist');
		});

		it('refuses a change worked out from content the file no longer holds', async () => {
			const error = await refusal(
				change({ kind: 'replace', path: 'clean.ts', content: text('x'), expected: 'f'.repeat(64) }),
			);

			expect(error.message).toContain('changed since it was read');
			expect(read('clean.ts')).toBe('clean\n');
		});

		it('writes what was prepared, even if the caller changes its buffer before applying', async () => {
			const bytes = text('approved\n');
			const prepared = await editor.prepare(
				{ kind: 'replace', path: 'clean.ts', content: bytes },
				signal,
			);
			bytes.write('mutated!');

			await editor.apply(prepared, signal);

			expect(read('clean.ts')).toBe('approved\n');
			expect(Object.isFrozen(prepared.target)).toBe(true);
			expect(Object.isFrozen(prepared.before)).toBe(true);
		});

		it('refuses a prepared change once the file changed under it', async () => {
			const prepared = await editor.prepare(
				{ kind: 'replace', path: 'clean.ts', content: text('agent\n') },
				signal,
			);
			write('clean.ts', 'the user typed this meanwhile\n');

			const error = await refusal(editor.apply(prepared, signal));

			expect(error.message).toContain('changed after this change was prepared');
			expect(read('clean.ts')).toBe('the user typed this meanwhile\n');
			expect(await entries()).toEqual([]);
		});

		it('refuses a prepared creation once something took the path', async () => {
			const prepared = await editor.prepare(
				{ kind: 'create', path: 'd.ts', content: text('agent\n') },
				signal,
			);
			write('d.ts', 'someone else\n');

			await refusal(editor.apply(prepared, signal));

			expect(read('d.ts')).toBe('someone else\n');
		});

		it('refuses content that is already there', async () => {
			expect(
				(await refusal(change({ kind: 'replace', path: 'clean.ts', content: text('clean\n') })))
					.message,
			).toContain('already holds that content');
		});

		it('refuses a file larger than its limit', async () => {
			const policy = await RootsAccessPolicy.create({
				roots: [{ path: repo, access: 'write' }],
				ignoreRules: new GitIgnoreRules(),
			});
			const small = new FileEditor({ policy, session, maxFileBytes: 4 });

			expect(
				(await refusal(change({ kind: 'create', path: 'big.ts', content: text('too big') }, small)))
					.message,
			).toContain('larger than');
		});

		it.each(['.env', '../outside.ts', 'node_modules/x.js', '.git/config'])(
			'leaves %s to the access policy',
			async path => {
				const target = join(repo, path);
				const held = existsSync(target) ? readFileSync(target, 'utf8') : undefined;

				const error = await refusal(change({ kind: 'create', path, content: text('x') }));

				expect(error).toBeInstanceOf(AccessDeniedError);
				expect(existsSync(target) ? readFileSync(target, 'utf8') : undefined).toBe(held);
			},
		);

		it('refuses a folder', async () => {
			mkdirSync(file('folder'));

			expect(
				(await refusal(change({ kind: 'replace', path: 'folder', content: text('x') }))).message,
			).toContain('not a regular file');
		});
	});

	describe('when recording or writing fails', () => {
		/** The test store, with some of its journal's steps replaced. */
		function storeWith(override: (journal: RunJournal) => Partial<RunJournal>): RecoveryStore {
			return {
				startRun: async () => {
					const journal = await store.startRun();
					const wrapped: RunJournal = {
						runId: journal.runId,
						saveContent: content => journal.saveContent(content),
						prepare: change => journal.prepare(change),
						applied: sequence => journal.applied(sequence),
						abandoned: sequence => journal.abandoned(sequence),
						finish: status => journal.finish(status),
					};
					return { ...wrapped, ...override(wrapped) };
				},
				readRun: id => store.readRun(id),
				readContent: hash => store.readContent(hash),
			};
		}

		/** A store whose journal fails at the step named, and works otherwise. */
		function failingStore(step: 'saveContent' | 'prepare'): RecoveryStore {
			return storeWith(() => ({ [step]: () => Promise.reject(new Error('disk full')) }));
		}

		it.each(['saveContent', 'prepare'] as const)(
			'changes nothing when the journal cannot %s',
			async step => {
				const failing = await makeEditor(failingStore(step));

				const error = await refusal(
					change({ kind: 'replace', path: 'tracked.ts', content: text('agent\n') }, failing),
				);

				expect(error).toBeInstanceOf(EditRefusedError);
				expect(error.message).toContain('could not record how to undo');
				expect(read('tracked.ts')).toBe('work in progress\n');
			},
		);

		const notRecorded = () => Promise.reject(new Error('disk full'));

		/** Expects a change that was made but not recorded as made: reported, kept, and the end. */
		async function expectUnconfirmed(apply: Promise<void>, run: FileEditor) {
			const error = await refusal(apply);
			expect(error).toBeInstanceOf(EditUnconfirmedError);
			expect(error.message).toContain(
				'"clean.ts" was changed, but the harness could not record it',
			);
			expect(read('clean.ts')).toBe('agent\n');
			// Kept as prepared: an undo can still compare the file with both of its states.
			expect((await entries())[0]?.status).toBe('prepared');
			expect(
				(await refusal(change({ kind: 'create', path: 'next.ts', content: text('n') }, run)))
					.message,
			).toContain('Writing stopped');
		}

		it('reports a change it made but could not record as made', async () => {
			const failing = await makeEditor(storeWith(() => ({ applied: notRecorded })));

			await expectUnconfirmed(
				change({ kind: 'replace', path: 'clean.ts', content: text('agent\n') }, failing),
				failing,
			);
		});

		it('reports a change a failed write made anyway but could not record as made', async () => {
			const handle = await open(join(parent, 'probe'), 'w');
			await handle.close();
			const prototype = Object.getPrototypeOf(handle) as FileHandle;
			const sync = Reflect.get(prototype, 'sync');
			let failFolderSync = false;
			// The file is renamed into place, then syncing its folder fails.
			vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
				if (failFolderSync && (await this.stat()).isDirectory()) {
					failFolderSync = false;
					throw Object.assign(new Error('input/output error'), { code: 'EIO' });
				}
				await Reflect.apply(sync, this, []);
			});
			const failing = await makeEditor(
				storeWith(journal => ({
					prepare: async change => {
						const sequence = await journal.prepare(change);
						failFolderSync = true;
						return sequence;
					},
					applied: notRecorded,
				})),
			);

			await expectUnconfirmed(
				change({ kind: 'replace', path: 'clean.ts', content: text('agent\n') }, failing),
				failing,
			);
		});

		it('abandons a change it could not write, and removes the folders it made for it', async () => {
			mkdirSync(file('locked'));
			chmodSync(file('locked'), 0o555);
			try {
				const error = await refusal(
					change({ kind: 'create', path: 'locked/deep/e.ts', content: text('e\n') }),
				);

				expect(error.message).toMatch(/Could not write "locked\/deep\/e.ts" \(EACCES\)/);
				expect(existsSync(file('locked/deep'))).toBe(false);
				const [entry] = await entries();
				expect(entry?.status).toBe('abandoned');
			} finally {
				chmodSync(file('locked'), 0o755);
			}
		});

		it('abandons a change cancelled after it was recorded, before writing', async () => {
			const controller = new AbortController();
			const prepared = await editor.prepare(
				{ kind: 'replace', path: 'clean.ts', content: text('agent\n') },
				controller.signal,
			);
			const recording = storeWith(journal => ({
				prepare: async change => {
					const sequence = await journal.prepare(change);
					controller.abort();
					return sequence;
				},
			}));
			const cancelling = await makeEditor(recording);

			await expect(cancelling.apply(prepared, controller.signal)).rejects.toHaveProperty(
				'name',
				'AbortError',
			);

			expect(read('clean.ts')).toBe('clean\n');
			expect((await entries())[0]?.status).toBe('abandoned');
		});
	});
});

describe('WriteSession', () => {
	it('does not hold the workspace until the first change', async () => {
		await editor.prepare({ kind: 'create', path: 'f.ts', content: text('f') }, signal);

		expect(await session.runId()).toBeUndefined();
		// Another session can still start writing.
		const other = new WriteSession({ store });
		await (await other.journalForChange()).finish('completed');
	});

	it('turns a second writer away while the first one writes', async () => {
		await change({ kind: 'create', path: 'g.ts', content: text('g') });
		const second = await makeEditor();

		const error = await refusal(
			change({ kind: 'create', path: 'h.ts', content: text('h') }, second),
		);

		expect(error.message).toContain('Another run is writing');
		expect(existsSync(file('h.ts'))).toBe(false);
	});

	it('stops at its limit of changes', async () => {
		const policy = await RootsAccessPolicy.create({
			roots: [{ path: repo, access: 'write' }],
			ignoreRules: new GitIgnoreRules(),
		});
		session = new WriteSession({ store, maxChanges: 1 });
		sessions.push(session);
		const limited = new FileEditor({ policy, session });
		await change({ kind: 'create', path: 'i.ts', content: text('i') }, limited);

		expect(
			(await refusal(change({ kind: 'create', path: 'j.ts', content: text('j') }, limited)))
				.message,
		).toContain('the most one run may make');
	});

	it('refuses every write once stopped', async () => {
		session.stop('Writing stopped: test');

		expect(
			(await refusal(change({ kind: 'create', path: 'k.ts', content: text('k') }))).message,
		).toBe('Writing stopped: test');
		expect(existsSync(file('k.ts'))).toBe(false);
	});

	it('marks the run finished and frees the workspace', async () => {
		await change({ kind: 'create', path: 'l.ts', content: text('l') });
		const runId = await session.runId();
		await session.finish('failed');

		expect((await store.readRun(runId ?? '')).record.status).toBe('failed');
		const next = new WriteSession({ store });
		await (await next.journalForChange()).finish('completed');
	});
});
