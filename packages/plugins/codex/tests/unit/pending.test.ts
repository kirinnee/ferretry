import { expect, test } from 'bun:test';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';
import pending from '../../../../../ports-pending.json';

test('Codex stays pending, saying why: it does not yet call copyShared for skill parts and the CLI has no config/item service', async () => {
  expect(pending.pending).toContain('codex');
  expect(pending.pendingReasons.codex.join(' ')).toContain('copyShared');
  const errors: string[] = [];
  const half = cli.build?.({
    manifest,
    client: {
      call: async () => {
        throw new Error('item service must not be invented');
      },
    },
    io: { out: () => {}, err: (text: string) => errors.push(text), isTty: false },
  } as never);
  if (half === undefined) throw new Error('missing CLI half');
  for (const verb of ['ls', 'show', 'add', 'edit', 'rm'] as const) {
    expect(await half.verbs[`harness codex settings ${verb}`]({ args: [], options: {} })).toBe(69);
  }
  expect(errors).toHaveLength(5);
  expect(errors.every(message => message.includes('not served by this daemon yet'))).toBe(true);
});
