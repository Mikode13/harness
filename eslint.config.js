import codeQuality from '@mikode13/code-quality/base';

// examples/ holds git-ignored local scripts outside every tsconfig project.
export default [{ ignores: ['examples/'] }, ...codeQuality];
