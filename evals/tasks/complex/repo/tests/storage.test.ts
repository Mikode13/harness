import { describe, expect, it } from 'vitest';
import { MemoryStorage, OutOfOrderError } from '../src/storage.ts';

const event = (number: number, clientId = `c${String(number)}`) => ({
	stream: 's',
	number,
	clientId,
	payload: { number },
});

describe('MemoryStorage', () => {
	it('keeps events in order and reads those after a number', async () => {
		const storage = new MemoryStorage();
		await storage.write(event(1));
		await storage.write(event(2));
		await storage.write(event(3));

		expect((await storage.readAfter('s', 1, 10)).map(each => each.number)).toEqual([2, 3]);
		expect((await storage.readAfter('s', 0, 2)).map(each => each.number)).toEqual([1, 2]);
	});

	it('refuses an event out of order', async () => {
		const storage = new MemoryStorage();
		await expect(storage.write(event(2))).rejects.toThrow(OutOfOrderError);
	});

	it('fails the next write when told to, and keeps nothing of it', async () => {
		const storage = new MemoryStorage();
		storage.failNextWrite();
		await expect(storage.write(event(1))).rejects.toThrow('unavailable');
		await storage.write(event(1));
		expect(storage.all('s')).toHaveLength(1);
	});
});
