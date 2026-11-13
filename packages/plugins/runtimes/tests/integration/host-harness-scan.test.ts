/**
 * The host scan against a real filesystem. Every path is inside a temporary directory this test made
 * and stands in for a person's home; every credential is a placeholder that authenticates nothing.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('HostHarnessScanner — a set-up machine', () => {
  // The checked-read seam exists (`HostFiles` over the harness-home roots): a setup document is checked component by
  // component (no link, no sign-in file), then read. A real disk shows the contents, and still no sign-in fact beyond Logins.
  it('should locate both harnesses, read safe sign-in facts and read each setup document and skill', async () => {
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
      kind: 'text',
      source: path.join(user, '.claude/CLAUDE.md'),
      text: '# Rules\n',
      bytes: 8,
    });
    should(claude?.settings).match({ kind: 'text', source: path.join(user, '.claude/settings.json') });
    should(claude?.mcp).match({ kind: 'text', source: path.join(user, '.claude.json') });
    should(codex?.instructions).match({ kind: 'text', source: path.join(user, '.codex/AGENTS.md'), text: '# Rules\n' });
    should(codex?.hooks).match({ kind: 'text', source: path.join(user, '.codex/hooks.json'), text: '{}' });
    should(claude?.skills.map(skill => skill.item)).deepEqual(['review']);
    should(codex?.skills.map(skill => skill.item)).deepEqual(['review']);
    should(claude?.problems).deepEqual([]);
    should(codex?.problems).deepEqual([]);
    // The MCP file is now read, so a server whose command is nowhere on this machine is reported missing, and `npx` (on PATH) is not.
    should(claude?.missingCommands).deepEqual(['/nowhere/bin/tool']);
    // It is read, so it was opened — and only ever below a harness home (or the one file beside it), never a sign-in file.
    should(opened.some(call => call === `readText ${path.join(user, '.claude/CLAUDE.md')}`)).be.true();
    for (const call of opened) {
      should(call).not.match(/auth\.json|\.credentials\.json/);
      should(call.split(' ')[1]?.startsWith(`${user}/`)).be.true();
    }
    const plan = planImport(
      [claude, codex].filter(scan => scan !== undefined),
      { digest: text => text },
    );
    // Both harnesses hold the same rules text, which is only knowable now that it is read.
    should(plan.preview.instructionsIdentical).be.true();
  });

  // S144: a sign-in file is never a setup document, wherever a person plants it; a real disk with the real names.
  it('S144 should refuse a CLAUDE.md that is a link to a Codex sign-in file, never reading through it', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, '.codex/auth.json'), '{"placeholder":"authenticates nothing"}');
    await mkdir(path.join(user, '.claude'), { recursive: true });
    await symlink(path.join(user, '.codex/auth.json'), path.join(user, '.claude/CLAUDE.md'));
    const { files, opened } = spiedFiles();

    // Act
    const [claude] = await scanner(user, { files }).scan();

    // Assert
    should(claude?.instructions).match({
      kind: 'unreadable',
      source: path.join(user, '.claude/CLAUDE.md'),
      reason: /links/,
    });
    should(opened.filter(call => call.startsWith('read'))).deepEqual([]);
  });

  it('S144 should never open a sign-in file inside a skill, so its bytes cannot reach the skill digest', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, '.codex/skills/leaky/SKILL.md'), 'leaky');
    await put(path.join(user, '.codex/skills/leaky/auth.json'), '{"placeholder":"first"}');
    await put(path.join(user, '.codex/skills/fine/SKILL.md'), 'fine');
    const first = spiedFiles();

    // Act
    const [, before] = await scanner(user, { files: first.files }).scan();
    await put(path.join(user, '.codex/skills/leaky/auth.json'), '{"placeholder":"second, different bytes"}');
    const second = spiedFiles();
    const [, after] = await scanner(user, { files: second.files }).scan();

    // Assert
    should(before?.skills.map(skill => skill.item)).deepEqual(['fine', 'leaky']);
    // Changing the sign-in file's bytes leaves the digest alone: it was counted as a name, never read.
    should(after?.skills.find(skill => skill.item === 'leaky')?.digest).equal(
      before?.skills.find(skill => skill.item === 'leaky')?.digest,
    );
    should(first.opened.some(call => call.includes('auth.json'))).be.false();
    should(second.opened.some(call => call.includes('auth.json'))).be.false();
    // The ordinary file beside it was read.
    should(first.opened).containEql(`readBytes ${path.join(user, '.codex/skills/leaky/SKILL.md')}`);
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
  it('should say not-signed-in for a host login that needs sign-in, and unknown for one still being checked', async () => {
    // Arrange
    const user = await home();
    const row = sampleLogin('you', { email: 'person@example.test' });

    // Act
    const [needs] = await scanner(user, {
      logins: fakeLogins([{ ...row, status: { ...row.status, word: 'needs_sign_in' } }]),
    }).scan();
    const [checking] = await scanner(user, {
      logins: fakeLogins([{ ...row, status: { ...row.status, word: 'checking' } }]),
    }).scan();

    // Assert
    should(needs?.login).deepEqual({ state: 'not-signed-in', email: 'person@example.test' });
    should(checking?.login).match({ state: 'unknown', email: 'person@example.test' });
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
    // Found where they were moved to (an absent document would say so) and read there.
    should(claude?.instructions).match({ kind: 'text', source: path.join(claudeDir, 'CLAUDE.md'), text: 'moved' });
    should(claude?.mcp).match({ kind: 'text', source: path.join(claudeDir, '.claude.json') });
    should(codex?.instructions).match({ kind: 'text', source: path.join(codexDir, 'AGENTS.md'), text: 'moved' });
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

  it('should list a skills folder, and name a skill that holds more files than the limit instead of importing it', async () => {
    const user = await home();
    await mkdir(path.join(user, '.claude/skills'), { recursive: true });
    await put(path.join(user, '.codex/skills/big/a.md'), 'a');
    await put(path.join(user, '.codex/skills/big/b.md'), 'b');
    await put(path.join(user, '.codex/skills/small/a.md'), 'a');
    const [claude, codex] = await scanner(user, { maxSkillFiles: 1 }).scan();
    // The empty folder is no skills and no problem; the oversized skill is a named problem, the small one is found.
    should(claude?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([]);
    should(codex?.skills.map(skill => skill.item)).deepEqual(['small']);
    should(codex?.problems).deepEqual(['Skill "big" has more than 1 files, so it was not imported.']);
  });

  it('should treat a skills path that is a file as no skills', async () => {
    const user = await home();
    await put(path.join(user, '.claude/skills'), 'a file, not a folder');
    const [claude] = await scanner(user).scan();
    should(claude?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([]);
  });

  it('should name a skill that is a link as a problem and import the others, never reading through the link', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, '.claude/skills/fine/SKILL.md'), 'fine');
    await put(path.join(user, 'elsewhere/SKILL.md'), 'elsewhere');
    await symlink(path.join(user, 'elsewhere'), path.join(user, '.claude/skills/linked'));

    // Act
    const [claude] = await scanner(user).scan();

    // Assert
    should(claude?.skills.map(skill => skill.item)).deepEqual(['fine']);
    should(claude?.problems).deepEqual([
      `Skill "linked" at ${path.join(user, '.claude/skills/linked')} could not be read (symbolic links are not readable setup paths).`,
    ]);
  });

  it('should say the skills folder could not be read when the folder itself is a link', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, 'elsewhere/review/SKILL.md'), 'review');
    await mkdir(path.join(user, '.claude'), { recursive: true });
    await symlink(path.join(user, 'elsewhere'), path.join(user, '.claude/skills'));

    // Act
    const [claude] = await scanner(user).scan();

    // Assert
    should(claude?.skills).deepEqual([]);
    should(claude?.problems).deepEqual([
      `Your skills folder ${path.join(user, '.claude/skills')} could not be read (symbolic links are not readable setup paths).`,
    ]);
  });

  it('should refuse a skill entry whose name climbs out of the harness home', async () => {
    // Arrange
    const user = await home();
    await put(path.join(user, '.claude/skills/fine/SKILL.md'), 'fine');
    await put(path.join(user, 'outside/SKILL.md'), 'outside');
    const files: HostFiles = {
      ...nodeHostFiles,
      list: async directory =>
        directory.endsWith(path.join('.claude', 'skills'))
          ? ['fine', ['x', '..', '..', '..', 'outside'].join(path.sep)]
          : await nodeHostFiles.list(directory),
    };

    // Act
    const [claude] = await scanner(user, { files }).scan();

    // Assert
    should(claude?.skills.map(skill => skill.item)).deepEqual(['fine']);
    should(claude?.problems).deepEqual([
      `Skill "${['x', '..', '..', '..', 'outside'].join(path.sep)}" at ${path.join(user, 'outside')} could not be read (the path is outside its harness home).`,
    ]);
  });

  it('should take the login only from Logins facts, whatever the settings file holds', async () => {
    const user = await home();
    await put(path.join(user, '.codex/config.toml'), '= broken');
    const [, codex] = await scanner(user).scan();
    // The config file is never parsed for a sign-in; the Logins row (refresh due) alone speaks.
    should(codex?.login).deepEqual({ state: 'refresh-due', email: 'codex@example.test' });
  });
});
