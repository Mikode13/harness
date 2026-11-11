import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSecretPath } from '../../src/tools/infrastructure/secretPaths.ts';

const home = join('/', 'Users', 'me');
const repository = join(home, 'code', 'app');

describe('isSecretPath', () => {
	it.each([
		'.env',
		'.ENV',
		'.env.local',
		'.env.production',
		'.envrc',
		'.netrc',
		'.git-credentials',
		'id_rsa',
		'id_ed25519',
		'server.pem',
		'tls/server.key',
		'cert.p12',
		'release.jks',
		'infra/terraform.tfstate',
		'infra/terraform.tfstate.backup',
		'.env-production',
		'.env_local',
		'.ENV-Staging',
		'prod.env',
		'config/staging.env',
		'.npmrc',
		'packages/web/.npmrc',
		'.pypirc',
		'.dev.vars',
		'.vault-token',
		'.htpasswd',
		'.dockercfg',
		'credentials.json',
		'infra/terraform.tfvars',
		'infra/prod.auto.tfvars.json',
		'passwords.kdbx',
		'id_rsa_work',
		'id_ed25519-old',
		'id_ecdsa.bak',
		'id_dsa_legacy',
	])('treats %s as a secret anywhere', path => {
		expect(isSecretPath(join(repository, path), home)).toBe(true);
	});

	it.each([
		'.env.example',
		'.env.sample',
		'.env.template',
		'.env.local.example',
		// A template ending wins after any separator an environment file's name uses.
		'.env-example',
		'.env_sample',
		'.env-production.template',
		'id_rsa.pub',
		'id_rsa_work.pub',
		'id_ed25519-old.pub',
		'id_rsassa.ts',
		'src/keys.ts',
		'monkey',
		'environment.ts',
		'dotenv.ts',
		'src/env.ts',
		'.venv',
		'prod.env.example',
		'credentials.ts',
		'variables.tf',
	])('lets %s through in a repository', path => {
		expect(isSecretPath(join(repository, path), home)).toBe(false);
	});

	it.each([
		'.ssh/config',
		'.ssh/known_hosts',
		'.aws/credentials',
		'.config/gcloud/application_default_credentials.json',
		'.config/gh/hosts.yml',
		'.kube/config',
		'.gnupg/private-keys-v1.d/key',
		'Library/Keychains/login.keychain-db',
		'.npmrc',
		'.pypirc',
		'.docker/config.json',
		'.SSH/config',
	])('treats ~/%s as a secret', path => {
		expect(isSecretPath(join(home, path), home)).toBe(true);
	});

	it.each(['notes.txt', '.config/other/settings.json', '.docker/daemon.json', '.sshrc'])(
		'lets ~/%s through',
		path => {
			expect(isSecretPath(join(home, path), home)).toBe(false);
		},
	);
});
