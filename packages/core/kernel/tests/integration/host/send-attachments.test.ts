import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConversationPort } from '../../../../../plugins/conversation/contract/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * A SEND THAT NAMES A FILE, through the daemon: the REAL Ferrets and the REAL Conversation halves, as the generated
 * registry builds them. An app-shaped send (upload, then send with `attachmentIds`) hands a copy of the stored original to
 * the ferret in ITS OWN session `attachments/` folder, and types the message listing that path. A file that is not the
 * ferret's refuses the send before anything is typed. `fy send --kind fyi` through the real route is typed, not refused.
 *
 * CI only (integration tier). Fixture values only.
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
/** Takes the Conversation port as a consumer (the app's own calls go by routes; the upload here is the port's). */
const consumer = implementDaemon(
  definePlugin({
    id: 'warden',
    title: 'Warden (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { conversation: ConversationPort },
  }),
  { build: () => ({}) },
);

async function boot(runner: FakeRunner): Promise<TestHost> {
  return await testHost({
    plugins: [real('ferrets'), real('conversation'), harnessPlugin(new FakeHarness()), runnerPlugin(runner), consumer],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const startFerret = async (h: TestHost, folder: string): Promise<string> => {
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder, prompt: 'Work.' },
  });
  expect(started.status).toBeLessThan(300);
  await h.settle();
  return started.json<{ id: string }>().id;
};

const upload = async (h: TestHost, id: string, filename: string, body: string): Promise<string> => {
  const added = await h.provided(ConversationPort, 'warden').addAttachment(id as never, {
    filename,
    mime: 'image/png',
    base64: Buffer.from(body).toString('base64'),
  });
  if (!added.ok) throw new Error('the fixture upload failed');
  return added.value.id;
};

const send = async (h: TestHost, id: string, body: Record<string, unknown>) =>
  await h.request('POST', `/v1/ferrets/${id}/send`, { headers: { 'x-fy-request-id': randomUUID() }, body });

describe('a send naming a file, through the real Ferrets and Conversation', () => {
  test('the file is copied into the ferret’s own attachments folder and the typed message lists that path', async () => {
    const runner = new FakeRunner();
    const h = await boot(runner);
    const id = await startFerret(h, '/work/a');
    const attachment = await upload(h, id, 'Screen Shot.png', 'FIXTURE-PNG-BYTES');
    const typedBefore = runner.deliveries.length;

    const sent = await send(h, id, { message: 'see the picture', attachmentIds: [attachment] });

    expect(sent.status).toBe(200);
    const typed = runner.deliveries.slice(typedBefore).map(entry => entry.delivery.text);
    expect(typed).toHaveLength(1);
    // v4's layout: a folder per FULL attachment id, the file under its own name.
    const name = `${attachment}/Screen-Shot.png`;
    expect(h.rootText('sessions', `${id}/attachments/${name}`)).toBe('FIXTURE-PNG-BYTES');
    expect(typed[0]).toContain('see the picture');
    expect(typed[0]).toContain(`${name} (image/png)`);
    expect(typed[0]).toContain('/attachments/');
  });

  test('another ferret’s file refuses the send 400 before anything is typed', async () => {
    const runner = new FakeRunner();
    const h = await boot(runner);
    const mine = await startFerret(h, '/work/a');
    const other = await startFerret(h, '/work/b');
    const theirs = await upload(h, other, 'secret.png', 'FIXTURE-OTHER');
    const typedBefore = runner.deliveries.length;

    const sent = await send(h, mine, { message: 'sneaky', attachmentIds: [theirs] });

    expect(sent.status).toBe(400);
    expect(sent.json<{ error: string }>().error).toMatch(/^an attached file could not be handed to the agent: /);
    expect(runner.deliveries).toHaveLength(typedBefore);
    expect(h.rootText('sessions', `${mine}/attachments/${theirs}/secret.png`)).toBeUndefined();
  });
});
