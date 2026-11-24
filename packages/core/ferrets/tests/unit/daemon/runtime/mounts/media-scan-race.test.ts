import { describe, it } from 'bun:test';
import { closeSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { ApiResponse, Redaction, RedactionScope } from '@ferretry/kernel/contract';
import should from 'should';
import { sessionFilesystemRoutes } from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import { SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
import { PosixSessionRootPinner } from '../../../../support/daemon/session-filesystem/index.ts';
import { refusalOf } from '../../support/calls.ts';
import { requestOf } from '../../support/requests.ts';
import { FakeRootPinner, FakeSessionGit, treeOf } from '../../session/filesystem/support.ts';

const SECRET = 'sk-live-not-for-chat-0123456789';

/**
 * A kept verdict is keyed on the descriptor's stat at OPEN, but the range is read later (the vault opens in between).
 * A same-size write in that gap must not be served from the old clean verdict: the descriptor is stat'ed again after
 * the read and the verdict is used only if the key still holds. Real pinner, real file, real in-place write.
 */
describe('media scan once: a write between the open stat and the windowed read', () => {
  async function raced() {
    const dir = mkdtempSync(path.join(tmpdir(), 'rv2486-'));
    const file = path.join(dir, 'clip.mp4');
    writeFileSync(file, Buffer.alloc(4096, 0x41));
    const inner = new FakeRedaction(new Map([['TOKEN' as never, SECRET]]));
    let calls = 0;
    let writeOnCall = -1;
    // A writer that lands while the request awaits the vault open (the span chooser's fingerprint read).
    const redaction: Pick<Redaction, 'read'> = {
      read: async <T>(fn: (scope: RedactionScope) => T | Promise<T>) => {
        calls += 1;
        if (calls === writeOnCall) {
          const fd = openSync(file, 'r+');
          writeSync(fd, Buffer.from(SECRET), 0, SECRET.length, 0); // in place, same size
          closeSync(fd);
        }
        return await inner.read(fn);
      },
    };
    const routes = sessionFilesystemRoutes({
      filesystem: new SessionFilesystem(new FakeRootPinner({ tree: treeOf() }), new FakeSessionGit({})),
      media: () => new SessionFilesystem(new PosixSessionRootPinner(), new FakeSessionGit({ isTracked: () => true })),
      reach: async () => ({ id: 's1', cwd: dir }),
      redaction,
    } as never);
    const ask = async (): Promise<ApiResponse> =>
      await routes['GET /v1/ferrets/:ferretId/fs/media'](
        requestOf({ params: { ferretId: 's1' }, query: { name: 'clip.mp4' }, headers: { range: 'bytes=0-99' } }),
      );
    return {
      ask,
      /** The next request's vault read (after its open stat) is where the write lands. */
      writeDuringNextRequest: () => {
        writeOnCall = calls + 1;
      },
    };
  }

  it('never serves the vault value the write put in the file, and judges the file again afterwards', async () => {
    const { ask, writeDuringNextRequest } = await raced();
    const first = await ask(); // scan: clean, verdict kept
    should(first.status).eql(206);

    writeDuringNextRequest();
    let served: ApiResponse | undefined;
    const refusal = await refusalOf(
      ask().then(response => {
        served = response;
      }),
    );
    const body = Buffer.from(served?.bytes ?? new Uint8Array()).toString('latin1');
    should(body.includes(SECRET)).be.false();
    should(refusal).eql({ status: 409, code: 'changed' });

    // The stale verdict is gone: the file as it is now is scanned, found to hold the value, and refused.
    should(await refusalOf(ask())).eql({ status: 403, code: 'holds_secret' });
  });
});
