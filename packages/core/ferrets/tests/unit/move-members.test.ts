/**
 * The move's contract members are ADDITIVE and OPTIONAL (c58-37): a runner or harness that does not fill one still
 * satisfies its interface, so no plugin changes until its own PR fills the member. The assignments below are the proof,
 * and the typecheck is what runs them: making any of these members required breaks this file.
 */
import { expect, test } from 'bun:test';
import type { RuntimeStartSource } from '../../contract/hooks/runtime-start.hook.ts';
import type { Harness, PortableConversation, Runner, RunnerHandle, RunnerPaneIdentity } from '../../contract/kinds.ts';

/** Whether every key of `Keys` is optional on `T`. */
type AllOptional<T, Keys extends keyof T> = Record<string, never> extends Pick<T, Keys> ? true : false;

const runnerMembersAreOptional: AllOptional<Runner, 'identify' | 'signalDescendant'> = true;
const catalogIsOptional: AllOptional<RuntimeStartSource, 'catalog'> = true;
const harnessMembersAreOptional: AllOptional<Harness, 'exportConversation' | 'adoptConversation'> = true;

test('c58-37 the move members are optional on Runner, Harness and RuntimeStartSource', () => {
  expect(runnerMembersAreOptional).toBe(true);
  expect(harnessMembersAreOptional).toBe(true);
  expect(catalogIsOptional).toBe(true);
});

test('c58-37 an identity names a pane by handle, pid and start, and a conversation carries what it dropped', () => {
  const identity: RunnerPaneIdentity = { handle: '%7' as RunnerHandle, pid: 41, processStart: '1234' };
  const conversation: PortableConversation = {
    harness: 'claude-code',
    entries: [{ kind: 'user', text: 'hello', attachments: [] }],
    dropped: { reasoning: 1, sidechains: 0, internal: 0, compactions: 0 },
  };
  expect([identity.handle, identity.pid, identity.processStart]).toEqual(['%7', 41, '1234']);
  expect(conversation.entries).toHaveLength(1);
});
