import { describe, expect, test } from 'bun:test';
import type { MailboxHost } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { MAILBOX_HOST_MISSING, MailboxHostMissingError, requireMailboxHost } from '../../../daemon/lib/host-slot.ts';

const HOST: MailboxHost = {
  queue: { read: async () => [], append: async () => undefined },
  ledger: {} as MailboxHost['ledger'],
};

/** The half built over a provider lookup and a log that remembers what was said. */
function half(provided: MailboxHost | 'unavailable') {
  const errors: string[] = [];
  if (daemon.build === undefined) throw new Error('the Mailbox daemon has no build');
  const built = daemon.build({
    hooks: { provider: () => provided },
    kernel: { log: { error: (message: string) => errors.push(message) } },
  } as never) as unknown as {
    doctor: { 'mailbox-host': () => Promise<{ state: string; detail: string; fix?: string }> };
    beforeListen: (ctx: never) => Promise<void>;
  };
  const ctx = { kernel: { log: { error: (message: string) => errors.push(message) } } } as never;
  return { built, ctx, errors };
}

describe('the mailbox.host slot', () => {
  test('hands back what Conversation provided', () => {
    expect(requireMailboxHost(() => HOST)).toBe(HOST);
  });

  test('with no provider every use throws a refusal that names the cause, never an empty store', () => {
    expect(() => requireMailboxHost(() => 'unavailable')).toThrow(MailboxHostMissingError);
    expect(() => requireMailboxHost(() => 'unavailable')).toThrow(MAILBOX_HOST_MISSING);
  });

  test('boot is quiet when the slot is filled and says so loudly when it is not', async () => {
    const filled = half(HOST);
    await filled.built.beforeListen(filled.ctx);
    expect(filled.errors).toEqual([]);

    const empty = half('unavailable');
    await empty.built.beforeListen(empty.ctx);
    expect(empty.errors).toEqual([MAILBOX_HOST_MISSING]);
  });

  test('fy doctor fails the mailbox-host row while the slot is empty, with the remedy', async () => {
    expect((await half(HOST).built.doctor['mailbox-host']()).state).toBe('ok');
    const failed = await half('unavailable').built.doctor['mailbox-host']();
    expect(failed).toEqual({ state: 'fail', detail: MAILBOX_HOST_MISSING, fix: 'turn Conversation on' });
  });
});
