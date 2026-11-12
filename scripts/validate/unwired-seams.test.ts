import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextFor } from '../gen/lib/check.ts';
import { z } from '../../packages/core/kernel/node_modules/zod';
import { defineBoundPort, defineHook, definePort } from '../../packages/core/kernel/contract/index.ts';
import type { Manifest } from '../../packages/core/kernel/manifest/index.ts';
import {
  type Facts,
  type UnwiredEntry,
  check,
  codeSeamsOf,
  routeRegex,
  parseUnwired,
  readBaseUnwired,
  unwiredFindings,
  unwiredSeams,
} from './unwired-seams.ts';

const Delivery = defineHook('ask.delivery', {
  mode: 'provide',
  key: z.enum(['ferret', 'machine']),
  value: z.custom<object>(),
});
const Moving = defineHook('card.moving', { mode: 'observe' });
const Open = defineHook('open.thing', { mode: 'provide', key: z.string(), value: z.custom<object>() });
const Port = definePort<{ ping(): void }>('lonely');
const Used = definePort<{ ping(): void }>('used');

const manifest = (parts: Record<string, unknown>): Manifest => parts as unknown as Manifest;

function facts(over: Partial<Facts> = {}): Facts {
  return {
    manifests: new Map<string, Manifest>([
      [
        'asks',
        manifest({
          hooks: { offers: [{ hook: Delivery }, { hook: Moving }, { hook: Open }] },
          provides: { lonely: Port, used: Used },
        }),
      ],
      [
        'conversation',
        manifest({
          hooks: {
            takes: [{ hook: Delivery, key: 'ferret' }, { hook: Moving }, { hook: Open, key: 'x' }],
          },
        }),
      ],
      ['board', manifest({ needs: { used: Used } })],
    ]),
    hookReads: new Map([['asks', new Set(['ask.delivery', 'card.moving', 'open.thing'])]]),
    codeSeams: [],
    halfReach: new Map<string, boolean>(),
    existingFiles: new Set<string>(),
    ...over,
  };
}

const card = '&F1787';
const entry = (seam: string, over: Partial<UnwiredEntry> = {}): UnwiredEntry => ({
  seam,
  card,
  why: 'the owner loses something',
  ...over,
});

describe('unwired-seams: the raw seams', () => {
  test('R1 an offered enum hook with one key untaken names that key', () => {
    expect(unwiredSeams(facts()).map(s => s.seam)).toContain('hook:ask.delivery:machine');
    expect(unwiredSeams(facts()).map(s => s.seam)).not.toContain('hook:ask.delivery:ferret');
  });

  test('R1 an offered hook nobody takes at all is one seam for the hook', () => {
    const f = facts({
      manifests: new Map([['asks', manifest({ hooks: { offers: [{ hook: Moving }] } })]]),
      hookReads: new Map([['asks', new Set(['card.moving'])]]),
    });
    expect(unwiredSeams(f).map(s => s.seam)).toEqual(['hook:card.moving']);
  });

  test('R1 an open key needs one taker, not one per key', () => {
    expect(unwiredSeams(facts()).map(s => s.seam)).not.toContain('hook:open.thing');
  });

  test('R2 an offered, taken, never-read hook is a read seam', () => {
    const f = facts({ hookReads: new Map([['asks', new Set(['ask.delivery', 'open.thing'])]]) });
    expect(unwiredSeams(f).map(s => s.seam)).toContain('read:card.moving');
  });

  test('R4 code seams are passed through by identifier', () => {
    const f = facts({
      codeSeams: [{ seam: 'code:packages/core/x/daemon/index.ts:reach', where: 'x/daemon/index.ts:3' }],
    });
    expect(unwiredSeams(f).map(s => s.seam)).toContain('code:packages/core/x/daemon/index.ts:reach');
  });
});

describe('unwired-seams: R3 a port nothing reaches', () => {
  test('a provided port with no needer, no kernel bind and no half reach is a port seam; a needed one is not', () => {
    const seams = unwiredSeams(facts()).map(s => s.seam);
    expect(seams).toContain('port:lonely');
    expect(seams).not.toContain('port:used');
  });

  test("a port its own app or cli half reaches over the plugin's routes is consumed", () => {
    const f = facts({ halfReach: new Map([['asks', true]]) });
    expect(unwiredSeams(f).map(s => s.seam)).not.toContain('port:lonely');
  });

  test('a kernel-bound port is consumed by the kernel', () => {
    const bound = defineBoundPort<object>('bound', 'asks');
    const f = facts({ manifests: new Map([['asks', manifest({ provides: { bound } })]]), hookReads: new Map() });
    expect(unwiredSeams(f).map(s => s.seam)).not.toContain('port:bound');
  });

  test('a port entry for a port that does not exist is a finding', () => {
    const all = unwiredSeams(facts()).map(s => ({ seam: s.seam, card, why: 'x' }));
    const found = unwiredFindings(facts(), [...all, { seam: 'port:ghost', card, why: 'x' }], undefined);
    expect(found.map(f => f.message)).toEqual([expect.stringContaining('no port named "ghost"')]);
  });

  test('routeRegex matches the whole path (params are wildcards) and never a longer path', () => {
    const route = routeRegex('/v1/ferrets/:id/agenda');
    expect(route.test('fetch(`/v1/ferrets/${id}/agenda`)')).toBe(true);
    expect(route.test("'/v1/ferrets/abc/agenda'")).toBe(true);
    expect(route.test("'/v1/ferrets/abc/agenda/replies'")).toBe(false);
    expect(routeRegex('/v1/ferrets').test("'/v1/ferrets/${id}/agenda'")).toBe(false);
    expect(routeRegex('/v1/ferrets').test("'/v1/ferrets'")).toBe(true);
  });
});

describe('unwired-seams: findings against the allowlist', () => {
  const all = unwiredSeams(facts()).map(s => s.seam);
  const listed = all.map(seam => entry(seam));

  test('an unlisted seam is a finding that says how to fix it', () => {
    const found = unwiredFindings(facts(), [], undefined);
    expect(found.map(f => f.message).join('\n')).toContain('hook:ask.delivery:machine');
    expect(found.every(f => f.check === 'unwired-seams')).toBe(true);
  });

  test('the full allowlist is clean', () => {
    expect(unwiredFindings(facts(), listed, undefined)).toEqual([]);
  });

  test('R5 a stale entry (the seam is wired now) is a finding', () => {
    const found = unwiredFindings(facts(), [...listed, entry('hook:ask.delivery:ferret')], undefined);
    expect(found.map(f => f.message)).toEqual([expect.stringContaining('stale')]);
  });

  test('R5 an entry without a &F card is a finding', () => {
    const [first, ...rest] = listed;
    const found = unwiredFindings(facts(), [{ ...(first as UnwiredEntry), card: 'F12' }, ...rest], undefined);
    expect(found.map(f => f.message)).toEqual([expect.stringContaining('card')]);
  });

  test('R5 an entry with no why is a finding', () => {
    const [first, ...rest] = listed;
    const found = unwiredFindings(facts(), [{ ...(first as UnwiredEntry), why: ' ' }, ...rest], undefined);
    expect(found.map(f => f.message)).toEqual([expect.stringContaining('why')]);
  });

  test('R5 an entry for a hook that does not exist is a finding of its own kind', () => {
    const found = unwiredFindings(facts(), [...listed, entry('hook:no.such'), entry('read:nothing')], undefined);
    const messages = found.map(f => f.message).join('\n');
    expect(found).toHaveLength(2);
    expect(messages).toContain('no hook named "no.such"');
    expect(messages).toContain('no hook named "nothing"');
  });

  test('R5 a code entry for a file that is gone is a finding', () => {
    const found = unwiredFindings(facts(), [...listed, entry('code:packages/gone.ts:x')], undefined);
    expect(found.map(f => f.message)).toEqual([expect.stringContaining('no file')]);
  });

  test('R5 a list that grew against the base is a finding; one that shrank or held is not', () => {
    const base = listed.slice(1);
    const grew = unwiredFindings(facts(), listed, base);
    expect(grew.map(f => f.message)).toEqual([expect.stringContaining('was added; the list may only shrink')]);
    expect(unwiredFindings(facts(), listed, listed)).toEqual([]);
    expect(unwiredFindings(facts(), listed, [...listed, entry('hook:old')])).toEqual([]);
  });

  test('the first baseline (the base has no unwired list) is the one allowed growth', () => {
    expect(unwiredFindings(facts(), listed, undefined)).toEqual([]);
  });

  test('a whole-hook entry covers every key; a whole-file code entry covers every identifier', () => {
    const f = facts({
      existingFiles: new Set(['packages/core/x/daemon/m.ts']),
      codeSeams: [
        { seam: 'code:packages/core/x/daemon/m.ts:a', where: 'm.ts:1' },
        { seam: 'code:packages/core/x/daemon/m.ts:b', where: 'm.ts:2' },
      ],
    });
    const entries = [
      entry('hook:ask.delivery'),
      entry('read:card.moving'),
      entry('port:lonely'),
      entry('code:packages/core/x/daemon/m.ts:*'),
    ];
    // read:card.moving is not a raw seam here (the hook is read), so it is stale; the rest cover.
    const found = unwiredFindings(f, entries, undefined);
    expect(found.map(x => x.message)).toEqual([expect.stringContaining('stale')]);
    expect(found[0]?.message).toContain('read:card.moving');
  });
});

describe('unwired-seams: the code regex', () => {
  test('unbound/unboundFn properties, notBuilt fallbacks and a hard-coded undefined are named by identifier', () => {
    const source = [
      'const reach: Reach | undefined = undefined;',
      'const real: Reach | undefined = await build();',
      'const deps = {',
      "  planner: unbound('The planner'),",
      "  start: own.start ?? unboundFn('Start'),",
      '};',
      'const notBuiltTool: ToolHandler = async () => 1;',
      'const handlers = routes.map(r => [r, answered[r] ?? notBuiltRoute]);',
      'function unbound(what: string) { return what; }',
      '// const ghost: X | undefined = undefined;',
    ].join('\n');
    expect(codeSeamsOf('packages/core/x/daemon/index.ts', source).map(s => [s.seam, s.where])).toEqual([
      ['code:packages/core/x/daemon/index.ts:reach', 'packages/core/x/daemon/index.ts:1'],
      ['code:packages/core/x/daemon/index.ts:planner', 'packages/core/x/daemon/index.ts:4'],
      ['code:packages/core/x/daemon/index.ts:start', 'packages/core/x/daemon/index.ts:5'],
      ['code:packages/core/x/daemon/index.ts:notBuiltRoute', 'packages/core/x/daemon/index.ts:8'],
    ]);
  });
});

describe('unwired-seams: the real workspace', () => {
  test('zero findings with the committed allowlist', async () => {
    const root = join(import.meta.dir, '..', '..');
    const found = await check.run(contextFor(root, { base: 'file:/nonexistent-base.json' }));
    expect(found).toEqual([]);
  }, 120_000);

  test('the committed allowlist parses and every entry has a card and a reason', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', 'ports-pending.json'), 'utf8');
    const entries = parseUnwired(text, 'ports-pending.json') ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.card).toMatch(/^&F\d+$/);
      expect(entry.why.trim()).not.toBe('');
    }
  });
});

describe('unwired-seams: the whole-file code entry', () => {
  test('covers its own file only: a NEW file that grows unbound seams is a finding', () => {
    const f = facts({
      existingFiles: new Set(['packages/core/ferrets/daemon/moves-deps.ts']),
      codeSeams: [
        { seam: 'code:packages/core/ferrets/daemon/moves-deps.ts:planner', where: 'moves-deps.ts:1' },
        { seam: 'code:packages/core/ferrets/daemon/other-deps.ts:planner', where: 'other-deps.ts:1' },
      ],
    });
    const rest = unwiredSeams(f)
      .filter(s => !s.seam.startsWith('code:'))
      .map(s => ({ seam: s.seam, card, why: 'x' }));
    const found = unwiredFindings(
      f,
      [...rest, { seam: 'code:packages/core/ferrets/daemon/moves-deps.ts:*', card, why: 'x' }],
      undefined,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('other-deps.ts:planner');
  });
});

describe('unwired-seams: the base the list may not grow from', () => {
  const git = (cwd: string, ...args: string[]): void => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  };
  /** A throwaway repo whose one commit holds `ports-pending.json` with `text`, or nothing when `text` is undefined. */
  const repoWith = (text: string | undefined): string => {
    const dir = mkdtempSync(join(tmpdir(), 'unwired-base-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, text === undefined ? 'other.txt' : 'ports-pending.json'), text ?? 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
  };
  const sentence = (ref: string): string =>
    `the base ${ref} cannot be read, so nothing proves the unwired list did not grow; fetch the base or pass a readable --base`;
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test('a ref that does not exist fails closed with a plain sentence, not a first baseline', () => {
    const dir = repoWith('{"unwired":[]}');
    dirs.push(dir);
    expect(() => readBaseUnwired(dir, 'definitely-missing-base')).toThrow(sentence('definitely-missing-base'));
  });

  test('a ref that exists but holds no ports-pending.json fails closed', () => {
    const dir = repoWith(undefined);
    dirs.push(dir);
    expect(() => readBaseUnwired(dir, 'HEAD')).toThrow(sentence('HEAD'));
  });

  test('a readable base with an empty unwired list still reports growth', () => {
    const dir = repoWith('{"unwired":[]}');
    dirs.push(dir);
    const base = readBaseUnwired(dir, 'HEAD');
    expect(base).toEqual([]);
    const everySeam = unwiredSeams(facts()).map(s => entry(s.seam));
    const grew = unwiredFindings(facts(), everySeam, base);
    expect(grew).toHaveLength(everySeam.length);
    expect(grew.every(f => f.message.includes('was added; the list may only shrink'))).toBe(true);
  });

  test('a readable base with no unwired key is the one first baseline', () => {
    const dir = repoWith('{"format":1,"pending":[]}');
    dirs.push(dir);
    expect(readBaseUnwired(dir, 'HEAD')).toBeUndefined();
  });

  test('a readable base with a list reads it as before', () => {
    const dir = repoWith(JSON.stringify({ unwired: [{ seam: 'hook:a', card, why: 'x' }] }));
    dirs.push(dir);
    expect(readBaseUnwired(dir, 'HEAD')).toEqual([{ seam: 'hook:a', card, why: 'x' }]);
  });

  test('the check exits with the sentence when the named base is missing', async () => {
    const root = join(import.meta.dir, '..', '..');
    const found = await check.run(contextFor(root, { base: 'definitely-missing-dfinal-base' }));
    expect(found.map(f => f.message)).toEqual([sentence('definitely-missing-dfinal-base')]);
  });
});
