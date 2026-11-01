/** The link `fy plan approve --open` prints: read once, held, and spent only when a machine that runs the session is known. */

import { afterEach, describe, expect, it } from 'bun:test';
import { useAgendaDeepLink } from '../../src/hooks/use-agenda-deep-link.ts';
import type { AgendaInboxMachine } from '../../src/hooks/use-agenda-inbox.ts';
import {
  captureAgendaDeepLink,
  clearAgendaDeepLink,
  pendingAgendaDeepLink,
  subscribeAgendaDeepLink,
} from '../../src/lib/agenda-deep-link.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { mount } from '../support/dom.ts';

const hereAt = (hash: string) => ({ hash, pathname: '/app/', search: '?x=1' });

const machine = (daemonId: string, sessions: readonly string[] | null): AgendaInboxMachine =>
  ({
    connection: daemonConnection({ daemonId, baseUrl: `https://${daemonId}.example`, deviceId: 'phone-1' }),
    name: daemonId,
    sessions: sessions === null ? null : sessions.map(id => ({ config: { id } })),
  }) as never;

afterEach(() => clearAgendaDeepLink());

describe('capturing the link', () => {
  it('holds a card link, tells the listeners and takes the fragment out of the address bar', () => {
    let heard = 0;
    const stop = subscribeAgendaDeepLink(() => {
      heard += 1;
    });
    captureAgendaDeepLink(hereAt('#agenda/A8?session=sess-1'));
    expect(pendingAgendaDeepLink()).toEqual({ id: 'A8', sessionId: 'sess-1' });
    expect(heard).toBe(1);
    expect(window.location.hash).toBe('');
    stop();
    captureAgendaDeepLink(hereAt('#agenda/A9?session=sess-1'));
    expect(heard).toBe(1);
  });

  it('leaves any other fragment alone, and a held link until it is cleared', () => {
    captureAgendaDeepLink(hereAt('#join=abc'));
    expect(pendingAgendaDeepLink()).toBeNull();
    captureAgendaDeepLink(hereAt('#agenda/A8?session=sess-1'));
    clearAgendaDeepLink();
    expect(pendingAgendaDeepLink()).toBeNull();
  });
});

describe('opening the card', () => {
  function Probe({
    machines,
    navigate,
  }: {
    readonly machines: readonly AgendaInboxMachine[];
    readonly navigate: (to: string) => void;
  }) {
    useAgendaDeepLink(machines, navigate);
    return null;
  }

  it('goes to the inbox card on the machine that runs the session, once', async () => {
    const went: string[] = [];
    captureAgendaDeepLink(hereAt('#agenda/A8?session=sess-1'));
    const mounted = await mount(
      <Probe machines={[machine('a', ['x']), machine('b', ['sess-1'])]} navigate={to => went.push(to)} />,
    );
    try {
      expect(went).toHaveLength(1);
      expect(went[0]).toContain('session=sess-1');
      expect(went[0]).toContain('A8');
      expect(pendingAgendaDeepLink()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('waits while a machine has not been read, then goes when it has', async () => {
    const went: string[] = [];
    captureAgendaDeepLink(hereAt('#agenda/A8?session=sess-1'));
    const mounted = await mount(<Probe machines={[machine('a', null)]} navigate={to => went.push(to)} />);
    try {
      expect(went).toEqual([]);
      expect(pendingAgendaDeepLink()).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('drops a link no machine runs, and a link that names no session, without navigating', async () => {
    const went: string[] = [];
    captureAgendaDeepLink(hereAt('#agenda/A8?session=sess-9'));
    const stale = await mount(<Probe machines={[machine('a', ['x'])]} navigate={to => went.push(to)} />);
    try {
      expect(pendingAgendaDeepLink()).toBeNull();
    } finally {
      await stale.unmount();
    }
    captureAgendaDeepLink(hereAt('#agenda/A8'));
    const bare = await mount(<Probe machines={[machine('a', ['x'])]} navigate={to => went.push(to)} />);
    try {
      expect(pendingAgendaDeepLink()).toBeNull();
      expect(went).toEqual([]);
    } finally {
      await bare.unmount();
    }
  });

  it('does nothing when there is no link', async () => {
    const went: string[] = [];
    const mounted = await mount(<Probe machines={[machine('a', ['x'])]} navigate={to => went.push(to)} />);
    try {
      expect(went).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });
});
