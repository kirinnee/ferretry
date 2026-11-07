import { describe, expect, test } from 'bun:test';
import { boardConformance, fakeBoard } from '../../contract/testing/index.ts';
import {
  BoardConfigSchema,
  CardActionRequestSchema,
  CardAskRefSchema,
  CardCreateRequestSchema,
  CardIdSchema,
  CardSchema,
  LaneSetActionRequestSchema,
  ProgressSchema,
} from '../../contract/index.ts';

boardConformance('fakeBoard', () => fakeBoard());

describe('board wire schemas', () => {
  test('a card id is a kind letter and a number', () => {
    for (const good of ['B1', 'F412', 'I3', 'C999']) expect(CardIdSchema.safeParse(good).success).toBe(true);
    for (const bad of ['T1', 'F0', 'f1', 'F', '#F1']) expect(CardIdSchema.safeParse(bad).success).toBe(false);
  });
  test('progress has exactly now, doneSoFar and next', () => {
    expect(ProgressSchema.safeParse({ now: '', doneSoFar: '', next: '' }).success).toBe(true);
    expect(ProgressSchema.safeParse({ now: '', doneSoFar: '', next: '', status: 'x' }).success).toBe(false);
  });
  test('#1552 a card has no answer action and no answer field', () => {
    expect(CardActionRequestSchema.safeParse({ action: 'answer', text: 'yes' }).success).toBe(false);
    expect(CardActionRequestSchema.safeParse({ action: 'move', to: 'done' }).success).toBe(true);
    expect('answer' in CardSchema.shape).toBe(false);
  });
  test('a link names exactly one thing', () => {
    expect(CardActionRequestSchema.safeParse({ action: 'link', pr: 'https://github.com/o/r/pull/1' }).success).toBe(
      true,
    );
    expect(CardActionRequestSchema.safeParse({ action: 'link', pr: 'a', branch: 'b' }).success).toBe(false);
  });
  test('the card ask obligation names a card, its lane and its gate entry', () => {
    expect(CardAskRefSchema.safeParse({ card: 'F12', lane: 'verify', entry: 'e1' }).success).toBe(true);
    expect(CardAskRefSchema.safeParse({ card: 'F12', answer: 'yes' }).success).toBe(false);
  });
  test('a create request defaults to the quick workflow and no parent; old fields are refused', () => {
    const parsed = CardCreateRequestSchema.parse({ kind: 'bug', title: 't', ask: { text: 'a', source: 's' } });
    expect([parsed.workflow, parsed.parent, parsed.visibility]).toEqual(['quick', null, undefined]);
    expect(CardCreateRequestSchema.safeParse({ kind: 'bug', title: 't', ask: { text: 'a', source: 's' }, legacyRef: 'x:B1' }).success).toBe(
      false,
    );
  });
  test('lane edits carry the version they read', () => {
    expect(LaneSetActionRequestSchema.safeParse({ action: 'confirm', version: 2 }).success).toBe(true);
    expect(LaneSetActionRequestSchema.safeParse({ action: 'confirm' }).success).toBe(false);
  });
  test('the config defaults the GitHub watch on', () => {
    expect(BoardConfigSchema.parse({})).toEqual({ github: { watch: true, pollSeconds: 60 } });
  });
});
