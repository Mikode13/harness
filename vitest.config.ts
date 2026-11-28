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
			{
				resolve,
				test: {
					// What keeps the evals in step with src/, such as the events the metrics read,
					// in seconds and offline: part of `pnpm test`, so pre-push and CI run it.
					name: 'evals',
					include: [
						'evals/tests/lib.test.ts',
						'evals/tests/record.test.ts',
						'evals/tests/preflight.test.ts',
					],
					testTimeout: 60_000,
				},
			},
			{
				resolve,
				test: {
					// Each task's checks, and each runner over a faked SDK, run the task's own tests,
					// types and lint in fresh repositories: minutes, so only `pnpm run test:evals`.
					name: 'evals-tasks',
					include: ['evals/tests/runners.test.ts', 'evals/tests/tasks.test.ts'],
					testTimeout: 180_000,
				},
			},
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts', 'cli/**/*.ts'],
		},
	},
});
