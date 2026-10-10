import { isAbsolute, relative, sep } from 'node:path';

// Every name is compared in lower case: on macOS `.ENV` is the same file as `.env`.

/** File names that hold credentials wherever they are. */
const secretNames = new Set([
	'.env',
	'.envrc',
	'.netrc',
	'.pgpass',
	'.git-credentials',
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'id_ecdsa_sk',
	'id_ed25519_sk',
]);

/** Endings of key stores, private keys and state files that embed secrets. */
const secretEndings = [
	'.pem',
	'.key',
	'.p12',
	'.pfx',
	'.jks',
	'.keystore',
	'.tfstate',
	'.tfstate.backup',
];

/** `.env.local` and its kind hold real values; these endings mark a template to copy from. */
const environmentTemplates = ['.example', '.sample', '.template'];

/** Folders under the home directory that only hold credentials. */
const secretHomeFolders = [
	'.ssh',
	'.aws',
	'.gnupg',
	'.azure',
	'.kube',
	'.password-store',
	'.config/gcloud',
	'.config/gh',
	'Library/Keychains',
].map(folder => folder.toLowerCase());

/** Files under the home directory that hold registry or tool tokens. */
const secretHomeFiles = ['.npmrc', '.pypirc', '.docker/config.json', '.config/git/credentials'].map(
	file => file.toLowerCase(),
);

/** `path` below `folder`, as lower-case components, or undefined when it is not inside. */
function inside(folder: string, path: string): string | undefined {
	const below = relative(folder.toLowerCase(), path.toLowerCase());
	if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return undefined;
	return below.split(sep).join('/');
}

/** Whether a file or folder name is one of the usual credential files. */
export function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	if (secretNames.has(lower)) return true;
	if (lower.startsWith('.env.')) {
		return !environmentTemplates.some(ending => lower.endsWith(ending));
	}
	return secretEndings.some(ending => lower.endsWith(ending));
}

/**
 * Whether an absolute path names a file the harness treats as a secret by default. It goes by
 * names and places, so it is a filter for the usual suspects, not a detector: a key pasted into
 * an ordinary source file is not found.
 */
export function isSecretPath(path: string, home: string): boolean {
	const name = path.split(sep).at(-1) ?? '';
	if (isSecretName(name)) return true;

	const underHome = inside(home, path);
	if (underHome === undefined || underHome === '') return false;
	return (
		secretHomeFolders.some(folder => underHome === folder || underHome.startsWith(`${folder}/`)) ||
		secretHomeFiles.includes(underHome)
	);
}
