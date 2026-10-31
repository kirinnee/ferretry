import { describe, it } from 'bun:test';
import type { PasteRule } from '@ferretry/protocol';
import should from 'should';
import { FilePasteRuleStore } from '../../../src/adapters/index.ts';
import { CopyPlanAgendaAdapter } from '../../../src/lib/index.ts';

const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  used: 0,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};

/** A filesystem in memory: the paths written, with their modes. */
function files(initial: Readonly<Record<string, string>> = {}) {
  const text = new Map(Object.entries(initial));
  const directories: string[] = [];
  return {
    text,
    directories,
    port: {
      readText: async (path: string) => text.get(path),
      writeTextAtomic: async (path: string, value: string) => void text.set(path, value),
      ensureDirectory: async (path: string, mode: number) => void directories.push(`${path}:${mode.toString(8)}`),
    },
  };
}

describe('FilePasteRuleStore', () => {
  it('should read nothing from a store never written, and write the rules in a private folder', async () => {
    const fs = files();
    const store = new FilePasteRuleStore('/state/secure-copy', fs.port);

    should(await store.read()).be.undefined();
    await store.write([RULE]);

    should(fs.directories).eql(['/state/secure-copy:700']);
    should(JSON.parse(fs.text.get('/state/secure-copy/rules.json') ?? '')).eql({ v: 1, rules: [RULE] });
    should(await store.read()).eql([RULE]);
  });

  it('should throw on a damaged document rather than read it as no rules', async () => {
    const broken = new FilePasteRuleStore('/s', files({ '/s/rules.json': '{"v":1,"rules":[{"id":"x"}]}' }).port);
    const garbled = new FilePasteRuleStore('/s', files({ '/s/rules.json': 'not json' }).port);

    should(
      await broken.read().then(
        () => 'read',
        () => 'threw',
      ),
    ).equal('threw');
    should(
      await garbled.read().then(
        () => 'read',
        () => 'threw',
      ),
    ).equal('threw');
  });
});

describe('CopyPlanAgendaAdapter', () => {
  it('should raise an info card as the daemon, saying approving happens only at the owner command', async () => {
    const raised: unknown[] = [];
    const resolved: unknown[] = [];
    const adapter = new CopyPlanAgendaAdapter({
      raise: async (sessionId, request, actor) => {
        raised.push({ sessionId, request, actor });
        return { ok: true, item: { id: 'A4' } } as never;
      },
      resolve: async (sessionId, id, actor, note) => {
        resolved.push({ sessionId, id, actor, note });
        return { ok: true } as never;
      },
    });

    const card = await adapter.raise('s1', {
      planId: 'b'.repeat(32),
      ask: 'Allow?',
      context: '1. x',
      expiresAt: '2026-10-31T14:00:00.000Z',
    });
    await adapter.close('s1', 'A4', 'done');
    await adapter.close('s1', 'not an id', 'ignored');

    should(card).eql({ ok: true, id: 'A4' });
    should(raised).match([
      {
        sessionId: 's1',
        actor: { kind: 'daemon', cause: 'secure-copy' },
        request: { kind: 'info', subject: 'Allow?', context: '1. x', neededBy: '2026-10-31T14:00:00.000Z' },
      },
    ]);
    should((raised[0] as { request: { howToResolve: string } }).request.howToResolve).containEql(
      'Closing this card approves nothing',
    );
    should(resolved).eql([
      { sessionId: 's1', id: 'A4', actor: { kind: 'daemon', cause: 'secure-copy' }, note: 'done' },
    ]);
  });

  it('should answer in words when the agenda refuses or keeps no card', async () => {
    const refusing = new CopyPlanAgendaAdapter({
      raise: async () => ({ ok: false, error: { message: 'too many open items' } }) as never,
      resolve: async () => ({ ok: true }) as never,
    });
    const empty = new CopyPlanAgendaAdapter({
      raise: async () => ({ ok: true, item: undefined }) as never,
      resolve: async () => {
        throw new Error('gone');
      },
    });
    const card = { planId: 'b'.repeat(32), ask: 'a', context: 'c', expiresAt: '2026-10-31T14:00:00.000Z' };

    should(await refusing.raise('s1', card)).eql({ ok: false, message: 'too many open items' });
    should(await empty.raise('s1', card)).eql({ ok: false, message: 'the agenda kept no card for this plan' });
    await empty.close('s1', 'A1', 'quietly');
  });
});
