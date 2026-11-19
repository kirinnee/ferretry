import { describe, expect, it } from 'bun:test';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';
import type { HostEntry, HostFiles } from '../../../daemon/adapters/ports.ts';

const CLAUDE_JSON = JSON.stringify({
  projects: { '/work/served': {}, '/work/served-without': {}, '/work/unserved': {}, '/work/odd-kind': {} },
});

/** A host where only some project folders are served: the rest refuse, as a folder outside every kernel root does. */
const scanWith = async () => {
  const lstatted: string[] = [];
  const read: string[] = [];
  const file = (size: number): HostEntry => ({ kind: 'file', size });
  const files: HostFiles = {
    readText: async path => {
      read.push(path);
      return path === '/home/.claude.json' ? CLAUDE_JSON : undefined;
    },
    readBytes: async path => {
      read.push(path);
      return undefined;
    },
    stat: async path => (path === '/home/.claude.json' ? file(CLAUDE_JSON.length) : undefined),
    lstat: async path => {
      lstatted.push(path);
      if (path === '/home/.claude.json') return file(CLAUDE_JSON.length);
      if (path === '/work/served/CLAUDE.md') return file(10);
      if (path === '/work/odd-kind/CLAUDE.md') return { kind: 'directory', size: 0 };
      if (path.startsWith('/work/served-without/')) return undefined;
      if (path.startsWith('/work/')) throw new Error(`${path} is outside the folders Runtimes may read`);
      return undefined;
    },
    list: async () => undefined,
  };
  const scanner = new HostHarnessScanner({
    userHome: '/home',
    files,
    commands: { resolve: () => undefined },
    logins: fakeLogins([]),
    maxDocumentBytes: 4096,
  });
  return { scans: await scanner.scan(), lstatted, read };
};

describe('project instructions hints', () => {
  it('lists each project folder with an instructions file seen, or one that could not be looked at', async () => {
    const { scans } = await scanWith();

    expect(scans[0]?.projectInstructions).toEqual([
      { path: '/work/served', file: 'CLAUDE.md', verified: true },
      { path: '/work/unserved', file: 'CLAUDE.md', verified: false },
    ]);
  });

  it('only ever looks at the one file by name, and reads nothing inside a project', async () => {
    const { lstatted, read } = await scanWith();

    expect(lstatted.filter(path => path.startsWith('/work/')).every(path => path.endsWith('/CLAUDE.md'))).toBe(true);
    expect(read.some(path => path.startsWith('/work/'))).toBe(false);
  });

  it('gives Codex no project hints', async () => {
    const { scans } = await scanWith();

    expect(scans[1]?.projectInstructions).toBeUndefined();
  });
});
