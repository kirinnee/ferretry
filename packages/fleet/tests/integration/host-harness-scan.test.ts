/**
 * The host scan against a real filesystem. Every path is inside a temporary directory this test made
 * and stands in for a person's home; every credential is a placeholder that authenticates nothing.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import type { StoredCredentialMaterialReader } from '../../src/adapters/credential-classifier.ts';
import { PlatformFleetCredentialStore } from '../../src/adapters/credential-store.ts';
import { HostHarnessScanner, type HostHarnessScanDeps } from '../../src/adapters/host-harness-scan.ts';
import { planImport } from '../../src/lib/account/import.ts';

const NOW = Date.parse('2026-10-13T00:00:00Z');
const HOUR = 3_600_000;

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fy-host-scan-'));
  created.push(dir);
  return dir;
}

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** An unsigned JWT with these claims: shaped like Codex's, worthless as a token. */
const jwt = (claims: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const store = (): PlatformFleetCredentialStore =>
  new PlatformFleetCredentialStore({
    platform: 'linux',
    command: {
      run: async () => {
        throw new Error('no command on linux');
      },
    },
    now: () => NOW,
    keychainAccount: 'placeholder',
  });

const scanner = (userHome: string, patch: Partial<HostHarnessScanDeps> = {}): HostHarnessScanner =>
  new HostHarnessScanner({
    userHome,
    commands: { resolve: name => (['claude', 'codex', 'npx'].includes(name) ? `/bin/${name}` : undefined) },
    credentials: store(),
    now: () => NOW,
    maxDocumentBytes: 4096,
    ...patch,
  });

describe('HostHarnessScanner — a set-up machine', () => {
  it('should read both harnesses where they keep their setup, and classify each login', async () => {
    // Arrange
    const user = await home();
    await put(
      path.join(user, '.claude/.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + HOUR } }),
    );
    await put(path.join(user, '.claude/CLAUDE.md'), '# Rules\n');
    await put(path.join(user, '.claude/settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
    await put(
      path.join(user, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'person@example.test' },
        mcpServers: {
          github: { command: 'npx', args: ['gh'] },
          notes: { command: 'uvx' },
          local: { command: '/nowhere/bin/tool' },
          here: { command: path.join(user, 'tool') },
        },
      }),
    );
    await put(path.join(user, 'tool'), '#!/bin/sh\n');
    await put(path.join(user, '.claude/skills/review/SKILL.md'), 'review');
    await put(path.join(user, '.claude/skills/review/nested/more.md'), 'more');
    await symlink(path.join(user, 'tool'), path.join(user, '.claude/skills/review/link'));
    await put(path.join(user, '.claude/skills/stray-file'), 'not a skill');
    await put(path.join(user, '.claude/skills/.hidden/SKILL.md'), 'hidden');

    await put(
      path.join(user, '.codex/auth.json'),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: Math.trunc((NOW - HOUR) / 1000) }),
          refresh_token: 'r',
          id_token: jwt({ email: 'codex@example.test' }),
        },
      }),
    );
    await put(path.join(user, '.codex/AGENTS.md'), '# Rules\n');
    await put(path.join(user, '.codex/config.toml'), 'model = "gpt-5.6"\n');
    await put(path.join(user, '.codex/hooks.json'), '{}');
    await put(path.join(user, '.codex/skills/review/SKILL.md'), 'review');
    await put(path.join(user, '.codex/skills/.system/SKILL.md'), 'bundled');

    // Act
    const [claude, codex] = await scanner(user).scan();

    // Assert
    should(claude?.command).equal('/bin/claude');
    should(claude?.login).deepEqual({ state: 'signed-in', email: 'person@example.test' });
    should(claude?.instructions).deepEqual({
      kind: 'text',
      source: path.join(user, '.claude/CLAUDE.md'),
      text: '# Rules\n',
      bytes: 8,
    });
    should(claude?.skills.map(skill => skill.item)).deepEqual(['review']);
    should(claude?.missingCommands).deepEqual(['uvx', '/nowhere/bin/tool']);
    should(codex?.login).deepEqual({ state: 'refresh-due', email: 'codex@example.test' });
    should(codex?.skills.map(skill => skill.item)).deepEqual(['review']);
    should(codex?.hooks?.kind).equal('text');

    // The two "review" folders differ (one has a nested file and a link), so their digests do too.
    should(claude?.skills[0]?.digest).not.equal(codex?.skills[0]?.digest);
    const plan = planImport(
      [claude, codex].filter(scan => scan !== undefined),
      { digest: text => text },
    );
    should(plan.preview.instructionsIdentical).be.true();
  });

  it('should give identical skill folders one digest', async () => {
    const user = await home();
    await put(path.join(user, '.claude/skills/a/SKILL.md'), 'same');
    await put(path.join(user, '.codex/skills/a/SKILL.md'), 'same');
    const [claude, codex] = await scanner(user).scan();
    should(claude?.skills[0]?.digest).equal(codex?.skills[0]?.digest);
  });
});

describe('HostHarnessScanner — logins', () => {
  it('should say not signed in when there is no login, and not installed when no command resolves', async () => {
    const user = await home();
    const [claude, codex] = await scanner(user, { commands: { resolve: () => undefined } }).scan();
    should(claude?.login).deepEqual({ state: 'not-signed-in' });
    should(claude?.command).be.undefined();
    should(codex?.login).deepEqual({ state: 'not-signed-in' });
    should(claude?.instructions).deepEqual({ kind: 'absent', source: path.join(user, '.claude/CLAUDE.md') });
  });

  it('should refuse to share a Codex login kept in a keyring (G5)', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const [, codex] = await scanner(user).scan();
    should(codex?.login.state).equal('not-shareable');
    should(codex?.login.reason).match(/system keyring/);
  });

  it('should explain a missing auth.json when Codex may be using the keyring', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), 'cli_auth_credentials_store = "auto"\n');
    const [, codex] = await scanner(user).scan();
    should(codex?.login.state).equal('not-signed-in');
    should(codex?.login.reason).match(/may be in the system keyring/);
  });

  it('should report a damaged credential as unreadable, never as signed out', async () => {
    const user = await home();
    await put(path.join(user, '.claude/.credentials.json'), 'not json');
    await put(path.join(user, '.codex/auth.json'), 'not json');
    const [claude, codex] = await scanner(user).scan();
    should(claude?.login).deepEqual({ state: 'unreadable', reason: 'the Claude credential is not readable JSON' });
    should(codex?.login.state).equal('unreadable');
  });

  it('should turn a throwing credential reader into an unreadable login', async () => {
    const user = await home();
    const credentials: StoredCredentialMaterialReader = {
      storedMaterial: async () => {
        throw new Error('locked');
      },
    };
    const [claude] = await scanner(user, { credentials }).scan();
    should(claude?.login).deepEqual({ state: 'unreadable', reason: 'locked' });
  });

  it('should read no email from a Codex token without one', async () => {
    const user = await home();
    await put(
      path.join(user, '.codex/auth.json'),
      JSON.stringify({ tokens: { access_token: jwt({ exp: Math.trunc((NOW + HOUR) / 1000) }), id_token: 'no-dots' } }),
    );
    const [, codex] = await scanner(user).scan();
    should(codex?.login).deepEqual({ state: 'signed-in' });
    await put(
      path.join(user, '.codex/auth.json'),
      JSON.stringify({
        tokens: { access_token: jwt({ exp: Math.trunc((NOW + HOUR) / 1000) }), id_token: 'a.!!!.c' },
      }),
    );
    should((await scanner(user).scan())[1]?.login).deepEqual({ state: 'signed-in' });
  });
});

describe('HostHarnessScanner — where the setup lives', () => {
  it('should follow CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const user = await home();
    const claudeDir = path.join(user, 'cfg-claude');
    const codexDir = path.join(user, 'cfg-codex');
    await put(path.join(claudeDir, 'CLAUDE.md'), 'moved');
    await put(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    await put(path.join(codexDir, 'AGENTS.md'), 'moved');
    const [claude, codex] = await scanner(user, { claudeConfigDir: claudeDir, codexHome: codexDir }).scan();
    should(claude?.instructions.kind).equal('text');
    should(claude?.mcp?.source).equal(path.join(claudeDir, '.claude.json'));
    should(codex?.instructions.kind).equal('text');
  });

  it('should say when CLAUDE_CONFIG_DIR or CODEX_HOME is a relative path', async () => {
    const user = await home();
    const [claude, codex] = await scanner(user, { claudeConfigDir: 'rel', codexHome: 'rel' }).scan();
    should(claude?.problems).deepEqual([
      `CLAUDE_CONFIG_DIR is the relative path "rel", so ${path.join(user, '.claude')} was read instead.`,
    ]);
    should(codex?.login.state).equal('not-shareable');
    should(codex?.instructions.kind).equal('unreadable');
  });

  it('should classify documents that are too large, not files, or unreadable', async () => {
    const user = await home();
    await put(path.join(user, '.claude/CLAUDE.md'), 'x'.repeat(5000));
    await mkdir(path.join(user, '.claude/settings.json'), { recursive: true });
    await put(path.join(user, '.claude.json'), '{}');
    await chmod(path.join(user, '.claude.json'), 0o000);
    const [claude] = await scanner(user).scan();
    should(claude?.instructions).deepEqual({
      kind: 'too-large',
      source: path.join(user, '.claude/CLAUDE.md'),
      bytes: 5000,
    });
    should(claude?.settings).deepEqual({
      kind: 'unreadable',
      source: path.join(user, '.claude/settings.json'),
      reason: 'it is not a file',
    });
    should(claude?.mcp?.kind).equal(process.getuid?.() === 0 ? 'text' : 'unreadable');
  });

  it('should report a skills folder or skill it could not read, and one with too many files', async () => {
    const user = await home();
    await mkdir(path.join(user, '.claude/skills'), { recursive: true });
    await chmod(path.join(user, '.claude/skills'), 0o000);
    await put(path.join(user, '.codex/skills/big/a.md'), 'a');
    await put(path.join(user, '.codex/skills/big/b.md'), 'b');
    await put(path.join(user, '.codex/skills/locked/a.md'), 'a');
    await chmod(path.join(user, '.codex/skills/locked'), 0o000);
    const [claude, codex] = await scanner(user, { maxSkillFiles: 1 }).scan();
    await chmod(path.join(user, '.codex/skills/locked'), 0o700);
    await chmod(path.join(user, '.claude/skills'), 0o700);
    if (process.getuid?.() !== 0) should(claude?.problems[0]).match(/^Your skills folder .* could not be read/);
    should(codex?.problems).containEql('Skill "big" has more than 1 files, so it was not imported.');
    if (process.getuid?.() !== 0)
      should(codex?.problems.some(problem => problem.startsWith('Skill "locked"'))).be.true();
  });

  it('should treat a skills path that is a file as no skills', async () => {
    const user = await home();
    await put(path.join(user, '.claude/skills'), 'a file, not a folder');
    const [claude] = await scanner(user).scan();
    should(claude?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([]);
  });

  it('should read no login details from a settings file that will not parse', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), '= broken');
    const [, codex] = await scanner(user).scan();
    should(codex?.login).deepEqual({ state: 'not-signed-in' });
  });
});
