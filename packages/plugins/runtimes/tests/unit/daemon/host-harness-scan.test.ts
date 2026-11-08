import { describe, expect, it } from 'bun:test';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { LoginsApi, LoginView } from '@ferretry/plugin-logins/contract';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';
import { planImport } from '../../../daemon/lib/account/import.ts';
import type { HostEntry, HostFiles } from '../../../daemon/adapters/ports.ts';

type FixtureEntry =
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'directory'; readonly names: readonly string[] }
  | { readonly kind: 'link'; readonly target: string };

/** In-memory paths only. Like the host, stat/read/list follow links; lstat follows ancestors only. */
const fixtureFiles = (entries: Readonly<Record<string, FixtureEntry>>) => {
  const opened: string[] = [];
  const listed: string[] = [];
  const described: string[] = [];
  const followed: string[] = [];
  const resolve = (path: string, followLeaf = true, hops = 0): string => {
    if (hops > 20) throw new Error('fixture link loop');
    const parts = path.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = `/${parts.slice(0, index + 1).join('/')}`;
      const entry = entries[prefix];
      if (entry?.kind === 'link' && (followLeaf || index < parts.length - 1)) {
        const rest = parts.slice(index + 1).join('/');
        return resolve(`${entry.target}${rest === '' ? '' : `/${rest}`}`, followLeaf, hops + 1);
      }
    }
    return path;
  };
  const describe = (entry: FixtureEntry | undefined): HostEntry | undefined =>
    entry === undefined ? undefined : { kind: entry.kind, size: entry.kind === 'file' ? entry.text.length : 0 };
  const text = async (path: string): Promise<string | undefined> => {
    const target = resolve(path);
    opened.push(target);
    const entry = entries[target];
    return entry?.kind === 'file' ? entry.text : undefined;
  };
  const files: HostFiles = {
    stat: async path => {
      followed.push(path);
      return describe(entries[resolve(path)]);
    },
    lstat: async path => {
      described.push(path);
      return describe(entries[resolve(path, false)]);
    },
    readText: text,
    readBytes: async path => {
      const value = await text(path);
      return value === undefined ? undefined : new TextEncoder().encode(value);
    },
    list: async path => {
      listed.push(path);
      const entry = entries[resolve(path)];
      return entry?.kind === 'directory' ? entry.names : undefined;
    },
  };
  return { files, opened, listed, described, followed };
};

const fixtureScan = async (entries: Readonly<Record<string, FixtureEntry>>, claudeConfigDir?: string) => {
  const fixture = fixtureFiles({
    '/fixture/home': { kind: 'directory', names: ['.claude', '.codex'] },
    '/fixture/home/.claude': { kind: 'directory', names: ['CLAUDE.md', 'skills'] },
    '/fixture/home/.codex': { kind: 'directory', names: ['auth.json'] },
    ...entries,
  });
  const scanner = new HostHarnessScanner({
    userHome: '/fixture/home',
    ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }),
    files: fixture.files,
    commands: { resolve: () => undefined },
    logins: fakeLogins([]),
    maxDocumentBytes: 4096,
  });
  return { ...fixture, scans: await scanner.scan() };
};

describe('host setup filesystem aliases', () => {
  const inert = 'INERT_SIGN_IN_FIXTURE';

  it('refuses CLAUDE.md linked to .codex/auth.json without opening or returning sign-in bytes', async () => {
    const result = await fixtureScan({
      '/fixture/home/.claude/CLAUDE.md': { kind: 'link', target: '/fixture/home/.codex/auth.json' },
      '/fixture/home/.codex/auth.json': { kind: 'file', text: inert },
    });
    expect(result.scans[0]?.instructions).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('links'),
    });
    expect(result.described).toContain('/fixture/home/.claude/CLAUDE.md');
    expect(result.opened).toEqual([]);
    expect(result.followed).toEqual([]);
    expect(JSON.stringify(result.scans)).not.toContain(inert);
  });

  it('refuses a skill directory linked to the Codex home without opening any credential bytes', async () => {
    const result = await fixtureScan({
      '/fixture/home/.claude/skills': { kind: 'directory', names: ['linked-home'] },
      '/fixture/home/.claude/skills/linked-home': { kind: 'link', target: '/fixture/home/.codex' },
      '/fixture/home/.codex/auth.json': { kind: 'file', text: inert },
    });
    expect(result.scans[0]?.skills).toEqual([]);
    expect(result.scans[0]?.problems.join(' ')).toContain('links');
    // Only the skills folder itself is listed; the linked entry is never entered, and nothing is opened.
    expect(result.listed).toEqual(['/fixture/home/.claude/skills']);
    expect(result.opened).toEqual([]);
    expect(result.followed).toEqual([]);
    expect(JSON.stringify(result.scans)).not.toContain(inert);
  });

  it('rejects a linked harness home and skills ancestor before reaching their children', async () => {
    for (const linked of ['/fixture/home/.claude', '/fixture/home/.claude/skills']) {
      const result = await fixtureScan({
        [linked]: { kind: 'link', target: '/fixture/home/.codex' },
        '/fixture/home/.codex/CLAUDE.md': { kind: 'file', text: inert },
        '/fixture/home/.codex/auth.json': { kind: 'file', text: inert },
      });
      expect(result.scans[0]?.problems.join(' ')).toContain('links');
      expect(result.described.some(path => path.startsWith(`${linked}/`))).toBe(false);
      expect(result.opened).toEqual([]);
      expect(result.listed).toEqual([]);
      expect(JSON.stringify(result.scans)).not.toContain(inert);
    }
  });

  it('refuses sign-in filenames as configured home components before any host call', async () => {
    for (const name of ['auth.json', '.credentials.json']) {
      const home = `/fixture/home/${name}`;
      const result = await fixtureScan({ [home]: { kind: 'directory', names: ['CLAUDE.md'] } }, home);
      expect(result.scans[0]?.instructions).toMatchObject({
        kind: 'unreadable',
        reason: expect.stringContaining('sign-in files'),
      });
      expect(result.described.some(path => path === home || path.startsWith(`${home}/`))).toBe(false);
      expect(result.opened).toEqual([]);
      expect(result.listed).toEqual([]);
    }
  });

  it('S144 reads an ordinary document and refuses a sign-in file named inside a skills folder, never opening it', async () => {
    const result = await fixtureScan({
      '/fixture/home/.claude/CLAUDE.md': { kind: 'file', text: 'ordinary instructions' },
      '/fixture/home/.claude/skills': { kind: 'directory', names: ['ordinary-skill', 'auth.json'] },
      '/fixture/home/.claude/skills/auth.json': { kind: 'file', text: inert },
    });
    expect(result.scans[0]?.instructions).toMatchObject({ kind: 'text', text: 'ordinary instructions' });
    expect(result.scans[0]?.problems.join(' ')).toContain('sign-in files');
    expect(result.scans[0]?.skills).toEqual([]);
    expect(result.opened).toEqual(['/fixture/home/.claude/CLAUDE.md']);
    expect(JSON.stringify(result.scans)).not.toContain(inert);
  });

  it('treats a skills path that is a file as no skills, without a problem', async () => {
    const result = await fixtureScan({
      '/fixture/home/.claude/skills': { kind: 'file', text: 'a file, not a folder' },
    });
    expect(result.scans[0]?.skills).toEqual([]);
    expect(result.scans[0]?.problems).toEqual([]);
    expect(result.opened).toEqual([]);
    expect(result.listed).toEqual([]);
  });
});

const scan = async (logins: Pick<LoginsApi, 'list'>) => {
  const paths: string[] = [];
  const touch = (path: string): undefined => {
    paths.push(path);
    if (/auth\.json|\.credentials\.json/.test(path)) throw new Error('credential file reached');
    return undefined;
  };
  const scanner = new HostHarnessScanner({
    userHome: '/fixture/home',
    files: {
      stat: async path => touch(path),
      lstat: async path => touch(path),
      readText: async path => touch(path),
      readBytes: async path => touch(path),
      list: async path => touch(path),
    },
    commands: { resolve: name => `/fixture/bin/${name}` },
    logins,
    maxDocumentBytes: 4096,
  });
  return { scans: await scanner.scan(), paths };
};

describe('opaque host sign-in scan', () => {
  it('uses only safe Logins facts and never opens a credential file', async () => {
    const facts = fakeLogins([
      sampleLogin('you', { email: 'you@example.test' }),
      sampleLogin('codex', {
        harness: 'codex',
        harnesses: ['codex'],
        status: { ...sampleLogin('codex').status, word: 'refresh_due' },
      }),
    ]);
    const { scans, paths } = await scan(facts);
    expect(scans.map(row => row.login)).toEqual([
      { state: 'signed-in', email: 'you@example.test' },
      { state: 'refresh-due' },
    ]);
    expect(paths.some(path => /auth\.json|\.credentials\.json/.test(path))).toBe(false);
  });

  it('reports unknown for unregistered, non-host, ambiguous and inconclusive host facts', async () => {
    const row = sampleLogin('you');
    const variants: readonly (readonly LoginView[])[] = [
      [],
      [{ ...row, store: 'ferretry' }],
      [row, sampleLogin('other')],
      [{ ...row, status: { ...row.status, lastCheckInconclusive: true } }],
      [{ ...row, status: { ...row.status, word: 'checking' } }],
    ];
    for (const rows of variants) {
      const { scans } = await scan(fakeLogins(rows));
      expect(scans[0]?.login.state).toBe('unknown');
    }
  });

  it('keeps a failing facts port unknown and retains an opaque store host pointer in the import plan', async () => {
    const { scans } = await scan({
      list: async () => {
        throw new Error('unavailable');
      },
    });
    expect(scans.map(row => row.login.state)).toEqual(['unknown', 'unknown']);
    const plan = planImport(scans, { digest: text => text });
    expect(Object.values(plan.credentials).map(login => login.store)).toEqual(['host', 'host']);
    expect(JSON.stringify(plan.notes)).toContain('unknown');
  });

  it('reports a definitive missing sign-in only when Logins says so', async () => {
    const row = sampleLogin('you');
    const { scans } = await scan(fakeLogins([{ ...row, status: { ...row.status, word: 'needs_sign_in' } }]));
    expect(scans[0]?.login.state).toBe('not-signed-in');
  });
});
