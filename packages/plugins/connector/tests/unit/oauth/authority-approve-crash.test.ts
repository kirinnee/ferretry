import { describe, expect, test } from 'bun:test';
import type { ConnectorState } from '../../../contract/index.ts';
import { ConnectorAuthority } from '../../../daemon/lib/oauth/authority.ts';
import { ConnectorMemory } from '../../../daemon/lib/oauth/model.ts';
import { ConnectorRateLimiter } from '../../../daemon/lib/oauth/rate-limiter.ts';
import type { ConnectorAuditEvent } from '../../../daemon/lib/ports.ts';
import { fixture } from '../../support/oauth-fixture.ts';

/**
 * An approval is three durable steps (pending record, audit, flip to approved). The process can die between any two,
 * so each test freezes the disk and the audit trail at one such point, then RELOADS: a brand-new authority over a
 * copy of what was on disk. Whatever it shows the owner as connected must already be audited as approved, and a
 * credential must be impossible for anything that is not.
 */
function crashWorld() {
  const f = fixture();
  let gate: { at: 'after-pending-save' | 'in-audit'; reached: () => void; released: Promise<void> } | undefined;
  let failFrom: number | undefined;
  let saves = 0;
  const authority = new ConnectorAuthority({
    ...f.options,
    store: {
      load: f.store.load,
      save: async value => {
        saves += 1;
        if (failFrom !== undefined && saves >= failFrom) throw new Error('disk full');
        await f.store.save(value);
        if (saves === 2 && gate?.at === 'after-pending-save') {
          const current = gate;
          gate = undefined;
          current.reached();
          await current.released;
        }
      },
    },
    audit: {
      record: async (event: ConnectorAuditEvent) => {
        if (gate?.at === 'in-audit') {
          const current = gate;
          gate = undefined;
          current.reached();
          await current.released;
        }
        await f.options.audit.record(event);
      },
    },
  });
  /** A new process: fresh memory, the frozen disk, the audit trail as it stood. */
  const reload = (disk: ConnectorState) => {
    const memory = new ConnectorMemory();
    const reloaded = new ConnectorAuthority({
      ...f.options,
      memory,
      limiter: new ConnectorRateLimiter(f.options.clock),
      store: { load: async () => structuredClone(disk), save: async () => undefined },
    });
    return { reloaded, memory };
  };
  const crashAt = async (at: 'after-pending-save' | 'in-audit') => {
    const client = await authority.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    await f.authorize(client.client_id);
    const id = (await authority.pending())[0]?.id ?? '';
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>(resolve => (reached = resolve));
    const released = new Promise<void>(resolve => (release = resolve));
    gate = { at, reached, released };
    const outcome = authority.approve(id, 'admin-cli');
    outcome.catch(() => undefined);
    await reachedPromise;
    return { disk: f.state(), events: [...f.events], release, outcome };
  };
  return {
    f,
    authority,
    reload,
    crashAt,
    /** Fails every store write from the nth one of this world on (1 = the registration). */
    failSavesFrom: (nth: number) => {
      failFrom = nth;
    },
  };
}

async function approvedIds(events: readonly ConnectorAuditEvent[]) {
  return events.flatMap(event => (event.kind === 'connector.grant.approved' ? [event.grantId] : []));
}

describe('connector authority — an approval that dies midway', () => {
  for (const at of ['after-pending-save', 'in-audit'] as const) {
    test(`crash ${at}: after reload nothing is connected, nothing is live and no credential exists`, async () => {
      const w = crashWorld();
      const frozen = await w.crashAt(at);
      expect(frozen.disk.grants).toHaveLength(1); // the record IS on disk at the moment of the crash
      expect(await approvedIds(frozen.events)).toEqual([]); // and its approval is not audited yet
      const { reloaded, memory } = w.reload(frozen.disk);
      expect(await reloaded.grants()).toEqual([]); // the owner view never shows it
      await memory.index.ensure(async () => frozen.disk);
      expect(memory.index.grantLive(frozen.disk.grants[0]?.id ?? '')).toBe(false);
      expect(frozen.disk.grants.every(grant => grant.access.length === 0 && grant.refresh.length === 0)).toBe(true);
      frozen.release();
      await frozen.outcome;
    });
  }

  test('every connected grant after a reload has its approval audited, whatever step the crash was at', async () => {
    const w = crashWorld();
    const frozen = await w.crashAt('in-audit');
    frozen.release();
    const finished = await frozen.outcome;
    expect(finished).toMatchObject({ ok: true });
    const events = [...w.f.events];
    const { reloaded } = w.reload(w.f.state());
    const shown = await reloaded.grants();
    expect(shown).toHaveLength(1);
    expect(await approvedIds(events)).toContain(shown[0]?.id ?? '');
  });

  test('the flip failing leaves a pending record that is not connected', async () => {
    const w = crashWorld();
    const client = await w.authority.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    await w.f.authorize(client.client_id);
    const id = (await w.authority.pending())[0]?.id ?? '';
    w.failSavesFrom(3); // save 1 is the registration, save 2 the pending write; the flip and the clean-up both fail
    const first = w.authority.approve(id, 'admin-cli');
    await expect(first).rejects.toThrow('disk full');
    expect(await w.authority.grants()).toEqual([]);
    const { reloaded } = w.reload(w.f.state());
    expect(await reloaded.grants()).toEqual([]);
  });
});
