import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { conversationConformance, fakeConversation } from '../../contract/testing/index.ts';
import {
  AnswerRequestSchema,
  AttachmentViewSchema,
  ConversationConfigSchema,
  CompactAtSchema,
  DraftClientFrameSchema,
  DraftEditSchema,
  KeepRequestSchema,
  QueuedMessageSchema,
  RenderIdSchema,
  RenderSaveRequestSchema,
  SendRequestSchema,
  WorkSearchQuerySchema,
} from '../../contract/index.ts';
import { at } from '../support/instant.ts';

conversationConformance('fakeConversation', () => fakeConversation());

describe('conversation wire schemas', () => {
  test('a send body is strict: an unknown field is refused', () => {
    expect(SendRequestSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(SendRequestSchema.safeParse({ message: 'hi', sessionId: 's' }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ message: '' }).success).toBe(false);
  });
  test('a queued message needs its format, state and revision', () => {
    const base = {
      v: 1,
      id: 'm1',
      sender: 'human',
      text: 'x',
      attachmentIds: [],
      enqueuedAt: at('2026-11-07T09:00:00Z') as Instant,
      state: 'queued',
      stateAt: at('2026-11-07T09:00:00Z') as Instant,
      revision: 1,
    };
    expect(QueuedMessageSchema.safeParse(base).success).toBe(true);
    expect(QueuedMessageSchema.safeParse({ ...base, v: 2 }).success).toBe(false);
    expect(QueuedMessageSchema.safeParse({ ...base, state: 'sent' }).success).toBe(false);
  });
  test('an answer names the question it answers', () => {
    expect(AnswerRequestSchema.safeParse({ toolUseId: 't', labels: ['Yes'] }).success).toBe(true);
    expect(AnswerRequestSchema.safeParse({ labels: ['Yes'] }).success).toBe(false);
  });
  test('compact-at is auto or at least 100k tokens', () => {
    expect(CompactAtSchema.safeParse('auto').success).toBe(true);
    expect(CompactAtSchema.safeParse(250_000).success).toBe(true);
    expect(CompactAtSchema.safeParse(50_000).success).toBe(false);
  });
  test('a locked attachment cannot expose extracted text', () => {
    const view = {
      id: 'att_1',
      filename: 'a.pdf',
      mime: 'application/pdf',
      size: 1,
      sha256: 'a'.repeat(64),
      createdAt: at('2026-11-07T09:00:00Z'),
      encrypted: { kind: 'pdf', locked: true },
    };
    expect(AttachmentViewSchema.safeParse(view).success).toBe(true);
    const withText = { ...view, textExtraction: { method: 'pdfjs', characters: 1, truncated: false } };
    expect(AttachmentViewSchema.safeParse(withText).success).toBe(false);
  });
  test('a render id is base32 without i, l, o or u; a save names a kind', () => {
    expect(RenderIdSchema.safeParse('abc123').success).toBe(true);
    expect(RenderIdSchema.safeParse('abcdeu').success).toBe(false);
    expect(RenderSaveRequestSchema.safeParse({ kind: 'png', alt: '', payload: '' }).success).toBe(false);
  });
  test('a draft edit and a presence frame parse; an unknown frame kind does not', () => {
    const edit = { generation: 'g', epoch: 0, base: 0, text: [3, 'ab', -1] };
    expect(DraftEditSchema.safeParse(edit).success).toBe(true);
    expect(DraftClientFrameSchema.safeParse({ kind: 'presence', typing: true }).success).toBe(true);
    expect(DraftClientFrameSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(DraftEditSchema.safeParse({ ...edit, text: [0] }).success).toBe(false);
  });
  test('keeping a conversation twice in one request, or starting too many, is refused', () => {
    const one = { id: 'c1', start: false };
    const copy = { id: 'c2', start: false, copy: true };
    expect(KeepRequestSchema.safeParse({ harness: 'claude-code', runtime: 'r', conversations: [copy] }).success).toBe(
      true,
    );
    expect(KeepRequestSchema.safeParse({ harness: 'claude-code', runtime: 'r', conversations: [one] }).success).toBe(
      true,
    );
    expect(
      KeepRequestSchema.safeParse({ harness: 'claude-code', runtime: 'r', conversations: [one, one] }).success,
    ).toBe(false);
    const six = Array.from({ length: 11 }, (_, n) => ({ id: `c${n}`, start: true }));
    expect(KeepRequestSchema.safeParse({ harness: 'claude-code', runtime: 'r', conversations: six }).success).toBe(
      false,
    );
  });
  test('work search defaults its limit and refuses a blank query', () => {
    expect(WorkSearchQuerySchema.parse({ q: 'badge' }).limit).toBe(20);
    expect(WorkSearchQuerySchema.safeParse({ q: '  ' }).success).toBe(false);
  });
  test('the config defaults to keeping drafts in sync and refuses an unknown key', () => {
    expect(ConversationConfigSchema.parse({}).keepInSync).toBe(true);
    expect(ConversationConfigSchema.safeParse({ other: 1 }).success).toBe(false);
  });
});
