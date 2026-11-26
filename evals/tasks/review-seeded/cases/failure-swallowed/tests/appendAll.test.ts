import { describe, expect, it } from 'vitest';
import { EventLog, InvalidPayloadError } from '../src/eventLog.ts';
import { MemoryStorage } from '../src/storage.ts';

describe('appendAll', () => {
	it('appends a batch in order, with consecutive numbers', async () => {
		const log = new EventLog(new MemoryStorage());

		expect(
			await log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
				{ clientId: 'c', payload: 3 },
			]),
		).toEqual([
			{ number: 1, duplicate: false },
			{ number: 2, duplicate: false },
			{ number: 3, duplicate: false },
		]);
	});

	it('answers an id appended before as a duplicate', async () => {
		const log = new EventLog(new MemoryStorage());
		await log.append('s', 'a', 1);

		expect(
			await log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
			]),
		).toEqual([
			{ number: 1, duplicate: true },
			{ number: 2, duplicate: false },
		]);
	});

	it('rejects a batch with a payload that is not JSON', async () => {
		const log = new EventLog(new MemoryStorage());

		await expect(
			log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: undefined },
			]),
		).rejects.toBeInstanceOf(InvalidPayloadError);
	});

	it('resolves an empty batch with no results', async () => {
		const log = new EventLog(new MemoryStorage());

		expect(await log.appendAll('s', [])).toEqual([]);
	});
});
