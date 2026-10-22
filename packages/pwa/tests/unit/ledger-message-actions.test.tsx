import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { LedgerMessage, OPEN_RESEND_RISK_COPY, QUEUED_CANCEL_COPY } from '../../src/components/ledger-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import {
  actionKeys,
  actionsButton,
  chooseAction,
  hasActionsButton,
  openActions,
  closeOpenMenus,
} from '../support/ledger-menu.ts';
import { render, runAsync } from '../support/react.ts';

afterEach(closeOpenMenus);

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

const menuItem = (renderer: ReactTestRenderer, key: string): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && node.props['data-menu-key'] === key);

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
  test('a message still sending can be cancelled, sent again behind a warning, and copied', async () => {
    const row = render(<LedgerMessage {...handlers} record={record()} />);
    expect(await actionKeys(row)).toEqual(['send-again', 'cancel', 'copy']);
  });

  test('a message typed in the composer can have Enter pressed, and is NOT offered a retry the daemon would refuse', async () => {
    const row = render(<LedgerMessage {...handlers} record={record({ typedNotSent: true })} />);
    expect(await actionKeys(row)).toEqual(['enter', 'cancel', 'copy']);
    expect(textOfNode(menuItem(row, 'enter'))).toContain('Press Enter');
  });

  test('Press Enter is for a typed message only', async () => {
    const variants: Partial<LedgerSendRecord>[] = [{}, { fate: 'queued' }, { fate: 'timed_out' }];
    for (const overrides of variants) {
      const row = render(<LedgerMessage {...handlers} record={record(overrides)} />);
      expect(await actionKeys(row)).not.toContain('enter');
    }
    // Typed on a row that already settled is stale: the flag only means something while the row is open.
    const settled = render(<LedgerMessage {...handlers} record={record({ fate: 'timed_out', typedNotSent: true })} />);
    expect(await actionKeys(settled)).not.toContain('enter');
  });

  test('a proven-absent message keeps its one-tap Retry and its reason, and gains Cancel and Copy', async () => {
    const row = render(<LedgerMessage {...handlers} record={record({ fate: 'timed_out', retryable: true })} />);
    expect(await actionKeys(row)).toEqual(['retry', 'cancel', 'copy']);
    expect(textOfNode(menuItem(row, 'retry'))).toContain('It never arrived, so this cannot send it twice');
  });

  test('an unconfirmed message offers a guarded "Send again" and gains Cancel and Copy', async () => {
    const row = render(
      <LedgerMessage {...handlers} record={record({ fate: 'unaccounted', unaccountedReason: 'timeout' })} />,
    );
    expect(await actionKeys(row)).toEqual(['send-again', 'cancel', 'copy']);
  });

  test('a send nothing can confirm offers no resend at all', async () => {
    const row = render(
      <LedgerMessage {...handlers} record={record({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' })} />,
    );
    expect(await actionKeys(row)).toEqual(['cancel', 'copy']);
  });

  test('a delivered, cancelled or held message offers no way to take it back', async () => {
    const delivered = render(<LedgerMessage {...handlers} record={record({ fate: 'delivered' })} />);
    expect(await actionKeys(delivered)).toEqual([]);
    expect(hasActionsButton(delivered)).toBe(false);
    // Cancelled keeps Copy so cancelling never costs the words.
    const cancelled = render(
      <LedgerMessage {...handlers} record={record({ fate: 'cancelled', cancelEffect: 'cleared' })} />,
    );
    expect(await actionKeys(cancelled)).toEqual(['copy']);
    const held = render(<LedgerMessage {...handlers} record={record({ held: true })} />);
    expect(await actionKeys(held)).toEqual(['copy']);
  });

  test('lists Hide and Dismiss after the rest, only for what the page wired and never for a delivered one', async () => {
    const wired = { ...handlers, onCollapse: () => undefined, onDismiss: () => undefined };
    const cancelled = render(<LedgerMessage {...wired} record={record({ fate: 'cancelled' })} />);
    expect(await actionKeys(cancelled)).toEqual(['copy', 'hide', 'dismiss']);
    const dismissOnly = render(
      <LedgerMessage {...handlers} onDismiss={() => undefined} record={record({ fate: 'cancelled' })} />,
    );
    expect(await actionKeys(dismissOnly)).toEqual(['copy', 'dismiss']);
    const delivered = render(<LedgerMessage {...wired} record={record({ fate: 'delivered' })} />);
    expect(await actionKeys(delivered)).toEqual([]);
  });

  test('shows only the actions the page wired, and nothing for a bodyless message', async () => {
    expect(await actionKeys(render(<LedgerMessage record={record()} write={async () => {}} />))).toEqual(['copy']);
    expect(await actionKeys(render(<LedgerMessage onCancel={noop} record={record()} />))).toEqual(['cancel', 'copy']);
    const bodyless = render(
      <LedgerMessage record={record({ message: '[peer message from teammate nero]\nFYI\n\n' })} />,
    );
    expect(await actionKeys(bodyless)).toEqual([]);
    expect(hasActionsButton(bodyless)).toBe(false);
  });

  test('is ONE small labelled button, not a row of them, and each action says what it does', async () => {
    const row = render(<LedgerMessage {...handlers} record={record({ fate: 'queued' })} />);
    const button = actionsButton(row);
    expect(button.props['aria-label']).toBe('Message actions');
    expect(button.props['aria-haspopup']).toBe('menu');
    expect(button.props['aria-expanded']).toBe(false);
    // The receipt and the "⋯": nothing else is a button until the menu opens.
    expect(row.root.findAllByType('button')).toHaveLength(2);

    await openActions(row);
    expect(actionsButton(row).props['aria-expanded']).toBe(true);
    const send = textOfNode(menuItem(row, 'send-again'));
    expect(send).toContain('Send again');
    expect(send).toContain('May make a second copy');
  });

  test('says a queued message is only removed here, because the agent may still read it', async () => {
    const queued = render(<LedgerMessage {...handlers} record={record({ fate: 'queued' })} />);
    await openActions(queued);
    expect(textOf(queued)).toContain(QUEUED_CANCEL_COPY);
    const unqueued: Partial<LedgerSendRecord>[] = [{}, { typedNotSent: true }, { fate: 'queued', typedNotSent: true }];
    for (const overrides of unqueued) {
      const row = render(<LedgerMessage {...handlers} record={record(overrides)} />);
      await openActions(row);
      expect(textOf(row)).not.toContain(QUEUED_CANCEL_COPY);
    }
    // Without a Cancel to explain, the sentence is not drawn.
    const noCancel = render(<LedgerMessage record={record({ fate: 'queued' })} />);
    await openActions(noCancel);
    expect(textOf(noCancel)).not.toContain(QUEUED_CANCEL_COPY);
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
    await chooseAction(row, 'enter');
    await chooseAction(row, 'cancel');
    expect(calls).toEqual(['enter', 'cancel']);
  });
});

describe('Cancel and Press Enter', () => {
  test('cancel is one pick, with no confirm, and says the row will update', async () => {
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
    await chooseAction(row, 'cancel');
    expect(calls).toEqual(['send-1']);
    expect(row.root.findByProps({ role: 'status' })).toBeDefined();
    expect(textOf(row)).toContain('Cancel sent');
  });

  test('Press Enter is one pick and says the row will update when the agent has it', async () => {
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
    await chooseAction(row, 'enter');
    expect(calls).toEqual(['send-1']);
    expect(textOf(row)).toContain('Enter pressed');
  });

  test('shows the daemon’s own refusal sentence when an action fails, and keeps the action for another try', async () => {
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
    await chooseAction(enter, 'enter');
    expect(enter.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      'Enter was not pressed — the composer holds other text too',
    );
    expect(await actionKeys(enter)).toContain('enter');
    expect(actionsButton(enter).props['aria-busy']).toBeUndefined();

    const cancel = render(<LedgerMessage {...handlers} onCancel={refusal('  the pane is busy  ')} record={record()} />);
    await chooseAction(cancel, 'cancel');
    expect(textOf(cancel)).toContain('Cancel did not go through — the pane is busy');

    const retry = render(
      <LedgerMessage
        {...handlers}
        onRetry={refusal('it is still typed in the composer')}
        record={record({ fate: 'timed_out', retryable: true })}
      />,
    );
    await chooseAction(retry, 'retry');
    expect(textOf(retry)).toContain('The retry did not go through — it is still typed in the composer');
  });

  test('says "check this row" when the failure carried no sentence, or the page had no client', async () => {
    const refused = render(<LedgerMessage {...handlers} onCancel={async () => false} record={record()} />);
    await chooseAction(refused, 'cancel');
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
    await chooseAction(thrown, 'enter');
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
    await chooseAction(nonError, 'cancel');
    expect(textOf(nonError)).toContain('check this row before trying again.');
  });

  test('a double pick is one request, and the button says it is busy while it is in flight', async () => {
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
    await openActions(row);
    // A second activation that arrives after the menu has gone (a double tap) reaches the same handlers.
    const pickCancel = menuItem(row, 'cancel').props.onClick;
    const pickEnter = menuItem(row, 'enter').props.onClick;
    await runAsync(async () => {
      pickCancel();
    });
    expect(actionsButton(row).props['aria-busy']).toBe(true);
    expect(row.root.findByProps({ 'data-ledger-busy': '' }).children.join('')).toBe('Cancelling…');
    await runAsync(async () => {
      pickCancel();
      pickEnter();
      release(true);
    });
    expect(calls).toBe(1);
    expect(actionsButton(row).props['aria-busy']).toBeUndefined();
    expect(row.root.findAllByProps({ 'data-ledger-busy': '' })).toHaveLength(0);
  });

  test('Enter says "Pressing Enter…" while it runs', async () => {
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
    await chooseAction(row, 'enter');
    expect(textOf(row)).toContain('Pressing Enter…');
    await runAsync(async () => {
      release(true);
    });
  });
});

describe('Send again on a message that is still open', () => {
  test('opens a confirm that says it may already be on its way, and forces the retry only when confirmed', async () => {
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
    await chooseAction(row, 'send-again');
    // Picking the item is NOT a send: it only opens the warning.
    expect(textOf(row)).toContain(OPEN_RESEND_RISK_COPY);
    expect(attempts).toEqual([]);
    await tap(buttonLabelled(row, 'Send again anyway'));
    expect(attempts).toEqual([['send-1', true]]);
    expect(textOf(row)).toContain('Sending again — this row updates');
    expect(await actionKeys(row)).not.toContain('send-again');
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
    await chooseAction(row, 'send-again');
    await tap(buttonLabelled(row, 'Keep waiting'));
    expect(textOf(row)).not.toContain(OPEN_RESEND_RISK_COPY);
    await chooseAction(row, 'send-again');
    expect(textOf(row)).toContain(OPEN_RESEND_RISK_COPY);
    await tap(buttonLabelled(row, 'Keep waiting'));
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
    await chooseAction(row, 'send-again');
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
    await chooseAction(row, 'send-again');
    await runAsync(async () => {
      buttonLabelled(row, 'Send again anyway').props.onClick();
    });
    expect(buttonLabelled(row, 'sending…').props.disabled).toBe(true);
    expect(actionsButton(row).props['aria-busy']).toBe(true);
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
    await openActions(row);
    expect(textOfNode(menuItem(row, 'copy'))).toContain('Copy text');
    await tap(menuItem(row, 'copy'));
    expect(written).toEqual(['is CI green?']);
    expect(row.root.findByProps({ role: 'status' }).children.join('')).toBe('Copied');
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
    await chooseAction(row, 'copy');
    expect(textOf(row)).toContain('Copy was blocked — select the text instead');
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
      await chooseAction(row, 'copy');
      expect(written).toEqual(['ship the tool group']);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'navigator');
      else Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});
