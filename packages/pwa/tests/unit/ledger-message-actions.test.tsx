import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { LedgerMessage, OPEN_RESEND_RISK_COPY, QUEUED_CANCEL_COPY } from '../../src/components/ledger-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { render, runAsync } from '../support/react.ts';

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message: 'ship the tool group',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const textOfNode = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOfNode(child))).join('');

const textOf = (renderer: ReactTestRenderer): string => textOfNode(renderer.root);

const labels = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll(node => node.type === 'button' && node.props['data-ledger-action'] !== undefined)
    .map(textOfNode);

const action = (renderer: ReactTestRenderer, name: string): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && node.props['data-ledger-action'] === name);

const maybeAction = (renderer: ReactTestRenderer, name: string): ReactTestInstance[] =>
  renderer.root.findAll(node => node.type === 'button' && node.props['data-ledger-action'] === name);

const buttonLabelled = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && textOfNode(node) === label);

const tap = async (button: ReactTestInstance): Promise<void> => {
  await runAsync(async () => {
    button.props.onClick();
  });
};

const noop = async (): Promise<boolean> => true;
const handlers = { onCancel: noop, onRetry: noop, onSubmit: noop, write: async () => {} };

describe('which actions a message offers', () => {
  test('a message still sending can be cancelled, retried behind a warning, and copied', () => {
    const row = render(<LedgerMessage {...handlers} record={record()} />);
    expect(labels(row)).toEqual(['Retry…', 'Cancel', 'Copy text']);
  });

  test('a message typed in the composer can have Enter pressed, and is NOT offered a retry the daemon would refuse', () => {
    const row = render(<LedgerMessage {...handlers} record={record({ typedNotSent: true })} />);
    expect(labels(row)).toEqual(['Press Enter', 'Cancel', 'Copy text']);
    expect(maybeAction(row, 'retry-open')).toHaveLength(0);
    expect(action(row, 'enter').props['data-variant']).toBe('primary');
  });

  test('Press Enter is for a typed message only', () => {
    const variants: Partial<LedgerSendRecord>[] = [{}, { fate: 'queued' }, { fate: 'timed_out' }];
    for (const overrides of variants) {
      const row = render(<LedgerMessage {...handlers} record={record(overrides)} />);
      expect(maybeAction(row, 'enter')).toHaveLength(0);
    }
    // Typed on a row that already settled is stale: the flag only means something while the row is open.
    const settled = render(<LedgerMessage {...handlers} record={record({ fate: 'timed_out', typedNotSent: true })} />);
    expect(maybeAction(settled, 'enter')).toHaveLength(0);
  });

  test('a proven-absent message keeps its one-tap Retry and its reason, and gains Cancel and Copy', () => {
    const row = render(<LedgerMessage {...handlers} record={record({ fate: 'timed_out', retryable: true })} />);
    expect(labels(row)).toEqual(['Retry', 'Cancel', 'Copy text']);
    expect(textOf(row)).toContain('it never arrived, so this cannot send it twice');
  });

  test('an unconfirmed message keeps its "send again…" disclosure and gains Cancel and Copy', () => {
    const row = render(
      <LedgerMessage {...handlers} record={record({ fate: 'unaccounted', unaccountedReason: 'timeout' })} />,
    );
    expect(labels(row)).toEqual(['Cancel', 'Copy text']);
    expect(textOf(row)).toContain('send again…');
  });

  test('a delivered, cancelled or held message offers no way to take it back', () => {
    const delivered = render(<LedgerMessage {...handlers} record={record({ fate: 'delivered' })} />);
    expect(labels(delivered)).toEqual([]);
    // Cancelled keeps Copy so cancelling never costs the words.
    const cancelled = render(
      <LedgerMessage {...handlers} record={record({ fate: 'cancelled', cancelEffect: 'cleared' })} />,
    );
    expect(labels(cancelled)).toEqual(['Copy text']);
    const held = render(<LedgerMessage {...handlers} record={record({ held: true })} />);
    expect(labels(held)).toEqual(['Copy text']);
  });

  test('shows only the actions the page wired, and nothing for a bodyless message', () => {
    expect(labels(render(<LedgerMessage record={record()} write={async () => {}} />))).toEqual(['Copy text']);
    expect(labels(render(<LedgerMessage onCancel={noop} record={record()} />))).toEqual(['Cancel', 'Copy text']);
    const bodyless = render(
      <LedgerMessage record={record({ message: '[peer message from teammate nero]\nFYI\n\n' })} />,
    );
    expect(labels(bodyless)).toEqual([]);
    expect(bodyless.root.findAllByProps({ 'data-ledger-actions': '' })).toHaveLength(0);
  });

  test('says a queued message is only removed here, because the agent may still read it', () => {
    const queued = render(<LedgerMessage {...handlers} record={record({ fate: 'queued' })} />);
    expect(textOf(queued)).toContain(QUEUED_CANCEL_COPY);
    const unqueued: Partial<LedgerSendRecord>[] = [{}, { typedNotSent: true }, { fate: 'queued', typedNotSent: true }];
    for (const overrides of unqueued) {
      expect(textOf(render(<LedgerMessage {...handlers} record={record(overrides)} />))).not.toContain(
        QUEUED_CANCEL_COPY,
      );
    }
    // Without a Cancel to explain, the sentence is not drawn.
    expect(textOf(render(<LedgerMessage record={record({ fate: 'queued' })} />))).not.toContain(QUEUED_CANCEL_COPY);
  });

  test('the transcript row carries the page’s handlers down to a ledger row', async () => {
    const calls: string[] = [];
    const row = render(
      <TranscriptRow
        entry={{
          id: 'l',
          kind: 'ledger',
          text: 'x',
          ledger: record({ typedNotSent: true }),
          placement: 'chronological',
        }}
        onCancel={async () => void calls.push('cancel') as never}
        onSubmit={async () => {
          calls.push('enter');
          return true;
        }}
      />,
    );
    await tap(action(row, 'enter'));
    await tap(action(row, 'cancel'));
    expect(calls).toEqual(['enter', 'cancel']);
  });
});

describe('Cancel and Press Enter', () => {
  test('cancel is one tap, with no confirm, and says the row will update', async () => {
    const calls: string[] = [];
    const row = render(
      <LedgerMessage
        {...handlers}
        onCancel={async attempted => {
          calls.push(attempted.sendId);
          return true;
        }}
        record={record({ typedNotSent: true })}
      />,
    );
    await tap(action(row, 'cancel'));
    expect(calls).toEqual(['send-1']);
    expect(row.root.findByProps({ role: 'status' })).toBeDefined();
    expect(textOf(row)).toContain('Cancel sent');
  });

  test('Press Enter is one tap and says the row will update when the agent has it', async () => {
    const calls: string[] = [];
    const row = render(
      <LedgerMessage
        {...handlers}
        onSubmit={async attempted => {
          calls.push(attempted.sendId);
          return true;
        }}
        record={record({ typedNotSent: true })}
      />,
    );
    await tap(action(row, 'enter'));
    expect(calls).toEqual(['send-1']);
    expect(textOf(row)).toContain('Enter pressed');
  });

  test('shows the daemon’s own refusal sentence when an action fails, and keeps the control for another try', async () => {
    const refusal = (message: string) => async (): Promise<boolean> => {
      throw new Error(message);
    };
    const enter = render(
      <LedgerMessage
        {...handlers}
        onSubmit={refusal('the composer holds other text too')}
        record={record({ typedNotSent: true })}
      />,
    );
    await tap(action(enter, 'enter'));
    expect(enter.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      'Enter was not pressed — the composer holds other text too',
    );
    expect(action(enter, 'enter').props.disabled).toBe(false);

    const cancel = render(<LedgerMessage {...handlers} onCancel={refusal('  the pane is busy  ')} record={record()} />);
    await tap(action(cancel, 'cancel'));
    expect(textOf(cancel)).toContain('Cancel did not go through — the pane is busy');

    const retry = render(
      <LedgerMessage
        {...handlers}
        onRetry={refusal('it is still typed in the composer')}
        record={record({ fate: 'timed_out', retryable: true })}
      />,
    );
    await tap(action(retry, 'retry'));
    expect(textOf(retry)).toContain('The retry did not go through — it is still typed in the composer');
  });

  test('says "check this row" when the failure carried no sentence, or the page had no client', async () => {
    const refused = render(<LedgerMessage {...handlers} onCancel={async () => false} record={record()} />);
    await tap(action(refused, 'cancel'));
    expect(textOf(refused)).toContain('Cancel did not go through — check this row before trying again.');
    const thrown = render(
      <LedgerMessage
        {...handlers}
        onSubmit={async () => {
          throw new Error('   ');
        }}
        record={record({ typedNotSent: true })}
      />,
    );
    await tap(action(thrown, 'enter'));
    expect(textOf(thrown)).toContain('Enter was not pressed — check this row before trying again.');
    const nonError = render(
      <LedgerMessage
        {...handlers}
        onCancel={async () => {
          throw 'plain string';
        }}
        record={record()}
      />,
    );
    await tap(action(nonError, 'cancel'));
    expect(textOf(nonError)).toContain('check this row before trying again.');
  });

  test('a double tap is one request, and every control is disabled while it is in flight', async () => {
    let release: (accepted: boolean) => void = () => {};
    const pending = new Promise<boolean>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const row = render(
      <LedgerMessage
        {...handlers}
        onCancel={() => {
          calls += 1;
          return pending;
        }}
        record={record({ typedNotSent: true })}
      />,
    );
    await runAsync(async () => {
      action(row, 'cancel').props.onClick();
    });
    expect(textOfNode(action(row, 'cancel'))).toBe('cancelling…');
    expect(action(row, 'cancel').props.disabled).toBe(true);
    expect(action(row, 'enter').props.disabled).toBe(true);
    await runAsync(async () => {
      action(row, 'cancel').props.onClick();
      action(row, 'enter').props.onClick();
      release(true);
    });
    expect(calls).toBe(1);
    expect(action(row, 'cancel').props.disabled).toBe(false);
  });

  test('Enter shows "pressing…" while it runs', async () => {
    let release: (accepted: boolean) => void = () => {};
    const row = render(
      <LedgerMessage
        {...handlers}
        onSubmit={() =>
          new Promise<boolean>(resolve => {
            release = resolve;
          })
        }
        record={record({ typedNotSent: true })}
      />,
    );
    await runAsync(async () => {
      action(row, 'enter').props.onClick();
    });
    expect(textOfNode(action(row, 'enter'))).toBe('pressing…');
    await runAsync(async () => {
      release(true);
    });
  });
});

describe('Retry on a message that is still open', () => {
  test('is behind a confirm that says it may already be on its way, and forces the retry only when confirmed', async () => {
    const attempts: Array<[string, boolean]> = [];
    const row = render(
      <LedgerMessage
        {...handlers}
        onRetry={async (attempted, force) => {
          attempts.push([attempted.sendId, force]);
          return true;
        }}
        record={record({ fate: 'queued' })}
      />,
    );
    expect(textOf(row)).not.toContain(OPEN_RESEND_RISK_COPY);
    await tap(action(row, 'retry-open'));
    expect(action(row, 'retry-open').props['aria-expanded']).toBe(true);
    expect(textOf(row)).toContain(OPEN_RESEND_RISK_COPY);
    expect(attempts).toEqual([]);
    await tap(buttonLabelled(row, 'Send again anyway'));
    expect(attempts).toEqual([['send-1', true]]);
    expect(textOf(row)).toContain('Sending again — this row updates');
    expect(maybeAction(row, 'retry-open')).toHaveLength(0);
  });

  test('can be talked out of: "Keep waiting" closes the warning without sending anything', async () => {
    let sent = 0;
    const row = render(
      <LedgerMessage
        {...handlers}
        onRetry={async () => {
          sent += 1;
          return true;
        }}
        record={record()}
      />,
    );
    await tap(action(row, 'retry-open'));
    await tap(buttonLabelled(row, 'Keep waiting'));
    expect(textOf(row)).not.toContain(OPEN_RESEND_RISK_COPY);
    await tap(action(row, 'retry-open'));
    await tap(action(row, 'retry-open'));
    expect(textOf(row)).not.toContain(OPEN_RESEND_RISK_COPY);
    expect(sent).toBe(0);
  });

  test('keeps the warning open and shows the daemon’s refusal when the forced retry is refused', async () => {
    const row = render(
      <LedgerMessage
        {...handlers}
        onRetry={async () => {
          throw new Error('the agent is holding it in its own queue');
        }}
        record={record({ fate: 'queued' })}
      />,
    );
    await tap(action(row, 'retry-open'));
    await tap(buttonLabelled(row, 'Send again anyway'));
    expect(textOf(row)).toContain('The retry did not go through — the agent is holding it in its own queue');
    expect(textOf(row)).toContain(OPEN_RESEND_RISK_COPY);
  });

  test('disables the confirm while the forced retry is in flight', async () => {
    let release: (accepted: boolean) => void = () => {};
    const row = render(
      <LedgerMessage
        {...handlers}
        onRetry={() =>
          new Promise<boolean>(resolve => {
            release = resolve;
          })
        }
        record={record()}
      />,
    );
    await tap(action(row, 'retry-open'));
    await runAsync(async () => {
      buttonLabelled(row, 'Send again anyway').props.onClick();
    });
    expect(buttonLabelled(row, 'sending…').props.disabled).toBe(true);
    expect(action(row, 'retry-open').props.disabled).toBe(true);
    await runAsync(async () => {
      release(true);
    });
  });
});

describe('Copy text', () => {
  test('writes the message body — not a teammate’s banner — and acknowledges with "Copied"', async () => {
    const written: string[] = [];
    const row = render(
      <LedgerMessage
        record={record({ message: '[peer message from teammate freddie]\nPARKED until 30m\n\nis CI green?' })}
        write={async text => void written.push(text)}
      />,
    );
    expect(textOfNode(action(row, 'copy'))).toBe('Copy text');
    await tap(action(row, 'copy'));
    expect(written).toEqual(['is CI green?']);
    expect(textOfNode(action(row, 'copy'))).toBe('Copied');
    expect(action(row, 'copy').props['data-copy-state']).toBe('copied');
  });

  test('says so, in words, when the clipboard refuses', async () => {
    const row = render(
      <LedgerMessage
        record={record()}
        write={async () => {
          throw new Error('blocked');
        }}
      />,
    );
    await tap(action(row, 'copy'));
    expect(textOf(row)).toContain('Copy was blocked — select the text instead');
    expect(textOfNode(action(row, 'copy'))).toBe('Copy text');
  });

  test('defaults to the browser clipboard', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const written: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => void written.push(text) } },
    });
    try {
      const row = render(<LedgerMessage record={record()} />);
      await tap(action(row, 'copy'));
      expect(written).toEqual(['ship the tool group']);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'navigator');
      else Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});
