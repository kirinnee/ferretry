import { describe, expect, test } from 'bun:test';
import type { FerretRecord } from '../../../../contract/index.ts';
import { FakeHarness, ferretId } from '../../../../contract/testing/index.ts';
import { boundConversation } from '../../../../daemon/lib/ferrets/bound-conversation.ts';

const record = (fields: Partial<FerretRecord> = {}): FerretRecord => ({
  format: 1,
  id: ferretId('fern'),
  name: 'fern',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work/fern',
  state: 'working',
  createdAt: '2026-11-01T00:00:00.000Z' as FerretRecord['createdAt'],
  stateAt: '2026-11-01T00:00:00.000Z' as FerretRecord['stateAt'],
  harnessConversation: 'conv-fern',
  ...fields,
});

describe('boundConversation', () => {
  test('names the recorded conversation and asks the harness, from the ferret’s own home, whether it is there', async () => {
    const harness = new FakeHarness();
    const asked: { home: string; folder: string; conversation: string }[] = [];
    harness.hasConversation = async (spec, conversation) => {
      asked.push({ home: spec.home, folder: spec.folder, conversation });
      return true;
    };

    expect(await boundConversation(record(), harness)).toEqual({ id: 'conv-fern', present: true });
    expect(asked).toEqual([{ home: '/home/agent-homes/fern', folder: '/work/fern', conversation: 'conv-fern' }]);
  });

  test('says absent only when the harness proves it', async () => {
    const harness = new FakeHarness();
    harness.hasConversation = async () => false;
    expect(await boundConversation(record(), harness)).toEqual({ id: 'conv-fern', present: false });
  });

  test('cannot tell when the harness cannot, throws, names no home, or has no such question', async () => {
    const undecided = new FakeHarness();
    undecided.hasConversation = async () => undefined;
    expect(await boundConversation(record(), undecided)).toEqual({ id: 'conv-fern', present: undefined });

    const throwing = new FakeHarness();
    throwing.hasConversation = async () => {
      throw new Error('disk');
    };
    expect(await boundConversation(record(), throwing)).toEqual({ id: 'conv-fern', present: undefined });

    const homeless = new FakeHarness();
    homeless.hasConversation = async () => true;
    homeless.homeFor = async () => {
      throw new Error('no home');
    };
    expect(await boundConversation(record(), homeless)).toEqual({ id: 'conv-fern', present: undefined });

    expect(await boundConversation(record(), new FakeHarness())).toEqual({ id: 'conv-fern', present: undefined });
    expect(await boundConversation(record(), undefined)).toEqual({ id: 'conv-fern', present: undefined });
  });

  test('a ferret with no recorded conversation takes the one its harness PROVES its last launch wrote', async () => {
    const harness = new FakeHarness();
    harness.provedConversation = async () => ({ id: 'rollout-9', file: '/h/r.jsonl', home: '/h' });
    harness.hasConversation = async (_spec, conversation) => conversation === 'rollout-9';

    expect(await boundConversation(record({ harnessConversation: undefined }), harness)).toEqual({
      id: 'rollout-9',
      present: true,
    });
  });

  test('a ferret with none recorded and none proved is bound to none: nothing is asked', async () => {
    const harness = new FakeHarness();
    let asked = 0;
    harness.hasConversation = async () => {
      asked += 1;
      return true;
    };
    harness.provedConversation = async () => {
      throw new Error('unreadable');
    };

    expect(await boundConversation(record({ harnessConversation: undefined }), harness)).toEqual({
      id: undefined,
      present: undefined,
    });
    expect(asked).toBe(0);
  });
});
