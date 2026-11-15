/**
 * THE FLEET THE CHAT PROVES `:agent` AGAINST: read once per client, kept live by Ferrets' change event, and the SAME value
 * until a fact the proof reads changes — so a status tick never rebuilds the reference surface.
 */
import { afterEach, describe, test } from 'bun:test';
import { ensureDom, interact, type Mounted, mount } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { type ChatFleet, chatFleetKey, chatFleetOf, useChatFleet } from '../../../../app/chat/chat-fleet.ts';

ensureDom();

const ROW = { id: 'f1', name: 'aniya', state: 'working', folder: '/repo' };

describe('chatFleetOf', () => {
  test('should read candidates and folders from a ferret list, leaving out a row of another shape', () => {
    // Act
    const fleet = chatFleetOf([
      ROW,
      { id: 'f2', name: 'torrey', state: 'stopped', folder: '/b', extra: 1 },
      { id: 3 },
      null,
    ]);

    // Assert
    should(fleet?.candidates).deepEqual([
      { id: 'f1', name: 'aniya', status: 'working' },
      { id: 'f2', name: 'torrey', status: 'stopped' },
    ]);
    should([...(fleet?.folders ?? [])]).deepEqual([
      ['f1', '/repo'],
      ['f2', '/b'],
    ]);
  });

  test('should read nothing from an answer that is not a list', () => {
    should(chatFleetOf({ ferrets: [] })).be.undefined();
    should(chatFleetOf(undefined)).be.undefined();
  });
});

describe('chatFleetKey', () => {
  test('should read liveness, not the raw state: working <-> idle moves nothing, going dormant does', () => {
    const working = chatFleetKey(chatFleetOf([ROW]));
    should(chatFleetKey(chatFleetOf([{ ...ROW, state: 'idle' }]))).equal(working);
    should(chatFleetKey(chatFleetOf([{ ...ROW, state: 'awaiting_question' }]))).equal(working);
    should(chatFleetKey(chatFleetOf([{ ...ROW, state: 'completed' }]))).not.equal(working);
  });

  test('should differ only when a fact the proof reads differs', () => {
    const base = chatFleetOf([ROW]);
    should(chatFleetKey(undefined)).equal('');
    should(chatFleetKey(base)).equal(chatFleetKey(chatFleetOf([{ ...ROW, title: 'new title' }])));
    should(chatFleetKey(base)).not.equal(chatFleetKey(chatFleetOf([{ ...ROW, state: 'stopped' }])));
    should(chatFleetKey(base)).not.equal(chatFleetKey(chatFleetOf([{ ...ROW, name: 'torrey' }])));
    should(chatFleetKey(base)).not.equal(chatFleetKey(chatFleetOf([{ ...ROW, folder: '/elsewhere' }])));
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** Draws what the hook gave as one line, so a test reads the value the chat would hold. */
const seen: Array<ChatFleet | undefined> = [];
function Probe({ client }: { readonly client: Pick<PluginClient, 'call'> & Partial<Pick<PluginClient, 'subscribe'>> }) {
  seen.push(useChatFleet(client));
  return null;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('useChatFleet', () => {
  afterEach(() => {
    seen.length = 0;
  });

  test('should hold no fleet until the list is read, then the fleet it described', async () => {
    // Arrange
    const asked: string[] = [];
    const client = { call: async (route: string) => (asked.push(route), [ROW]) } as never;

    // Act
    view = await mount(<Probe client={client} />);
    await settle();

    // Assert
    should(seen[0]).be.undefined();
    should(seen.at(-1)?.candidates).deepEqual([{ id: 'f1', name: 'aniya', status: 'working' }]);
    should(asked).deepEqual(['GET /v1/ferrets']);
  });

  test('should prove nothing from a read that failed or answered no list', async () => {
    // Arrange
    const failing = { call: async () => Promise.reject(new Error('offline')) } as never;

    // Act
    view = await mount(<Probe client={failing} />);
    await settle();

    // Assert
    should(seen.at(-1)).be.undefined();
  });

  test('should keep the fleet it has when a later read fails', async () => {
    // Arrange
    let reads = 0;
    let notify: () => void = () => undefined;
    const client = {
      call: async () => {
        reads += 1;
        if (reads > 1) throw new Error('offline');
        return [ROW];
      },
      subscribe: (_event: unknown, listener: () => void) => {
        notify = listener;
        return () => undefined;
      },
    } as never;
    view = await mount(<Probe client={client} />);
    await settle();
    const first = seen.at(-1);

    // Act
    notify();
    await interact(() => new Promise(resolve => setTimeout(resolve, 1_100)));

    // Assert
    should(reads).equal(2);
    should(seen.at(-1)).equal(first);
  });

  test('should read again when Ferrets says a ferret changed, and keep the same fleet when nothing the proof reads moved', async () => {
    // Arrange
    let reads = 0;
    let state = 'working';
    let notify: () => void = () => undefined;
    let stopped = 0;
    const client = {
      call: async () => {
        reads += 1;
        return [{ ...ROW, state }];
      },
      subscribe: (_event: unknown, listener: () => void) => {
        notify = listener;
        return () => {
          stopped += 1;
        };
      },
    } as never;
    view = await mount(<Probe client={client} />);
    await settle();
    const first = seen.at(-1);

    // Act — a change that moves nothing the proof reads, then one that does
    notify();
    await interact(() => new Promise(resolve => setTimeout(resolve, 1_100)));
    const same = seen.at(-1);
    state = 'idle';
    notify();
    await interact(() => new Promise(resolve => setTimeout(resolve, 1_100)));
    const idle = seen.at(-1);
    state = 'stopped';
    notify();
    await interact(() => new Promise(resolve => setTimeout(resolve, 1_100)));
    await view.unmount();
    view = null;

    // Assert
    should(reads).equal(4);
    should(same).equal(first);
    should(idle).equal(first);
    should(seen.at(-1)).not.equal(first);
    should(seen.at(-1)?.candidates[0]?.status).equal('stopped');
    should(stopped).equal(1);
  });
});
