import codeQuality from '@mikode13/code-quality/base';

// examples/ holds git-ignored local scripts outside every tsconfig project. The repositories the
// evals start from are checked by their own configuration, and one of them breaks the rules on purpose.
export default [{ ignores: ['examples/', 'evals/tasks/', 'evals/results/'] }, ...codeQuality];
