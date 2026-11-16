import { describe, expect, test } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { AttachmentView } from '../../../contract/index.ts';
import { AttachmentError } from '../../../daemon/attachments/lib/index.ts';
import { downloadRoute, lockRoute, unlockRoute, uploadRoute } from '../../../daemon/attachments/routes.ts';
import type { AttachmentSubsystem } from '../../../daemon/attachments/routes.ts';

const view: AttachmentView = {
  id: `att_${'a'.repeat(64)}`,
  filename: 'notes.txt',
  mime: 'text/plain',
  size: 5,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-07T00:00:00.000Z' as Instant,
};

const subsystem = (calls: string[], fail?: AttachmentError): AttachmentSubsystem => ({
  upload: async (ferret, request) => {
    if (fail) throw fail;
    calls.push(`upload ${ferret} ${request.filename} ${new TextDecoder().decode(request.bytes)}`);
    return view;
  },
  download: async (ferret, id) => {
    if (fail) throw fail;
    calls.push(`download ${ferret} ${id}`);
    return { attachment: view, bytes: new TextEncoder().encode('hello') };
  },
  unlock: async (ferret, id, password) => {
    calls.push(`unlock ${ferret} ${id} ${password.length}`);
    return view;
  },
  lock: async (ferret, id) => {
    calls.push(`lock ${ferret} ${id}`);
    return view;
  },
});

const call = (body: unknown, params: Record<string, string> = { ferretId: 'f1' }) =>
  ({
    request: { text: async () => JSON.stringify(body) } as unknown as ApiRequest,
    params: new Map(Object.entries(params)),
  }) as never;

const id = view.id;

describe('the attachment routes', () => {
  test('an upload decodes the base64 and answers 201 with the view', async () => {
    const calls: string[] = [];
    const response = await uploadRoute(subsystem(calls))(
      call({ filename: 'notes.txt', mime: 'text/plain', base64: btoa('hello') }),
    );
    expect(response.status).toBe(201);
    expect(calls).toEqual(['upload f1 notes.txt hello']);
  });

  test('bytes that are not base64 are a 400', async () => {
    const refusal = await uploadRoute(subsystem([]))(
      call({ filename: 'notes.txt', mime: 'text/plain', base64: '***' }),
    ).then(
      () => undefined,
      (error: unknown) => error as { status: number; code?: string },
    );
    expect(refusal).toMatchObject({ status: 400, code: 'invalid_attachment' });
  });

  test('a download is spelled as {attachment, base64} exactly', async () => {
    const response = await downloadRoute(subsystem([]))(call({}, { ferretId: 'f1', attachmentId: id }));
    expect(response.body).toBe(`{"attachment":${JSON.stringify(view)},"base64":"${btoa('hello')}"}`);
  });

  test('a store refusal becomes its status and an attachment_ code', async () => {
    const error = await downloadRoute(
      subsystem([], new AttachmentError('too_large', 'attachment exceeds the daemon size limit')),
    )(call({}, { ferretId: 'f1', attachmentId: id })).then(
      () => undefined,
      (caught: unknown) => caught as { status: number; code?: string },
    );
    expect(error).toMatchObject({ status: 413, code: 'attachment_too_large' });
  });

  test('unlock and lock reach the store with the path ids, and the password only as a length here', async () => {
    const calls: string[] = [];
    await unlockRoute(subsystem(calls))(call({ password: 'secret' }, { ferretId: 'f1', attachmentId: id }));
    await lockRoute(subsystem(calls))(call({}, { ferretId: 'f1', attachmentId: id }));
    expect(calls).toEqual([`unlock f1 ${id} 6`, `lock f1 ${id}`]);
  });

  test('a path id that is not usable is a 400', async () => {
    const error = await lockRoute(subsystem([]))(call({}, { ferretId: '..', attachmentId: id })).then(
      () => undefined,
      (caught: unknown) => caught as { status: number },
    );
    expect(error?.status).toBe(400);
  });
});
