/**
 * THE FACTS AGENDA'S REFERENCE PROOFS READ, for one machine: its fleet, its client and Ferrets' `ferrets.file-open` —
 * narrowed, so a missing hook or a value of another shape is no opener.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, WithAppHooks } from '@ferretry/app/testing';
import { FERRETS_FILE_OPEN_HOOK } from '@ferretry/core-ferrets/contract';
import { useAgendaReferenceFacts } from '../../../app/hooks/use-agenda-reference-facts.ts';
import type { AgendaFerretReferences, AgendaReferenceFacts } from '../../../app/lib/agenda-references.ts';
import type { AgendaRuntime } from '../../../app/lib/agenda-runtime.ts';
import { daemonConnection } from '../../../app/shell.ts';

ensureDom();

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const connection = daemonConnection({ daemonId: 'd1' });
const sessions = [{ config: { id: 'f1', teammate: 'aniya' }, state: { status: 'working' as const } }];

/** One runtime per answer: the store's snapshot must be the same value until it changes, as the real one is. */
const runtimeWith = (daemons: ReadonlyMap<string, { sessions: typeof sessions }>): AgendaRuntime => {
  const snapshot = { daemons };
  return {
    connection,
    client: { call: async () => undefined },
    ferrets: { subscribe: () => () => undefined, getSnapshot: () => snapshot },
  } as unknown as AgendaRuntime;
};
const READ = runtimeWith(new Map([[connection.daemonId, { sessions }]]));
const UNREAD = runtimeWith(new Map());
const noop = (): void => undefined;

const seen: AgendaReferenceFacts[] = [];
function Probe({ read, ferret }: { readonly read: boolean; readonly ferret?: AgendaFerretReferences }) {
  seen.push(useAgendaReferenceFacts(read ? READ : UNREAD, noop, ferret));
  return null;
}

const draw = async (provided: Record<string, unknown>, read = true, ferret?: AgendaFerretReferences) => {
  view = await mount(
    <WithAppHooks provided={provided}>
      <Probe read={read} {...(ferret === undefined ? {} : { ferret })} />
    </WithAppHooks>,
  );
  await interact(async () => undefined);
  return seen.at(-1) as AgendaReferenceFacts;
};

afterEach(() => {
  seen.length = 0;
});

describe('useAgendaReferenceFacts, as the fleet changes', () => {
  /** A store whose snapshot is a new value on every update, as the real one is. */
  const live = () => {
    const listeners = new Set<() => void>();
    let snapshot = { daemons: new Map<string, { sessions: unknown }>() };
    const runtime = {
      connection,
      client: { call: async () => undefined },
      ferrets: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
      },
    } as unknown as AgendaRuntime;
    const set = async (rows: ReadonlyArray<readonly [string, string, string, string]>) => {
      snapshot = {
        daemons: new Map([
          [
            connection.daemonId,
            {
              sessions: rows.map(([id, teammate, status, cwd]) => ({
                config: { id, teammate, cwd },
                state: { status },
              })),
            },
          ],
        ]),
      };
      await interact(async () => {
        for (const listener of listeners) listener();
      });
    };
    return { runtime, set };
  };
  const ferret: AgendaFerretReferences = { id: 'f1', ledger: [], openAsk: noop, showFiles: noop };
  function Own({ runtime }: { readonly runtime: AgendaRuntime }) {
    seen.push(useAgendaReferenceFacts(runtime, noop, ferret));
    return null;
  }

  test('keeps the very facts across working <-> idle, and builds new ones when a fact the proofs read changes', async () => {
    const { runtime, set } = live();
    await set([['f1', 'aniya', 'working', '/repo']]);
    view = await mount(
      <WithAppHooks provided={{}}>
        <Own runtime={runtime} />
      </WithAppHooks>,
    );
    await interact(async () => undefined);
    const first = seen.at(-1) as AgendaReferenceFacts;

    // Act — the snapshot is a new value each time
    await set([['f1', 'aniya', 'idle', '/repo']]);
    const idle = seen.at(-1) as AgendaReferenceFacts;
    await set([
      ['f1', 'aniya', 'working', '/repo'],
      ['f2', 'kim', 'working', '/other'],
    ]);
    const grown = seen.at(-1) as AgendaReferenceFacts;
    await set([
      ['f1', 'aniya', 'stopped', '/repo'],
      ['f2', 'kim', 'working', '/other'],
    ]);
    const done = seen.at(-1) as AgendaReferenceFacts;

    // Assert
    expect(idle).toBe(first);
    expect(grown).not.toBe(first);
    expect(done).not.toBe(grown);
    expect(done.fleet?.[0]?.state.status).toBe('stopped');
  });
});

describe('useAgendaReferenceFacts', () => {
  test('hands over this machine’s fleet, its client and the opener Ferrets provides', async () => {
    const open = { open: () => true };
    const ferret: AgendaFerretReferences = {
      id: 'f1',
      ledger: [],
      openAsk: () => undefined,
      showFiles: () => undefined,
    };

    const facts = await draw({ [FERRETS_FILE_OPEN_HOOK]: open }, true, ferret);

    expect(facts.daemonId).toBe(connection.daemonId);
    expect(facts.fleet).toEqual(sessions);
    expect(facts.fileOpen).toBe(open);
    expect(facts.ferret).toBe(ferret);
  });

  test('holds no fleet until it is read, and no opener without the hook or with a value of another shape', async () => {
    const bare = await draw({}, false);
    expect(bare.fleet).toBeNull();
    expect(bare.fileOpen).toBeUndefined();
    expect(bare.ferret).toBeUndefined();
    await view?.unmount();
    view = null;

    const wrong = await draw({ [FERRETS_FILE_OPEN_HOOK]: { open: 'no' } });
    expect(wrong.fileOpen).toBeUndefined();
  });
});
