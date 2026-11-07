/**
 * The host scan against a real filesystem. Every path is inside a temporary directory this test made
 * and stands in for a person's home; every credential is a placeholder that authenticates nothing.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { HostHarnessScanner, type HostHarnessScanDeps } from '../../daemon/adapters/host-harness-scan.ts';
import type { HostFiles } from '../../daemon/adapters/ports.ts';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { planImport } from '../../daemon/lib/account/import.ts';
import { nodeHostFiles } from './support/node-host.ts';

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

const scanner = (userHome: string, patch: Partial<HostHarnessScanDeps> = {}): HostHarnessScanner =>
  new HostHarnessScanner({
    files: nodeHostFiles,
    userHome,
    commands: { resolve: name => (['claude', 'codex', 'npx'].includes(name) ? `/bin/${name}` : undefined) },
    logins: fakeLogins([
      sampleLogin('claude-you', { email: 'person@example.test' }),
      sampleLogin('codex-you', {
        harness: 'codex',
        harnesses: ['codex'],
        email: 'codex@example.test',
        status: { ...sampleLogin('codex-you').status, word: 'refresh_due' },
      }),
    ]),
    maxDocumentBytes: 4096,
    ...patch,
  });

/** The real-disk host, recording every call that would open a document or walk a folder. */
const spiedFiles = (): { files: HostFiles; opened: string[] } => {
  const opened: string[] = [];
  const spy =
    <A extends unknown[], R>(name: string, call: (...args: A) => R) =>
    (...args: A): R => {
      opened.push(`${name} ${String(args[0])}`);
      return call(...args);
    };
  return {
    opened,
    files: {
      ...nodeHostFiles,
      readText: spy('readText', nodeHostFiles.readText),
      readBytes: spy('readBytes', nodeHostFiles.readBytes),
      list: spy('list', nodeHostFiles.list),
    },
  };
};

const CHECKED_READS_TEXT =
  'checked host reads are unavailable: the host cannot check and read through the same descriptor';
const CHECKED_READS = /checked host reads are unavailable.*same descriptor/;

describe('HostHarnessScanner — a set-up machine', () => {
  // 5.0 (b082f7ff76) reads no setup content until the host can check and read through ONE descriptor; this pins
  // what a real disk shows meanwhile: locations and safe sign-in facts, never contents, never a path-based read.
  it('should locate both harnesses and read safe sign-in facts, but open no setup document until checked reads exist', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, '.claude/CLAUDE.md'), '# Rules\n');
    await put(path.join(user, '.claude/settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
    await put(
      path.join(user, '.claude.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['gh'] }, local: { command: '/nowhere/bin/tool' } },
      }),
    );
    await put(path.join(user, '.claude/skills/review/SKILL.md'), 'review');
    await put(path.join(user, '.codex/AGENTS.md'), '# Rules\n');
    await put(path.join(user, '.codex/config.toml'), 'model = "gpt-5.6"\n');
    await put(path.join(user, '.codex/hooks.json'), '{}');
    await put(path.join(user, '.codex/skills/review/SKILL.md'), 'review');
    const { files, opened } = spiedFiles();

    // Act
    const [claude, codex] = await scanner(user, { files }).scan();

    // Assert
    should(claude?.command).equal('/bin/claude');
    should(claude?.login).deepEqual({ state: 'signed-in', email: 'person@example.test' });
    should(codex?.login).deepEqual({ state: 'refresh-due', email: 'codex@example.test' });
    should(claude?.instructions).match({
      kind: 'unreadable',
      source: path.join(user, '.claude/CLAUDE.md'),
      reason: CHECKED_READS,
    });
    should(claude?.mcp?.kind).equal('unreadable');
    should(codex?.hooks?.kind).equal('unreadable');
    should(claude?.skills).deepEqual([]);
    should(codex?.skills).deepEqual([]);
    should(claude?.problems[0]).match(/^Your skills folder .* could not be read \(checked host reads are unavailable/);
    // No MCP server was read, so none can be reported missing, and nothing was opened or listed by path.
    should(claude?.missingCommands).deepEqual([]);
    should(opened).deepEqual([]);
    const plan = planImport(
      [claude, codex].filter(scan => scan !== undefined),
      { digest: text => text },
    );
    should(plan.preview.instructionsIdentical).not.be.true();
  });
});

describe('HostHarnessScanner — logins', () => {
  it('should report unknown for an unregistered host, and not installed when no command resolves', async () => {
    const user = await home();
    const [claude, codex] = await scanner(user, {
      commands: { resolve: () => undefined },
      logins: fakeLogins(),
    }).scan();
    should(claude?.login.state).equal('unknown');
    should(codex?.login.state).equal('unknown');
    should(claude?.command).be.undefined();
  });
  it('should not infer sign-in from a Codex keyring preference (G5)', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const [, codex] = await scanner(user, { logins: fakeLogins() }).scan();
    should(codex?.login.state).equal('unknown');
  });
  it('should not infer a missing login from a Codex auto store preference', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), 'cli_auth_credentials_store = "auto"\n');
    const [, codex] = await scanner(user, { logins: fakeLogins() }).scan();
    should(codex?.login.state).equal('unknown');
  });
  it('should keep an inconclusive status unknown, never signed out', async () => {
    const user = await home();
    const row = sampleLogin('you');
    const [claude] = await scanner(user, {
      logins: fakeLogins([{ ...row, status: { ...row.status, lastCheckInconclusive: true } }]),
    }).scan();
    should(claude?.login.state).equal('unknown');
  });
  it('should turn a throwing facts port into an unknown login', async () => {
    const user = await home();
    const logins = {
      list: async () => {
        throw new Error('locked');
      },
    };
    const [claude] = await scanner(user, { logins }).scan();
    should(claude?.login.state).equal('unknown');
  });
  it('should read email only from safe Logins facts', async () => {
    const user = await home();
    const row = sampleLogin('codex-you', { harness: 'codex', harnesses: ['codex'] });
    const [, codex] = await scanner(user, { logins: fakeLogins([row]) }).scan();
    should(codex?.login).deepEqual({ state: 'signed-in' });
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
    // Found where they were moved to (an absent document would say so), though unreadable until checked reads exist.
    should(claude?.instructions).match({ kind: 'unreadable', source: path.join(claudeDir, 'CLAUDE.md') });
    should(claude?.mcp).match({ kind: 'unreadable', source: path.join(claudeDir, '.claude.json') });
    should(codex?.instructions).match({
      kind: 'unreadable',
      source: path.join(codexDir, 'AGENTS.md'),
      reason: CHECKED_READS,
    });
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

  it('should report a skills folder as unreadable, however many files its skills hold', async () => {
    const user = await home();
    await mkdir(path.join(user, '.claude/skills'), { recursive: true });
    await put(path.join(user, '.codex/skills/big/a.md'), 'a');
    await put(path.join(user, '.codex/skills/big/b.md'), 'b');
    const { files, opened } = spiedFiles();
    const [claude, codex] = await scanner(user, { files, maxSkillFiles: 1 }).scan();
    // The folder is never listed, so no skill is found and no per-skill problem (too many files, locked) can exist.
    should(claude?.skills).deepEqual([]);
    should(codex?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([
      `Your skills folder ${path.join(user, '.claude/skills')} could not be read (${CHECKED_READS_TEXT}).`,
    ]);
    should(codex?.problems).deepEqual([
      `Your skills folder ${path.join(user, '.codex/skills')} could not be read (${CHECKED_READS_TEXT}).`,
    ]);
    should(opened).deepEqual([]);
  });

  it('should treat a skills path that is a file as no skills', async () => {
    const user = await home();
    await put(path.join(user, '.claude/skills'), 'a file, not a folder');
    const [claude] = await scanner(user).scan();
    should(claude?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([]);
  });

  it('should take the login only from Logins facts, whatever the settings file holds', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), '= broken');
    const [, codex] = await scanner(user).scan();
    // The config file is never parsed for a sign-in; the Logins row (refresh due) alone speaks.
    should(codex?.login).deepEqual({ state: 'refresh-due', email: 'codex@example.test' });
  });
});
