import { describe, expect, it } from 'vitest';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import {
	buildArguments,
	type CommandDefinition,
	type Commands,
	commandsFor,
	validateCommands,
} from '../../src/tools/domain/commands.ts';

const test: CommandDefinition = {
	description: 'Runs the tests',
	executable: 'pnpm',
	args: [
		'vitest',
		'run',
		{ type: 'choice', name: 'update', description: 'Update snapshots', values: ['--update'] },
		{ type: 'text', name: 'filter', description: 'A test name', pattern: '[A-Za-z ]+' },
		'--',
		{ type: 'paths', name: 'paths', description: 'Test files' },
	],
};

function invalid(commands: Commands): unknown {
	try {
		validateCommands(commands);
	} catch (error) {
		return error;
	}
	return undefined;
}

describe('validateCommands', () => {
	it('accepts a command with every kind of parameter', () => {
		expect(() => {
			validateCommands({ test });
		}).not.toThrow();
	});

	it.each<[string, Commands, RegExp]>([
		['no command at all', {}, /No command is configured/],
		['a name that is not a word', { 'run tests': test }, /needs a name/],
		['no description', { test: { ...test, description: ' ' } }, /needs a description/],
		['no executable', { test: { ...test, executable: '' } }, /needs an executable/],
		[
			'an executable with a NUL',
			{ test: { ...test, executable: 'pn\0pm' } },
			/needs an executable/,
		],
		['a timeout of zero', { test: { ...test, timeoutMs: 0 } }, /timeoutMs/],
		['a fractional output limit', { test: { ...test, outputBytes: 1.5 } }, /outputBytes/],
		['an invalid variable name', { test: { ...test, env: { 'A-B': 'x' } } }, /variable name/],
		[
			'a parameter named like the command key',
			{ test: { ...test, args: [{ type: 'paths', name: 'name', description: 'x' }] } },
			/invalid name "name"/,
		],
		[
			'a parameter used twice',
			{
				test: {
					...test,
					args: [
						{ type: 'paths', name: 'paths', description: 'x' },
						{ type: 'paths', name: 'paths', description: 'x' },
					],
				},
			},
			/twice/,
		],
		[
			'a choice with no values',
			{ test: { ...test, args: [{ type: 'choice', name: 'mode', description: 'x', values: [] }] } },
			/at least one value/,
		],
		[
			'a text whose pattern does not compile',
			{
				test: { ...test, args: [{ type: 'text', name: 'filter', description: 'x', pattern: '(' }] },
			},
			/not a valid regular expression/,
		],
		[
			'a parameter of an unknown type',
			{
				test: {
					...test,
					args: [{ type: 'free', name: 'anything', description: 'x' } as never],
				},
			},
			/unknown type/,
		],
		// A configuration read from JSON can hold anything.
		['a command that is not an object', { test: null } as never, /must be an object/],
		['args that are not a list', { test: { ...test, args: 'test' } } as never, /args to be a list/],
		['env that is not an object', { test: { ...test, env: ['A=1'] } } as never, /env to map/],
		['a cwd that is not text', { test: { ...test, cwd: 1 } } as never, /invalid cwd/],
		[
			'a timeout that is not a number',
			{ test: { ...test, timeoutMs: '10' } } as never,
			/timeoutMs/,
		],
		[
			'an argument that is neither text nor a parameter',
			{ test: { ...test, args: [1] } } as never,
			/neither text nor a parameter/,
		],
		['a role that does not exist', { test: { ...test, roles: ['tester'] } } as never, /roles/],
		['no role at all', { test: { ...test, roles: [] } }, /roles/],
		['a role named twice', { test: { ...test, roles: ['planner', 'planner'] } }, /each once/],
		[
			'a required flag that is not a boolean',
			{
				test: {
					...test,
					args: [{ type: 'text', name: 'f', description: 'x', pattern: '.', required: 'yes' }],
				},
			} as never,
			/required to be true or false/,
		],
	])('refuses %s', (_, commands, message) => {
		const error = invalid(commands);
		expect(error).toBeInstanceOf(InvalidAgentConfigError);
		expect((error as Error).message).toMatch(message);
	});
});

describe('buildArguments', () => {
	const none = { update: null, filter: null, paths: [] };

	it('keeps the fixed arguments and leaves out what the model did not give', () => {
		expect(buildArguments(test, none)).toEqual(['vitest', 'run', '--']);
	});

	it('puts each value where its parameter is, and each path as its own argument', () => {
		expect(
			buildArguments(test, {
				update: '--update',
				filter: 'adds numbers',
				paths: ['a.test.ts', 'b.test.ts'],
			}),
		).toEqual(['vitest', 'run', '--update', 'adds numbers', '--', 'a.test.ts', 'b.test.ts']);
	});

	it.each([
		['a choice it does not list', { update: '--watch' }, /takes one of: --update/],
		['a text that starts like a flag', { filter: '-t' }, /may not start with "-"/],
		['a text that matches only part of the pattern', { filter: 'adds 2 numbers' }, /must match/],
		['a text with a NUL', { filter: 'a\0b' }, /must match/],
		['a list where one value goes', { filter: ['a'] }, /takes one value/],
	])('refuses %s', (_, values, message) => {
		expect(() => buildArguments(test, { ...none, ...values })).toThrow(message);
	});

	it('refuses to leave out a required value', () => {
		const required: CommandDefinition = {
			...test,
			args: [{ type: 'text', name: 'filter', description: 'x', pattern: '.+', required: true }],
		};

		expect(() => buildArguments(required, { filter: null })).toThrow(/"filter" is required/);
	});
});

describe('commandsFor', () => {
	it('gives each role the commands that name it, and the executor those that name none', () => {
		const commands: Commands = { test, issue: { ...test, roles: ['planner', 'executor'] } };

		expect(Object.keys(commandsFor(commands, 'planner'))).toEqual(['issue']);
		expect(Object.keys(commandsFor(commands, 'executor'))).toEqual(['test', 'issue']);
		expect(commandsFor(commands, 'reviewer')).toEqual({});
	});
});
