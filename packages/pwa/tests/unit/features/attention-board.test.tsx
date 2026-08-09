import { describe, expect, it } from 'bun:test';
import type { AttentionSnapshot } from '@ferretry/protocol';

import {
  AttentionBoard,
  attentionAge,
  attentionReference,
  collapsesByDefault,
  describeResponse,
  resolutionBadge,
} from '../../../src/features/attention/attention-board.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});

const item = {
  id: 'A3',
  source: 'agent-raised' as const,
  sourceRef: null,
  sourceSeq: 1,
  subject: 'Approve the pairing request',
  why: 'The device needs a signed pairing record before it can load session data.',
  context: 'This is enough background to make the person understand the request.',
  waitingSince: '2026-07-31T11:30:00.000Z',
  howToResolve: 'Approve to let this browser access the paired daemon.',
  ask: { kind: 'permission' as const },
  raisedBy: 'agent' as const,
  raisedBySession: 'sess-1',
  raisedByName: 'zoe',
};

const snapshot = (overrides: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  v: 1,
  sessionId: 'sess-1',
  items: [item],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-07-31T12:00:00.000Z',
  ...overrides,
});

describe('AttentionBoard', () => {
  it('distinguishes who dismissed an item from who answered or cleared it', () => {
    const agent = { resolvedBy: 'agent' as const, resolvedBySession: 'sess-agent-7' };
    const person = { resolvedBy: 'human' as const, resolvedBySession: null, resolvedByName: null };
    const daemon = { resolvedBy: 'daemon' as const, resolvedBySession: null, resolvedByName: null };
    expect(resolutionBadge({ ...agent, resolvedByName: 'zoe', disposition: 'dismissed' }).label).toBe(
      'dismissed by agent zoe',
    );
    expect(resolutionBadge({ ...agent, resolvedByName: null, disposition: 'done' }).label).toBe(
      'retracted by agent sess-agent-7',
    );
    expect(resolutionBadge({ ...person, disposition: 'dismissed' }).label).toBe('dismissed by you');
    expect(resolutionBadge({ ...person, disposition: 'done' }).label).toBe('done by you');
    expect(resolutionBadge({ ...daemon, disposition: 'dismissed' }).label).toBe('dismissed by the daemon');
    expect(resolutionBadge({ ...daemon, disposition: 'done' }).label).toBe('cleared by the daemon');
  });

  it('names the acting agent by its session when the ledger records no display name', () => {
    const agent = { resolvedBy: 'agent' as const, resolvedBySession: 'sess-agent-7' };
    // The real daemon leaves the name null far more often than the session, so a
    // session id — not a placeholder — is what the audit has to show.
    expect(resolutionBadge({ ...agent, resolvedByName: null, disposition: 'dismissed' }).label).toBe(
      'dismissed by agent sess-agent-7',
    );
    expect(resolutionBadge({ ...agent, resolvedByName: 'zoe', disposition: 'done' }).label).toBe(
      'retracted by agent zoe',
    );
    // A damaged record that names neither still has to read as an agent action.
    expect(
      resolutionBadge({ resolvedBy: 'agent', resolvedBySession: null, resolvedByName: null, disposition: 'done' })
        .label,
    ).toBe('retracted by agent an unidentified session');
  });

  it('separates an agent that answered for the human from one that retracted its own request', () => {
    const answered = resolutionBadge({
      resolvedBy: 'agent',
      resolvedBySession: 'sess-agent-7',
      resolvedByName: null,
      disposition: 'done',
      response: { kind: 'permission', decision: 'approve' },
    });
    expect(answered.label).toBe('answered by agent sess-agent-7');
    // Answering on the human's behalf is still agent provenance, so it keeps the warn treatment.
    expect(answered.className).toContain('text-warn');
    expect(
      resolutionBadge({
        resolvedBy: 'agent',
        resolvedBySession: 'sess-agent-7',
        resolvedByName: null,
        disposition: 'done',
      }).label,
    ).toBe('retracted by agent sess-agent-7');
  });

  it('falls back to the raising session when an unresolved item carries no agent name', async () => {
    const { container } = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [{ ...item, raisedByName: null }] })}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    expect(container.textContent).toContain('raised by agent sess-1');
    expect(container.textContent).not.toContain('(unnamed)');
  });

  it('renders the oldest item as a rail-led ledger and routes the permission answer', async () => {
    const calls: unknown[][] = [];
    const { container } = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot()}
        loading={false}
        error={null}
        now={Date.parse('2026-07-31T12:00:00.000Z')}
        onAction={(...call) => calls.push(call)}
      />,
    );
    const row = container.querySelector('[data-kind="permission"]');
    expect(container.querySelector('[data-daemon="daemon/a"]')).not.toBeNull();
    expect(row?.className).toContain('kt-attn-rail');
    expect(row?.getAttribute('data-oldest')).toBe('true');
    expect(container.textContent).toContain('waiting 30m');
    expect(container.textContent).toContain('raised by agent zoe');
    // The shared answer control labels each action with its own description and
    // gesture hint, so the button is matched on containing its label rather than
    // on being exactly it.
    await interact(() =>
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent?.includes('Approve'))
        ?.click(),
    );
    expect(calls).toEqual([['A3', { kind: 'permission', decision: 'approve' }]]);
  });

  it('keeps long background behind a phone-sized disclosure while the action stays visible', async () => {
    const long = 'background '.repeat(30);
    const { container } = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [{ ...item, context: long }] })}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    const toggle = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Background'),
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('What clears this');
    await interact(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain(long.trim());
  });

  it('gives multiple choice, answer review, and open questions their own answer controls', async () => {
    const calls: unknown[][] = [];
    const answers = async (ask: AttentionSnapshot['items'][number]['ask'], click: string, text?: string) => {
      const { container } = await mount(
        <AttentionBoard
          connection={connection}
          snapshot={snapshot({ items: [{ ...item, ask }] })}
          loading={false}
          error={null}
          onAction={(...call) => calls.push(call)}
        />,
      );
      const first = Array.from(container.querySelectorAll('button')).find(button =>
        button.textContent?.includes(click),
      );
      await interact(() => first?.click());
      if (text) {
        const textarea = container.querySelector('textarea');
        if (textarea)
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
        await interact(() => textarea?.dispatchEvent(new Event('input', { bubbles: true })));
        await interact(() =>
          Array.from(container.querySelectorAll('button'))
            .find(
              button =>
                button.textContent?.includes('Ask to clarify') === true ||
                button.textContent?.includes('Send answer') === true,
            )
            ?.click(),
        );
      }
    };
    await answers({ kind: 'multiple-choice', options: [{ label: 'Pair now' }, { label: 'Not yet' }] }, 'Pair now');
    await answers({ kind: 'answer-review' }, 'Needs clarification', 'Cite the daemon status.');
    await answers({ kind: 'open-question' }, 'Send answer', 'Use pairing.');
    expect(calls).toEqual([
      ['A3', { kind: 'multiple-choice', choice: 'Pair now' }],
      ['A3', { kind: 'answer-review', verdict: 'clarify', clarification: 'Cite the daemon status.' }],
      ['A3', { kind: 'open-question', answer: 'Use pairing.' }],
    ]);
  });

  it('renders an explicit empty, loading, error, and resolution audit state', async () => {
    const empty = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [], count: 0 })}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    expect(empty.container.textContent).toContain('Nothing needs attention.');
    const loading = await mount(
      <AttentionBoard connection={connection} snapshot={null} loading error={null} onAction={() => undefined} />,
    );
    expect(loading.container.textContent).toContain('Loading attention ledger');
    const audit = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({
          resolved: [
            {
              ...item,
              resolvedAt: '2026-07-31T12:00:00.000Z',
              resolvedBy: 'human',
              resolvedBySession: null,
              resolvedByName: null,
              resolutionNote: 'Handled.',
              disposition: 'done',
              response: { kind: 'permission', decision: 'approve' },
            },
            {
              ...item,
              id: 'A4',
              resolvedAt: '2026-07-31T12:05:00.000Z',
              resolvedBy: 'agent',
              resolvedBySession: 'sess-agent-7',
              resolvedByName: null,
              resolutionNote: 'The agent approved it while the human was away.',
              disposition: 'done',
              response: { kind: 'permission', decision: 'approve' },
            },
          ],
        })}
        loading={false}
        error="offline"
        onAction={() => undefined}
      />,
    );
    expect(audit.container.textContent).toContain('offline');
    expect(audit.container.textContent).toContain('Could not verify attention');
    expect(audit.container.textContent).toContain('Resolution audit');
    expect(audit.container.textContent).toContain('done by you');
    expect(audit.container.textContent).toContain('answered by agent sess-agent-7');
  });

  it('fails closed when the daemon cannot provide a complete attention ledger', async () => {
    const unavailable = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={null}
        loading={false}
        error="malformed response"
        onAction={() => undefined}
      />,
    );
    expect(unavailable.container.textContent).toContain('Attention needs human verification.');
    expect(unavailable.container.textContent).not.toContain('Nothing needs attention.');

    const damaged = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [], count: 0, parseErrors: 1 })}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    expect(damaged.container.textContent).toContain('Attention needs human verification.');
    expect(damaged.container.textContent).toContain('damaged attention data');
    expect(damaged.container.textContent).not.toContain('Nothing needs attention.');
  });

  it('fails closed for an attention kind a newer or damaged runtime sends directly to the board', async () => {
    const unknownSnapshot = {
      ...snapshot(),
      items: [{ ...item, ask: { kind: 'future-kind' } }],
    } as unknown as AttentionSnapshot;
    const { container } = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={unknownSnapshot}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    expect(container.textContent).toContain('Damaged attention');
    expect(container.textContent).toContain('Cannot offer a response for this damaged attention item.');
    expect(container.textContent).not.toContain('Send answer');
  });

  it('shows source-matched icons and action lines for every requested action before a person opens an item', async () => {
    const asks = [
      { kind: 'permission' as const },
      { kind: 'multiple-choice' as const, options: [{ label: 'One' }, { label: 'Two' }] },
      { kind: 'answer-review' as const },
      { kind: 'open-question' as const },
    ];
    const { container } = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({
          items: asks.map((ask, index) => ({
            ...item,
            id: `A${index + 3}`,
            ask,
            waitingSince: `2026-07-31T11:3${index}:00.000Z`,
          })),
          count: asks.length,
        })}
        loading={false}
        error={null}
        onAction={() => undefined}
      />,
    );
    expect(container.textContent).toContain('Permission');
    expect(container.textContent).toContain('Pick one');
    expect(container.textContent).toContain('Review answer');
    expect(container.textContent).toContain('Open question');
    expect(Array.from(container.querySelectorAll('[data-attention-action]')).map(node => node.textContent)).toEqual([
      'Approve or reject.',
      'Choose an answer.',
      'Accept it, or ask for more.',
      'Write an answer.',
    ]);
    expect(container.querySelectorAll('.kt-attn-chip svg')).toHaveLength(4);
  });

  it('keeps a legacy no-ask item actionable and makes pending work visibly busy', async () => {
    const calls: unknown[][] = [];
    const legacy = {
      ...item,
      ask: undefined,
      source: 'task' as const,
      raisedBy: 'human' as const,
      raisedBySession: null,
      raisedByName: null,
    };
    const ready = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [legacy] })}
        loading={false}
        error={null}
        onAction={(...call) => calls.push(call)}
      />,
    );
    expect(ready.container.textContent).toContain('No answer shape recorded');
    await interact(() =>
      Array.from(ready.container.querySelectorAll('button'))
        .find(button => button.textContent === 'Mark done')
        ?.click(),
    );
    const pending = await mount(
      <AttentionBoard
        connection={connection}
        snapshot={snapshot({ items: [legacy] })}
        loading={false}
        error={null}
        busyId="A3"
        onAction={() => undefined}
      />,
    );
    expect(
      Array.from(pending.container.querySelectorAll('button')).find(button => button.textContent === 'Mark done')
        ?.disabled,
    ).toBe(true);
    expect(calls).toEqual([['A3', null]]);
  });
});

describe('attention helpers and transport', () => {
  it('uses explicit attention copy and never makes a long context open by default', () => {
    expect(attentionReference('A3')).toBe('!A3');
    expect(attentionAge('2026-07-31T11:30:00.000Z', Date.parse('2026-07-31T12:00:00.000Z'))).toBe('waiting 30m');
    expect(collapsesByDefault('x'.repeat(221))).toBe(true);
    expect(
      describeResponse({ kind: 'answer-review', verdict: 'clarify', clarification: 'Cite the source.' }),
    ).toContain('Cite the source.');
  });

  // The live-page cases that used to sit here went with `AttentionPage` and
  // `attention-api.ts`. They asserted a SECOND transport for the same fact; the
  // one that remains is `lib/attention-client.ts`, proved in
  // `tests/unit/attention-client.test.ts` and driven for real by the focused
  // action modal. The board keeps what it actually is: a pure render.
});
