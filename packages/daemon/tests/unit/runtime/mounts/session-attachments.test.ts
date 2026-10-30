import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import type { AttachmentView } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionAttachmentError } from '../../../../src/lib/attachments/index.ts';
import {
  type SessionAttachmentSubsystem,
  sessionAttachmentRoutes,
} from '../../../../src/lib/runtime/mounts/session-attachments.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

const attachment: AttachmentView = {
  id: `att_${'a'.repeat(64)}`,
  filename: 'private.pdf',
  mime: 'application/pdf',
  size: 3,
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  encrypted: { kind: 'pdf', locked: true },
};

class FakeAttachments implements SessionAttachmentSubsystem {
  uploaded: Array<{
    readonly id: string;
    readonly request: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array };
  }> = [];
  unlocked: Array<{ readonly id: string; readonly attachmentId: string; readonly password: string }> = [];
  locked: Array<{ readonly id: string; readonly attachmentId: string }> = [];
  failure: Error | undefined;
  content = new Uint8Array([1, 2, 3]);

  async upload(
    id: string,
    value: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
  ): Promise<AttachmentView> {
    if (this.failure !== undefined) throw this.failure;
    this.uploaded.push({ id, request: value });
    return attachment;
  }

  async download(
    id: string,
    attachmentId: string,
  ): Promise<{ readonly attachment: AttachmentView; readonly bytes: Uint8Array }> {
    if (this.failure !== undefined) throw this.failure;
    should(id).equal('session-1');
    should(attachmentId).equal(attachment.id);
    return { attachment, bytes: this.content };
  }

  async unlock(id: string, attachmentId: string, password: string): Promise<AttachmentView> {
    if (this.failure !== undefined) throw this.failure;
    this.unlocked.push({ id, attachmentId, password });
    return {
      ...attachment,
      encrypted: { kind: 'pdf', locked: false, expiresAt: '2026-01-01T00:15:00.000Z', decryptedSize: 3 },
    };
  }

  async lock(id: string, attachmentId: string): Promise<AttachmentView> {
    if (this.failure !== undefined) throw this.failure;
    this.locked.push({ id, attachmentId });
    return attachment;
  }
}

const dispatcher = (subsystem = new FakeAttachments()): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionAttachmentRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

const path = (suffix = ''): string => `/v1/sessions/session-1/attachments${suffix}`;
const body = (value: unknown): string => JSON.stringify(value);

describe('the session attachment mount', () => {
  it('uploads JSON bytes and returns the durable attachment view', async () => {
    const attachments = new FakeAttachments();
    const response = await dispatcher(attachments).dispatch(
      request({
        method: 'POST',
        path: path(),
        headers: human,
        body: body({ filename: 'private.pdf', mime: 'application/pdf', base64: 'AQID' }),
      }),
    );

    should(response.status).equal(201);
    should(JSON.parse(response.body)).deepEqual(attachment);
    should(attachments.uploaded[0]?.id).equal('session-1');
    should([...((attachments.uploaded[0]?.request.bytes ?? new Uint8Array()) as Uint8Array)]).deepEqual([1, 2, 3]);
  });

  it('downloads the encrypted original rather than an unlocked plaintext', async () => {
    const response = await dispatcher().dispatch(
      request({ method: 'GET', path: path(`/${attachment.id}`), headers: human }),
    );

    should(response.status).equal(200);
    should(JSON.parse(response.body)).deepEqual({ attachment, base64: 'AQID' });
  });

  /**
   * The stall budget of a download (the EC2 stalls of 2026-10-30): the largest attachment the daemon keeps is
   * encoded with the loop handed back between slices, so a timer armed beside it keeps firing — before, the
   * whole file was one `String.fromCharCode` loop and the loop ran nothing else until it ended.
   */
  it('hands the loop back while it encodes the largest attachment, and spells the same JSON', async () => {
    const attachments = new FakeAttachments();
    attachments.content = new Uint8Array(32 * 1024 * 1024);
    for (let index = 0; index < attachments.content.length; index += 4093) attachments.content[index] = index % 251;
    let turns = 0;
    let worstGapMs = 0;
    let last = performance.now();
    let running = true;
    const turn = (): void => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - last);
      last = now;
      turns += 1;
      if (running) setImmediate(turn);
    };
    setImmediate(turn);
    const response = await dispatcher(attachments).dispatch(
      request({ method: 'GET', path: path(`/${attachment.id}`), headers: human }),
    );
    running = false;

    should(response.status).equal(200);
    should(response.body).equal(
      JSON.stringify({ attachment, base64: Buffer.from(attachments.content).toString('base64') }),
    );
    // One turn of the loop per 768 KiB slice at least: 32 MiB is 43 of them.
    should(turns).be.aboveOrEqual(40);
    // Generous for a loaded CI host; the old encoder held the loop for about 700 ms on this size.
    should(worstGapMs).be.below(200);
  });

  it('unlocks with a body password and locks via DELETE without putting either in the URL', async () => {
    const attachments = new FakeAttachments();
    const subject = dispatcher(attachments);
    const unlocked = await subject.dispatch(
      request({
        method: 'POST',
        path: path(`/${attachment.id}/unlock`),
        headers: human,
        body: body({ password: 'use once' }),
      }),
    );
    const locked = await subject.dispatch(
      request({ method: 'DELETE', path: path(`/${attachment.id}/unlock`), headers: human }),
    );

    should(unlocked.status).equal(200);
    should(locked.status).equal(200);
    should(attachments.unlocked).deepEqual([{ id: 'session-1', attachmentId: attachment.id, password: 'use once' }]);
    should(attachments.locked).deepEqual([{ id: 'session-1', attachmentId: attachment.id }]);
  });

  it('refuses malformed IDs and base64, and gives attachment failures their actionable status', async () => {
    const malformedId = await dispatcher().dispatch(
      request({ method: 'GET', path: path('/bad%2Fid'), headers: human }),
    );
    const malformedBytes = await dispatcher().dispatch(
      request({
        method: 'POST',
        path: path(),
        headers: human,
        body: body({ filename: 'x', mime: 'text/plain', base64: '%' }),
      }),
    );
    const attachments = new FakeAttachments();
    attachments.failure = new SessionAttachmentError('wrong_password', 'password rejected');
    const refused = await dispatcher(attachments).dispatch(
      request({
        method: 'POST',
        path: path(`/${attachment.id}/unlock`),
        headers: human,
        body: body({ password: 'bad' }),
      }),
    );

    should([malformedId.status, malformedBytes.status, refused.status]).deepEqual([400, 400, 409]);
    should((JSON.parse(refused.body) as { code: string }).code).equal('attachment_wrong_password');
  });
});
