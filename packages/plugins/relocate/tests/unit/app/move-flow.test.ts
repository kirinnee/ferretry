/** U16: the app's move flow, against two scripted machines: the order of the calls, what each is told, and where it stops. */
import { describe, expect, it } from 'bun:test';
import { toBase64Url } from '@ferretry/std/sealing';
import { carry, type Machine, MoveStopped, type Progress, review, sizeWords } from '../../../app/lib/move.ts';
import { newIdentity, openOffer } from '../../support/identity.ts';

const FERRET = 'f1';

interface Scripted {
  readonly machine: Machine;
  readonly calls: { readonly route: string; readonly params?: unknown; readonly body?: unknown }[];
  readonly pressed: { count: number };
}

function scripted(
  daemon: string,
  name: string,
  answer: (route: string, init: { params?: Record<string, string>; body?: unknown }) => unknown,
  options: { readonly dismiss?: boolean } = {},
): Scripted {
  const calls: Scripted['calls'] = [];
  const pressed = { count: 0 };
  const machine: Machine = {
    daemon,
    name,
    press: async act => {
      pressed.count += 1;
      return options.dismiss === true ? undefined : await act();
    },
    client: {
      call: (async (route: string, init?: { params?: Record<string, string>; body?: unknown }) => {
        (calls as { route: string; params?: unknown; body?: unknown }[]).push({
          route,
          params: init?.params,
          body: init?.body,
        });
        const out = answer(route, init ?? {});
        if (out instanceof Error) throw out;
        return out;
      }) as Machine['client']['call'],
    },
  };
  return { machine, calls, pressed };
}

const needs = { harness: 'claude-code', remote: 'https://example.test/a/b.git', secrets: [] };
const preflight = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  refusals: [],
  moves: [{ id: 'ferret-record', label: 'Its name' }],
  stays: [{ id: 'jobs', label: 'Jobs', why: 'refused while running' }],
  files: 3,
  bytes: 2048,
  largest: [],
  needs,
  ignored: ['.env'],
  withheld: [],
  branch: 'main',
  head: 'a'.repeat(40),
  ...extra,
});

async function world(options: { targetRefuses?: string; completeFails?: boolean } = {}) {
  const sourceIdentity = await newIdentity();
  const targetIdentity = await newIdentity();
  const opened = await openOffer(targetIdentity, { expiresAtMs: Date.now() + 120_000 });
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const header = {
    v: 1,
    offerId: opened.offer.offerId,
    sourceDaemonId: sourceIdentity.daemonId,
    identityKey: 'AAAA',
    signature: 'AAAA',
    targetDaemonId: targetIdentity.daemonId,
    expiresAt: opened.offer.expiresAt,
    ephemeralKey: 'AAAA',
    chunks: chunks.length,
    bytes: 5,
  };
  const exportId = 'fy_relocate_export_' + 'x'.repeat(22);
  const from = scripted(sourceIdentity.daemonId, 'Desk', route => {
    if (route === 'POST /v1/relocate/:ferretId/preflight') return preflight();
    if (route === 'POST /v1/relocate/:ferretId/export') return { exportId, header };
    if (route === 'GET /v1/relocate/exports/:exportId/chunks/:index') return undefined;
    if (route === 'POST /v1/relocate/exports/:exportId/complete')
      return options.completeFails === true
        ? new Error('the ledger could not be written')
        : { ferretId: FERRET, movedTo: {} };
    throw new Error(`unscripted ${route}`);
  });
  let served = 0;
  const source = scripted(sourceIdentity.daemonId, 'Desk', (route, init) => {
    if (route === 'GET /v1/relocate/exports/:exportId/chunks/:index') {
      served += 1;
      return chunks[Number(init.params?.index)];
    }
    return from.machine.client.call(route, init as never);
  });
  void served;
  const to = scripted(targetIdentity.daemonId, 'Laptop', route => {
    if (route === 'POST /v1/relocate/offers') return opened.offer;
    if (route === 'POST /v1/relocate/offers/:offerId/preflight')
      return {
        ok: options.targetRefuses === undefined,
        refusals: options.targetRefuses === undefined ? [] : [options.targetRefuses],
        project: 'found',
        missingSecrets: [],
      };
    if (route === 'PUT /v1/relocate/offers/:offerId/chunks/:index') return { index: 0 };
    if (route === 'POST /v1/relocate/offers/:offerId/import')
      return {
        ferretId: 'g9',
        folder: '/work/x',
        movedFrom: { daemonId: sourceIdentity.daemonId, ferretId: FERRET },
      };
    throw new Error(`unscripted ${route}`);
  });
  return { source, to, chunks, header, exportId, sourceIdentity, targetIdentity };
}

describe('the review', () => {
  it('opens the target’s offer, then asks both machines, each behind its own press', async () => {
    const w = await world();
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    expect(reviewed.ok).toBe(true);
    expect(w.to.calls.map(call => call.route)).toEqual([
      'POST /v1/relocate/offers',
      'POST /v1/relocate/offers/:offerId/preflight',
    ]);
    expect(w.source.calls[0]).toMatchObject({ params: { ferretId: FERRET }, body: { to: w.to.machine.daemon } });
    // the target is asked what the SOURCE said the ferret needs
    expect(w.to.calls[1]?.body).toMatchObject({ needs });
    expect(w.source.pressed.count).toBe(1);
    expect(w.to.pressed.count).toBe(2);
  });

  it('names the machine that refused, and does not call the move ok', async () => {
    const w = await world({ targetRefuses: 'no claude-code login' });
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    expect(reviewed.ok).toBe(false);
    expect(reviewed.refusals).toEqual(['Laptop: no claude-code login']);
    await expect(carry(FERRET, w.source.machine, w.to.machine, reviewed)).rejects.toThrow(MoveStopped);
    // nothing was sealed
    expect(w.source.calls.some(call => call.route.endsWith('/export'))).toBe(false);
  });

  it('refuses an offer another machine answered with, before anything is sent', async () => {
    const w = await world();
    const other = await newIdentity();
    const stranger = scripted(other.daemonId, 'Stranger', () => w.to.calls.length && undefined);
    const wrong = { ...stranger.machine, client: w.to.machine.client };
    await expect(review(FERRET, w.source.machine, wrong)).rejects.toThrow('another machine’s offer');
    expect(w.source.calls).toEqual([]);
  });

  it('stops when the person dismisses the passkey on a machine', async () => {
    const w = await world();
    const quiet = scripted(w.to.machine.daemon, 'Laptop', () => undefined, { dismiss: true });
    await expect(review(FERRET, w.source.machine, quiet.machine)).rejects.toThrow('was not unlocked with your passkey');
    expect(quiet.calls).toEqual([]);
  });
});

describe('carrying', () => {
  it('seals, carries every chunk A → B as base64url, imports with the app’s own source id, then completes', async () => {
    const w = await world();
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    const steps: Progress[] = [];
    const moved = await carry(FERRET, w.source.machine, w.to.machine, reviewed, { onProgress: p => steps.push(p) });
    expect(moved.stub).toBe('marked');
    expect(moved.received.ferretId).toBe('g9');
    const puts = w.to.calls.filter(call => call.route.startsWith('PUT '));
    expect(puts.map(call => (call.body as { chunk: string }).chunk)).toEqual(w.chunks.map(toBase64Url));
    const importCall = w.to.calls.find(call => call.route.endsWith('/import'));
    expect(importCall?.body).toMatchObject({ sourceDaemonId: w.source.machine.daemon, header: { chunks: 2 } });
    // the source is told where it went only after the target had it
    const order = [...w.source.calls.map(call => `A ${call.route}`), ...w.to.calls.map(call => `B ${call.route}`)];
    expect(w.source.calls.at(-1)?.route).toBe('POST /v1/relocate/exports/:exportId/complete');
    expect(w.source.calls.at(-1)?.body).toEqual({ to: { daemonId: w.to.machine.daemon, ferretId: 'g9' } });
    expect(order.length).toBeGreaterThan(6);
    expect(steps.map(step => step.step)).toEqual(
      expect.arrayContaining(['sealing', 'carrying', 'receiving', 'finishing', 'done']),
    );
    expect(steps.filter(step => step.chunk !== undefined).at(-1)?.chunk).toEqual({ done: 2, of: 2 });
  });

  it('leaves the ferret on the target and says so when the source cannot leave its note', async () => {
    const w = await world({ completeFails: true });
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    const moved = await carry(FERRET, w.source.machine, w.to.machine, reviewed);
    expect(moved.stub).toBe('unmarked');
    expect(moved.stubNote).toContain('the ledger could not be written');
    expect(moved.received.ferretId).toBe('g9');
  });

  it('does not complete the source when the target refuses the import', async () => {
    const w = await world();
    const failing = scripted(w.to.machine.daemon, 'Laptop', (route, init) =>
      route.endsWith('/import')
        ? new Error('the harness is not installed')
        : w.to.machine.client.call(route, init as never),
    );
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    await expect(carry(FERRET, w.source.machine, failing.machine, reviewed)).rejects.toThrow(
      'Laptop: the harness is not installed',
    );
    expect(w.source.calls.some(call => call.route.endsWith('/complete'))).toBe(false);
  });

  it('refuses a ran-out offer before sealing anything', async () => {
    const w = await world();
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    const stale = {
      ...reviewed,
      offer: { ...reviewed.offer, expiresAt: new Date(Date.now() - 1000).toISOString() as never },
    };
    await expect(carry(FERRET, w.source.machine, w.to.machine, stale)).rejects.toThrow('offer ran out');
    expect(w.source.calls.some(call => call.route.endsWith('/export'))).toBe(false);
  });
});

describe('a chunk that is not ciphertext', () => {
  it('stops the move before the target is sent anything', async () => {
    const w = await world();
    const reviewed = await review(FERRET, w.source.machine, w.to.machine);
    const odd = scripted(w.source.machine.daemon, 'Desk', (route, init) =>
      route.includes('/chunks/') ? 'not bytes' : w.source.machine.client.call(route, init as never),
    );
    await expect(carry(FERRET, odd.machine, w.to.machine, reviewed)).rejects.toThrow('not ciphertext');
    expect(w.to.calls.some(call => call.route.startsWith('PUT'))).toBe(false);
  });
});

describe('sizes', () => {
  it('reads as a person would', () => {
    expect([sizeWords(12), sizeWords(2048), sizeWords(5 * 1024 * 1024), sizeWords(300 * 1024 * 1024)]).toEqual([
      '12 B',
      '2.0 KB',
      '5.0 MB',
      '300 MB',
    ]);
  });
});

describe('what the review says', () => {
  it('lays the preflight out as moves, stays and what is left behind by name', async () => {
    const { tableOf } = await import('../../../app/lib/move.ts');
    const view = {
      moves: [{ id: 'turns', label: 'Turns' }],
      stays: [{ id: 'jobs', label: 'Jobs', why: 'refused while running' }],
      ignored: ['.env'],
      withheld: ['deploy.pem'],
      files: 3,
      bytes: 2048,
    } as never;
    expect(tableOf(view)).toEqual({
      moves: [{ id: 'turns', label: 'Turns' }],
      stays: [{ id: 'jobs', label: 'Jobs', why: 'refused while running' }],
      left: ['.env', 'deploy.pem'],
      files: 3,
      bytes: 2048,
    });
  });
});
