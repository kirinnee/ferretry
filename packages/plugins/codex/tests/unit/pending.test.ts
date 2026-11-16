import { expect, test } from 'bun:test';
import cli from '../../cli/index.ts';
import { codexFixedArguments } from '../../daemon/lib/fixed-layer.ts';
import manifest from '../../manifest.ts';
import pending from '../../ports-pending.json';

test('the five `fy harness codex settings` verbs run over the config routes, and their pending line is gone', async () => {
  expect(pending.pendingReasons.codex.join(' ')).not.toContain('settings` verbs refuse with exit 69');
  const calls: string[] = [];
  const out: string[] = [];
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: { query?: { path?: string } }) => {
        calls.push(`${route} ${init?.query?.path ?? ''}`.trim());
        if (route === 'GET /v1/config/status')
          return {
            directory: '/h/config',
            files: [{ path: 'codex/settings/fast.yaml', kind: 'codex', state: 'ok' }],
            issues: [],
            pending: [],
          };
        return { path: init?.query?.path, exists: true, text: 'settings: {}\n', etag: 'e1', state: 'ok' };
      },
    },
    io: { out: (text: string) => out.push(text), err: () => {}, isTty: false },
  } as never);
  if (half === undefined) throw new Error('missing CLI half');
  expect(await half.verbs['harness codex settings ls']({ args: [], options: {} })).toBe(0);
  expect(await half.verbs['harness codex settings show']({ args: ['fast'], options: {} })).toBe(0);
  expect(calls).toEqual(['GET /v1/config/status', 'GET /v1/config/file codex/settings/fast.yaml']);
  expect(out.join('')).toContain('fast\n');
  expect(out.join('')).toContain('settings: {}');
});

test('a Codex ferret is not yet told to re-absorb its task, card and agenda after a compaction, and the GAP says so', () => {
  const gap = pending.pendingReasons.codex.filter(line => line.includes('GAP(codex-compaction)'));
  expect(gap).toHaveLength(1);
  expect(gap[0]).toContain('SessionStart');
  expect(gap[0]).toContain('hooks.state');
  // The day a compact prompt or a trusted hook lands in the fixed layer, this fails: delete the GAP line with it.
  const fixed = codexFixedArguments('auto', '/work').join(' ');
  expect(fixed).not.toMatch(/compact|hooks/u);
});
