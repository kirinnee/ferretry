import { expect, test } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { StateAgentPinRepository } from '../../../../../daemon/adapters/agent-pins/file-agent-pin-repository.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import type { DaemonStorage } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { AgentPinService } from '../../../../../daemon/lib/agent-pins/service.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { AgentPinsFile } from '../../../../../daemon/lib/state.ts';
import { memoryStorage, sessionConfig, sessionState } from '../../../../support/daemon/storage.ts';

/**
 * A pin is a keep: pinning an archived ferret brings it, and the ancestors it was started under, back into the live
 * set with their journals (today's `keep-publications`, the Ferrets-internal half).
 *
 * Today's file also published agenda items and board cards and watched them restore membership. Those publications
 * are Asks' and Board's now and reach Ferrets through the archive-keep hook, which is not built yet, so they are
 * not here; nor is the injected journal-read EIO, which needed a real disk under the storage.
 */

const LEAD = parseSessionId('lead-1');
const KID = parseSessionId('kid-1');
const NOW = '2026-11-06T12:00:00.000Z';

async function world() {
  const { storage, folder } = await memoryStorage();
  for (const id of [LEAD, KID]) {
    await storage.writeConfig(id, sessionConfig(id, { mode: 'auto', ...(id === KID ? { parent: LEAD } : {}) }));
    await storage.writeState(id, sessionState(id, { status: 'completed', finishedAt: '2026-11-01T00:00:00Z' }));
    await storage.append(id, 'session.created', {});
    await storage.append(id, 'session.note', { kept: 'original journal' });
  }
  await storage.archiveSessions([KID, LEAD], async () => ({}));
  expect(storage.listSessions()).toHaveLength(0);
  return { storage, pinsState: folder.port([AgentPinsFile]) };
}

async function restored(storage: DaemonStorage) {
  expect(storage.archivedCount()).toBe(0);
  expect(
    storage
      .listSessions()
      .map(row => row.id)
      .sort(),
  ).toEqual([KID, LEAD]);
  expect((await storage.replay(KID)).events.map(event => event.type)).toEqual(['session.created', 'session.note']);
}

/** A state port that counts the writes made to the pin file. */
function counting(state: StatePort): { readonly state: StatePort; writes(): number } {
  let writes = 0;
  const wrapped = Object.create(state) as StatePort;
  wrapped.write = async (file: StateFileDef, value: unknown, name?: string) => {
    writes += 1;
    return await state.write(file as never, value as never, name);
  };
  return { state: wrapped, writes: () => writes };
}

test('a pin publication alone restores an archived session and its ancestors, including journal pointers', async () => {
  const { storage, pinsState } = await world();
  const pins = new StateAgentPinRepository(
    pinsState,
    AgentPinsFile,
    async id => await storage.retainSession(parseSessionId(id)),
  );
  const entry = [{ sessionId: KID, pinnedAt: NOW }];
  await pins.save(entry);
  await pins.save(entry);
  expect(await pins.load()).toEqual(entry);
  await restored(storage);
});

test('re-pinning retries failed archive retention without rewriting the existing pin document', async () => {
  const { storage, pinsState } = await world();
  const { state, writes } = counting(pinsState);
  let failed = false;
  const repository = new StateAgentPinRepository(state, AgentPinsFile, async id => {
    if (!failed) {
      failed = true;
      throw new Error('transient retention failure');
    }
    await storage.retainSession(parseSessionId(id));
  });
  const pins = new AgentPinService(repository, { now: () => NOW }, new KeyedSerialExecutor());
  await expect(pins.pin(KID)).rejects.toThrow('transient retention failure');
  expect(await repository.load()).toEqual([{ sessionId: KID, pinnedAt: NOW }]);
  expect(storage.archivedCount()).toBe(2);
  expect(await pins.pin(KID)).toBe(NOW);
  expect(writes()).toBe(1);
  await restored(storage);
});
