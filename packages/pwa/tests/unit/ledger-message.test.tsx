import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { LedgerMessage, RESEND_RISK_COPY, runResendOnce } from '../../src/components/ledger-message.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { type LedgerBlockPlacement, ledgerPlacementCopy } from '../../src/lib/ledger-placement.ts';
import { peerFrom } from '../../src/lib/peer-message.ts';
import { sendBadge } from '../../src/lib/send-badge.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { absoluteTime } from '../../src/lib/session-screens.ts';
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

describe('sendBadge', () => {
  test('never dresses an unconfirmed send as an error, and names why it is unconfirmed', () => {
    const timedOut = sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'timeout' }));

    expect(timedOut.label).toBe('unconfirmed');
    expect(timedOut.tone).not.toContain('err');
    expect(timedOut.detail).toContain('may still have landed');

    expect(sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'session_ended' })).detail).toContain(
      'the session ended',
    );
    expect(sendBadge(record({ fate: 'unaccounted', unaccountedReason: 'composer_discarded' })).detail).toContain(
      'interrupted',
    );
    expect(sendBadge(record({ fate: 'unaccounted' })).detail).toContain('may still have landed');
  });

  test('claims delivery only when the harness transcript proves it', () => {
    const badge = sendBadge(record({ fate: 'delivered' }));

    expect(badge.label).toBe('delivered');
    expect(badge.tone).toContain('ok');
    expect(badge.detail).toContain('confirms');
  });

  test('separates a held row from one the harness has yet to read', () => {
    expect(sendBadge(record({ held: true })).label).toBe('held for revive');
  });

  test('promises the harness queue only on a native queue path that still has a turn coming', () => {
    expect(sendBadge(record({ path: 'native-inline' })).label).toBe('queued for next turn');
    expect(sendBadge(record({ path: 'native-file' })).label).toBe('queued for next turn');
    expect(sendBadge(record({ path: 'native-inline', opportunityAt: '2026-07-31T10:01:00.000Z' })).label).toBe(
      'accepted — awaiting confirmation',
    );
    expect(sendBadge(record({ path: 'direct' })).label).toBe('accepted — awaiting confirmation');
  });
});

describe('peerFrom', () => {
  test('lifts the daemon banner off a peer message and reads whether a reply is expected', () => {
    const parked = peerFrom('[peer message from teammate freddie (session x)]\nPARKED until 30m\n\nis CI green?');

    expect(parked.from?.name).toBe('freddie');
    expect(parked.from?.replyExpected).toBe(true);
    expect(parked.body).toBe('is CI green?');

    const informational = peerFrom('[peer message from teammate nero]\nFYI\n\nthe rail landed');

    expect(informational.from?.replyExpected).toBe(false);
    expect(informational.body).toBe('the rail landed');
  });

  test('leaves an unrecognised banner in the body rather than half-stripping it', () => {
    const human = peerFrom('[peer message from an unknown shape]\nbody');

    expect(human.from).toBeNull();
    expect(human.body).toBe('[peer message from an unknown shape]\nbody');
  });
});

describe('absoluteTime', () => {
  test('shows the exact instant a ledger row was accepted', () => {
    const at = new Date(2026, 6, 31, 9, 8, 7);

    expect(absoluteTime(at.toISOString())).toBe('2026-07-31 09:08:07');
  });

  test('shows an unparseable value verbatim instead of hiding the skew that produced it', () => {
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

describe('a ledger row inside the transcript', () => {
  test('renders the durable attempt where it happened, and carries the resend down to it', async () => {
    const attempts: string[] = [];
    const transcript = render(
      <Transcript
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        daemonId="daemon-a"
        entries={[
          { id: 'said', kind: 'user', text: 'ship it' },
          {
            id: 'ledger-1',
            kind: 'ledger',
            text: 'a durable send attempt',
            ledger: record({ fate: 'unaccounted', unaccountedReason: 'timeout' }),
            placement: 'after-loaded',
          },
        ]}
        onResend={async attempted => {
          attempts.push(attempted.sendId);
          return true;
        }}
        sessionId="session-1"
      />,
    );

    const row = transcript.root.findByProps({ 'data-transcript-kind': 'ledger' });

    expect(textOf(transcript)).toContain('unconfirmed');
    expect(textOf(transcript)).toContain('newer than the loaded transcript');
    // The row must NOT fall back to the plain text line: `text` is the summary
    // the entry carries for a reader that cannot render the bubble.
    expect(textOf(transcript)).not.toContain('a durable send attempt');

    await click(row.findByType('button'));

    expect(attempts).toEqual(['send-1']);
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
  test('shows who sent it, when it was accepted, and the badge for its fate', () => {
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        record={record({
          message: '[peer message from teammate freddie]\nPARKED until 30m\n\nis CI green?',
          path: 'native-inline',
        })}
      />,
    );

    expect(textOf(row)).toContain('Freddie sent:');
    expect(textOf(row)).toContain('is CI green?');
    expect(textOf(row)).toContain('queued for next turn');
    expect(row.root.findByProps({ 'data-ledger-placement': 'chronological' })).toBeDefined();
  });

  test('says a human sent it when there is no peer banner, and carries the detail for a reader who cannot see colour', () => {
    const row = render(<LedgerMessage asOf={Date.parse('2026-07-31T10:00:30.000Z')} record={record()} />);

    expect(textOf(row)).toContain('You said:');
    expect(textOf(row)).toContain('stored durably');
  });

  test('marks a row that is only at the loaded-history boundary', () => {
    const row = render(
      <LedgerMessage asOf={Date.parse('2026-07-31T10:00:30.000Z')} placement="before-loaded" record={record()} />,
    );

    expect(row.root.findByProps({ 'data-ledger-boundary': true })).toBeDefined();
    expect(textOf(row)).toContain('older than the loaded transcript');
  });

  test('renders a body-less row without an empty prose block', () => {
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        record={record({ message: '[peer message from teammate nero]\nFYI\n\n' })}
      />,
    );

    expect(row.root.findAllByProps({ className: expect.stringContaining('kt-user-copy') })).toHaveLength(0);
  });

  test('offers no resend at all until a send is unconfirmed', () => {
    const row = render(
      <LedgerMessage asOf={Date.parse('2026-07-31T10:00:30.000Z')} onResend={async () => true} record={record()} />,
    );

    expect(row.root.findAllByType('button')).toHaveLength(0);
  });

  test('keeps the duplicate risk behind a disclosure and reports an accepted resend', async () => {
    const attempts: string[] = [];
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        onResend={async attempted => {
          attempts.push(attempted.sendId);
          return true;
        }}
        record={record({ fate: 'unaccounted', unaccountedReason: 'timeout' })}
      />,
    );

    expect(textOf(row)).toContain(RESEND_RISK_COPY);
    await click(row.root.findByType('button'));

    expect(attempts).toEqual(['send-1']);
    expect(row.root.findByProps({ role: 'status' })).toBeDefined();
    expect(textOf(row)).toContain('The original remains unconfirmed');
    // The disclosure is gone once a fresh attempt was accepted: a second one
    // would be a third copy of the same message.
    expect(row.root.findAllByType('button')).toHaveLength(0);
  });

  test('reports a refused resend as an alert and leaves the disclosure open for another try', async () => {
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        onResend={async () => false}
        record={record({ fate: 'unaccounted' })}
      />,
    );

    await click(row.root.findByType('button'));

    expect(row.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(row.root.findAllByType('button')).toHaveLength(1);
  });

  test('treats a thrown resend exactly as a refused one', async () => {
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        onResend={async () => {
          throw new Error('the daemon is unreachable');
        }}
        record={record({ fate: 'unaccounted' })}
      />,
    );

    await click(row.root.findByType('button'));

    expect(row.root.findByProps({ role: 'alert' })).toBeDefined();
  });

  test('disables the button while a resend is in flight, so a double tap is one send', async () => {
    let release: (accepted: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const row = render(
      <LedgerMessage
        asOf={Date.parse('2026-07-31T10:00:30.000Z')}
        onResend={() => {
          calls += 1;
          return pending;
        }}
        record={record({ fate: 'unaccounted' })}
      />,
    );

    await runAsync(async () => {
      row.root.findByType('button').props.onClick();
    });

    expect(row.root.findByType('button').props.disabled).toBe(true);
    expect(textOf(row)).toContain('resending…');

    await runAsync(async () => {
      row.root.findByType('button').props.onClick();
      release(true);
    });

    expect(calls).toBe(1);
  });
});
