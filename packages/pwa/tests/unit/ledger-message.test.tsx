import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  LedgerMessage,
  RESEND_RISK_COPY,
  runResendOnce,
  UNBOUND_SEND_COPY,
} from '../../src/components/ledger-message.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import {
  CANCELLED_ROW_LIFETIME_MS,
  isStuckSend,
  type LedgerBlockPlacement,
  ledgerPlacementCopy,
  placeLedgerRows,
  SETTLED_ROW_LIFETIME_MS,
} from '../../src/lib/ledger-placement.ts';
import { peerFrom } from '../../src/lib/peer-message.ts';
import { sendBadge } from '../../src/lib/send-badge.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { absoluteTime, type TranscriptEntry } from '../../src/lib/session-screens.ts';
import { actionKeys, actionsButton, chooseAction, hasActionsButton, openActions } from '../support/ledger-menu.ts';
import { render, runAsync } from '../support/react.ts';

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message: 'ship the tool group',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const textOf = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return walk((node as { children: unknown }).children);
    }
    return '';
  };
  return walk(renderer.toJSON());
};

const click = async (button: ReactTestInstance): Promise<void> => {
  await runAsync(async () => {
    button.props.onClick();
  });
};

const buttonLabelled = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && textOfNode(node) === label);

const textOfNode = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOfNode(child))).join('');

describe('sendBadge', () => {
  test('says only what the daemon proved, in five plain words', () => {
    expect(sendBadge(record()).label).toBe('sending');
    expect(sendBadge(record({ attempt: 2 })).detail).toContain('sending again (2 attempts)');
    expect(sendBadge(record({ fate: 'queued' })).label).toBe('queued');
    expect(sendBadge(record({ fate: 'queued' })).detail).toContain('its own queue');
    expect(sendBadge(record({ held: true })).label).toBe('held for revive');
    expect(sendBadge(record({ fate: 'delivered' }))).toMatchObject({
      label: 'delivered',
      tone: expect.stringContaining('ok'),
    });
  });

  test('names a proven absence "not delivered", and never dresses an unconfirmed send as an error', () => {
    const lost = sendBadge(record({ fate: 'timed_out', unaccountedReason: 'not_delivered', attempt: 2 }));
    const unsure = sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' }));

    expect(lost.label).toBe('not delivered');
    expect(lost.detail).toBe('timed out — it never reached the agent (2 attempts)');
    expect(sendBadge(record({ fate: 'timed_out' })).detail).toContain('(1 attempt)');
    expect(unsure.label).toBe('unconfirmed');
    expect(unsure.tone).not.toContain('err');
    expect(unsure.detail).toContain('transcript could not be read');
    expect(unsure.detail).toContain('may still have landed');
    expect(sendBadge(record({ fate: 'unaccounted' })).detail).toContain('arrival could not be checked');
    for (const reason of ['timeout', 'session_ended', 'composer_discarded', 'pane_unreadable'] as const)
      expect(sendBadge(record({ fate: 'unaccounted', unaccountedReason: reason })).detail.length).toBeGreaterThan(30);
    // A dialog on screen is named as what stopped it, not as an unreadable transcript.
    const blocked = sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'blocked_by_prompt' })).detail;
    expect(blocked).toContain('a prompt on the agent’s screen is waiting for an answer');
    expect(blocked).not.toContain('transcript');
  });
});

describe('sendBadge · typed, cancelled and merged', () => {
  test('says a message sitting in the composer is typed, not sent, and what the reader can do about it', () => {
    const badge = sendBadge(record({ typedNotSent: true }));
    expect(badge.label).toBe('typed, not sent');
    expect(badge.tone).toContain('warn');
    expect(badge.detail).toContain('sitting in the agent’s composer');
    expect(badge.detail).toContain('press Enter to send it or cancel it');
    expect(sendBadge(record({ fate: 'queued', typedNotSent: true })).label).toBe('typed, not sent');
    // A settled fate outranks it: a timed-out message is no longer waiting in a composer.
    expect(sendBadge(record({ fate: 'timed_out', typedNotSent: true })).label).toBe('not delivered');
  });

  test('says what a cancel did on the agent’s screen, in four plain sentences and one fallback', () => {
    const detail = (cancelEffect?: LedgerSendRecord['cancelEffect']) =>
      sendBadge(record({ fate: 'cancelled', ...(cancelEffect === undefined ? {} : { cancelEffect }) })).detail;
    expect(sendBadge(record({ fate: 'cancelled' })).label).toBe('cancelled');
    expect(sendBadge(record({ fate: 'cancelled' })).tone).not.toContain('err');
    expect(detail('cleared')).toBe('removed, and erased from the agent’s composer');
    expect(detail('not_in_pane')).toBe('removed; it never reached the agent');
    expect(detail('left_in_queue')).toContain('may still read it');
    expect(detail('left_in_composer')).toContain('the agent’s composer held other text too');
    expect(detail()).toBe('taken back; what that did on the agent’s screen is not known');
  });

  test('delivered joined with its neighbours says so, and an ordinary delivery does not', () => {
    const evidence = (tier: 'exact-text' | 'merged-text') => ({
      key: 'k',
      tier,
    });
    expect(sendBadge(record({ fate: 'delivered', evidence: evidence('merged-text') })).detail).toContain(
      'delivered joined with the message next to it',
    );
    expect(sendBadge(record({ fate: 'delivered', evidence: evidence('exact-text') })).detail).not.toContain('joined');
    expect(sendBadge(record({ fate: 'delivered' })).label).toBe('delivered');
  });
});

describe('isStuckSend', () => {
  const now = Date.parse('2026-07-31T10:05:00.000Z');

  test('counts what the reader can see waiting, and nothing proven, cancelled, held or retired', () => {
    const stuck = (overrides: Partial<LedgerSendRecord>) => isStuckSend(record(overrides), now);
    expect(stuck({})).toBe(true);
    expect(stuck({ fate: 'queued' })).toBe(true);
    expect(stuck({ typedNotSent: true })).toBe(true);
    expect(stuck({ fate: 'timed_out' })).toBe(true);
    expect(stuck({ fate: 'unaccounted' })).toBe(true);
    expect(stuck({ fate: 'delivered' })).toBe(false);
    expect(stuck({ fate: 'cancelled' })).toBe(false);
    expect(stuck({ held: true })).toBe(false);
    expect(stuck({ withdrawn: true })).toBe(false);
    // A settled row retires from view after a day, and so stops counting as something to clear.
    expect(stuck({ fate: 'timed_out', acceptedAt: new Date(now - SETTLED_ROW_LIFETIME_MS).toISOString() })).toBe(false);
    // An in-flight one never retires.
    expect(stuck({ acceptedAt: new Date(now - 3 * SETTLED_ROW_LIFETIME_MS).toISOString() })).toBe(true);
    expect(isStuckSend(record({ fate: 'timed_out' }))).toBe(false);
  });

  test('keeps a cancelled row for ten minutes after the cancel, so it can say what the cancel did', () => {
    const cancelled = record({
      sendId: 'c',
      fate: 'cancelled',
      cancelEffect: 'cleared',
      fateAt: new Date(now - CANCELLED_ROW_LIFETIME_MS + 1).toISOString(),
    });
    const retired = { ...cancelled, fateAt: new Date(now - CANCELLED_ROW_LIFETIME_MS).toISOString() };
    expect(placeLedgerRows([], [cancelled], now).map(entry => entry.id)).toEqual(['send:c']);
    expect(placeLedgerRows([], [retired], now)).toEqual([]);
  });
});

describe('placeLedgerRows', () => {
  const entries: TranscriptEntry[] = [
    { id: 'a', kind: 'user', text: 'continue' },
    { id: 'b', kind: 'assistant', text: 'done' },
    { id: 'c', kind: 'user', text: 'continue' },
    { id: 'd', kind: 'user', text: '[peer message from teammate nero]\nFYI\n\nthe rail landed' },
  ];
  const now = Date.parse('2026-07-31T10:05:00.000Z');

  test('chips the newest matching message for each delivered send, one to one', () => {
    const placed = placeLedgerRows(
      entries,
      [
        record({ sendId: 'old', fate: 'delivered', message: 'continue', acceptedAt: '2026-07-31T09:00:00.000Z' }),
        record({ sendId: 'new', fate: 'delivered', message: 'continue', acceptedAt: '2026-07-31T09:30:00.000Z' }),
        record({
          sendId: 'peer',
          fate: 'delivered',
          message: '[peer message from teammate nero]\nFYI\n\nthe rail landed',
        }),
        record({ sendId: 'off-page', fate: 'delivered', message: 'scrolled away' }),
      ],
      now,
    );

    expect(placed.map(entry => entry.send?.sendId)).toEqual(['old', undefined, 'new', 'peer']);
  });

  test('chips a message handed over through a file by the turn or send its pointer names', () => {
    const placed = placeLedgerRows(
      [
        {
          id: 't',
          kind: 'user',
          text: 'Read the file …',
          handoff: { kind: 'turn', name: 'turn-008', turn: 8, path: '/t' },
        },
        {
          id: 'q',
          kind: 'user',
          text: 'Read the queued message file …',
          handoff: { kind: 'queued', name: 'queued-send-q', sendId: 'send-q', path: '/q' },
        },
        {
          id: 'x',
          kind: 'user',
          text: 'look at this',
          handoff: { kind: 'turn', name: 'turn-009', turn: 9, path: '/x' },
        },
      ],
      [
        // The text matches the third row, but a hand-off row is matched by identity, never by text.
        record({ sendId: 'by-text', fate: 'delivered', message: 'look at this' }),
        record({ sendId: 'turn', fate: 'delivered', message: 'a long message', turn: 8 }),
        record({ sendId: 'send-q', fate: 'delivered', message: 'a queued one' }),
      ],
      now,
    );

    expect(placed.map(entry => entry.send?.sendId)).toEqual(['turn', 'send-q', undefined]);
  });

  test('puts every send not yet in the conversation after it, oldest first, and retires old failures', () => {
    const placed = placeLedgerRows(
      [],
      [
        record({ sendId: 'queued', fate: 'queued', acceptedAt: '2026-07-31T10:04:00.000Z' }),
        record({ sendId: 'sending', acceptedAt: '2026-07-31T10:03:00.000Z' }),
        record({ sendId: 'lost', fate: 'timed_out', acceptedAt: '2026-07-31T10:00:00.000Z' }),
        record({
          sendId: 'stale',
          fate: 'timed_out',
          acceptedAt: new Date(now - SETTLED_ROW_LIFETIME_MS).toISOString(),
        }),
        record({ sendId: 'undated', fate: 'unaccounted', acceptedAt: 'not a date' }),
        record({ sendId: 'gone', withdrawn: true }),
      ],
      now,
    );

    expect(placed.map(entry => entry.id)).toEqual(['send:undated', 'send:lost', 'send:sending', 'send:queued']);
    expect(placed[0]).toMatchObject({
      kind: 'ledger',
      placement: 'unknown-time',
      settled: 'slim',
      text: 'ship the tool group',
    });
  });
});

describe('peerFrom', () => {
  test('lifts the daemon banner off a peer message and reads whether a reply is expected', () => {
    const parked = peerFrom('[peer message from teammate freddie (session x)]\nPARKED until 30m\n\nis CI green?');

    expect(parked.from?.name).toBe('freddie');
    expect(parked.from?.replyExpected).toBe(true);
    expect(parked.body).toBe('is CI green?');
    expect(peerFrom('[peer message from an unknown shape]\nbody').from).toBeNull();
  });
});

describe('absoluteTime', () => {
  test('shows the exact instant, or an unparseable value verbatim', () => {
    expect(absoluteTime(new Date(2026, 6, 31, 9, 8, 7).toISOString())).toBe('2026-07-31 09:08:07');
    expect(absoluteTime('not a date')).toBe('not a date');
    expect(absoluteTime(undefined)).toBe('—');
  });
});

describe('ledgerPlacementCopy', () => {
  test('says out loud when a row is only at the history boundary', () => {
    const placements: readonly LedgerBlockPlacement[] = [
      'before-loaded',
      'after-loaded',
      'unknown-time',
      'chronological',
    ];

    expect(placements.map(ledgerPlacementCopy)).toEqual([
      'older than the loaded transcript · shown at the history boundary',
      'newer than the loaded transcript · shown at the history boundary',
      'time position unavailable · shown at the loaded-history boundary',
      undefined,
    ]);
  });
});

describe('runResendOnce', () => {
  test('lets one activation through and answers nothing to the one that raced it', async () => {
    const latch = { current: false };
    let release: (accepted: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });

    const first = runResendOnce(latch, () => pending);
    const second = await runResendOnce(latch, async () => true);
    release(true);

    expect(second).toBeUndefined();
    expect(await first).toBe(true);
    expect(latch.current).toBe(false);
  });
});

describe('sends inside the transcript', () => {
  test('chips a delivered message where it is, and carries a retry down to a send that never arrived', async () => {
    const attempts: Array<[string, boolean]> = [];
    const transcript = render(
      <Transcript
        daemonId="daemon-a"
        entries={[
          { id: 'said', kind: 'user', text: 'ship it', send: record({ fate: 'delivered', message: 'ship it' }) },
          {
            id: 'ledger-1',
            kind: 'ledger',
            text: 'a durable send attempt',
            ledger: record({ sendId: 'lost', fate: 'timed_out', retryable: true, unaccountedReason: 'not_delivered' }),
            placement: 'after-loaded',
          },
        ]}
        onRetry={async (attempted, force) => {
          attempts.push([attempted.sendId, force]);
          return true;
        }}
        sessionId="session-1"
      />,
    );

    expect(transcript.root.findByProps({ 'data-send-fate': 'delivered' })).toBeDefined();
    // A failed send keeps a word beside its mark, because it needs the reader; a delivered one never does.
    expect(transcript.root.findByProps({ 'data-send-chip': 'failed' }).children).toEqual(['not delivered']);
    expect(transcript.root.findAllByProps({ 'data-send-chip': 'delivered' })).toHaveLength(0);
    expect(textOf(transcript)).toContain('newer than the loaded transcript');
    expect(textOf(transcript)).not.toContain('a durable send attempt');

    await chooseAction(transcript, 'retry');

    expect(attempts).toEqual([['lost', false]]);
  });

  test('falls back to a text row when a ledger entry carries no record', () => {
    const transcript = render(
      <Transcript
        daemonId="daemon-a"
        entries={[{ id: 'ledger-2', kind: 'ledger', text: 'a send with no record' }]}
        sessionId="session-1"
      />,
    );

    expect(textOf(transcript)).toContain('Send ledger');
    expect(textOf(transcript)).toContain('a send with no record');
  });
});

describe('LedgerMessage', () => {
  test('shows who sent it and its receipt, and reads out the reason when the receipt is tapped', async () => {
    const row = render(
      <LedgerMessage
        record={record({
          message: '[peer message from teammate freddie]\nPARKED until 30m\n\nis CI green?',
          fate: 'queued',
        })}
      />,
    );

    expect(textOf(row)).toContain('Freddie sent:');
    expect(textOf(row)).toContain('is CI green?');
    expect(row.root.findAllByProps({ 'data-send-reason': '' })).toHaveLength(0);

    const receipt = row.root.findByProps({ 'data-send-receipt': 'queued' });
    expect(receipt.props['aria-label']).toMatch(/^Queued, sent .*\d{2}:\d{2}:\d{2}/u);
    await click(receipt);

    expect(row.root.findByProps({ 'data-send-reason': '' })).toBeDefined();
    expect(textOf(row)).toContain('will read it when its current turn ends');
    expect(row.root.findByProps({ 'data-ledger-placement': 'chronological' })).toBeDefined();
  });

  test('says a human sent it, marks a boundary row, and drops an empty prose block', () => {
    const human = render(<LedgerMessage record={record()} />);
    const boundary = render(<LedgerMessage placement="before-loaded" record={record()} />);
    const bodyless = render(
      <LedgerMessage record={record({ message: '[peer message from teammate nero]\nFYI\n\n' })} />,
    );

    expect(textOf(human)).toContain('You said:');
    expect(textOf(human)).toContain('checking that it reached the agent');
    expect(boundary.root.findByProps({ 'data-ledger-boundary': true })).toBeDefined();
    expect(bodyless.root.findAllByProps({ className: expect.stringContaining('kt-user-copy') })).toHaveLength(0);
  });

  test('offers no one-tap retry while a send is in flight, and no action at all once it was delivered', async () => {
    for (const fate of ['accepted', 'queued'] as const) {
      const row = render(<LedgerMessage onRetry={async () => true} record={record({ fate })} />);
      // The guarded "Send again" and Copy text — never a bare Retry that could send it twice.
      expect(await actionKeys(row)).toEqual(['send-again', 'copy']);
    }
    const settled = render(<LedgerMessage onRetry={async () => true} record={record({ fate: 'delivered' })} />);
    expect(hasActionsButton(settled)).toBe(false);
    const unprovable = render(
      <LedgerMessage
        onRetry={async () => true}
        record={record({ fate: 'timed_out', unaccountedReason: 'session_ended' })}
      />,
    );
    expect(await actionKeys(unprovable)).toEqual(['copy']);
  });

  test('retries a proven-absent send in one pick, under its own id, and says it is sending again', async () => {
    const attempts: Array<[string, boolean]> = [];
    const row = render(
      <LedgerMessage
        onRetry={async (attempted, force) => {
          attempts.push([attempted.sendId, force]);
          return true;
        }}
        record={record({ fate: 'timed_out', retryable: true })}
      />,
    );

    await chooseAction(row, 'retry');

    expect(attempts).toEqual([['send-1', false]]);
    expect(row.root.findByProps({ role: 'status' })).toBeDefined();
    expect(await actionKeys(row)).not.toContain('retry');
  });

  test('keeps "send again anyway" for an unconfirmed send behind a warning that says what it costs', async () => {
    const attempts: Array<[string, boolean]> = [];
    const row = render(
      <LedgerMessage
        onRetry={async (attempted, force) => {
          attempts.push([attempted.sendId, force]);
          return true;
        }}
        record={record({ fate: 'unaccounted', unaccountedReason: 'timeout' })}
      />,
    );

    expect(textOf(row)).not.toContain(RESEND_RISK_COPY);
    await chooseAction(row, 'send-again');
    expect(textOf(row)).toContain(RESEND_RISK_COPY);
    expect(attempts).toEqual([]);
    await click(buttonLabelled(row, 'Send again anyway'));

    expect(attempts).toEqual([['send-1', true]]);
  });

  test('offers no resend for a send whose session has no provable transcript, and says why', async () => {
    // The owner's Codex session: the agent answered in its pane, and nothing could ever confirm it.
    const row = render(
      <LedgerMessage
        onRetry={async () => true}
        record={record({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' })}
      />,
    );

    expect(textOf(row)).toContain(UNBOUND_SEND_COPY);
    expect(textOf(row)).not.toContain(RESEND_RISK_COPY);
    expect(await actionKeys(row)).toEqual(['copy']);
    expect(sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' })).detail).toContain(
      'can’t find a transcript it can prove is this session’s',
    );
  });

  test('drops "Sending again" once the attempt it described has settled, so it never sticks', async () => {
    const first = record({ fate: 'unaccounted', unaccountedReason: 'timeout' });
    const row = render(<LedgerMessage onRetry={async () => true} record={first} />);
    await chooseAction(row, 'send-again');
    await click(buttonLabelled(row, 'Send again anyway'));
    expect(textOf(row)).toContain('Sending again — this row updates');

    // Still in flight under the new attempt: the word stays.
    await runAsync(async () => {
      row.update(<LedgerMessage onRetry={async () => true} record={{ ...first, fate: 'accepted', attempt: 2 }} />);
    });
    expect(textOf(row)).toContain('Sending again — this row updates');

    // The new attempt settled unconfirmed: the row says that instead, and offers its own choice again.
    await runAsync(async () => {
      row.update(<LedgerMessage onRetry={async () => true} record={{ ...first, attempt: 2 }} />);
    });
    expect(textOf(row)).not.toContain('Sending again — this row updates');
    expect(await actionKeys(row)).toContain('send-again');
  });

  test('reports a refused or thrown retry as an alert and leaves the action for another try', async () => {
    const refused = render(<LedgerMessage onRetry={async () => false} record={record({ fate: 'unaccounted' })} />);
    await chooseAction(refused, 'send-again');
    await click(buttonLabelled(refused, 'Send again anyway'));
    const thrown = render(
      <LedgerMessage
        onRetry={async () => {
          throw new Error('the daemon is unreachable');
        }}
        record={record({ fate: 'timed_out', retryable: true })}
      />,
    );
    await chooseAction(thrown, 'retry');

    expect(refused.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(thrown.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(await actionKeys(thrown)).toContain('retry');
  });

  test('marks the button busy while a retry is in flight, so a double pick is one send', async () => {
    let release: (accepted: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const row = render(
      <LedgerMessage
        onRetry={() => {
          calls += 1;
          return pending;
        }}
        record={record({ fate: 'timed_out', retryable: true })}
      />,
    );

    await openActions(row);
    const again = row.root.find(node => node.type === 'button' && node.props['data-menu-key'] === 'retry').props
      .onClick;
    await runAsync(async () => {
      again();
    });

    expect(actionsButton(row).props['aria-busy']).toBe(true);
    expect(textOf(row)).toContain('Retrying…');

    await runAsync(async () => {
      again();
      release(true);
    });

    expect(calls).toBe(1);
  });
});
