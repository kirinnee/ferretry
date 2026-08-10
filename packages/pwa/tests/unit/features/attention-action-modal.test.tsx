/**
 * The focused Attention action surface (rows 8, 10, 17).
 *
 * WHAT THIS SURFACE PROMISES, and therefore what is asserted here:
 *
 *   ONE ASK AT A TIME  — the reader is shown what it is, why it matters now,
 *                        what should happen, and then nothing but valid actions.
 *   THE DAEMON DECIDES — a respond/resolve/dismiss returns the daemon's own
 *                        snapshot, and the addressed item leaves this deck in
 *                        the same render. Nothing is removed optimistically.
 *   ABSENCE IS LOUD    — a ledger that could not be read says so instead of
 *                        rendering an all-clear, which is the one wrong answer.
 */

import type { AttentionItem, AttentionResponse, AttentionSnapshot } from '@ferretry/protocol';
import { beforeEach, describe, expect, it } from 'bun:test';
import { useLayoutEffect } from 'react';

import {
  type AttentionActionClient,
  AttentionActionModal,
  AttentionActionTrigger,
} from '../../../src/features/attention/attention-action-modal.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import type { AttentionLoadStatus } from '../../../src/lib/attention-store.ts';
import { interact, mount, must } from '../../support/dom.ts';

const installMatchMedia = (): void => {
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
};

beforeEach(installMatchMedia);

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const scope = daemonSessionScope(connection, 'sess-1');

const item = (overrides: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'A3',
    source: 'agent-raised',
    sourceRef: null,
    sourceSeq: 1,
    subject: 'Approve the pairing request',
    why: 'The device needs a signed pairing record before it can load session data.',
    context: 'The daemon has been holding this since the sweep.',
    waitingSince: '2026-07-31T11:30:00.000Z',
    howToResolve: 'Approve to let this browser reach the paired daemon.',
    ask: { kind: 'permission' },
    raisedBy: 'agent',
    raisedBySession: 'sess-1',
    raisedByName: 'zoe',
    ...overrides,
  }) as AttentionItem;

const snapshot = (overrides: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  v: 1,
  sessionId: 'sess-1',
  items: [item()],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-07-31T12:00:00.000Z',
  ...overrides,
});

interface RecordedCall {
  readonly kind: 'respond' | 'resolve' | 'dismiss';
  readonly id: string;
  readonly response?: AttentionResponse;
}

const client = (calls: RecordedCall[], fail?: string): AttentionActionClient & { readonly calls: RecordedCall[] } => {
  const answer = async (): Promise<void> => {
    if (fail !== undefined) throw new Error(fail);
  };
  return {
    calls,
    respond: async (_daemon, _scope, id, response) => {
      calls.push({ kind: 'respond', id, response });
      return await answer();
    },
    resolve: async (_daemon, _scope, id) => {
      calls.push({ kind: 'resolve', id });
      return await answer();
    },
    dismiss: async (_daemon, _scope, id) => {
      calls.push({ kind: 'dismiss', id });
      return await answer();
    },
  };
};

const modal = async (props: {
  snapshot: AttentionSnapshot | null;
  status?: AttentionLoadStatus;
  targetId?: string | null;
  open?: boolean;
  swipeEnabled?: boolean;
  client?: AttentionActionClient;
  onClose?: () => void;
}) =>
  await mount(
    <AttentionActionModal
      client={props.client ?? client([])}
      connection={connection}
      id="attention-sheet"
      onClose={props.onClose ?? (() => undefined)}
      open={props.open ?? true}
      scope={scope}
      snapshot={props.snapshot}
      status={props.status ?? (props.snapshot === null ? 'loading' : 'ready')}
      swipeEnabled={props.swipeEnabled ?? false}
      targetId={(props.targetId ?? null) as never}
    />,
  );

/** What the dialog said on the commit that a reader is first handed. */
interface CommittedDialog {
  /** The `aria-labelledby` text — what a screen reader announces for the sheet. */
  readonly label: string;
  readonly text: string;
  readonly approveControls: number;
}

/**
 * Reads the sheet from a LAYOUT effect, which is exactly where `BottomSheet`
 * installs the dialog's focus — so this is the dialog as the first commit
 * exposes it, with no passive effect awaited and none yet run.
 */
const DialogLayoutProbe = ({ into }: { readonly into: CommittedDialog[] }) => {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sink is a stable array the test owns, and this probe must read the FIRST commit exactly once
  useLayoutEffect(() => {
    const panel = must(document.getElementById('attention-sheet'), 'the sheet panel at layout time');
    const labelId = must(panel.getAttribute('aria-labelledby'), 'the dialog label id');
    into.push({
      label: must(document.getElementById(labelId), 'the dialog label').textContent ?? '',
      text: panel.textContent ?? '',
      approveControls: Array.from(panel.querySelectorAll('button')).filter(button =>
        button.textContent?.includes('Approve'),
      ).length,
    });
  }, []);
  return null;
};

const buttonNamed = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(label)),
    `the “${label}” button`,
  );

describe('AttentionActionTrigger', () => {
  it('states the outstanding count, and stays honest while the ledger is unread', async () => {
    const openers: (HTMLElement | null)[] = [];
    const view = await mount(
      <AttentionActionTrigger
        id="attn-trigger"
        controls="attention-sheet"
        count={3}
        expanded={false}
        onOpen={element => openers.push(element)}
      />,
    );
    const trigger = must(view.container.querySelector('button'), 'the trigger');

    expect(trigger.getAttribute('aria-label')).toBe('Answer attention (3)');
    expect(trigger.getAttribute('aria-controls')).toBe('attention-sheet');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-active')).toBe('true');
    // The opener is handed back so the sheet's host can return focus here.
    await interact(() => trigger.click());
    expect(openers).toEqual([trigger]);

    await view.render(
      <AttentionActionTrigger
        id="attn-trigger"
        controls="attention-sheet"
        count={0}
        loading
        expanded
        onOpen={() => undefined}
      />,
    );
    // Loading is NOT zero. A badge that reads "0" before the board was read
    // would be a claim the app cannot make yet.
    expect(must(view.container.querySelector('button'), 'the trigger').getAttribute('aria-label')).toBe(
      'Checking attention',
    );
    expect(view.container.querySelector('.kt-attn-action-trigger__count')).toBeNull();

    await view.render(
      <AttentionActionTrigger
        id="attn-trigger"
        controls="attention-sheet"
        count={140}
        expanded={false}
        onOpen={() => undefined}
      />,
    );
    expect(must(view.container.querySelector('.kt-attn-action-trigger__count'), 'the badge').textContent).toBe('99+');

    await view.unmount();
  });

  it('reads as a plain, empty entry point when nothing is waiting', async () => {
    const view = await mount(
      <AttentionActionTrigger
        id="attn-trigger"
        controls="attention-sheet"
        count={0}
        expanded={false}
        onOpen={() => undefined}
      />,
    );
    const trigger = must(view.container.querySelector('button'), 'the trigger');

    expect(trigger.getAttribute('aria-label')).toBe('Attention');
    expect(trigger.getAttribute('data-active')).toBeNull();

    await view.unmount();
  });
});

describe('AttentionActionModal', () => {
  it('opens on the requested item rather than on the oldest one', async () => {
    const view = await modal({
      snapshot: snapshot({
        items: [item(), item({ id: 'A7', subject: 'Choose a deploy window', ask: { kind: 'open-question' } })],
        count: 2,
      }),
      targetId: 'A7',
    });

    // Assert — a `!A7` in the transcript opens A7, not "the first thing".
    expect(view.container.textContent).toContain('Choose a deploy window');
    expect(view.container.textContent).toContain('!A7');
    expect(view.container.textContent).toContain('2/2');

    await view.unmount();
  });

  it('hands the FIRST committed dialog the explicit target, never the oldest item', async () => {
    // The one the eventual-selection test above cannot see. `BottomSheet` traps
    // focus in a layout effect, so the first committed dialog is already the one
    // a keyboard or a screen reader is holding: a target picked in a passive
    // effect would announce A3's label and offer A3's Approve control under a
    // proved `!A7`. This probe reads that commit; it awaits nothing.
    const committed: CommittedDialog[] = [];
    const view = await mount(
      <>
        <AttentionActionModal
          client={client([])}
          connection={connection}
          id="attention-sheet"
          onClose={() => undefined}
          open
          scope={scope}
          snapshot={snapshot({
            items: [item(), item({ id: 'A7', subject: 'Choose a deploy window', ask: { kind: 'open-question' } })],
            count: 2,
          })}
          status="ready"
          swipeEnabled={false}
          targetId="A7"
        />
        <DialogLayoutProbe into={committed} />
      </>,
    );

    const first = must(committed[0], 'the first committed dialog');
    expect(first.label).toBe('Choose a deploy window');
    expect(first.text).toContain('!A7');
    // A3 is present in the deck and must appear nowhere in this commit — not as
    // the announced label, not as prose, and above all not as a live control
    // that answers a decision the reader never navigated to.
    expect(first.text).not.toContain('Approve the pairing request');
    expect(first.text).not.toContain('!A3');
    expect(first.approveControls).toBe(0);

    // Deck navigation is untouched: the target is where the sheet OPENS, and
    // the reader can still step back through the older asks from there.
    await interact(() => buttonNamed(view.container, 'Older').click());
    expect(view.container.textContent).toContain('Approve the pairing request');
    expect(view.container.textContent).toContain('1/2');

    await view.unmount();
  });

  it('keeps the explicit reference instead of substituting when no audit trail exists', async () => {
    // A `!A9` that left neither an active row nor a resolution record must NOT
    // become A3's decision. The sheet names A9, says it is no longer active
    // without inventing an outcome, and offers no controls for the survivor.
    const view = await modal({
      snapshot: snapshot({ items: [item()], count: 1 }),
      targetId: 'A9',
    });

    expect(view.container.querySelector('[data-attention-addressed]')).not.toBeNull();
    expect(view.container.textContent).toContain('!A9');
    expect(view.container.textContent).toContain('no longer active');
    // No outcome is invented for an item with no recorded resolution.
    expect(view.container.textContent).not.toContain('done by you');
    expect(view.container.textContent).not.toContain('Approved');
    // The surviving A3 is not surfaced: its subject and its Approve control are gone.
    expect(view.container.textContent).not.toContain('Approve the pairing request');
    expect(
      Array.from(view.container.querySelectorAll('button')).filter(b => b.textContent?.includes('Approve')),
    ).toHaveLength(0);

    await view.unmount();
  });

  it('keeps the exact clicked reference through the resolve race, never the survivor', async () => {
    // The reader followed !A3 while A3 and A7 were both active. Another actor
    // resolved A3 before the authoritative snapshot landed; only A7 remains. The
    // modal must still name A3's addressed state and never render A7's controls.
    const two = snapshot({
      items: [item(), item({ id: 'A7', subject: 'Choose a deploy window', ask: { kind: 'open-question' } })],
      count: 2,
    });
    const view = await modal({ snapshot: two, targetId: 'A3' });
    expect(view.container.textContent).toContain('Approve the pairing request');

    await view.render(
      <AttentionActionModal
        client={client([])}
        connection={connection}
        id="attention-sheet"
        onClose={() => undefined}
        open
        scope={scope}
        snapshot={{
          ...two,
          items: [item({ id: 'A7', subject: 'Choose a deploy window', ask: { kind: 'open-question' } })],
          count: 1,
          resolved: [
            {
              ...item(),
              resolvedAt: '2026-07-31T12:01:00.000Z',
              resolvedBy: 'human',
              resolvedBySession: null,
              resolvedByName: null,
              disposition: 'done',
              response: { kind: 'permission', decision: 'approve' },
            },
          ] as AttentionSnapshot['resolved'],
        }}
        status="ready"
        swipeEnabled={false}
        targetId="A3"
      />,
    );

    // A3's addressed state — its own audit evidence — not A7's open question.
    expect(view.container.querySelector('[data-attention-addressed]')).not.toBeNull();
    expect(view.container.textContent).toContain('!A3');
    expect(view.container.textContent).toContain('This attention was addressed.');
    expect(view.container.textContent).toContain('done by you');
    expect(view.container.textContent).toContain('Approved');
    // The survivor A7 is never handed to the reader under A3's navigation.
    expect(view.container.textContent).not.toContain('Choose a deploy window');
    expect(view.container.querySelector('[aria-label="Attention items"]')).toBeNull();

    await view.unmount();
  });

  it('steps through the deck oldest-first, and disables the ends', async () => {
    const view = await modal({
      snapshot: snapshot({
        items: [item(), item({ id: 'A7', subject: 'Choose a deploy window' })],
        count: 2,
      }),
    });

    expect(view.container.textContent).toContain('1/2');
    expect(buttonNamed(view.container, 'Older').disabled).toBe(true);
    await interact(() => buttonNamed(view.container, 'Newer').click());

    expect(view.container.textContent).toContain('Choose a deploy window');
    expect(view.container.textContent).toContain('2/2');
    expect(buttonNamed(view.container, 'Newer').disabled).toBe(true);
    await interact(() => buttonNamed(view.container, 'Older').click());
    expect(view.container.textContent).toContain('Approve the pairing request');

    await view.unmount();
  });

  it('offers no navigation for a single ask', async () => {
    const view = await modal({ snapshot: snapshot() });

    expect(view.container.querySelector('[aria-label="Attention items"]')).toBeNull();

    await view.unmount();
  });

  it('says the radio is clear, and says where the answered items went', async () => {
    const view = await modal({
      snapshot: snapshot({
        items: [],
        count: 0,
        resolved: [
          {
            ...item(),
            resolvedAt: '2026-07-31T12:00:00.000Z',
            resolvedBy: 'human',
            resolvedBySession: null,
            resolvedByName: null,
            disposition: 'done',
            response: { kind: 'permission', decision: 'approve' },
          },
        ] as AttentionSnapshot['resolved'],
      }),
    });

    expect(must(view.container.querySelector('[data-attention-clear]'), 'the clear panel').textContent).toContain(
      'Radio clear.',
    );
    expect(must(view.container.querySelector('[data-attention-resolved-count]'), 'the audit line').textContent).toBe(
      '1 recorded in the resolution audit.',
    );

    await view.unmount();
  });

  it('fails closed when the ledger could not be read at all', async () => {
    const view = await modal({ snapshot: null, status: 'error' });

    // Assert — unknown is not all-clear. This is the one confusion that would
    // let a person walk away from a session that needed them.
    expect(view.container.textContent).toContain('Attention cannot be verified.');
    expect(view.container.textContent).not.toContain('Radio clear.');
    expect(view.container.querySelector('[data-attention-clear]')).toBeNull();

    await view.unmount();
  });

  it('reports that it is still reading rather than guessing', async () => {
    const view = await modal({ snapshot: null, status: 'loading' });

    expect(view.container.textContent).toContain("Checking this session's attention ledger");
    expect(view.container.textContent).not.toContain('Radio clear.');

    await view.unmount();
  });

  it('submits the exact typed response and announces it once', async () => {
    const calls: RecordedCall[] = [];
    const view = await modal({ snapshot: snapshot(), client: client(calls) });

    await interact(() => buttonNamed(view.container, 'Approve').click());

    expect(calls).toEqual([{ kind: 'respond', id: 'A3', response: { kind: 'permission', decision: 'approve' } }]);
    // ONE live region carries it. A second, `sr-only` copy of the same sentence
    // is read out twice by a screen reader.
    const announced = Array.from(view.container.querySelectorAll('[role="status"]')).filter(node =>
      node.textContent?.includes('!A3 answered'),
    );
    expect(announced).toHaveLength(1);

    await view.unmount();
  });

  it('marks a legacy item with no recorded ask as done, without inventing an answer', async () => {
    const calls: RecordedCall[] = [];
    const view = await modal({
      snapshot: snapshot({ items: [item({ ask: undefined, source: 'task' })] }),
      client: client(calls),
    });

    await interact(() => buttonNamed(view.container, 'Mark done').click());

    expect(calls).toEqual([{ kind: 'resolve', id: 'A3' }]);
    expect(view.container.textContent).toContain('!A3 marked done');

    await view.unmount();
  });

  it('records a dismissal as a dismissal, not as an answer', async () => {
    const calls: RecordedCall[] = [];
    const view = await modal({ snapshot: snapshot(), client: client(calls) });

    await interact(() => buttonNamed(view.container, 'Dismiss without answering').click());

    expect(calls).toEqual([{ kind: 'dismiss', id: 'A3' }]);
    expect(view.container.textContent).toContain('moved to the resolution audit');

    await view.unmount();
  });

  it('keeps the ask on screen and says why when the daemon refuses', async () => {
    const view = await modal({ snapshot: snapshot(), client: client([], 'the daemon refused this action') });

    await interact(() => buttonNamed(view.container, 'Approve').click());

    expect(must(view.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'the daemon refused this action',
    );
    // The item is still here to retry: a failed action clears nothing.
    expect(view.container.textContent).toContain('Approve the pairing request');

    await view.unmount();
  });

  it('drops an addressed item from the deck the moment the daemon says it is gone', async () => {
    const calls: RecordedCall[] = [];
    const two = snapshot({
      items: [item(), item({ id: 'A7', subject: 'Choose a deploy window' })],
      count: 2,
    });
    const view = await modal({ snapshot: two, client: client(calls) });

    await interact(() => buttonNamed(view.container, 'Approve').click());
    // The authoritative snapshot arrives through the store, exactly as the live
    // client publishes it — the modal never removes the row on its own.
    await view.render(
      <AttentionActionModal
        client={client(calls)}
        connection={connection}
        id="attention-sheet"
        onClose={() => undefined}
        open
        scope={scope}
        snapshot={{
          ...two,
          items: [item({ id: 'A7', subject: 'Choose a deploy window' })],
          count: 1,
          resolved: [
            {
              ...item(),
              resolvedAt: '2026-07-31T12:01:00.000Z',
              resolvedBy: 'human',
              resolvedBySession: null,
              resolvedByName: null,
              disposition: 'done',
              response: { kind: 'permission', decision: 'approve' },
            },
          ] as AttentionSnapshot['resolved'],
        }}
        status="ready"
        swipeEnabled={false}
        targetId={null}
      />,
    );

    // Assert — the answered ask is out of the active deck, the next one is
    // selected for the reader, and the navigation is gone with the second item.
    expect(view.container.textContent).not.toContain('Approve the pairing request');
    expect(view.container.textContent).toContain('Choose a deploy window');
    expect(view.container.querySelector('[aria-label="Attention items"]')).toBeNull();

    await view.unmount();
  });

  it('offers the swipe affordance only on a phone, and never for an open question', async () => {
    const phone = await modal({ snapshot: snapshot(), swipeEnabled: true });
    expect(phone.container.textContent).toContain('swipe any labelled answer right or tap it');
    await phone.unmount();

    const desktop = await modal({ snapshot: snapshot(), swipeEnabled: false });
    expect(desktop.container.textContent).not.toContain('swipe any labelled answer');
    await desktop.unmount();

    const open = await modal({
      snapshot: snapshot({ items: [item({ ask: { kind: 'open-question' } })] }),
      swipeEnabled: true,
    });
    expect(open.container.textContent).not.toContain('swipe any labelled answer');
    await open.unmount();
  });

  it('renders as a labelled modal dialog with a closing control', async () => {
    let closed = 0;
    const view = await modal({ snapshot: snapshot(), onClose: () => (closed += 1) });
    const panel = must(view.container.querySelector('#attention-sheet'), 'the sheet panel');

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(must(panel.getAttribute('aria-labelledby'), 'the title id').length).toBeGreaterThan(0);
    // The header's own close control, not just the sheet's backdrop: a phone
    // reader must be able to leave without a swipe.
    const close = must(panel.querySelector('button[aria-label="Close attention"]'), 'the close button');
    await interact(() => (close as HTMLButtonElement).click());
    expect(closed).toBe(1);

    await view.unmount();
  });

  it('leaves the clear panel by its own action', async () => {
    let closed = 0;
    const view = await modal({ snapshot: snapshot({ items: [], count: 0 }), onClose: () => (closed += 1) });

    await interact(() => buttonNamed(view.container, 'Back to session').click());

    expect(closed).toBe(1);

    await view.unmount();
  });

  it('does not carry a success sentence from one open sheet into the next', async () => {
    const calls: RecordedCall[] = [];
    const api = client(calls);
    const props = {
      client: api,
      connection,
      id: 'attention-sheet',
      onClose: () => undefined,
      scope,
      snapshot: snapshot(),
      status: 'ready' as const,
      swipeEnabled: false,
      targetId: null,
    };
    const view = await mount(<AttentionActionModal {...props} open />);

    await interact(() => buttonNamed(view.container, 'Approve').click());
    // While THIS sheet is open the reader keeps their confirmation.
    expect(view.container.textContent).toContain('!A3 answered');

    await view.render(<AttentionActionModal {...props} open={false} />);
    await view.render(<AttentionActionModal {...props} open />);

    // Reopened — possibly over another session's board. Nothing was answered
    // here, so nothing may claim it was.
    expect(view.container.textContent).not.toContain('answered');

    await view.unmount();
  });

  it('renders nothing while closed, so the session keeps its whole screen', async () => {
    const view = await modal({ snapshot: snapshot(), open: false });

    expect(view.container.innerHTML).toBe('');

    await view.unmount();
  });
});
