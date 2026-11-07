import { describe, it } from 'bun:test';
import should from 'should';
import type { BoardSwitch } from '../../../contract/index.ts';
import { BoardSwitchService, type BoardSwitchStore, switchOf } from '../../../daemon/lib/lanes/index.ts';
import { DOCS_ID, FERRETRY_ID } from './support.ts';

class MemoryStore implements BoardSwitchStore {
  readonly switches = new Map<string, BoardSwitch>();
  async read(projectId: string): Promise<BoardSwitch | null> {
    return this.switches.get(projectId) ?? null;
  }
  async set(projectId: string, on: boolean, at: string): Promise<BoardSwitch> {
    const stored = { projectId, on, setBy: 'owner', setAt: at } as BoardSwitch;
    this.switches.set(projectId, stored);
    return stored;
  }
}

const AT = '2026-11-01T12:00:00.000Z';
const world = () => {
  const store = new MemoryStore();
  return { store, service: new BoardSwitchService(store, { now: () => AT }) };
};

describe('switchOf', () => {
  it('should read a board nobody switched as off by default', () => {
    should(switchOf(null, FERRETRY_ID)).eql({ projectId: FERRETRY_ID, on: false, setBy: 'default', setAt: null });
  });

  it('should read a stored switch as it is', () => {
    const stored = { projectId: FERRETRY_ID, on: true, setBy: 'owner', setAt: AT } as BoardSwitch;
    should(switchOf(stored, FERRETRY_ID)).equal(stored);
  });
});

describe('BoardSwitchService', () => {
  it('should keep every board off until the owner switches it, Unfiled included', async () => {
    const { service } = world();

    should(await service.isOn(FERRETRY_ID)).be.false();
    should(await service.isOn('unfiled')).be.false();
    should(await service.read(DOCS_ID)).eql({ projectId: DOCS_ID, on: false, setBy: 'default', setAt: null });
  });

  it('should record the owner switching a board on and off, at the instant it was thrown', async () => {
    const { service, store } = world();

    should(await service.set(FERRETRY_ID, true)).eql({ projectId: FERRETRY_ID, on: true, setBy: 'owner', setAt: AT });
    should(await service.isOn(FERRETRY_ID)).be.true();
    should(await service.isOn(DOCS_ID)).be.false();

    await service.set(FERRETRY_ID, false);
    should(await service.isOn(FERRETRY_ID)).be.false();
    should(store.switches.get(FERRETRY_ID)?.setBy).equal('owner');
  });

  it('should let a damaged store refuse the read, not guess a board off', async () => {
    const service = new BoardSwitchService(
      {
        read: async () => {
          throw new Error('damaged');
        },
        set: async () => {
          throw new Error('damaged');
        },
      },
      { now: () => AT },
    );

    await service.isOn(FERRETRY_ID).then(
      () => {
        throw new Error('read an unreadable switch');
      },
      error => should(error.message).equal('damaged'),
    );
  });
});
