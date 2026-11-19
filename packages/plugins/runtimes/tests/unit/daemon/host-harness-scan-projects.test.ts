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

describe('MCP commands the scan may not look at', () => {
  const claudeJson = JSON.stringify({
    mcpServers: {
      outside: { command: '/opt/tools/outside-mcp' },
      inside: { command: '/home/bin/inside-mcp' },
      gone: { command: '/home/bin/gone-mcp' },
    },
  });
  const scan = async () => {
    const files: HostFiles = {
      readText: async path => (path === '/home/.claude.json' ? claudeJson : undefined),
      readBytes: async () => undefined,
      stat: async path => {
        if (path === '/home/.claude.json') return { kind: 'file', size: claudeJson.length };
        if (path === '/home/bin/inside-mcp') return { kind: 'file', size: 10 };
        if (path.startsWith('/opt/')) throw new Error(`${path} is outside the folders Runtimes may read`);
        return undefined;
      },
      lstat: async path => (path === '/home/.claude.json' ? { kind: 'file', size: claudeJson.length } : undefined),
      list: async () => undefined,
    };
    return await new HostHarnessScanner({
      userHome: '/home',
      files,
      commands: { resolve: () => undefined },
      logins: fakeLogins([]),
      maxDocumentBytes: 4096,
    }).scan();
  };

  it('should finish the scan of both harnesses and leave the refused command neither missing nor found', async () => {
    const scans = await scan();

    expect(scans.map(one => one.harness)).toEqual(['claude', 'codex']);
    expect(scans[0]?.missingCommands).toEqual(['/home/bin/gone-mcp']);
  });

  it('should say the refused command was not checked, without a path outside the readable folders being read', async () => {
    const scans = await scan();

    expect(scans[0]?.problems).toEqual([
      'Could not check whether the MCP command /opt/tools/outside-mcp exists, because it is outside the folders Ferretry may read.',
    ]);
    expect(scans[1]?.problems).toEqual([]);
  });
});
