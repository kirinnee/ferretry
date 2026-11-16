import { describe, expect, test } from 'bun:test';
import { readPushMessage } from '@ferretry/kernel/contract/push-envelope';
import { machineShow, planNotificationPresentation } from '../../../src/worker/notify-group.ts';

/**
 * THE WORKER HALF OF "TWO EVENTS, ONE TAG". Each payload is exactly what a real sender composes (Access's
 * `passkeyAddedNotice` and `buzzPayload(stopBuzzWords(…))`, whose own tests pin these shapes: another package's code is
 * reached only through its contract, so it cannot be imported here), read through the kernel's own `readPushMessage`,
 * filed under the machine and decided against the lines already showing.
 */
const MACHINE = { daemonId: 'sha256:review/one', label: 'Review machine' };
const ORIGIN = 'https://app.test';

const shownFrom = (payload: unknown) => {
  const message = readPushMessage(payload);
  if (message?.type !== 'show') throw new Error('the producer did not make a readable show');
  return machineShow(message.show, MACHINE, ORIGIN);
};

/** Delivers each payload in turn while the earlier lines stay on screen; returns what the worker did with each. */
const deliver = (payloads: readonly unknown[]) => {
  const showing: object[] = [];
  return payloads.map(payload => {
    const plan = planNotificationPresentation(shownFrom(payload), showing);
    if (plan.action === 'show') showing.push(plan.data);
    return plan.action;
  });
};

const passkeyAdded = (device: string, at: string, body: string) => ({
  version: 1,
  eventKey: `passkey-added:${device}:${at}`,
  title: 'A passkey was added',
  body,
  tag: 'passkey-added',
  url: '/',
  count: 1,
});

const stop = (stoppedAt: string, ask: string) => ({
  version: 1,
  eventKey: `stop:f1:${stoppedAt}`,
  title: 'Review is stopped · 1 needs you',
  body: `Question ${ask}`,
  tag: 'agenda-f1',
  url: `/ferrets/f1/chat?ask=${ask}`,
  count: 1,
});

describe('S6 distinct events under one tag', () => {
  test('two passkey additions while the first notice is showing both show', () => {
    const first = passkeyAdded('device-a', '2026-11-15T10:00:00.000Z', 'Laptop has a new passkey');
    const second = passkeyAdded('device-a', '2026-11-15T10:05:00.000Z', 'New phone has a new passkey');
    expect(shownFrom(first).tag).toBe(shownFrom(second).tag);
    expect(deliver([first, second])).toEqual(['show', 'show']);
  });

  test('the same passkey addition delivered twice shows once', () => {
    const notice = () => passkeyAdded('device-a', '2026-11-15T10:00:00.000Z', 'Laptop has a new passkey');
    expect(deliver([notice(), notice()])).toEqual(['show', 'skip']);
  });

  test('two stops of one ferret while the first notice is showing both show, and the newer tap url wins', () => {
    const first = stop('1', 'A1');
    const second = stop('2', 'A2');
    expect(shownFrom(second).tag).toBe(shownFrom(first).tag);
    expect(deliver([first, second])).toEqual(['show', 'show']);
    expect(shownFrom(second).url).toBe(`${ORIGIN}/d/sha256%3Areview%2Fone/ferrets/f1/chat?ask=A2`);
    expect(shownFrom(second).url).not.toBe(shownFrom(first).url);
  });

  test('the same stop delivered twice shows once', () => {
    expect(deliver([stop('1', 'A1'), stop('1', 'A1')])).toEqual(['show', 'skip']);
  });

  test('a buzz that names no event carries no key, so it is never skipped', () => {
    const buzz = { version: 1, title: 'T', body: 'B', tag: 'agenda-f1', url: '/', count: 1 };
    expect(shownFrom(buzz).eventKey).toBeUndefined();
    expect(deliver([buzz, buzz])).toEqual(['show', 'show']);
  });
});

describe('S6 an older daemon whose event key is the notification tag', () => {
  test('never skips a distinct event under the same tag', () => {
    const older = (body: string) => ({ ...passkeyAdded('d', 't', body), eventKey: 'passkey-added' });
    expect(deliver([older('Laptop has a new passkey'), older('Phone has a new passkey')])).toEqual(['show', 'show']);
  });
});
