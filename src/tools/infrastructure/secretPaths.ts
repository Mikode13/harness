import { isAbsolute, relative, sep } from 'node:path';

// Every name is compared in lower case: on macOS `.ENV` is the same file as `.env`.

/** File names that hold credentials wherever they are. */
const secretNames = new Set([
	'.env',
	'.envrc',
	'.netrc',
	'.pgpass',
	'.git-credentials',
	// Registry, deployment and vault tokens, which a project often commits next to its code.
	'.npmrc',
	'.pypirc',
	'.dev.vars',
	'.vault-token',
	'.htpasswd',
	'.dockercfg',
	'credentials.json',
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
	'.tfvars',
	'.tfvars.json',
	'.kdbx',
	// `prod.env` and its kind, which hold what `.env` does under another name.
	'.env',
];

/** `.env.local`, `.env-production`, `.env_local`: the values of one environment. */
const environmentPrefixes = ['.env.', '.env-', '.env_'];

/**
 * `.env.local` and its kind hold real values; these endings mark a template to copy from, after
 * any of the separators the prefixes use, so `.env-example` is a template as `.env.example` is.
 */
const environmentTemplates = ['example', 'sample', 'template'].flatMap(word =>
	['.', '-', '_'].map(separator => `${separator}${word}`),
);

/** Private keys under the usual names, so `id_rsa_work` or `id_ed25519-old` too. */
const privateKeyNames = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

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

/**
 * Files under the home directory that hold registry or tool tokens under a name that is not a
 * secret elsewhere. `.npmrc` and `.pypirc` are closed by name, wherever they are.
 */
const secretHomeFiles = ['.docker/config.json', '.config/git/credentials'].map(file =>
	file.toLowerCase(),
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
	if (environmentPrefixes.some(prefix => lower.startsWith(prefix))) {
		return !environmentTemplates.some(ending => lower.endsWith(ending));
	}
	// A public key is meant to be shared, whatever name its private key has.
	if (
		!lower.endsWith('.pub') &&
		privateKeyNames.some(key => ['_', '-', '.'].some(next => lower.startsWith(`${key}${next}`)))
	) {
		return true;
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
