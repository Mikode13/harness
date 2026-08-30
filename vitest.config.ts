import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.unit.test.ts'],
				},
			},
			{
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.integration.test.ts'],
				},
			},
			{
				test: {
					name: 'external',
					include: ['tests/external/**/*.external.test.ts'],
				},
			},
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
		},
	},
});
