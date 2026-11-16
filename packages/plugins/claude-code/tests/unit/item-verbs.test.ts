import { expect, test } from 'bun:test';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';

const built = () => {
  const calls: string[] = [];
  const out: string[] = [];
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: { query?: { path?: string } }) => {
        calls.push(`${route} ${init?.query?.path ?? ''}`.trim());
        return { path: init?.query?.path, exists: true, text: 'hooks: {}\n', etag: 'e1', state: 'ok' };
      },
    },
    io: { out: (text: string) => out.push(text), err: () => {}, isTty: false },
  } as never);
  if (half === undefined) throw new Error('missing CLI half');
  return { half, calls, out };
};

test('the settings and hooks item verbs read their own collections, not the item-service stub that answered 69', async () => {
  const { half, calls } = built();
  expect(await half.verbs['harness claude-code settings show']({ args: ['fast'], options: {} })).toBe(0);
  expect(await half.verbs['harness claude-code hooks show']({ args: ['guard'], options: {} })).toBe(0);
  expect(calls).toEqual([
    'GET /v1/config/file claude-code/settings/fast.yaml',
    'GET /v1/config/file claude-code/hooks/guard.yaml',
  ]);
});

test('it implements every item verb the manifest declares', () => {
  const { half } = built();
  const declared = (manifest.actions?.cli ?? []).map(verb => verb.verb).filter(verb => /settings|hooks/.test(verb));
  expect(declared).toHaveLength(10);
  for (const verb of declared) expect(typeof half.verbs[verb as keyof typeof half.verbs]).toBe('function');
});
