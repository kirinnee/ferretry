import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Admission, ApiRequest } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import daemon from '../../../daemon/index.ts';
import type { AskAnswer } from '@ferretry/core-asks/contract';

/**
 * Board's daemon half over the test host, with the Asks and Ferrets fakes. The host's stand-in admission refuses a
 * ferret on an `operator` route, which Gate does not, so these tests bring a gate of their own: it admits everyone
 * and stands the caller in Gate's own fields (`actor`, `credential`), read from the `x-test-caller` header.
 */
const gate: Admission = {
  admit: input => {
    const header = input.request.headers.get('x-test-caller') ?? (input.table === 'tool' ? 'ferret:f1' : 'owner');
    const [kind, id = ''] = header.split(':');
    const standing =
      kind === 'ferret'
        ? { actor: `ferret:${id}`, credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: id } }
        : kind === 'device'
          ? {
              actor: `device:${id}`,
              credential: { kind: 'authenticated', tokenClass: 'device', principal: input.request.principal },
            }
          : { actor: 'admin-cli', credential: { kind: 'authenticated', tokenClass: 'admin' } };
    return { outcome: 'admitted', standing, actor: kind === 'ferret' ? 'ferret' : 'owner-tools' } as never;
  },
  admitMember: () => {
    throw new Error('Board has no member routes');
  },
  readmit: (_request: ApiRequest) => true,
  inventory: (_request, entries) => entries,
};

/** The daemon identity the test host stands in, as the kernel's identity port will give it. */
export const TEST_IDENTITY = {
  daemonId: 'fy_daemon_test0000000000000000000000000000000000000',
  daemonName: 'test-host',
};

export const as = (caller: string) => ({ 'x-test-caller': caller });

export const boot = async (
  options: { uses?: Record<string, unknown>; spawn?: Parameters<typeof testHost>[0]['spawn'] } = {},
) => {
  const asks = new FakeAsks();
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1') });
  // The half is captured as it is built, so a test can call the `apply` the card source hands Asks.
  const taken: { half?: { hooks: Record<string, unknown> } } = {};
  const capturing = {
    ...daemon,
    build: (ctx: never) => {
      // The kernel's identity port (DECISIONS-1 #1) is not on the test host yet: the daemon id it will carry.
      const withIdentity = {
        ...(ctx as object),
        kernel: { ...(ctx as { kernel: object }).kernel, identity: TEST_IDENTITY },
      };
      const half = (daemon.build as (ctx: never) => unknown)(withIdentity as never);
      taken.half = half as never;
      return half;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [capturing],
    fakes: { asks, ferrets },
    gate,
    ...(options.uses === undefined ? {} : { uses: options.uses }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });
  const apply = async (answer: AskAnswer) =>
    await (
      taken.half?.hooks['ask.sources:card'] as { apply?: (answer: AskAnswer) => Promise<unknown> } | undefined
    )?.apply?.(answer);
  /** Calls one of the half's observe hooks as the kernel would (`turn.ended`, `ferret.started`). */
  const observe = async (hook: string, payload: unknown) =>
    await (taken.half?.hooks[hook] as ((payload: unknown) => Promise<void>) | undefined)?.(payload);
  /** What one of the half's contribute hooks answers (`search.sources`, `sitrep.lines`). */
  const contribution = (hook: string): unknown => (taken.half?.hooks[hook] as (() => unknown) | undefined)?.();
  return { asks, ferrets, host, apply, observe, contribution };
};

/** Makes a card as the owner; a refusal fails the test with the daemon's own words. */
export const makeCard = async (host: Awaited<ReturnType<typeof boot>>['host'], extra: Record<string, unknown> = {}) => {
  const made = await host.request('POST', '/v1/board/cards', { body: { ...NEW_CARD, ...extra }, headers: as('owner') });
  if (made.status !== 200) throw new Error(`creating a card was refused (${String(made.status)}): ${made.body}`);
  return made.json<{ card: { id: string; title: string; laneId: string } }>().card;
};

export const NEW_CARD = {
  kind: 'feature',
  title: 'Badge colour',
  assignee: 'f1',
  ask: { text: 'Make the badge green.', source: 'owner' },
};
