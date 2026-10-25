import { randomInt } from 'node:crypto';
import { UnrecoverableError } from '#src/shared/domain/errors';
import type { RunOptions } from './agent.ts';
import type { Session } from '#src/shared/domain/session';
import { runContextOf } from './runContext.ts';

// Short, plain and inoffensive in any pairing, so an id reads like a name.
// prettier-ignore
const adjectives = [
	'able', 'agile', 'amber', 'ample', 'azure', 'bold', 'brave', 'breezy', 'bright', 'brisk',
	'calm', 'candid', 'clever', 'cosmic', 'cozy', 'crisp', 'curious', 'daring', 'dawn', 'deft',
	'eager', 'early', 'easy', 'electric', 'epic', 'fair', 'fancy', 'fast', 'fearless', 'fine',
	'fluent', 'fresh', 'friendly', 'frosty', 'gentle', 'giant', 'glad', 'golden', 'grand',
	'green', 'happy', 'hardy', 'hearty', 'honest', 'humble', 'jolly', 'keen', 'kind', 'lively',
	'loyal', 'lucid', 'lucky', 'lunar', 'mellow', 'merry', 'mighty', 'misty', 'modest', 'neat',
	'nimble', 'noble', 'patient', 'peppy', 'plucky', 'polar', 'polite', 'proud', 'quick', 'quiet',
	'radiant', 'rapid', 'ready', 'regal', 'rosy', 'royal', 'rustic', 'sage', 'sandy', 'serene',
	'sharp', 'shiny', 'silent', 'silver', 'simple', 'sleek', 'smart', 'snowy', 'solar', 'solid',
	'sonic', 'spry', 'steady', 'stellar', 'sturdy', 'sunny', 'super', 'swift', 'tidy', 'tranquil',
	'true', 'trusty', 'upbeat', 'urban', 'valiant', 'vivid', 'warm', 'wise', 'witty', 'young',
	'zesty',
];

// prettier-ignore
const animals = [
	'alpaca', 'badger', 'beaver', 'bison', 'bobcat', 'buffalo', 'camel', 'caribou', 'cheetah',
	'condor', 'cougar', 'coyote', 'crane', 'cricket', 'dingo', 'dolphin', 'dove', 'eagle',
	'egret', 'elk', 'falcon', 'ferret', 'finch', 'flamingo', 'fox', 'gazelle', 'gecko', 'gibbon',
	'giraffe', 'goose', 'gopher', 'gorilla', 'grouse', 'gull', 'hare', 'hawk', 'hedgehog',
	'heron', 'hippo', 'ibex', 'ibis', 'iguana', 'impala', 'jackal', 'jaguar', 'jay', 'kestrel',
	'kiwi', 'koala', 'lark', 'lemur', 'leopard', 'lion', 'llama', 'lynx', 'macaw', 'magpie',
	'manatee', 'marmot', 'marten', 'meerkat', 'mink', 'moose', 'narwhal', 'newt', 'ocelot',
	'orca', 'oriole', 'osprey', 'otter', 'owl', 'panda', 'panther', 'parrot', 'pelican',
	'penguin', 'puffin', 'puma', 'quail', 'rabbit', 'raccoon', 'raven', 'reindeer', 'robin',
	'salmon', 'seal', 'sparrow', 'squirrel', 'stork', 'swallow', 'swan', 'tapir', 'tiger',
	'toucan', 'trout', 'turtle', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'wren', 'yak',
	'zebra',
];

function pick(words: readonly string[]): string {
	return words[randomInt(words.length)] ?? '';
}

/**
 * A session of its own, for an agent the consumer gave none: its id, such as `smart-hawk-4821`,
 * is easier to read and say than a UUID, and unlikely to repeat in one workspace's history.
 */
export function newSession(): Session {
	return { id: `${pick(adjectives)}-${pick(animals)}-${String(randomInt(1000, 10000))}` };
}

/**
 * The session a run belongs to: the outer run's, for an agent another agent started, or the one
 * its options name. Absent when neither gives one, and the agent uses its own.
 *
 * @throws {UnrecoverableError} when the options name a session with no id, or a name that is not
 * text.
 */
export function sessionOf(options: RunOptions): Session | undefined {
	const inherited = runContextOf(options)?.session;
	if (inherited) return inherited;
	const { session } = options;
	if (session === undefined) return undefined;
	// Read without trusting its type, as a JavaScript consumer can pass anything.
	const { id, name } = session as { id?: unknown; name?: unknown };
	if (typeof id !== 'string' || id.trim() === '') {
		throw new UnrecoverableError('The run was given a session without an id', {
			cause: 'RunOptions.session needs an id that is not blank.',
		});
	}
	if (name !== undefined && typeof name !== 'string') {
		throw new UnrecoverableError('The run was given a session whose name is not text', {
			cause: 'RunOptions.session.name, when given, is a string.',
		});
	}
	// A copy, so a consumer changing its object later changes nothing recorded.
	return name === undefined ? { id } : { id, name };
}
