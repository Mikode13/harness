import { GitWorkspace } from '../../src/tools/infrastructure/gitWorkspace.ts';
import { describeWorkspaceContract } from '../support/workspaceContract.ts';

// git is the fallback, and the one implementation every machine that has a repository can run.
describeWorkspaceContract('GitWorkspace', root => new GitWorkspace({ root }));
