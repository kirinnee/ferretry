import { describe, expect, test } from 'bun:test';
import { bytesToBase64, uploadAttachment } from '../../src/lib/attachment-upload.ts';
import {
  attachmentTypeLabel,
  isAudioMime,
  normalizeAttachmentMime,
  validateAttachmentFile,
} from '../../src/lib/attachments.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemon = daemonConnection({ daemonId: 'up', baseUrl: 'https://up.example.test', deviceId: 'device' });
const scope = daemonSessionScope(daemon, 'sess one');
const file = new File([new Uint8Array([104, 105])], 'hi.txt', { type: 'text/plain' });

const attachment = {
  id: 'att_1',
  filename: 'hi.txt',
  mime: 'text/plain',
  size: 2,
  sha256: 'b'.repeat(64),
  createdAt: '2026-10-16T00:00:00.000Z',
};

describe('uploadAttachment', () => {
  test('posts the bytes as base64 JSON to the session’s own route and returns the parsed view', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const view = await uploadAttachment(daemon, scope, file, async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(attachment, { status: 201 });
    });
    expect(view).toEqual(attachment);
    expect(calls[0]?.url).toBe('https://up.example.test/v1/sessions/sess%20one/attachments');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      filename: 'hi.txt',
      mime: 'text/plain',
      base64: 'aGk=',
    });
  });

  test('declares an untyped file as octet-stream and lets the daemon sniff it', async () => {
    let body = '';
    await uploadAttachment(daemon, scope, new File([new Uint8Array([1])], 'blob'), async (_input, init) => {
      body = String(init?.body);
      return Response.json(attachment);
    });
    expect(JSON.parse(body).mime).toBe('application/octet-stream');
  });

  test('restates a refusal with the daemon’s code, and a nameless failure with its status', async () => {
    const refused = uploadAttachment(daemon, scope, file, async () =>
      Response.json({ error: 'too big', code: 'attachment_too_large' }, { status: 413 }),
    );
    await expect(refused).rejects.toMatchObject({ status: 413, message: 'too big', code: 'attachment_too_large' });
    const bare = uploadAttachment(daemon, scope, file, async () => new Response('nope', { status: 500 }));
    await expect(bare).rejects.toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });

  test('refuses an answer that names no attachment, and a scope from another daemon', async () => {
    await expect(uploadAttachment(daemon, scope, file, async () => Response.json({ id: '' }))).rejects.toBeInstanceOf(
      DaemonResponseError,
    );
    const other = daemonSessionScope(
      daemonConnection({ daemonId: 'other', baseUrl: 'https://o.example.test', deviceId: 'd' }),
      's',
    );
    await expect(uploadAttachment(daemon, other, file)).rejects.toThrow('attachment scope must belong');
  });

  test('encodes large inputs in chunks', () => {
    const bytes = new Uint8Array(70_000).fill(65);
    expect(atob(bytesToBase64(bytes))).toHaveLength(70_000);
  });
});

describe('attachment types', () => {
  test('accepts audio by its common aliases and any text type, and labels audio', () => {
    expect(normalizeAttachmentMime('audio/x-m4a')).toBe('audio/mp4');
    expect(isAudioMime('audio/mp3')).toBe(true);
    expect(isAudioMime('image/png')).toBe(false);
    expect(validateAttachmentFile({ size: 3, type: 'audio/webm' })).toBeNull();
    expect(validateAttachmentFile({ size: 3, type: 'text/x-typescript' })).toBeNull();
    expect(attachmentTypeLabel('audio/wave')).toBe('Audio recording');
  });
});
