/**
 * `fy send --message-file` and `-f` through the shell's REAL verb table, the REAL conversation half and the REAL
 * file readers (a temporary directory on disk), over a fake daemon. The half used to throw "the shell gives a plugin no
 * file access" for both, so an agent could not send a long message or a file at all.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

const VIEW = {
  id: 'a1',
  filename: 'shot.png',
  mime: 'image/png',
  size: 4,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-14T00:00:00.000Z',
};

class DaemonStub extends RecordingTransport {
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    if (request.path.endsWith('/attachments')) return { status: 201, body: VIEW };
    return { status: 200, body: { ferret: 'f1', disposition: 'queued', sendId: 's1' } };
  }
}

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fy-send-files-'));
  await writeFile(join(dir, 'long.md'), '\n  the long message\nwith two lines  \n');
  await writeFile(join(dir, 'shot.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, 'empty.pdf'), new Uint8Array());
  await mkdir(join(dir, 'folder'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (...words: string[]) => {
  const transport = new DaemonStub();
  const made = fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
    transport,
    environment: {},
    // The real readers, over the real disk; only the home is in memory.
    host: createPluginHost({ home: '/fake-home', fs: state.createMemoryHostFs(), cwd: () => dir }),
  });
  const code = await runFy(['send', 'f1', ...words], made.world);
  return { code, err: made.io.stderr(), transport };
};
const body = (transport: DaemonStub, suffix: string) =>
  transport.sent.find(request => request.path.endsWith(suffix))?.body as Record<string, unknown> | undefined;

describe('fy send --message-file', () => {
  it('sends the file’s words, after the typed ones, and exits 0', async () => {
    const { code, err, transport } = await run('look at this', '--message-file', join(dir, 'long.md'));
    should(err).not.containEql('cannot read');
    should(code).equal(0);
    should(body(transport, '/send')?.message).equal('look at this\n\nthe long message\nwith two lines');
  });

  it('a file that is not there is the caller’s mistake, naming the path (exit 2), and nothing is sent', async () => {
    const { code, err, transport } = await run('--message-file', 'nope.md');
    should(err).containEql('cannot read nope.md');
    should(code).equal(2);
    should(transport.sent).have.length(0);
  });

  it('a directory is refused the same way', async () => {
    const { code, err, transport } = await run('--message-file', join(dir, 'folder'));
    should(err).containEql('cannot read ' + join(dir, 'folder'));
    should(code).equal(2);
    should(transport.sent).have.length(0);
  });
});

describe('fy send -f', () => {
  it('uploads the file under its name and type, then sends the message with its id', async () => {
    const { code, err, transport } = await run('this is the screenshot', '-f', join(dir, 'shot.png'));
    should(err).not.containEql('cannot read');
    should(code).equal(0);
    should(body(transport, '/attachments')).deepEqual({
      filename: 'shot.png',
      mime: 'image/png',
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    });
    should(body(transport, '/send')?.attachmentIds).deepEqual(['a1']);
  });

  it('a file that is not there, or is empty, is refused before anything is uploaded (exit 2)', async () => {
    const missing = await run('x', '-f', 'nope.png');
    should(missing.err).containEql('cannot read attachment nope.png');
    should(missing.code).equal(2);
    should(missing.transport.sent).have.length(0);

    const empty = await run('x', '-f', join(dir, 'empty.pdf'));
    should(empty.err).containEql('is empty');
    should(empty.code).equal(2);
    should(empty.transport.sent.filter(request => request.path.endsWith('/send'))).have.length(0);
  });
});
