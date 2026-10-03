import { rgPath } from '@vscode/ripgrep';
import { RipgrepWorkspace } from '../../src/tools/infrastructure/ripgrepWorkspace.ts';
import { describeWorkspaceContract } from '../support/workspaceContract.ts';

// The binary ships with the package (`@vscode/ripgrep`), so this runs on every machine and in CI.
describeWorkspaceContract(
	'RipgrepWorkspace',
	root => new RipgrepWorkspace({ root, ripgrepPath: rgPath }),
);
