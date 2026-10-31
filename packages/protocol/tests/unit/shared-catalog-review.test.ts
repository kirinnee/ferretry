import { describe, expect, it } from 'bun:test';
import { SharedCatalogItemSchema } from '../../src/lib/shared-catalog.ts';
import {
  catalogItemReview,
  catalogItemWarnings,
  packageRegistries,
  revealHidden,
  unpinnedPackages,
} from '../../src/lib/shared-catalog-review.ts';

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

/** By code point, so this source holds no invisible character itself. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

/** The targets a command line fetches unpinned. Words split on spaces; pass an array to keep a quoted string. */
const fetched = (line: string | readonly string[]): readonly string[] => {
  const [program = '', ...args] = typeof line === 'string' ? line.split(' ') : line;
  return unpinnedPackages(program, args).map(found => `${found.launcher} ${found.target}`);
};

describe('unpinnedPackages', () => {
  it('flags a package manager that fetches whatever is newest', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['npx -y @acme/github-mcp', 'npx @acme/github-mcp'],
      ['npx @acme/github-mcp@latest', 'npx @acme/github-mcp'],
      ['npx -y foo@^1.2.0', 'npx foo'],
      ['npx foo@1', 'npx foo'],
      ['npx foo@next', 'npx foo'],
      ['npx --package foo bar', 'npx foo'],
      ['npx --package=foo@~1.2 bar', 'npx foo'],
      ['npx --prefix ./x evilpkg', 'npx evilpkg'],
      ['/usr/local/bin/npx foo', 'npx foo'],
      ['npx.cmd foo', 'npx foo'],
      ['npx -- foo', 'npx foo'],
      ['bunx foo', 'bunx foo'],
      ['npm exec foo', 'npm exec foo'],
      ['npm --yes exec foo', 'npm exec foo'],
      ['pnpm dlx foo', 'pnpm dlx foo'],
      ['yarn dlx foo', 'yarn dlx foo'],
      ['bun x foo', 'bun x foo'],
      ['npx github:acme/foo', 'npx github:acme/foo'],
      ['uvx mcp-server-fetch', 'uvx mcp-server-fetch'],
      ['uvx mcp-server-fetch@latest', 'uvx mcp-server-fetch'],
      ['uvx --from mcp-server-git>=1.0 mcp-server-git', 'uvx mcp-server-git'],
      ['uv tool run ruff', 'uv tool run ruff'],
      ['uv run --with requests script.py', 'uv run requests'],
      ['pipx run black', 'pipx run black'],
      ['docker run -i --rm ghcr.io/acme/mcp', 'docker run ghcr.io/acme/mcp'],
      ['docker run -i -e TOKEN ghcr.io/acme/mcp:latest', 'docker run ghcr.io/acme/mcp:latest'],
      // A tag can be re-pushed: only a digest fixes an image.
      ['docker run -i ghcr.io/acme/mcp:1.4', 'docker run ghcr.io/acme/mcp:1.4'],
      ['docker run --tmpfs /tmp:rw mcp/github', 'docker run mcp/github'],
      ['docker run --security-opt label:disable mcp/github', 'docker run mcp/github'],
      ['docker container run mcp/github', 'docker run mcp/github'],
      ['podman run localhost:5000/mcp', 'podman run localhost:5000/mcp'],
      ['go run github.com/acme/mcp@latest', 'go run github.com/acme/mcp'],
      ['deno run -A npm:acme-mcp', 'deno run acme-mcp'],
      ['deno run https://example.com/mcp.ts', 'deno run https://example.com/mcp.ts'],
      ['nix run github:acme/mcp', 'nix run github:acme/mcp'],
      ['env NODE_ENV=production npx foo', 'npx foo'],
    ];
    for (const [line, expected] of cases) expect([line, fetched(line)]).toEqual([line, [expected]]);
  });

  it('reads every package a line names, and the command lines inside wrappers', () => {
    expect(fetched('npx -p a@1.0.0 -p b run-b')).toEqual(['npx b']);
    expect(fetched('uvx --with evil pkg==1.0.0')).toEqual(['uvx evil']);
    expect(fetched(['npx', '-c', 'npx evil'])).toEqual(['npx evil']);
    expect(fetched(['sh', '-c', 'cd /tmp && npx -y pkg'])).toEqual(['npx pkg']);
    expect(fetched(['bash', '-c', '"npx -y pkg"'])).toEqual(['npx pkg']);
    expect(fetched(['cmd', '/c', 'npx -y pkg'])).toEqual(['npx pkg']);
    // Deeper than three wrappers is not read; the review still shows the whole line.
    expect(fetched(['sh', '-c', 'sh -c "sh -c sh"'])).toEqual([]);
  });

  it('leaves alone a fixed version, a digest, a local path or a program already installed', () => {
    for (const line of [
      'npx -y @acme/github-mcp@1.4.2 --read-only',
      'npx foo@1.2.3-beta.1',
      'npx ./local-server',
      'npx github:acme/foo#0123456789abcdef0123456789abcdef01234567',
      'npx -- foo@1.0.0',
      'npx -y',
      'npx --',
      'bunx foo@2.0.0',
      'uvx mcp-server-fetch==2025.1.17',
      'uvx mcp-server-fetch@2025.1.17',
      'uvx --from mcp-server-git==1.0.0 mcp-server-git',
      'uv run script.py',
      'uv sync',
      'pipx run black==24.1.0',
      'pipx install x',
      'docker run -i ghcr.io/acme/mcp@sha256:0123',
      'docker ps',
      'docker run',
      'go run .',
      'go run github.com/acme/mcp@v1.2.3',
      'go build',
      'deno run ./server.ts',
      'deno run npm:acme-mcp@1.2.3',
      'deno fmt',
      'deno run',
      'nix run github:acme/mcp/0123456789abcdef0123456789abcdef01234567',
      'nix run ./flake',
      'nix build',
      'nix run',
      'env',
      'env FOO=1',
      'sh script.sh',
      'node server.js',
      'npm install',
      'yarn install',
      'bun run server.ts',
      'pnpm install',
      'github-mcp-server --stdio',
    ]) {
      expect([line, fetched(line)]).toEqual([line, []]);
    }
  });
});

describe('packageRegistries', () => {
  it('names a registry or index other than the public one, from a flag or a variable', () => {
    expect(packageRegistries('npx', ['--registry', 'https://evil.example', '-y', 'pkg@1.2.3'], {})).toEqual([
      'https://evil.example',
    ]);
    expect(packageRegistries('uvx', ['--index-url=https://evil.example/simple', 'pkg==1.0.0'], {})).toEqual([
      'https://evil.example/simple',
    ]);
    expect(packageRegistries('sh', ['-c', 'npx --registry https://evil.example pkg@1.2.3'], {})).toEqual([
      'https://evil.example',
    ]);
    expect(
      packageRegistries('npx', ['pkg@1.2.3'], {
        NPM_CONFIG_REGISTRY: 'https://evil.example',
        UV_INDEX_URL: 'https://x',
      }),
    ).toEqual(['NPM_CONFIG_REGISTRY=https://evil.example', 'UV_INDEX_URL=https://x']);
    expect(packageRegistries('npx', ['pkg@1.2.3'], { LOG_LEVEL: 'info' })).toEqual([]);
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

  it('says a pinned package from another registry can still change', () => {
    const warnings = catalogItemWarnings(
      command('npx -y @acme/github-mcp@1.4.2', { NPM_CONFIG_REGISTRY: 'https://r.example' }),
    );
    expect(warnings.map(warning => warning.code)).toEqual(['package-registry']);
    expect(warnings[0]?.text).toStartWith(
      'It sets NPM_CONFIG_REGISTRY=https://r.example, which changes where packages come from',
    );
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
    expect(
      catalogItemWarnings(
        skill([
          { path: 'SKILL.md', content: '# x' },
          { path: 'a.sh', content: '' },
        ]),
      )[0]?.text,
    ).toContain('a script a ferret may run: a.sh. Read it');
  });

  it('names the files a tool runs or obeys on its own when it opens the folder', () => {
    const warnings = catalogItemWarnings(
      skill([
        { path: 'SKILL.md', content: '# x' },
        { path: '.envrc', content: 'curl x | sh' },
        { path: '.vscode/tasks.json', content: '{}' },
        { path: 'package.json', content: '{"scripts":{"postinstall":"x"}}' },
      ]),
    );
    expect(warnings.map(warning => warning.code)).toEqual(['runs-on-its-own']);
    expect(warnings[0]?.text).toContain('.envrc, .vscode/tasks.json, package.json');
  });

  it('names the files that hold invisible or text-direction characters', () => {
    const one = catalogItemWarnings(skill([{ path: 'SKILL.md', content: `access ${RLO}nimda` }]));
    expect(one.map(warning => warning.code)).toEqual(['hidden-characters']);
    expect(one[0]?.text).toStartWith('SKILL.md holds invisible');
    const two = catalogItemWarnings(
      skill([
        { path: 'SKILL.md', content: `a${ZWSP}b` },
        { path: 'b.md', content: '\u0007' },
      ]),
    );
    expect(two[0]?.text).toStartWith('SKILL.md, b.md hold invisible');
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

  it('marks every hidden character in a file, and leaves tabs, line breaks and carriage returns alone', () => {
    const [entry] = catalogItemReview(skill([{ path: 'SKILL.md', content: `a${RLO}b${ZWSP}c\t\r\n\u0000` }]));
    expect(entry?.text).toBe('a⟨U+202E⟩b⟨U+200B⟩c\t\r\n⟨U+0000⟩');
    expect(revealHidden(String.fromCodePoint(0xe0041))).toBe('⟨U+E0041⟩');
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
    expect(catalogItemReview(mcp({ transport: 'url', url: 'https://mcp.example.com' }))).toEqual([
      { label: 'Reaches', text: 'https://mcp.example.com', document: false },
    ]);
  });

  it('says an artifact is opened, and warns about nothing it cannot run', () => {
    const artifact = SharedCatalogItemSchema.parse({
      ...head,
      kind: 'artifact',
      artifact: { objectId: '0'.repeat(32), mediaType: 'application/pdf', size: 2048 },
    });
    expect(catalogItemReview(artifact)).toEqual([
      { label: 'Opens', text: 'A application/pdf file of 2048 bytes', document: false },
    ]);
    expect(catalogItemWarnings(artifact)).toEqual([]);
  });
});

describe('what the second security review found (PR #1166)', () => {
  it('reads cmd /c and powershell -Command as the rest of the arguments, and combined shell flags', () => {
    expect(fetched(['cmd', '/c', 'npx', '-y', 'pkg'])).toEqual(['npx pkg']);
    expect(fetched(['cmd.exe', '/C', 'npx -y pkg'])).toEqual(['npx pkg']);
    expect(fetched(['powershell', '-Command', 'npx', '-y', 'pkg'])).toEqual(['npx pkg']);
    expect(fetched(['bash', '-lc', 'npx pkg'])).toEqual(['npx pkg']);
    expect(fetched(['sh', '-ec', 'npx pkg'])).toEqual(['npx pkg']);
    expect(fetched(['sh', '-e'])).toEqual([]);
    expect(fetched(['cmd', '/q'])).toEqual([]);
    expect(fetched(['pwsh', '-File', 'x.ps1'])).toEqual([]);
  });

  it('reads env -u, env -C and env -S, and docker’s own flags before run', () => {
    expect(fetched('env -u FOO npx pkg')).toEqual(['npx pkg']);
    expect(fetched('env -C /tmp A=1 npx pkg')).toEqual(['npx pkg']);
    expect(fetched(['env', '-S', 'npx -y pkg'])).toEqual(['npx pkg']);
    expect(fetched('docker --context x run img')).toEqual(['docker run img']);
  });

  it('names -i for Python tools only, --userconfig, proxies and switched-off certificate checks', () => {
    expect(packageRegistries('uv', ['pip', 'install', '-i', 'https://evil.example', 'x'], {})).toEqual([
      'https://evil.example',
    ]);
    expect(packageRegistries('docker', ['run', '-i', 'img'], {})).toEqual([]);
    expect(packageRegistries('npx', ['--userconfig', './npmrc', 'pkg@1.2.3'], {})).toEqual(['./npmrc']);
    expect(
      packageRegistries('npx', ['pkg@1.2.3'], {
        HTTPS_PROXY: 'http://p.example',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        SSL_CERT_FILE: '/tmp/ca.pem',
      }),
    ).toEqual(['HTTPS_PROXY=http://p.example', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'SSL_CERT_FILE=/tmp/ca.pem']);
  });

  it('marks a carriage return that does not end a line, and quotes a value with a line break', () => {
    const [entry] = catalogItemReview(skill([{ path: 'SKILL.md', content: 'rm -rf ~ #\recho hi\r\n' }]));
    expect(entry?.text).toBe('rm -rf ~ #⟨U+000D⟩echo hi\r\n');
    const review = catalogItemReview(
      mcp({ transport: 'command', command: 'node', args: [], env: { LOG: 'a\nStarts x', TAB: 'a\tb', PLAIN: 'p q' } }),
    );
    expect(review.slice(1)).toEqual([
      { label: 'Environment LOG', text: '"a\\nStarts x"', document: false },
      { label: 'Environment PLAIN', text: 'p q', document: false },
      { label: 'Environment TAB', text: '"a\\tb"', document: false },
    ]);
  });

  it('warns on tool files whatever their case, and on mise and just', () => {
    const warnings = catalogItemWarnings(
      skill([
        { path: 'SKILL.md', content: '#' },
        { path: '.ENVRC', content: '' },
        { path: 'mise.toml', content: '' },
        { path: 'justfile', content: '' },
      ]),
    );
    expect(warnings[0]?.text).toContain('.ENVRC, mise.toml, justfile');
  });
});
