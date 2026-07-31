import { describe, expect, it } from 'bun:test';
import type { AttentionSnapshot } from '@ferretry/protocol';

import { actOnAttention, fetchAttention } from '../../../src/features/attention/attention-api.ts';
import {
  AttentionBoard,
  AttentionPage,
  attentionAge,
  attentionReference,
  collapsesByDefault,
  describeResponse,
} from '../../../src/features/attention/attention-board.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';
import { render, runAsync } from '../../support/react.ts';

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
    await interact(() =>
      Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === 'Approve')
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
      const first = Array.from(container.querySelectorAll('button')).find(button => button.textContent === click);
      await interact(() => first?.click());
      if (text) {
        const textarea = container.querySelector('textarea');
        if (textarea)
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
        await interact(() => textarea?.dispatchEvent(new Event('input', { bubbles: true })));
        await interact(() =>
          Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent === 'Ask to clarify' || button.textContent === 'Send answer')
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
          ],
        })}
        loading={false}
        error="offline"
        onAction={() => undefined}
      />,
    );
    expect(audit.container.textContent).toContain('offline');
    expect(audit.container.textContent).toContain('Resolution audit');
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

  it('fetches and mutates only against the supplied paired daemon', async () => {
    const seen: Request[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(snapshot()), { headers: { 'content-type': 'application/json' } });
    };
    await fetchAttention(connection, 'sess-1', fetcher);
    await actOnAttention(connection, 'sess-1', { action: 'dismiss', id: 'A3' }, fetcher);
    expect(seen.map(request => request.url)).toEqual([
      'https://a.example.test/v1/sessions/sess-1/attention',
      'https://a.example.test/v1/sessions/sess-1/attention',
    ]);
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token-a');
    expect(seen[1]?.method).toBe('POST');
    expect(await seen[1]?.json()).toEqual({ action: 'dismiss', id: 'A3' });
  });

  it('clears the prior daemon ledger during a live page load and shows a request failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'offline' }), { status: 503 })) as unknown as typeof fetch;
    try {
      const page = render(<AttentionPage connection={connection} sessionId="sess-1" />);
      await runAsync(async () => await Promise.resolve());
      expect(JSON.stringify(page.toJSON())).toContain('offline');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('loads and mutates the live page through the selected daemon, surfacing a mutation refusal', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.method === 'POST'
        ? new Response(JSON.stringify({ error: 'mutation refused' }), { status: 503 })
        : new Response(JSON.stringify(snapshot()), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const page = await mount(<AttentionPage connection={connection} sessionId="sess-1" />);
      await interact(async () => await Promise.resolve());
      await interact(async () => await Promise.resolve());
      await interact(() =>
        Array.from(page.container.querySelectorAll('button'))
          .find(button => button.textContent === 'Approve')
          ?.click(),
      );
      await interact(async () => await Promise.resolve());
      expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
      expect(await requests[1]?.json()).toEqual({
        action: 'resolve',
        id: 'A3',
        response: { kind: 'permission', decision: 'approve' },
      });
      expect(page.container.textContent).toContain('mutation refused');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
