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
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
		},
	},
});
