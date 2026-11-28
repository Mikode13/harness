import { describe, expect, it } from 'vitest';
import { EventLog, InvalidPayloadError } from '../src/eventLog.ts';
import { MemoryStorage, type StoredEvent } from '../src/storage.ts';

/** A storage that refuses to keep the event of one client id. */
class RefusingStorage extends MemoryStorage {
	private readonly refused: string;

	constructor(refused: string) {
		super();
		this.refused = refused;
	}

	override async write(event: StoredEvent): Promise<void> {
		if (event.clientId === this.refused) throw new Error(`Could not keep ${event.clientId}`);
		await super.write(event);
	}
}

const kept = (storage: MemoryStorage) =>
	storage.all('s').map(({ number, clientId, payload }) => ({ number, clientId, payload }));

describe('appendAll', () => {
	it('appends a batch in order, with consecutive numbers', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);

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
		expect(kept(storage)).toEqual([
			{ number: 1, clientId: 'a', payload: 1 },
			{ number: 2, clientId: 'b', payload: 2 },
			{ number: 3, clientId: 'c', payload: 3 },
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

	it('answers an id repeated in the batch as a duplicate of the first', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);

		expect(
			await log.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
				{ clientId: 'a', payload: 3 },
			]),
		).toEqual([
			{ number: 1, duplicate: false },
			{ number: 2, duplicate: false },
			{ number: 1, duplicate: true },
		]);
		expect(kept(storage)).toEqual([
			{ number: 1, clientId: 'a', payload: 1 },
			{ number: 2, clientId: 'b', payload: 2 },
		]);
	});

	it('rejects a batch with a payload that is not JSON, and writes nothing', async () => {
		const storage = new MemoryStorage();
		const log = new EventLog(storage);
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		for (const invalid of [undefined, circular]) {
			await expect(
				log.appendAll('s', [
					{ clientId: 'a', payload: 1 },
					{ clientId: 'b', payload: invalid },
				]),
			).rejects.toBeInstanceOf(InvalidPayloadError);
		}
		expect(storage.writes).toBe(0);
		expect(await log.append('s', 'a', 1)).toEqual({ number: 1, duplicate: false });
	});

	it('rejects with the error of a failed append, and appends none after it', async () => {
		const storage = new RefusingStorage('b');
		const log = new EventLog(storage);

		await log
			.appendAll('s', [
				{ clientId: 'a', payload: 1 },
				{ clientId: 'b', payload: 2 },
			])
			.catch(() => undefined);
		expect(kept(storage)).toEqual([{ number: 1, clientId: 'a', payload: 1 }]);
		expect(await log.append('s', 'c', 3)).toEqual({ number: 2, duplicate: false });
	});

	it('resolves an empty batch with no results', async () => {
		const log = new EventLog(new MemoryStorage());

		expect(await log.appendAll('s', [])).toEqual([]);
	});
});
