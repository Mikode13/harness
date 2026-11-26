import { describe, expect, it } from 'vitest';
import { EventLog, InvalidPayloadError } from '../../src/eventLog.ts';
import { MemoryStorage } from '../../src/storage.ts';

describe('appendAll, as the request says', () => {
	it('writes nothing when a later payload has no JSON form', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);

		await expect(
			log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: () => 2 },
			]),
		).rejects.toBeInstanceOf(InvalidPayloadError);
		expect(storage.writes).toBe(0);
	});

	it('answers an id repeated in the batch as a duplicate, one result per item', async () => {
		const log = new EventLog(new MemoryStorage());

		expect(
			await log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
				{ clientId: 'a', payload: 1 },
			]),
		).toEqual([
			{ number: 1, duplicate: false },
			{ number: 2, duplicate: false },
			{ number: 1, duplicate: true },
		]);
	});

	it('rejects with a failed write and appends nothing after it', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		const failure = new Error('disk full');
		storage.failNextWrite(failure);

		await expect(
			log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
			]),
		).rejects.toBe(failure);
		expect(storage.all('s')).toEqual([]);
	});
});
