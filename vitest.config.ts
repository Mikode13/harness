import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors the `#src/*` entry of `imports` in package.json under its source condition, so
// tests run against `src/` and never against a stale `dist/`.
const resolve = {
	alias: [
		{
			find: /^#src\/(.*)$/,
			replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1.ts`,
		},
	],
};

export default defineConfig({
	test: {
		projects: [
			{
				resolve,
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.unit.test.ts'],
				},
			},
			{
				resolve,
				test: {
					name: 'cli',
					include: ['cli/tests/unit/**/*.unit.test.ts'],
				},
			},
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts', 'cli/**/*.ts'],
		},
	},
});
