/**
 * The host homes the import goldens read: in-memory trees (`/host/home/.claude`, `/host/home/.codex`), never a disk. The
 * sign-in files exist in them with inert text so a scan that opened one would show it; none is ever read.
 */
import type { HostEntry, HostFiles } from '../../../../daemon/adapters/ports.ts';

export type HostTree = Readonly<Record<string, string>>;

export const HOST_HOME = '/host/home';

/** `HostFiles` over a path → text map: a directory is every prefix of a path, listed in name order. */
export function memoryHostFiles(tree: HostTree): HostFiles {
  const directories = new Set<string>(['/']);
  for (const path of Object.keys(tree)) {
    const parts = path.split('/').filter(Boolean);
    for (let end = 1; end < parts.length; end++) directories.add(`/${parts.slice(0, end).join('/')}`);
  }
  const entryOf = (path: string): HostEntry | undefined => {
    const text = tree[path];
    if (text !== undefined) return { kind: 'file', size: text.length };
    return directories.has(path) ? { kind: 'directory', size: 0 } : undefined;
  };
  const listOf = (path: string): readonly string[] | undefined => {
    if (!directories.has(path)) return undefined;
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const candidate of [...Object.keys(tree), ...directories]) {
      if (candidate.startsWith(prefix) && candidate !== path)
        names.add(candidate.slice(prefix.length).split('/')[0] as string);
    }
    return [...names].toSorted();
  };
  return {
    readText: async path => tree[path],
    readBytes: async (path, limit) => {
      const text = tree[path];
      if (text === undefined) return undefined;
      const bytes = new TextEncoder().encode(text);
      return limit === undefined ? bytes : bytes.subarray(0, limit);
    },
    stat: async path => entryOf(path),
    lstat: async path => entryOf(path),
    list: async path => listOf(path),
  };
}

const SIGN_IN = 'INERT_SIGN_IN_FIXTURE_NOT_A_CREDENTIAL';

const CLAUDE_SETTINGS = JSON.stringify(
  {
    model: 'claude-opus-5-5',
    env: { GH_TOKEN: 'FAKE_GH_VALUE_NOT_A_TOKEN', EDITOR: 'vim' },
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo golden' }] }] },
  },
  null,
  2,
);

const CLAUDE_JSON = JSON.stringify(
  {
    mcpServers: {
      files: { type: 'stdio', command: 'npx', args: ['server-files'], env: { FILES_TOKEN: 'FAKE_FILES_TOKEN_VALUE' } },
      docs: { type: 'http', url: 'https://docs.example.test/mcp' },
      missing: { type: 'stdio', command: 'golden-not-installed' },
    },
    projects: { '/work/golden-project': {} },
  },
  null,
  2,
);

const CODEX_CONFIG = [
  'model = "gpt-6"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.files]',
  'command = "npx"',
  'args = ["server-files"]',
  '',
  '[mcp_servers.files.env]',
  'FILES_TOKEN = "FAKE_FILES_TOKEN_VALUE"',
  '',
  '[mcp_servers.docs]',
  'url = "https://docs.example.test/mcp"',
  '',
  // Declared but switched off in Codex's own file: the import leaves it out.
  '[mcp_servers.archive]',
  'command = "npx"',
  'args = ["server-archive"]',
  'enabled = false',
  '',
  // The `env` a Codex person writes: a plain variable and a token (the token is left out unless ticked).
  '[shell_environment_policy]',
  'inherit = "core"',
  '',
  '[shell_environment_policy.set]',
  'GITHUB_TOKEN = "FAKE_CODEX_GITHUB_VALUE"',
  'PAGER = "less"',
  '',
  '[profiles.fast]',
  'model = "gpt-6-mini"',
  '',
].join('\n');

const CLAUDE_FILES: HostTree = {
  [`${HOST_HOME}/.claude/CLAUDE.md`]: '# Golden Claude notes\nBe kind.\n',
  [`${HOST_HOME}/.claude/settings.json`]: CLAUDE_SETTINGS,
  [`${HOST_HOME}/.claude/.credentials.json`]: SIGN_IN,
  [`${HOST_HOME}/.claude/skills/review/SKILL.md`]:
    '---\nname: review\ndescription: Review a change\n---\nLook closely.\n',
  [`${HOST_HOME}/.claude/skills/review/notes.md`]: 'extra file\n',
  [`${HOST_HOME}/.claude.json`]: CLAUDE_JSON,
  '/work/golden-project/CLAUDE.md': 'project notes\n',
};

const CODEX_FILES: HostTree = {
  [`${HOST_HOME}/.codex/AGENTS.md`]: '# Golden Codex notes\nBe brief.\n',
  [`${HOST_HOME}/.codex/config.toml`]: CODEX_CONFIG,
  [`${HOST_HOME}/.codex/hooks.json`]: JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  }),
  [`${HOST_HOME}/.codex/auth.json`]: SIGN_IN,
  [`${HOST_HOME}/.codex/skills/deploy/SKILL.md`]: '---\nname: deploy\ndescription: Ship it\n---\nShip carefully.\n',
  [`${HOST_HOME}/.codex/skills/.system/bundled/SKILL.md`]: 'harness-owned\n',
};

/** The named hosts: both harnesses set up, nothing installed, and both with ONE instructions text. */
export const HOSTS: Readonly<Record<string, HostTree>> = {
  both: { ...CLAUDE_FILES, ...CODEX_FILES },
  empty: {},
  'shared-instructions': {
    ...CLAUDE_FILES,
    ...CODEX_FILES,
    [`${HOST_HOME}/.codex/AGENTS.md`]: CLAUDE_FILES[`${HOST_HOME}/.claude/CLAUDE.md`] as string,
  },
};
