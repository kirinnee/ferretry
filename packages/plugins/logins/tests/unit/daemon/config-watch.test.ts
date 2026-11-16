/**
 * Logins' watch on its own files (docs/config-files.md): a login file that moved in effect by any editor — a hand edit,
 * `fy config`, an agent's config tool — publishes `logins.changed` naming the login and how it moved, so whoever reads
 * the logins reads them again. A set that leaves every value as it was (a comment-only edit) publishes nothing.
 */
import { describe, expect, test } from 'bun:test';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { LoginChanged } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const work = { harness: 'claude-code', store: 'host' };
const home = { harness: 'codex', store: 'host' };

async function watching(logins: Record<string, unknown>) {
  const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: { logins } });
  await host.settle();
  const before = host.published.length;
  const changed = () => host.published.slice(before).filter(entry => entry.event === LoginChanged.name);
  return { host, changed };
}

async function afterSet(host: TestHost, logins: Record<string, unknown>) {
  host.setConfig('logins', logins);
  await host.settle();
}

describe('the logins config watch', () => {
  test('a login file added by hand is announced as added', async () => {
    const { host, changed } = await watching({ work });
    try {
      await afterSet(host, { work, home });
      expect(changed()).toEqual([{ event: LoginChanged.name, payload: { loginId: 'home', change: 'added' } }]);
    } finally {
      await host.stop();
    }
  });

  test('a login file removed by hand is announced as removed', async () => {
    const { host, changed } = await watching({ work, home });
    try {
      await afterSet(host, { work });
      expect(changed()).toEqual([{ event: LoginChanged.name, payload: { loginId: 'home', change: 'removed' } }]);
    } finally {
      await host.stop();
    }
  });

  test('a login switched off in its file by hand is announced as edited, naming only that login', async () => {
    const { host, changed } = await watching({ work, home });
    try {
      await afterSet(host, {
        work: { ...work, disabled: { reason: 'cooling off', until: '2026-11-08T09:30:00Z' } },
        home,
      });
      expect(changed()).toEqual([{ event: LoginChanged.name, payload: { loginId: 'work', change: 'edited' } }]);
    } finally {
      await host.stop();
    }
  });

  test('a set that leaves every value as it was announces nothing', async () => {
    const { host, changed } = await watching({ work, home });
    try {
      await afterSet(host, { work: { ...work }, home: { ...home } });
      expect(changed()).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});
