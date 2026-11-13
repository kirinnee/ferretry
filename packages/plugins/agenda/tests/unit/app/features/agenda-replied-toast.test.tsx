import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { afterEach, describe, expect, it } from 'bun:test';
import { useSyncExternalStore } from 'react';
import { AgendaUndoToast } from '../../../../app/features/agenda/agenda-undo-toast.tsx';
import type { AgendaInbox } from '../../../../app/hooks/use-agenda-inbox.ts';
import { type DeferredTimers, DeferredAgendaActions } from '../../../../app/lib/agenda-inbox.ts';
import { RepliedAgenda, type RepliedPorts } from '../../../../app/lib/agenda-replied.ts';
import { agendaItem, choices, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { sessionView } from '../../../support/app/sessions.ts';

const card = inboxCard(
  agendaItem('A2', { ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'zoe', name: 'Release train' } as never }),
);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** Time nobody advances unless the test says so: the toast only ever ticks against this clock. */
const toastOver = async (ports: RepliedPorts) => {
  let now = 1_000_000;
  const timers: DeferredTimers = { now: () => now, setTimeout: () => 1, clearTimeout: () => undefined };
  const replied = new RepliedAgenda(ports, timers);
  const deferred = new DeferredAgendaActions(async () => undefined, timers);
  function Toast() {
    const repliedState = useSyncExternalStore(replied.subscribe, replied.getSnapshot);
    const inbox = { replied, repliedState, deferred, deferredState: deferred.getSnapshot() } as unknown as AgendaInbox;
    return <AgendaUndoToast clock={() => now} inbox={inbox} />;
  }
  view = await mount(<Toast />);
  const text = (): string =>
    must(view?.container.querySelector<HTMLElement>('[role=status]'), 'the status line').textContent ?? '';
  const wait = async (ms: number, move: number): Promise<void> => {
    now += move;
    await interact(async () => {
      await new Promise(done => setTimeout(done, ms));
    });
  };
  return { replied, text, wait, container: () => must(view?.container, 'the toast') };
};

const ports = (over: Partial<RepliedPorts> = {}): RepliedPorts => ({
  withdraw: async () => 'withdrawn',
  unsnooze: async () => undefined,
  ...over,
});

describe('what the reply toast says after Undo', () => {
  it('names the move while Undo is on offer, then says nothing once the window has closed', async () => {
    const run = await toastOver(ports());
    await interact(async () => {
      run.replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    });
    expect(run.text()).toBe('Moved to Replied');
    expect(run.container().querySelector('.fy-attn-undo--inline')).toBeNull();
    await run.wait(300, 6_000);
    expect(run.text()).toBe('');
  });

  it.each([
    ['the ferret already read it', ports(), { words: 'hi', disposition: 'delivered' }, 'zoe already read your reply'],
    ['the queue cannot say', ports(), { words: 'hi' }, 'may already be with the ferret'],
    [
      'the queue refused',
      ports({
        withdraw: async () => {
          throw new Error('offline');
        },
      }),
      { words: 'hi', sendId: 'm1', disposition: 'queued' },
      'may still reach zoe. offline',
    ],
    [
      'the machine would not put the card back',
      ports({
        unsnooze: async () => {
          throw new Error('no');
        },
      }),
      { words: 'hi', sendId: 'm1', disposition: 'queued' },
      'Could not put it back on your list. no',
    ],
  ])('says what happened when %s', async (_name, port, sent, expected) => {
    const run = await toastOver(port);
    await interact(async () => {
      run.replied.mark(card, sent);
    });
    await interact(async () => run.replied.undo());
    expect(run.text().toLowerCase()).toContain(expected.toLowerCase());
    expect(run.container().querySelector('[data-agenda-replied-notice]')).not.toBeNull();
  });

  it('lets the sentence go once its time is up', async () => {
    const run = await toastOver(ports());
    await interact(async () => {
      run.replied.mark(card, { words: 'hi', sendId: 'm1', disposition: 'queued' });
    });
    await interact(async () => run.replied.undo());
    expect(run.text()).toContain('your words are back in the box');
    await run.wait(300, 10_000);
    expect(run.container().querySelector('[data-agenda-replied-notice]')).toBeNull();
    expect(run.replied.getSnapshot().notice).toBeNull();
  });
});
