import { describe, expect, test } from 'bun:test';
import { ensureDom, render, run, runAsync, settleUntil } from '@ferretry/app/testing';
import { OutboxHost } from '../../../../app/composer/outbox-host.ts';
import { documentOutbox } from '../../../../app/composer/send-outbox-wiring.ts';

ensureDom();

/**
 * B12 — a saved message is retried by the app itself, with no chat open. The shell mounts the host once per paired
 * daemon at the frame root; the host offers the daemon's outbox a sender over the plugin's own (background) client.
 */

interface Call {
  readonly route: string;
  readonly init: {
    readonly params?: { readonly ferretId?: string };
    readonly body?: { readonly sendId?: string };
    readonly headers?: Record<string, string>;
  };
}

const clientOf = (answer: () => unknown) => {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      call: async <Answer,>(route: string, init?: unknown): Promise<Answer> => {
        calls.push({ route, init: (init ?? {}) as Call['init'] });
        return answer() as Answer;
      },
    },
  };
};

const sent = (ferret: string) => ({ ferret, disposition: 'sent' });

describe('the background outbox host', () => {
  test('B12 a message saved earlier goes out when the host mounts, under its own id, with no composer drawn', async () => {
    const daemonId = 'bg-host-1';
    const held = documentOutbox(daemonId);
    // Saved while nothing could carry it: the entry waits (no sender has been offered for this daemon).
    const saved = await held.outbox.submit({ daemonId, ferretId: 'f1', message: 'saved before the app reopened' });
    expect(saved.outcome.kind).toBe('waiting');

    const { calls, client } = clientOf(() => sent('f1'));
    const view = render(<OutboxHost daemon={daemonId} client={client as never} />);
    await runAsync(async () => {
      await settleUntil(() => calls.length > 0, 'the saved message to be sent', runAsync);
    });

    const sends = calls.filter(call => call.route === 'POST /v1/ferrets/:ferretId/send');
    expect(sends).toHaveLength(1);
    // The SAME id the entry was saved under: a retry the daemon already saw is answered from its first record.
    expect(sends[0]?.init.body?.sendId).toBe(saved.entry.id);
    expect(sends[0]?.init.headers?.['x-fy-request-id']).toBe(saved.entry.id);
    await runAsync(async () => {
      await settleUntil(() => held.outbox.snapshot().length === 0, 'the sent entry to leave the outbox', runAsync);
    });
    run(() => view.unmount());
  });

  test('B12 a host that unmounts hands the sender back: a later save waits again instead of calling a dead client', async () => {
    const daemonId = 'bg-host-2';
    const held = documentOutbox(daemonId);
    const { calls, client } = clientOf(() => sent('f1'));
    const view = render(<OutboxHost daemon={daemonId} client={client as never} />);
    run(() => view.unmount());

    const saved = await held.outbox.submit({ daemonId, ferretId: 'f1', message: 'saved after the host left' });

    expect(saved.outcome.kind).toBe('waiting');
    expect(calls.filter(call => call.route === 'POST /v1/ferrets/:ferretId/send')).toHaveLength(0);
  });

  test('a send that waited on a down machine goes out when the client’s feed says the machine is back', async () => {
    const daemonId = 'bg-host-3';
    const held = documentOutbox(daemonId);
    const listeners = new Set<(live: boolean) => void>();
    let down = true;
    const calls: string[] = [];
    const client = {
      call: async <Answer,>(route: string): Promise<Answer> => {
        calls.push(route);
        if (down) throw new TypeError('Failed to fetch');
        return sent('f1') as Answer;
      },
      feed: {
        isLive: () => !down,
        subscribeLive: (listener: (live: boolean) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    const view = render(<OutboxHost daemon={daemonId} client={client as never} />);
    expect(listeners.size).toBe(1);
    const saved = await held.outbox.submit({ daemonId, ferretId: 'f1', message: 'saved while the machine was down' });
    expect(saved.outcome.kind).toBe('waiting');

    // Only the feed can wake it now: the retry timer is 20 s away and the browser never went offline.
    down = false;
    await runAsync(async () => {
      for (const listener of [...listeners]) listener(true);
      await settleUntil(() => held.outbox.snapshot().length === 0, 'the waiting message to be sent', runAsync);
    });

    expect(calls.filter(route => route === 'POST /v1/ferrets/:ferretId/send').length).toBeGreaterThanOrEqual(2);
    run(() => view.unmount());
    expect(listeners.size).toBe(0);
  });
});
