import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import {
  PushEnvelopeSchema as fromBarrel,
  readPushMessage as readFromBarrel,
  shouldShowPush as decideFromBarrel,
} from '../../contract/index.ts';
import { shouldShowPush } from '../../contract/notification-filter.ts';
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  PUSH_URL_MAX,
  PushEnvelopeSchema,
  readPushMessage,
} from '../../contract/push-envelope.ts';

const root = resolve(import.meta.dir, '../..');

/** Every module the entry reaches, by walking its static imports (type-only imports included). */
async function importGraph(entry: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(/^(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gmu)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) await visit(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  };
  await visit(entry);
  return [...[...seen].map(file => file.slice(root.length + 1)), ...[...external].map(name => `external:${name}`)];
}

const good = { title: 'Deploy approval', body: 'Ship the build?', url: '/ferrets/f1/chat?ask=A3' };

describe('@ferretry/kernel/contract/notification-filter', () => {
  test('is zod and the push envelope only: the signed service worker imports it by this subpath', async () => {
    expect(await importGraph(resolve(root, 'contract/notification-filter.ts'))).toEqual([
      'contract/notification-filter.ts',
      'contract/push-envelope.ts',
      'external:zod',
    ]);
  });

  test('the subpath and the contract barrel are the same declaration', () => {
    expect(decideFromBarrel).toBe(shouldShowPush);
  });

  test('both subpaths resolve alone through the package exports', () => {
    for (const subpath of ['push-envelope', 'notification-filter'])
      expect(Bun.resolveSync(`@ferretry/kernel/contract/${subpath}`, root)).toBe(
        resolve(root, `contract/${subpath}.ts`),
      );
  });
});

describe('@ferretry/kernel/contract/push-envelope', () => {
  test('is zod and nothing else: the signed service worker imports it by this subpath', async () => {
    expect(await importGraph(resolve(root, 'contract/push-envelope.ts'))).toEqual([
      'contract/push-envelope.ts',
      'external:zod',
    ]);
  });

  test('the subpath and the contract barrel are the same declaration', () => {
    expect(fromBarrel).toBe(PushEnvelopeSchema);
    expect(readFromBarrel).toBe(readPushMessage);
  });

  test('a field exactly at its cap is accepted and one past it is refused; nothing else rides along', () => {
    const at = (field: 'title' | 'body' | 'url', length: number) => ({ ...good, [field]: 'x'.repeat(length) });
    for (const [field, cap] of [
      ['title', PUSH_TITLE_MAX],
      ['body', PUSH_BODY_MAX],
      ['url', PUSH_URL_MAX],
    ] as const) {
      expect(PushEnvelopeSchema.safeParse(at(field, cap)).success).toBe(true);
      expect(PushEnvelopeSchema.safeParse(at(field, cap + 1)).success).toBe(false);
    }
    expect(PushEnvelopeSchema.safeParse({ ...good, token: 'secret' }).success).toBe(false);
  });
});
