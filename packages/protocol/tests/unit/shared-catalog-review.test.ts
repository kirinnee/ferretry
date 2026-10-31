import { describe, expect, it } from 'bun:test';
import { SharedCatalogItemSchema } from '../../src/lib/shared-catalog.ts';
import { catalogItemReview, catalogItemWarnings, unpinnedPackage } from '../../src/lib/shared-catalog-review.ts';

const head = {
  format: 'ferretry-catalog-item',
  version: 1,
  publisher: `fy_daemon_${'P'.repeat(43)}`,
  catalogId: `cat_${'c'.repeat(22)}`,
  itemId: `itm_${'i'.repeat(22)}`,
  itemVersion: 1,
  name: 'thing',
  summary: 'A thing',
} as const;

const skill = (files: readonly { path: string; content: string }[]) =>
  SharedCatalogItemSchema.parse({ ...head, kind: 'skill', skill: { files } });
const mcp = (setup: unknown) => SharedCatalogItemSchema.parse({ ...head, kind: 'mcp', mcp: setup });
const command = (line: string, env: Record<string, string> = {}) => {
  const [program = '', ...args] = line.split(' ');
  return mcp({ transport: 'command', command: program, args, env });
};

describe('unpinnedPackage', () => {
  const moves = (line: string) => {
    const [program = '', ...args] = line.split(' ');
    return unpinnedPackage(program, args);
  };

  it('flags a package manager that fetches whatever is newest', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['npx -y @acme/github-mcp', 'npx', '@acme/github-mcp'],
      ['npx @acme/github-mcp@latest', 'npx', '@acme/github-mcp'],
      ['npx -y foo@^1.2.0', 'npx', 'foo'],
      ['npx foo@1', 'npx', 'foo'],
      ['npx foo@next', 'npx', 'foo'],
      ['npx --package foo bar', 'npx', 'foo'],
      ['npx --package=foo@~1.2 bar', 'npx', 'foo'],
      ['/usr/local/bin/npx foo', 'npx', 'foo'],
      ['npx.cmd foo', 'npx', 'foo'],
      ['bunx foo', 'bunx', 'foo'],
      ['npm exec foo', 'npm exec', 'foo'],
      ['pnpm dlx foo', 'pnpm dlx', 'foo'],
      ['yarn dlx foo', 'yarn dlx', 'foo'],
      ['bun x foo', 'bun x', 'foo'],
      ['npx github:acme/foo', 'npx', 'github:acme/foo'],
      ['uvx mcp-server-fetch', 'uvx', 'mcp-server-fetch'],
      ['uvx mcp-server-fetch@latest', 'uvx', 'mcp-server-fetch'],
      ['uvx --from mcp-server-git>=1.0 mcp-server-git', 'uvx', 'mcp-server-git'],
      ['uv tool run ruff', 'uv tool run', 'ruff'],
      ['pipx run black', 'pipx run', 'black'],
      ['docker run -i --rm ghcr.io/acme/mcp', 'docker run', 'ghcr.io/acme/mcp'],
      ['docker run -i -e TOKEN ghcr.io/acme/mcp:latest', 'docker run', 'ghcr.io/acme/mcp:latest'],
      ['podman run localhost:5000/mcp', 'podman run', 'localhost:5000/mcp'],
    ];
    for (const [line, launcher, target] of cases) expect([line, moves(line)]).toEqual([line, { launcher, target }]);
  });

  it('leaves alone a fixed version, a digest, a local path or a program already installed', () => {
    for (const line of [
      'npx -y @acme/github-mcp@1.4.2 --read-only',
      'npx foo@1.2.3-beta.1',
      'npx ./local-server',
      'npx github:acme/foo#0123456789abcdef0123456789abcdef01234567',
      'bunx foo@2.0.0',
      'uvx mcp-server-fetch==2025.1.17',
      'uvx mcp-server-fetch@2025.1.17',
      'uvx --from mcp-server-git==1.0.0 mcp-server-git',
      'pipx run black==24.1.0',
      'docker run -i ghcr.io/acme/mcp@sha256:0123',
      'docker run -i ghcr.io/acme/mcp:1.4',
      'node server.js',
      'npm install',
      'docker ps',
      'github-mcp-server --stdio',
    ]) {
      expect([line, moves(line)]).toEqual([line, null]);
    }
  });
});

describe('catalogItemWarnings', () => {
  it('says an unpinned package can change without an update', () => {
    const [warning] = catalogItemWarnings(command('npx @acme/github-mcp'));
    expect(warning?.code).toBe('unpinned-package');
    expect(warning?.text).toBe(
      'npx @acme/github-mcp has no fixed version. It runs whatever is newest each time a ferret starts, so it can change without an update.',
    );
    expect(catalogItemWarnings(command('npx @acme/github-mcp@1.4.2'))).toEqual([]);
  });

  it('says a server at an address runs on someone else’s computer', () => {
    expect(catalogItemWarnings(mcp({ transport: 'url', url: 'https://mcp.example.com' })).map(w => w.code)).toEqual([
      'network-url',
    ]);
  });

  it('names every script a skill carries', () => {
    const [warning] = catalogItemWarnings(
      skill([
        { path: 'SKILL.md', content: '# x' },
        { path: 'scripts/split.sh', content: 'echo' },
        { path: 'tools/run', content: '#!/usr/bin/env python3\n' },
        { path: 'notes.md', content: 'x' },
      ]),
    );
    expect(warning?.code).toBe('carries-scripts');
    expect(warning?.text).toContain('2 scripts');
    expect(warning?.text).toContain('scripts/split.sh, tools/run');
    expect(catalogItemWarnings(skill([{ path: 'SKILL.md', content: '# x' }]))).toEqual([]);
  });
});

describe('catalogItemReview', () => {
  it('shows SKILL.md first, then every file by path, each in full', () => {
    const review = catalogItemReview(
      skill([
        { path: 'b.md', content: 'B' },
        { path: 'SKILL.md', content: 'S' },
        { path: 'a/z.sh', content: 'Z' },
      ]),
    );
    expect(review).toEqual([
      { label: 'Skill file SKILL.md', text: 'S', document: true },
      { label: 'Skill file a/z.sh', text: 'Z', document: true },
      { label: 'Skill file b.md', text: 'B', document: true },
    ]);
  });

  it('shows the command line as typed, and every variable — placeholders as written', () => {
    const review = catalogItemReview(
      mcp({
        transport: 'command',
        command: 'npx',
        args: ['-y', '@acme/github-mcp@1.4.2', '--title', 'two words'],
        env: { LOG_LEVEL: 'info', GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' },
      }),
    );
    expect(review).toEqual([
      { label: 'Starts', text: 'npx -y @acme/github-mcp@1.4.2 --title "two words"', document: false },
      { label: 'Environment GITHUB_TOKEN', text: '${secret:GITHUB_TOKEN}', document: false },
      { label: 'Environment LOG_LEVEL', text: 'info', document: false },
    ]);
  });

  it('shows the address of a server it reaches, and that the installer signs in themselves', () => {
    const review = catalogItemReview(
      mcp({ transport: 'url', url: 'https://mcp.example.com', auth: 'oauth', oauth: { clientId: 'client-1' } }),
    );
    expect(review.map(entry => entry.label)).toEqual(['Reaches', 'Signs in', 'Sign-in client']);
  });
});
