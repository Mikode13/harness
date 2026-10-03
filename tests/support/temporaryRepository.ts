import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A real git repository in a temporary folder, holding every case the workspace boundary has
 * to get right. `root` is the repository; `outside` is a sibling folder no agent may reach.
 *
 * ```text
 * root/.gitignore                 ignores .env and node_modules
 * root/.env                       ignored, holds a secret
 * root/node_modules/pkg/index.js  ignored
 * root/.github/workflows/ci.yml   hidden but tracked
 * root/src/agent.ts               tracked
 * root/src/nested/loop.ts         tracked
 * root/src/flags.md               tracked, holds text that looks like a command-line flag
 * root/docs/new.md                new: neither tracked nor ignored
 * root/removed.ts                 tracked, but deleted from disk
 * root/image.bin                  tracked, binary
 * root/link.txt                   tracked symlink to outside/secret.txt
 * root/tracked-secret.txt         tracked, then ignored: committed before .gitignore named it
 * outside/secret.txt              outside the root
 * ```
 */
export function createTemporaryRepository() {
	// macOS hands out a symlinked temporary folder; the real path is what a workspace resolves.
	const parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-workspace-')));
	const root = join(parent, 'root');
	const outside = join(parent, 'outside');

	const write = (base: string, path: string, content: string | Buffer) => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), content);
	};
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
			cwd: root,
			stdio: 'pipe',
		});

	write(outside, 'secret.txt', 'outside needle\n');

	write(root, '.gitignore', '.env\nnode_modules\n');
	write(root, '.env', 'API_KEY=needle-secret\n');
	write(root, 'node_modules/pkg/index.js', "export const needle = 'in a dependency';\n");
	write(root, '.github/workflows/ci.yml', 'name: needle-ci\n');
	write(
		root,
		'src/agent.ts',
		'export const needle = 1;\nexport function run() {}\nconst version = 42;\n',
	);
	write(root, 'src/nested/loop.ts', '// Needle in a comment\nconst needle = 2;\n');
	write(root, 'src/flags.md', 'use --files to list\n');
	write(root, 'removed.ts', 'const needle = "removed";\n');
	write(root, 'image.bin', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0xff, 0x00]));
	symlinkSync(join('..', 'outside', 'secret.txt'), join(root, 'link.txt'));
	write(root, 'tracked-secret.txt', 'TOKEN=needle-tracked\n');

	git('init', '--quiet');
	git('add', '--all');
	git('commit', '--quiet', '--message', 'fixture');

	// After the commit: one file git still tracks but the disk lost, one it has never seen, and
	// one it tracks that .gitignore now names. git keeps tracking that last one; ripgrep hides it.
	rmSync(join(root, 'removed.ts'));
	write(root, 'docs/new.md', 'a new needle\n');
	write(root, '.gitignore', '.env\nnode_modules\ntracked-secret.txt\n');

	return {
		root,
		outside,
		remove: () => {
			rmSync(parent, { recursive: true, force: true });
		},
	};
}
