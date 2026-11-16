import { describe, expect, it } from 'bun:test';
import {
  type HypermediaFacts,
  hypermediaDefault,
  hypermediaNote,
  SessionHypermediaError,
  SessionHypermediaService,
} from '../../../../daemon/hypermedia/lib/service.ts';
import { hypermediaLaunchEnvironment } from '../../../../daemon/hypermedia/lib/launch.ts';

const AT = '2026-10-19T00:00:00.000Z';

function service(facts: HypermediaFacts | undefined) {
  const writes: Array<readonly [string, boolean, string]> = [];
  const subject = new SessionHypermediaService({
    facts: async () => facts,
    write: async (id, enabled, at) => {
      writes.push([id, enabled, at]);
    },
    now: () => AT,
  });
  return { subject, writes };
}

describe('SessionHypermediaService', () => {
  it('records the switch and asks for a restart only when a running ferret changes', async () => {
    const running = service({ enabled: true, running: true });
    const stopped = service({ enabled: false, running: false });

    const off = await running.subject.set('s1', false);
    const on = await stopped.subject.set('s2', true);

    expect(off).toEqual({
      restartRequired: true,
      note: 'Hypermedia is off. This ferret is running, so it takes effect when the ferret restarts.',
    });
    expect(on).toEqual({
      restartRequired: false,
      note: 'Hypermedia is on; this ferret is not running, so it takes effect at its next launch.',
    });
    expect([...running.writes, ...stopped.writes]).toEqual([
      ['s1', false, AT],
      ['s2', true, AT],
    ]);
  });

  it('treats a ferret already on (by its mode default or its record) as unchanged by turning it on', async () => {
    const already = service({ enabled: true, running: true });

    expect(await already.subject.set('s1', true)).toEqual({
      restartRequired: false,
      note: 'Hypermedia was already on.',
    });
    expect(already.writes).toEqual([['s1', true, AT]]);
  });

  it('refuses a ferret that does not exist and writes nothing', async () => {
    const missing = service(undefined);

    const refused = await missing.subject.set('ghost', true).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(SessionHypermediaError);
    expect((refused as SessionHypermediaError).reason).toBe('not-found');
    expect(missing.writes).toEqual([]);
    expect(hypermediaNote(false, false, false)).toBe('Hypermedia was already off.');
  });

  it('defaults on for an interactive ferret and off for an automatic one or one with no mode', () => {
    expect([hypermediaDefault('interactive'), hypermediaDefault('auto'), hypermediaDefault(undefined)]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('says only a switch the owner set at launch, so a ferret with none keeps its mode default', () => {
    expect(hypermediaLaunchEnvironment(undefined)).toEqual({});
    expect(hypermediaLaunchEnvironment(true)).toEqual({ FY_HYPERMEDIA: '1' });
    expect(hypermediaLaunchEnvironment(false)).toEqual({ FY_HYPERMEDIA: '0' });
  });
});
