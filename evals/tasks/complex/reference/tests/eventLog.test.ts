import { describe, expect, it } from 'vitest';
import { EventLog, InvalidPayloadError } from '../src/eventLog.ts';
import { MemoryStorage, type StoredEvent } from '../src/storage.ts';

const later = (milliseconds: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, milliseconds);
	});

/** Waits until `check` stops throwing, or fails after a second. */
async function eventually(check: () => void): Promise<void> {
	for (let tries = 0; ; tries++) {
		try {
			check();
			return;
		} catch (error) {
			if (tries > 100) throw error;
			await later(10);
		}
	}
}

// A different delay for each write, so writes started together finish in another order.
const shuffled = (event: StoredEvent): number => (event.number * 7) % 5;

describe('numbering', () => {
	it('numbers a stream from 1 with no gaps, whatever order the writes finish in', async () => {
		const storage = new MemoryStorage({ write: shuffled });
		const log = new EventLog(storage);
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, index) => log.append('s', `c${String(index)}`, { index })),
		);

		expect(results.map(result => result.number).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 30 }, (_, index) => index + 1),
		);
		expect(results.every(result => !result.duplicate)).toBe(true);
		expect(storage.all('s').map(event => event.number)).toEqual(
			Array.from({ length: 30 }, (_, index) => index + 1),
		);
	});

	it('numbers each stream on its own, and a slow stream does not hold up another', async () => {
		const storage = new MemoryStorage({ write: event => (event.stream === 'slow' ? 300 : 0) });
		const log = new EventLog(storage);
		const slow = log.append('slow', 'a', 1);
		const started = Date.now();
		const fast = await log.append('fast', 'a', 1);

		expect(fast).toEqual({ number: 1, duplicate: false });
		expect(Date.now() - started).toBeLessThan(250);
		expect(await slow).toEqual({ number: 1, duplicate: false });
	});
});

describe('a failed write', () => {
	it('rejects with the storage error, keeps nothing, and leaves its number to the next append', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		await log.append('s', 'a', 1);
		const failure = new Error('disk full');
		storage.failNextWrite(failure);

		await expect(log.append('s', 'b', 2)).rejects.toBe(failure);
		expect(await log.append('s', 'c', 3)).toEqual({ number: 2, duplicate: false });
		expect(storage.all('s').map(event => event.clientId)).toEqual(['a', 'c']);
	});

	it('frees the id it failed with', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		storage.failNextWrite();

		await expect(log.append('s', 'a', 1)).rejects.toThrow();
		expect(await log.append('s', 'a', 1)).toEqual({ number: 1, duplicate: false });
	});
});

describe('idempotent appends', () => {
	it('answers an id appended before with its number, and keeps nothing more', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		await log.append('s', 'a', 1);
		await log.append('s', 'b', 2);

		expect(await log.append('s', 'a', 'other')).toEqual({ number: 1, duplicate: true });
		expect(storage.all('s')).toHaveLength(2);
	});

	it('settles a duplicate sent while the first is in flight as the first does', async () => {
		const storage = new MemoryStorage({ write: () => 50 });
		const log = new EventLog(storage);
		const [first, second] = await Promise.all([log.append('s', 'a', 1), log.append('s', 'a', 1)]);

		expect(first).toEqual({ number: 1, duplicate: false });
		expect(second).toEqual({ number: 1, duplicate: true });
		expect(storage.all('s')).toHaveLength(1);
		expect(storage.writes).toBe(1);
	});

	it('fails a duplicate in flight when the first fails', async () => {
		const storage = new MemoryStorage({ write: () => 30 });
		const log = new EventLog(storage);
		storage.failNextWrite();
		const results = await Promise.allSettled([log.append('s', 'a', 1), log.append('s', 'a', 1)]);

		expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
		expect(storage.all('s')).toHaveLength(0);
	});

	it('scopes ids to their stream', async () => {
		const log = new EventLog(new MemoryStorage());
		await log.append('one', 'a', 1);

		expect(await log.append('two', 'a', 1)).toEqual({ number: 1, duplicate: false });
	});
});

describe('restart', () => {
	it('goes on from what the storage keeps', async () => {
		const storage = new MemoryStorage();
		const before = new EventLog(storage);
		await before.append('s', 'a', 1);
		await before.append('s', 'b', 2);

		const after = new EventLog(storage);
		expect(await after.append('s', 'a', 1)).toEqual({ number: 1, duplicate: true });
		expect(await after.append('s', 'c', 3)).toEqual({ number: 3, duplicate: false });
	});
});

describe('payloads', () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;

	it.each([
		['undefined', undefined],
		['a function', () => 1],
		['a bigint', 1n],
		['an object that contains itself', circular],
	])('refuses %s before anything is written or numbered', async (_, payload) => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);

		await expect(log.append('s', 'a', payload)).rejects.toBeInstanceOf(InvalidPayloadError);
		expect(storage.writes).toBe(0);
		expect(await log.append('s', 'b', 1)).toEqual({ number: 1, duplicate: false });
	});

	it('keeps the payload as JSON gives it back', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		await log.append('s', 'a', { at: new Date(0), skip: undefined, list: [1, undefined] });

		expect(storage.all('s')[0]?.payload).toEqual({
			at: '1970-01-01T00:00:00.000Z',
			list: [1, null],
		});
	});

	it('names its error', () => {
		expect(new InvalidPayloadError('x').name).toBe('InvalidPayloadError');
	});
});

describe('reading', () => {
	it('gives the events after a number, in order, up to a limit', async () => {
		const log = new EventLog(new MemoryStorage());
		for (const id of ['a', 'b', 'c', 'd']) await log.append('s', id, id);

		expect((await log.read('s')).map(event => event.number)).toEqual([1, 2, 3, 4]);
		expect((await log.read('s', 2)).map(event => event.number)).toEqual([3, 4]);
		expect((await log.read('s', 0, 3)).map(event => event.number)).toEqual([1, 2, 3]);
		expect(await log.read('other')).toEqual([]);
	});

	it('defaults to 100 events', async () => {
		const log = new EventLog(new MemoryStorage());
		for (let index = 0; index < 105; index++) await log.append('s', `c${String(index)}`, index);

		expect(await log.read('s')).toHaveLength(100);
	});

	it.each([
		['a negative after', -1, 10],
		['a fractional after', 1.5, 10],
		['a limit of 0', 0, 0],
		['a limit over 1000', 0, 1001],
		['a fractional limit', 0, 2.5],
	])('refuses %s', async (_, after, limit) => {
		const log = new EventLog(new MemoryStorage());

		await expect(log.read('s', after, limit)).rejects.toBeInstanceOf(RangeError);
	});
});

describe('following', () => {
	it('gives what was kept, then each new event, in order, each once', async () => {
		const log = new EventLog(new MemoryStorage());
		await log.append('s', 'a', 1);
		await log.append('s', 'b', 2);
		const seen: number[] = [];
		log.subscribe('s', 0, event => seen.push(event.number));
		await log.append('s', 'c', 3);

		await eventually(() => {
			expect(seen).toEqual([1, 2, 3]);
		});
	});

	it('starts after the number it is given', async () => {
		const log = new EventLog(new MemoryStorage());
		for (const id of ['a', 'b', 'c']) await log.append('s', id, id);
		const seen: number[] = [];
		log.subscribe('s', 2, event => seen.push(event.number));

		await eventually(() => {
			expect(seen).toEqual([3]);
		});
	});

	it('loses and repeats nothing kept while it reads the earlier events', async () => {
		const storage = new MemoryStorage({ read: () => 80 });
		const log = new EventLog(storage);
		for (const id of ['a', 'b']) await log.append('s', id, id);
		const seen: number[] = [];
		log.subscribe('s', 0, event => seen.push(event.number));
		await later(20);
		await Promise.all(['c', 'd', 'e'].map(id => log.append('s', id, id)));

		await eventually(() => {
			expect(seen).toEqual([1, 2, 3, 4, 5]);
		});
		await later(200);
		expect(seen).toEqual([1, 2, 3, 4, 5]);
	});

	it('stops after unsubscribe', async () => {
		const log = new EventLog(new MemoryStorage());
		const seen: number[] = [];
		const subscription = log.subscribe('s', 0, event => seen.push(event.number));
		await log.append('s', 'a', 1);
		await eventually(() => {
			expect(seen).toEqual([1]);
		});
		subscription.unsubscribe();
		await log.append('s', 'b', 2);
		await later(50);

		expect(seen).toEqual([1]);
	});

	it('lets a listener that throws affect nothing else', async () => {
		const log = new EventLog(new MemoryStorage());
		const seen: number[] = [];
		log.subscribe('s', 0, () => {
			throw new Error('a broken listener');
		});
		log.subscribe('s', 0, event => seen.push(event.number));
		await later(20);

		expect(await log.append('s', 'a', 1)).toEqual({ number: 1, duplicate: false });
		expect(await log.append('s', 'b', 2)).toEqual({ number: 2, duplicate: false });
		await eventually(() => {
			expect(seen).toEqual([1, 2]);
		});
	});
});
