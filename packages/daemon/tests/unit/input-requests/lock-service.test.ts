import { describe, it } from 'bun:test';
import { type InputRaise, type InputTargetFacts, type LoginEntrySummary, padInputValue } from '@ferretry/protocol';
import should from 'should';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';
import type { InputCaller as ServiceCaller } from '../../../src/lib/input-requests/ports.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from './support.ts';

/** The adaptive lock (!A149) through the REAL input service: the card says it, and the hold runs it. */

const HOST: ServiceCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const NOW = Date.parse('2026-10-30T12:00:00.000Z');

const PAGE: InputTargetFacts = {
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://accounts.example.test',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'password',
      frameOrigin: 'https://accounts.example.test',
      frameId: 'main',
      backendNodeId: 9,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    },
  ],
};

const PAGE_RAISE: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'the password',
  submit: 'owner-default',
  fields: [{ id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
} as InputRaise;

const flag = { value: true, observedAt: '2026-10-30T09:00:00.000Z', count: 2 };
const provenEntry = (): LoginEntrySummary => ({
  id: 'EXAMPLE',
  label: 'Example',
  match: [],
  fields: { password: true, totp: false },
  observed: [
    {
      at: 'accounts.example.test',
      surface: 'page',
      identity: identityOf(PAGE, 'accounts.example.test') as string,
      since: '2026-10-30T09:00:00.000Z',
      masked: flag,
      noEchoAfterSubmit: flag,
      navigatedAway: flag,
    },
  ],
  createdAt: 'a',
  updatedAt: 'a',
});
const logins = (entries: () => readonly LoginEntrySummary[]) => ({
  entries: async () => entries(),
  fill: async () => '',
  save: async () => undefined,
});

async function raised(w: ReturnType<typeof inputRequestService>, raise: InputRaise = RAISE) {
  const view = await w.service.raise(SESSION, raise);
  const request = (await w.service.list(HOST)).find(candidate => candidate.agendaItemId === view.id);
  if (request === undefined) throw new Error('not raised');
  return { view, request };
}

const deliver = async (w: ReturnType<typeof inputRequestService>, request: { id: string; observedDigest?: string }) =>
  await w.service.deliver(
    SESSION,
    request.id,
    {
      deliveryId: crypto.randomUUID(),
      observedDigest: request.observedDigest as string,
      fields: [{ field: 'password', padded: padInputValue('hunter2-UNIQUE-pw') }],
      submit: true,
    } as never,
    HOST,
  );

describe('the lock a card shows, and the hold that runs it', () => {
  it('should hold a sudo terminal with echo off for 10 seconds, and tell the agent so', async () => {
    const w = inputRequestService({ facts: { ...FACTS, canonical: true, trustedProgram: true } });
    const { view, request } = await raised(w);
    should(request.lock).deepEqual({ seconds: 10, reason: 'hidden-terminal' });
    should(view.lockSeconds).equal(10);
    await w.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        padded: padInputValue('hunter2-UNIQUE-pw'),
        submit: true,
      },
      HOST,
    );
    should(w.quarantine.until(SESSION, ['dev'])).equal(NOW + 10_000);
  });

  it('should hold a terminal that echoes for the full two minutes', async () => {
    const w = inputRequestService({ facts: { ...FACTS, echo: 'on', canonical: true, trustedProgram: true } });
    const { request } = await raised(w);
    should(request.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    await w.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        padded: padInputValue('hunter2-UNIQUE-pw'),
        submit: true,
      },
      HOST,
    );
    should(w.quarantine.until(SESSION, ['dev'])).equal(NOW + 120_000);
  });

  it('should give a plain value no lock at all', async () => {
    const { request } = await raised(inputRequestService(), { ...RAISE, sensitivity: 'plain' });
    should(request).not.have.property('lock');
  });

  it('should probe a qualifying page and hold it 10 seconds after a clean probe', async () => {
    const asked: (readonly string[])[] = [];
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      probe: async fieldIds => {
        asked.push(fieldIds);
        return 'hidden';
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(asked).deepEqual([['password']]);
    should(request.lock).deepEqual({ seconds: 10, reason: 'probed-field' });
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 10_000);
  });

  it('should keep the full lock when the probe stops, shows the value, throws or cannot run', async () => {
    for (const probe of [
      async () => 'aborted' as const,
      async () => 'shown' as const,
      async () => await Promise.reject(new Error('the page went away')),
    ]) {
      const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE, probe }), PAGE_RAISE);
      should(request.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    }
    const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE }), PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
  });

  it('should not probe a page a saved login already proves, and hold it 10 seconds', async () => {
    let probed = false;
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      logins: logins(() => [provenEntry()]),
      probe: async () => {
        probed = true;
        return 'hidden';
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(probed).be.false();
    should(request.lock).deepEqual({ seconds: 10, reason: 'proven-field' });
  });

  it('should never shorten at the write a lock the card showed long', async () => {
    let entries: readonly LoginEntrySummary[] = [];
    const w = inputRequestService({ steered: () => false, facts: PAGE, logins: logins(() => entries) });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
    entries = [provenEntry()];
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should earn the lock again without the probe when the card is redrawn onto a re-rendered field', async () => {
    let facts: InputTargetFacts = PAGE;
    const w = inputRequestService({ steered: () => false, facts: () => facts, probe: async () => 'hidden' });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.reason).equal('probed-field');
    facts = {
      ...PAGE,
      fields: PAGE.kind === 'browser' ? [{ ...PAGE.fields[0], backendNodeId: 77 } as never] : [],
    } as InputTargetFacts;
    await deliver(w, request).catch(() => undefined);
    const [redrawn] = await w.service.list(HOST);
    should(redrawn?.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    should(w.writes).deepEqual([]);
  });

  it('should give a redrawn plain card no lock', async () => {
    let facts: InputTargetFacts = PAGE;
    const w = inputRequestService({ steered: () => false, facts: () => facts });
    const plain = {
      ...PAGE_RAISE,
      fields: [{ id: 'password', sensitivity: 'plain', element: { kind: 'ref', ref: 'e3' } }],
    } as InputRaise;
    const { request } = await raised(w, plain);
    facts = {
      ...PAGE,
      fields: PAGE.kind === 'browser' ? [{ ...PAGE.fields[0], backendNodeId: 77 } as never] : [],
    } as InputTargetFacts;
    await deliver(w, request).catch(() => undefined);
    const [redrawn] = await w.service.list(HOST);
    should(redrawn?.observedDigest).not.equal(request.observedDigest);
    should(redrawn).not.have.property('lock');
  });

  it('should not probe, and keep the full lock, where the ferret ran a page script or no observer can tell', async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return 'hidden' as const;
    };
    const scripted = await raised(inputRequestService({ steered: () => true, facts: PAGE, probe }), PAGE_RAISE);
    const blind = await raised(inputRequestService({ facts: PAGE, probe }), PAGE_RAISE);
    should(probed).be.false();
    should(scripted.request.lock?.seconds).equal(120);
    should(blind.request.lock?.seconds).equal(120);
  });

  it('should hold the full lock at the write when the ferret acted on a page after the card was raised', async () => {
    let acted = false;
    const w = inputRequestService({
      steered: since => acted && since !== Number.POSITIVE_INFINITY,
      facts: PAGE,
      probe: async () => 'hidden',
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(10);
    acted = true;
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should hold the full lock when the saved logins cannot be read', async () => {
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      logins: {
        entries: async () => await Promise.reject(new Error('damaged')),
        fill: async () => '',
        save: async () => undefined,
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
  });
});
