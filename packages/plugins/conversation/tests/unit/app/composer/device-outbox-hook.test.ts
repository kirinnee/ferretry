/**
 * `conversation.device-outbox`: this device's unsent owner messages for one ferret, read only. A window over the
 * daemon's outbox that narrows to one ferret and to the contract's fields.
 */
import { describe, expect, test } from 'bun:test';
import { deviceOutboxFor } from '../../../../app/composer/device-outbox-hook.ts';
import {
  MemoryOutboxBackend,
  type OutboxEnqueue,
  type OutboxSender,
  SendOutbox,
} from '../../../../app/composer/send-outbox.ts';
import { CONVERSATION_DEVICE_OUTBOX_HOOK, CONVERSATION_PROVIDED_APP_HOOKS } from '../../../../contract/app-hooks.ts';

const DAEMON = 'd1';

/** `sender` null is a machine that cannot be reached: entries wait. A throwing sender is a machine that says no. */
const harness = (sender: OutboxSender | null = null) => {
  let n = 0;
  const outbox = new SendOutbox({
    backend: new MemoryOutboxBackend(),
    mintId: () => `m${++n}`,
    now: () => 1,
    resolve: async () => sender,
    setTimer: () => undefined,
  });
  const hook = deviceOutboxFor(DAEMON, outbox);
  const enqueue = (ferretId: string, message: string, extra: Partial<OutboxEnqueue> = {}) =>
    outbox.enqueue({ daemonId: DAEMON, ferretId, message, ...extra });
  return { outbox, hook, enqueue };
};

const accepting: OutboxSender = { send: async () => ({ disposition: 'queued' }), upload: async () => 'att_1' };
const refusing: OutboxSender = {
  send: async () => {
    throw new Error('this ferret is stopped');
  },
  upload: async () => 'att_1',
};

describe('conversation.device-outbox', () => {
  test('an entry saved for ferret A shows for A and not for B', async () => {
    const { hook, enqueue } = harness();
    await enqueue('A', 'thank you');
    expect(hook.entries('A').map(entry => entry.message)).toEqual(['thank you']);
    expect(hook.entries('B')).toEqual([]);
  });

  test('entries are oldest first and carry the references apart from the words', async () => {
    const { hook, enqueue } = harness();
    await enqueue('A', 'first', { references: ['^A3'] });
    await enqueue('A', 'second');
    const entries = hook.entries('A');
    expect(entries.map(entry => entry.message)).toEqual(['first', 'second']);
    expect(entries[0]?.references).toEqual(['^A3']);
    expect(entries[1]?.references).toEqual([]);
  });

  test('an entry leaves when the outbox sends it', async () => {
    const { hook, enqueue, outbox } = harness(accepting);
    await enqueue('A', 'bye');
    expect(hook.entries('A')).toHaveLength(1);
    await outbox.drain(DAEMON, 'A');
    expect(hook.entries('A')).toEqual([]);
  });

  test('an entry also leaves when the owner cancels it', async () => {
    const { hook, enqueue, outbox } = harness();
    const entry = await enqueue('A', 'never mind');
    await outbox.cancel(entry.id);
    expect(hook.entries('A')).toEqual([]);
  });

  test('subscribe hears a change and stops being heard once cancelled', async () => {
    const { hook, enqueue } = harness();
    let heard = 0;
    const stop = hook.subscribe(() => {
      heard += 1;
    });
    await enqueue('A', 'one');
    expect(heard).toBeGreaterThan(0);
    stop();
    const before = heard;
    await enqueue('A', 'two');
    expect(heard).toBe(before);
  });

  test('the array is the same object between unchanged snapshots, and a new one after a change', async () => {
    const { hook, enqueue } = harness();
    await enqueue('A', 'one');
    const first = hook.entries('A');
    expect(hook.entries('A')).toBe(first);
    // A change for another ferret does not move this ferret's array.
    await enqueue('B', 'elsewhere');
    expect(hook.entries('A')).toBe(first);
    await enqueue('A', 'two');
    expect(hook.entries('A')).not.toBe(first);
    expect(hook.entries('A')).toHaveLength(2);
  });

  test('a ferret with nothing unsent gets the same empty array every time', () => {
    const { hook } = harness();
    expect(hook.entries('A')).toBe(hook.entries('Z'));
  });

  test('a refused entry carries `refused` and its reason; a waiting one carries neither refusal', async () => {
    const waiting = harness();
    await waiting.enqueue('A', 'later');
    await waiting.outbox.drain(DAEMON, 'A');
    expect(waiting.hook.entries('A')[0]?.refused).toBeUndefined();
    expect(waiting.hook.entries('A')[0]?.reason).toBeTruthy();

    const said = harness(refusing);
    await said.enqueue('A', 'nope');
    await said.outbox.drain(DAEMON, 'A');
    const [entry] = said.hook.entries('A');
    expect(entry?.refused).toBe(true);
    expect(entry?.reason).toBe('this ferret is stopped');
  });

  test('only the contract’s fields cross: no files, no shared-draft data, no attachment ids', async () => {
    const { hook, enqueue } = harness();
    await enqueue('A', 'with a file', {
      files: [{ name: 'a.txt', type: 'text/plain', blob: new Blob(['x']) }],
      attachmentIds: ['att_1'],
      sharedDraft: { text: 'draft' } as never,
    });
    const [entry] = hook.entries('A');
    expect(Object.keys(entry ?? {}).sort()).toEqual(['createdAt', 'ferretId', 'id', 'message', 'references']);
  });

  test('the hook is declared as a provided shared action whose narrowing accepts it and nothing else', () => {
    const narrows = CONVERSATION_PROVIDED_APP_HOOKS[CONVERSATION_DEVICE_OUTBOX_HOOK];
    expect(narrows(harness().hook)).toBe(true);
    expect(narrows({ subscribe: () => () => undefined })).toBe(false);
    expect(narrows(null)).toBe(false);
  });
});
