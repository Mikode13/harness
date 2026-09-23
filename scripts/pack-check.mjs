import { runPackageManager } from '@mikode13/cross-platform';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts` file under `src`, relative to `src`, so the walk survives future subdirectories. */
async function sourceFiles(directory, prefix = '') {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const relative = path.posix.join(prefix, entry.name);

		if (entry.isDirectory()) {
			files.push(...(await sourceFiles(path.join(directory, entry.name), relative)));
		} else if (entry.name.endsWith('.ts')) {
			files.push(relative);
		}
	}

	return files;
}

/** Every emitted source map must carry the source it references into the published package. */
async function sourceMapProblems(files) {
	const problems = [];

	for (const file of files.filter(file => file.endsWith('.map'))) {
		const map = JSON.parse(await readFile(path.join(repositoryRoot, file), 'utf8'));
		const sources = Array.isArray(map.sources) ? map.sources : [];
		const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];

		if (
			sources.length === 0 ||
			sourcesContent.length !== sources.length ||
			sourcesContent.some(content => typeof content !== 'string')
		) {
			problems.push(`Source map is not self-contained: ${file}`);
		}
	}

	return problems;
}

const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));

// The shared Node configuration enables `declaration`, `declarationMap`, and `sourceMap`,
// so every source file emits exactly these four artifacts.
const emitted = (await sourceFiles(path.join(repositoryRoot, 'src'))).flatMap(source => {
	const base = `dist/${source.replace(/\\.ts$/, '')}`;
	return [`${base}.js`, `${base}.js.map`, `${base}.d.ts`, `${base}.d.ts.map`];
});

// npm always includes these three regardless of the `files` field. LICENSE is required in
// every published artifact by the MiKode licensing standard. `cli/` is a workspace project,
// not part of the published package, so nothing from it should ever appear here.
const expected = new Set([...emitted, 'LICENSE', 'package.json', 'README.md']);

// `runPackageManager` spawns the package manager through its own entry point, so the check
// also runs on Windows, where `pnpm` is a `.cmd` shim that `execFile` refuses to execute.
const { stdout } = await runPackageManager(['pack', '--dry-run', '--json'], {
	cwd: repositoryRoot,
});

// `pnpm pack` prints the lifecycle output of `prepare` and `prepack` before the JSON.
const packed = JSON.parse(stdout.slice(stdout.indexOf('{')));
const actual = new Set(packed.files.map(file => file.path));

const missing = [...expected].filter(file => !actual.has(file)).sort();
const unexpected = [...actual].filter(file => !expected.has(file)).sort();

const problems = [];

problems.push(...(await sourceMapProblems(emitted)));

if (missing.length > 0) {
	problems.push(`Missing from the tarball:\n${missing.map(file => `  - ${file}`).join('\n')}`);
}

if (unexpected.length > 0) {
	problems.push(
		`Unexpected in the tarball:\n${unexpected.map(file => `  - ${file}`).join('\n')}\n` +
			'  Output of a renamed or deleted source file is the usual cause; `pnpm run build`\n' +
			'  removes `dist` first, so a stale file here means the tarball was not rebuilt.',
	);
}

// The manifest's own promises to consumers: a declared entry point that is absent from the
// tarball produces a package that fails on `import`, which a file-set check alone can miss.
const entryPoints = [
	['main', manifest.main],
	['types', manifest.types],
	...Object.entries(manifest.exports ?? {}).flatMap(([key, value]) =>
		typeof value === 'string'
			? [[`exports["${key}"]`, value]]
			: Object.entries(value).map(([condition, target]) => [
					`exports["${key}"].${condition}`,
					target,
				]),
	),
	...Object.entries(manifest.bin ?? {}).map(([key, value]) => [`bin.${key}`, value]),
];

const unresolved = entryPoints
	.filter(([, target]) => typeof target === 'string')
	.filter(([, target]) => !actual.has(path.posix.normalize(target.replace(/^\.\//, ''))));

if (unresolved.length > 0) {
	problems.push(
		`Declared entry points absent from the tarball:\n${unresolved
			.map(([field, target]) => `  - ${field} -> ${target}`)
			.join('\n')}`,
	);
}

if (problems.length > 0) {
	process.stderr.write(`${problems.join('\n\n')}\n`);
	process.exit(1);
}

process.stdout.write(
	`The publishable tarball contains exactly the ${expected.size} expected files, ` +
		`and every declared entry point is present.\n`,
);
