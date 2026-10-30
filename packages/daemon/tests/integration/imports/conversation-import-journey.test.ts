/**
 * Keeping an existing conversation as a ferret, through the real composition root.
 *
 * WHAT ONLY THIS TIER CAN PROVE. `bin/fyd.ts` is in neither coverage ledger, so the adopter it builds
 * — account resolution, the runtime's history folder, the link, the session record — is wiring nobody
 * executes unless a booted daemon does. This boots one over a temp HOME holding a FAKE Claude
 * conversation (the owner's real `~/.claude` / `~/.codex` are never read: both CLI homes are pointed at
 * the fixture for the duration) and asserts what the owner would see: the conversation listed, adopted
 * STOPPED with an argv that RESUMES it, its transcript record naming the same file, and a second
 * adoption refused as a duplicate.
 *
 * IT SPENDS NOTHING. The adoption is `start: false`, so no harness is launched and no model is asked.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFleetManifest } from '@ferretry/fleet';
import { ConversationAdoptResultSchema, ConversationImportListingSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { NO_RELAY_DIRECTORY, type RelayAdvertisement } from '../../../src/lib/index.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { OS_CHOSEN_PORT, recordedPort } from '../support/os-port.ts';

const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';
const WRAPPER = 'claude-auto-import';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CODEX_ACCOUNT = '00000000-0000-4000-8000-0000000000c2';
const CODEX_WRAPPER = 'codex-auto-import';
const ROLLOUT = '55555555-5555-4555-8555-555555555555';
const GENERATED_AT = '2027-01-15T08:00:00.000Z';
const SAVED_ENV = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };

afterEach(async () => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await cleanupTempDirectories();
});

function world(): DaemonWorld {
  return {
    ...buildWorld({}, { userHome: ABSENT_USER_HOME }),
    relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
  };
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) return;
    await Bun.sleep(50);
  }
  throw new Error('the daemon never answered its health probe');
}

/** A runtime whose history folder is a link into the shared pool, as Ferretry provisions it. */
async function seedHome(home: string, id: string, harness: 'claude' | 'codex', wrapper: string) {
  const runtimeHome = join(home, 'fleet', 'homes', id);
  const folder = harness === 'claude' ? 'projects' : 'sessions';
  const pool = join(home, 'fleet', 'shared', harness, folder);
  await mkdir(pool, { recursive: true });
  await mkdir(runtimeHome, { recursive: true });
  await symlink(pool, join(runtimeHome, folder));
  const executable = join(home, 'bin', wrapper);
  await mkdir(join(home, 'bin'), { recursive: true });
  const variable = harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  // Never executed: the adoption under test does not launch.
  await writeFile(executable, ['#!/bin/sh', `export ${variable}="${runtimeHome}"`, 'exit 0', ''].join('\n'), {
    mode: 0o755,
  });
  return { runtimeHome, executable };
}

/** One Claude and one Codex runtime. */
async function seedRuntime(home: string): Promise<string> {
  const { runtimeHome, executable } = await seedHome(home, 'r1', 'claude', WRAPPER);
  const codex = await seedHome(home, 'r2', 'codex', CODEX_WRAPPER);
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: GENERATED_AT,
        accounts: [
          {
            id: ACCOUNT,
            kind: 'claude',
            mode: 'auto',
            wrapper: executable,
            home: runtimeHome,
            displayName: 'Import',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
          },
          {
            id: CODEX_ACCOUNT,
            kind: 'codex',
            mode: 'auto',
            wrapper: codex.executable,
            home: codex.runtimeHome,
            displayName: 'Import Codex',
            defaultModel: 'gpt-5.5',
            models: [{ id: 'gpt-5.5', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );
  return runtimeHome;
}

/** The owner's own CLI home, FAKE: one conversation that ran in `project`. */
async function seedOwnerConversation(owner: string, project: string): Promise<string> {
  const slug = project.replaceAll(/[^a-zA-Z0-9]/gu, '-');
  const folder = join(owner, '.claude', 'projects', slug);
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${CONVERSATION}.jsonl`);
  const record = (text: string, timestamp: string) =>
    JSON.stringify({
      type: 'user',
      sessionId: CONVERSATION,
      cwd: project,
      timestamp,
      message: { role: 'user', content: text },
    });
  const day = join(owner, '.codex', 'sessions', '2026', '10', '10');
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, `rollout-2026-10-10T09-00-00-${ROLLOUT}.jsonl`),
    `${[
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-10T09:00:00.000Z',
        payload: { id: ROLLOUT, cwd: project },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-10T09:01:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Draft the notes' }] },
      }),
    ].join('\n')}\n`,
  );
  await writeFile(
    file,
    `${record('Fix the cart total', '2026-10-17T08:01:00.000Z')}\n${record('Now ship it', '2026-10-17T08:05:00.000Z')}\n`,
  );
  return file;
}

describe('keeping an existing conversation as a ferret, on a booted daemon', () => {
  it('should list it, adopt it stopped with a resume argv over the same file, and refuse it twice', async () => {
    // Arrange
    const home = await tempDirectory('ferretry-import-journey-');
    const owner = await tempDirectory('ferretry-import-owner-');
    const project = await tempDirectory('ferretry-import-project-');
    process.env.CLAUDE_CONFIG_DIR = join(owner, '.claude');
    process.env.CODEX_HOME = join(owner, '.codex');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    process.env.FY_HOME = home;
    const opened = await world().storage.open();
    await opened.storage.close();
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: OS_CHOSEN_PORT }), {
      mode: 0o600,
    });
    const runtimeHome = await seedRuntime(home);
    const source = await seedOwnerConversation(owner, project);
    const original = await readFile(source, 'utf8');
    const shutdown = new Promise<void>(resolve => {
      release = resolve;
    });
    const exit = start({ ...world(), untilShutdown: () => shutdown }, cleanups);
    const port = await recordedPort(home);
    await waitForHealth(port);
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
    };
    const base = `http://127.0.0.1:${port}/v1/imports/conversations`;
    const adopt = async () =>
      await fetch(`${base}/adopt`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ harness: 'claude', runtime: WRAPPER, conversations: [{ id: CONVERSATION }] }),
      });

    // Act
    const before = ConversationImportListingSchema.parse(await (await fetch(`${base}?q=cart`, { headers })).json());
    const first = await adopt();
    const firstBody = await first.text();
    const second = ConversationAdoptResultSchema.parse(await (await adopt()).json());
    const after = ConversationImportListingSchema.parse(
      await (await fetch(`${base}?harness=claude`, { headers })).json(),
    );
    const mismatch = ConversationAdoptResultSchema.parse(
      await (
        await fetch(`${base}/adopt`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ harness: 'codex', runtime: WRAPPER, conversations: [{ id: ROLLOUT }] }),
        })
      ).json(),
    );
    const codex = ConversationAdoptResultSchema.parse(
      await (
        await fetch(`${base}/adopt`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ harness: 'codex', runtime: CODEX_WRAPPER, conversations: [{ id: ROLLOUT }] }),
        })
      ).json(),
    );
    const keptId = (JSON.parse(firstBody) as { adopted: { session: string }[] }).adopted[0]?.session ?? 'none';
    const messages = await (await fetch(`http://127.0.0.1:${port}/v1/sessions/${keptId}/messages`, { headers })).text();
    const sessionIds = await readdir(join(home, 'state', 'sessions')).catch(() => [] as string[]);

    release();
    await exit;
    for (const cleanup of cleanups) await cleanup();

    // Assert
    should(before.conversations.map(row => [row.id, row.project, row.preview, row.latest, row.turns])).deepEqual([
      [CONVERSATION, project, 'Fix the cart total', 'Now ship it', 2],
    ]);
    should(first.status).equal(200);
    const adopted = ConversationAdoptResultSchema.parse(JSON.parse(firstBody));
    should(adopted.refused).deepEqual([]);
    should(adopted.adopted).have.length(1);
    const kept = adopted.adopted[0];
    if (kept === undefined) throw new Error('the adoption kept nothing');
    should(kept.status).equal('stopped');
    // A duplicate is refused, and the listing says who keeps it.
    should(second.adopted).deepEqual([]);
    should(second.refused.map(item => item.code)).deepEqual(['already_adopted']);
    should(after.conversations[0]?.adoptedBy).equal(kept.session);
    // The record resumes the conversation and names the runtime's view of the SAME file.
    should(sessionIds.length).be.above(0);
    const configFile = join(home, 'state', 'sessions', kept.session, 'config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8')) as {
      readonly command: readonly string[];
      readonly cwd: string;
      readonly transcript: { readonly identity: string; readonly file: string; readonly harnessSessionId: string };
    };
    should(config.command.slice(1, 3)).deepEqual(['--resume', CONVERSATION]);
    should(config.command).not.containEql('--session-id');
    should(config.transcript).containDeep({
      identity: 'adopted',
      harnessSessionId: CONVERSATION,
      file: join(runtimeHome, 'projects', project.replaceAll(/[^a-zA-Z0-9]/gu, '-'), `${CONVERSATION}.jsonl`),
    });
    const [sourceStat, linkedStat] = await Promise.all([stat(source), stat(config.transcript.file)]);
    should([linkedStat.ino, linkedStat.dev]).deepEqual([sourceStat.ino, sourceStat.dev]);
    // Codex resumes with its own subcommand, and a Claude runtime is refused a Codex conversation.
    const codexSession = codex.adopted[0]?.session ?? 'none';
    const codexConfig = JSON.parse(
      await readFile(join(home, 'state', 'sessions', codexSession, 'config.json'), 'utf8'),
    ) as { readonly command: readonly string[] };
    should(codexConfig.command.slice(1, 3)).deepEqual(['resume', ROLLOUT]);
    should(mismatch.refused.map(item => item.code)).deepEqual(['harness_mismatch']);
    // Chat reads that file before anything has launched.
    should(messages).containEql('Fix the cart total');
    should(messages).containEql('Now ship it');
    // Never copied, never modified.
    should(await readFile(source, 'utf8')).equal(original);
  });

  it('should list the computer’s conversations only while “Keep in sync” is on, and continue one on the spot either way', async () => {
    // Arrange
    const home = await tempDirectory('ferretry-sync-journey-');
    const owner = await tempDirectory('ferretry-sync-owner-');
    const project = await tempDirectory('ferretry-sync-project-');
    process.env.CLAUDE_CONFIG_DIR = join(owner, '.claude');
    process.env.CODEX_HOME = join(owner, '.codex');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    process.env.FY_HOME = home;
    const opened = await world().storage.open();
    await opened.storage.close();
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: OS_CHOSEN_PORT }), {
      mode: 0o600,
    });
    await seedRuntime(home);
    const source = await seedOwnerConversation(owner, project);
    const original = await readFile(source, 'utf8');
    const shutdown = new Promise<void>(resolve => {
      release = resolve;
    });
    const exit = start({ ...world(), untilShutdown: () => shutdown }, cleanups);
    const port = await recordedPort(home);
    await waitForHealth(port);
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
    };
    const base = `http://127.0.0.1:${port}/v1/imports/conversations`;
    const synced = async () =>
      ConversationImportListingSchema.parse(await (await fetch(`${base}?source=synced`, { headers })).json());

    // Act
    const defaulted = await synced();
    await writeFile(join(home, 'config', 'machine.yaml'), 'conversations:\n  listComputer: false\n');
    const off = await synced();
    const adopted = ConversationAdoptResultSchema.parse(
      await (
        await fetch(`${base}/adopt`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ harness: 'claude', runtime: WRAPPER, conversations: [{ id: CONVERSATION }] }),
        })
      ).json(),
    );
    await writeFile(join(home, 'config', 'machine.yaml'), 'conversations:\n  listComputer: true\n');
    const on = await synced();

    release();
    await exit;
    for (const cleanup of cleanups) await cleanup();

    // Assert
    should(defaulted.conversations.map(row => [row.id, row.keptIn, row.adoptedBy])).deepEqual([
      [CONVERSATION, 'computer', undefined],
      [ROLLOUT, 'computer', undefined],
    ]);
    should(off.conversations).deepEqual([]);
    should(off.computerListed).equal(false);
    // Continuing one adopts it from the computer's home even though listing it is off.
    should(adopted.refused).deepEqual([]);
    should(adopted.adopted).have.length(1);
    // Once it is hard-linked into Ferretry's history it is Ferretry's row, listed once and owned.
    should(on.conversations.map(row => [row.id, row.keptIn, row.adoptedBy === undefined])).deepEqual([
      [CONVERSATION, 'ferretry', false],
      [ROLLOUT, 'computer', true],
    ]);
    should(on.computerListed).equal(undefined);
    should(await readFile(source, 'utf8')).equal(original);
  });
});
