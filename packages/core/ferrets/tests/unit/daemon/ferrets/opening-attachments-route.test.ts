import { expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { type OpeningAttachmentsSource, StartRequestsFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { fakeAttachmentsOwner, host } from './route-fixture.ts';

/**
 * `fy start -f` (V-0443) through the REAL Ferrets daemon half on the test host: `POST /v1/ferrets` with
 * `initialAttachments` is answered by whoever provides `opening.attachments` (a stand-in under Conversation's real id;
 * Conversation's own half is proved in its package, and both real halves together in the kernel's integration tier).
 * This pins Ferrets' end of the seam: the half asks the hook's provider, writes what it planned into the ferret's own
 * `attachments/` folder, and names it in turn-001; with no provider a start with files is refused and writes nothing.
 */

const NOTES = 'Ship the login fix by Friday.';
const attachment = { filename: 'notes.txt', base64: Buffer.from(NOTES).toString('base64') };

/** Plans each file straight into the folder it is told, decoded, and words one line naming its absolute path. */
const owner = (asked: string[] = []): OpeningAttachmentsSource => ({
  plan: ({ attachments, directory }) => {
    asked.push(directory);
    return ok({
      section: `\n## Attachments\n\n${attachments.map(item => `- ${directory}/${item.filename}`).join('\n')}\n`,
      files: attachments.map(item => ({
        file: `${directory}/${item.filename}`,
        contents: new Uint8Array(Buffer.from(item.base64, 'base64')),
      })),
    });
  },
});

const start = { folder: '/work/a', prompt: 'Fix the login.', initialAttachments: [attachment] };

test('V-0443 a start with a file is planned by the opening.attachments provider, written into the ferret’s own attachments folder and named in turn-001', async () => {
  const asked: string[] = [];
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, plugins: [fakeAttachmentsOwner(owner(asked))] });
  const started = await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': 'attach-1' }, body: start });
  expect(started.status).toBe(201);
  const id = started.json<{ id: string }>().id;
  const directory = `/sessions/${id}/attachments`;
  expect(asked).toEqual([directory]);
  expect(h.rootText('sessions', `${id}/attachments/notes.txt`)).toBe(NOTES);
  expect(h.rootText('sessions', `${id}/turns/turn-001.md`)).toBe(
    `# Assigned task\n\nFix the login.\n\n## Attachments\n\n- ${directory}/notes.txt\n\n`,
  );
  expect(runner.starts).toBe(1);
});

test('V-0443 the file’s bytes are never echoed: not in the 201, the GET view, the start-request ledger or any state file, and appear under the ferret’s session folder only as attachments/notes.txt', async () => {
  const h = await host([], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    plugins: [fakeAttachmentsOwner(owner())],
  });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'attach-echo' },
    body: start,
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: string }>().id;
  // The 201 names the ferret and nothing else.
  expect(started.json<Record<string, unknown>>()).toEqual({ id });
  expect(started.body).not.toContain(attachment.base64);
  expect(started.body).not.toContain(NOTES);
  // The read views never carry them either.
  for (const path of [`/v1/ferrets/${id}`, '/v1/ferrets']) {
    const view = await h.request('GET', path);
    expect(view.status).toBe(200);
    expect(view.body).not.toContain(attachment.base64);
    expect(view.body).not.toContain(NOTES);
  }
  // The start-request ledger keeps the request id and a digest of the body, not the body.
  const ledger = h.state('ferrets').raw(StartRequestsFile);
  expect(ledger).toContain('attach-echo');
  expect(ledger).not.toContain(attachment.base64);
  expect(ledger).not.toContain(NOTES);
  // No state file of the Ferrets half holds them (the ferret's record, its details, the ledger, …).
  const everything = [
    ...h.state('ferrets').files.values(),
    ...[...h.state('ferrets').bytes.values()].map(b => Buffer.from(b).toString('latin1')),
  ];
  expect(everything.length).toBeGreaterThan(0);
  for (const text of everything) {
    expect(text).not.toContain(attachment.base64);
    expect(text).not.toContain(NOTES);
  }
  // On disk the bytes live in the one planned file; the opening turn only names it.
  expect(h.rootText('sessions', `${id}/attachments/notes.txt`)).toBe(NOTES);
  const opening = h.rootText('sessions', `${id}/turns/turn-001.md`);
  expect(opening).toContain(`/sessions/${id}/attachments/notes.txt`);
  expect(opening).not.toContain(NOTES);
  expect(opening).not.toContain(attachment.base64);
});

test('V-0443 with no provider of opening.attachments a start with files is refused 409 with its sentence, and nothing is written or launched', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner });
  const refused = await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': 'attach-2' }, body: start });
  expect(refused.status).toBe(409);
  expect(refused.body).toContain('the plugin that owns them is off');
  expect(runner.starts).toBe(0);
  // Nothing behind: the refusal is before the first write, so there is no ferret to list.
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toEqual([]);
});

test('V-0443 opening.attachments is on the security path: a plugin other than conversation may not provide it', async () => {
  await expect(
    host([], { harness: new FakeHarness(), runner: new FakeRunner(), plugins: [fakeAttachmentsOwner(owner(), 'mcp')] }),
  ).rejects.toThrow('mcp takes a refused hook definition');
});

test('V-0443 a SECOND taker of opening.attachments beside conversation refuses the build', async () => {
  await expect(
    host([], {
      harness: new FakeHarness(),
      runner: new FakeRunner(),
      plugins: [fakeAttachmentsOwner(owner()), fakeAttachmentsOwner(owner(), 'mcp')],
    }),
  ).rejects.toThrow('mcp takes a refused hook definition');
});
