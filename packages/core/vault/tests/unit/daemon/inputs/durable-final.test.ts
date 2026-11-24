import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import should from 'should';
import { HoldsFile, InputRequestFiles } from '../../../../contract/index.ts';
import { InputStateJournal } from '../../../../daemon/adapters/inputs/journal.ts';
import type { InputCaller } from '../../../../daemon/lib/inputs/ports.ts';
import { type AgendaId, padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { RAISE, SESSION, inputRequestService } from './support.ts';

/**
 * THE FINAL OUTCOME IS DURABLE BEFORE ANYONE IS TOLD IT, through the REAL state-journal adapter on an in-memory state
 * folder, and a restart is a NEW service restored over the same folder. Nothing here is a pre-registered waiter alone.
 */
const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const CARD = 'A1' as AgendaId;
const settle = async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 5));
};

/** The real journal over `folder`; a write of a request record in a state `hold` names waits for `release()` or fails. */
function world(options: { readonly hold?: 'delivered'; readonly fail?: 'delivered' } = {}) {
  const folder = new MemoryStateFolder();
  const real = folder.port([HoldsFile, InputRequestFiles]);
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const port: StatePort = {
    ...real,
    write: (async (file: never, value: { state?: string }, name?: string) => {
      if (value?.state !== undefined && value.state === options.hold) await gate;
      if (value?.state !== undefined && value.state === options.fail) throw new Error('disk full');
      return await (real.write as (...args: unknown[]) => Promise<unknown>)(file, value, name);
    }) as StatePort['write'],
  };
  const journal = () =>
    new InputStateJournal(
      port,
      async () => CARD,
      () => '2026-10-30T12:00:00.000Z',
    );
  /** A service over the SAME folder: the first is the daemon that ran, the next is the daemon after a restart. */
  const boot = () => inputRequestService({ journal: journal() });
  return { folder, boot, release };
}

const sendOf = (request: { id: string; observedDigest?: string | undefined }) =>
  [
    SESSION,
    request.id,
    {
      deliveryId: crypto.randomUUID(),
      observedDigest: request.observedDigest ?? '',
      padded: padInputValue('hunter2-UNIQUE'),
      submit: true,
    },
    OWNER,
  ] as const;

async function raised(service: ReturnType<typeof inputRequestService>['service']) {
  await service.raise(SESSION, RAISE);
  const [request] = await service.list(OWNER);
  if (request === undefined) throw new Error('no request');
  return request;
}

const restarted = async (boot: () => ReturnType<typeof inputRequestService>) => {
  const next = boot();
  await next.service.restore();
  return next;
};

describe('a request that ends, through the real journal', () => {
  it('(a) should not read delivered to a NEW input_wait while the final write is still going, then should read it', async () => {
    const { boot, release } = world({ hold: 'delivered' });
    const { service, writes } = boot();
    const request = await raised(service);
    const answered = service.deliver(...sendOf(request));
    await settle();
    should(writes).eql(['hunter2-UNIQUE']);

    // The journal still says delivering: so does the ferret's view, polled or waited on.
    should((await service.agentView(SESSION, CARD, 0)).state).equal('delivering');
    let late: string | undefined;
    const waiting = service.agentView(SESSION, CARD, 60_000).then(view => {
      late = view.state;
    });
    await settle();
    should(late).be.undefined();

    release();
    await Promise.all([answered, waiting]);
    should(late).equal('delivered');
  });

  it('(b) should restore a delivering left in the journal as an unknown outcome, never refused or delivered', async () => {
    const { boot, release } = world({ hold: 'delivered' });
    const first = boot();
    const request = await raised(first.service);
    const answered = first.service.deliver(...sendOf(request));
    await settle();

    // The daemon dies here: the journal's last word for the request is `delivering`.
    const next = await restarted(boot);
    const view = await next.service.agentView(SESSION, CARD, 0);
    should(view.state).not.equal('refused');
    should(view.state).not.equal('delivered');
    should(view.state).equal('cancelled');
    should(view.reason).equal('outcome_unknown');
    should(view.note).match(/may have been typed/u);
    should(next.writes).eql([]);

    release();
    await answered;
  });

  it('(c) should tell every waiter an unknown outcome, never delivered, when the final write fails', async () => {
    const { boot } = world({ fail: 'delivered' });
    const first = boot();
    const request = await raised(first.service);
    const told: string[] = [];
    const waiting = first.service.agentView(SESSION, CARD, 60_000).then(view => void told.push(view.state));
    await settle();
    const result = await first.service.deliver(...sendOf(request));
    await waiting;

    // The owner's Send did type it, and says so; the ferret is told what the journal can prove.
    should(result.state).equal('delivered');
    should(told).eql(['cancelled']);
    const fresh = await first.service.agentView(SESSION, CARD, 60_000);
    should(fresh.state).equal('cancelled');
    should(fresh.reason).equal('outcome_unknown');
    should(first.writes).eql(['hunter2-UNIQUE']);

    // And a restart finds the same: the journal still says delivering.
    const next = await restarted(boot);
    const again = await next.service.agentView(SESSION, CARD, 0);
    should(again.state).equal('cancelled');
    should(again.reason).equal('outcome_unknown');
  });

  it('(d) should keep the true final state across a restart, so input_wait is not not_found', async () => {
    const { boot } = world();
    const first = boot();
    const request = await raised(first.service);
    await first.service.deliver(...sendOf(request));

    const next = await restarted(boot);
    const view = await next.service.agentView(SESSION, CARD, 60_000);
    should(view.state).equal('delivered');
    should(next.writes).eql([]);
    // An ended request is not asked about again: it is not a pending card.
    should(await next.service.list(OWNER)).eql([]);
  });

  it('(d) should keep a refused or cancelled outcome too, and let go of one that ended over an hour ago', async () => {
    const { boot, folder } = world();
    const first = boot();
    const request = await raised(first.service);
    await first.service.cancel(SESSION, request.id, OWNER);
    const next = await restarted(boot);
    should((await next.service.agentView(SESSION, CARD, 0)).state).equal('cancelled');

    const raw = folder.raw(InputRequestFiles, request.id) ?? '';
    folder.plant(
      InputRequestFiles,
      raw.replace(/"expiresAt":\s*"[^"]*"/u, '"expiresAt":"2026-10-30T09:00:00.000Z"'),
      request.id,
    );
    const later = await restarted(boot);
    await should(later.service.agentView(SESSION, CARD, 0)).be.rejectedWith(/no input request/u);
  });
});
