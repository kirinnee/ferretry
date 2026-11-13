import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * V-0443 `fy start -f` through the daemon: the REAL Ferrets and the REAL Conversation halves, as the generated registry
 * builds them, meet on `opening.attachments` (Ferrets offers it; Conversation is its one provider). A start that carries
 * a file is planned by Conversation's real source (decoded, bounded, worded), written by Ferrets into the ferret's own
 * `attachments/` folder and named by absolute path in turn-001. Without Conversation a start with files is refused 409 and
 * nothing is launched. Each package pins its own end of the seam in its unit tier; this file proves the two ends meet.
 *
 * CI only (integration tier: real halves and the real inflate adapter). Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

async function boot(conversation: boolean, runner: FakeRunner): Promise<TestHost> {
  return await testHost({
    everyDirectory: true,
    plugins: [
      real('ferrets'),
      ...(conversation ? [real('conversation')] : []),
      harnessPlugin(new FakeHarness()),
      runnerPlugin(runner),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const NOTES = 'Ship the login fix by Friday.';
const body = {
  folder: '/work/a',
  prompt: 'Fix the login.',
  initialAttachments: [{ filename: 'notes.txt', base64: Buffer.from(NOTES).toString('base64') }],
};
const start = async (h: TestHost) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

describe('V-0443 a start’s attachments cross from Ferrets to Conversation and back', () => {
  test('V-0443 with the real Conversation a start with a file writes it into the ferret’s attachments folder and turn-001 names it', async () => {
    // Arrange
    const runner = new FakeRunner();
    const h = await boot(true, runner);

    // Act
    const started = await start(h);
    await h.settle();

    // Assert
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    const directory = `/sessions/${id}/attachments`;
    expect(h.rootText('sessions', `${id}/attachments/notes.txt`)).toBe(NOTES);
    const turn = h.rootText('sessions', `${id}/turns/turn-001.md`) ?? '';
    expect(turn.startsWith('# Assigned task\n\nFix the login.\n')).toBe(true);
    expect(turn).toContain('## Attachments');
    expect(turn).toContain(`${directory}/notes.txt`);
    expect(runner.starts).toBe(1);
    await h.stop();
  });

  test('V-0443 without Conversation a start with a file is refused 409 with its sentence and nothing is launched', async () => {
    // Arrange
    const runner = new FakeRunner();
    const h = await boot(false, runner);

    // Act
    const refused = await start(h);

    // Assert
    expect(refused.status).toBe(409);
    expect(refused.body).toContain('the plugin that owns them is off');
    expect(runner.starts).toBe(0);
    await h.stop();
  });
});
