import { describe, expect, test } from 'bun:test';
import { bytesToBase64, uploadAttachment } from '../../../../app/composer/attachment-upload.ts';
import {
  attachmentTypeLabel,
  normalizeAttachmentMime,
  validateAttachmentFile,
} from '../../../../app/composer/attachments.ts';
import { DaemonCallError, daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { noteClientDaemon } from '@ferretry/app/testing';
import { fakeClient, refusal } from './fake-client.ts';

const daemon = daemonConnection('up');
const scope = daemonFerretScope(daemon, 'ferret one');
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
  test('posts the bytes as base64 JSON to the ferret’s own route and returns the parsed view', async () => {
    const { client, calls } = fakeClient(() => attachment);
    const view = await uploadAttachment(client, scope, file);
    expect(view as unknown).toEqual(attachment);
    expect(calls[0]?.route).toBe('POST /v1/ferrets/:ferretId/attachments');
    expect(calls[0]?.params).toEqual({ ferretId: 'ferret one' });
    expect(calls[0]?.body).toEqual({ filename: 'hi.txt', mime: 'text/plain', base64: 'aGk=' });
  });

  test('declares an untyped file as octet-stream and lets the daemon sniff it', async () => {
    const { client, calls } = fakeClient(() => attachment);
    await uploadAttachment(client, scope, new File([new Uint8Array([1])], 'blob'));
    expect((calls[0]?.body as { mime: string } | undefined)?.mime).toBe('application/octet-stream');
  });

  test('passes a refusal on with the daemon’s code and sentence', async () => {
    const { client } = fakeClient(() => {
      throw refusal(413, 'attachment_too_large', 'too big');
    });
    await expect(uploadAttachment(client, scope, file)).rejects.toMatchObject({
      status: 413,
      message: 'too big',
      code: 'attachment_too_large',
    });
  });

  test('refuses a scope from another daemon', async () => {
    const { client, calls } = fakeClient(() => attachment);
    noteClientDaemon(client, 'up');
    const other = daemonFerretScope(daemonConnection('other'), 's');
    await expect(uploadAttachment(client, other, file)).rejects.toThrow('attachment scope must belong');
    expect(calls).toEqual([]);
    await expect(uploadAttachment(client, scope, file)).resolves.toBeDefined();
  });

  test('refuses an answer that names no attachment', async () => {
    const { client } = fakeClient(() => ({ id: '' }));
    await expect(uploadAttachment(client, scope, file)).rejects.toBeInstanceOf(DaemonCallError);
  });

  test('encodes large inputs in chunks', () => {
    const bytes = new Uint8Array(70_000).fill(65);
    expect(atob(bytesToBase64(bytes))).toHaveLength(70_000);
  });
});

describe('attachment types', () => {
  test('accepts audio by its common aliases and any text type, and labels audio', () => {
    expect(normalizeAttachmentMime('audio/x-m4a')).toBe('audio/mp4');
    expect(validateAttachmentFile({ size: 3, type: 'audio/webm' })).toBeNull();
    expect(validateAttachmentFile({ size: 3, type: 'text/x-typescript' })).toBeNull();
    expect(attachmentTypeLabel('audio/wave')).toBe('Audio recording');
  });
});
