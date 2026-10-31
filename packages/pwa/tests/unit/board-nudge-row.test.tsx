import { describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { isBoardNudge, linkNudgePullRequests } from '../../src/lib/board-nudge.ts';
import { CardPullRequestsProvider } from '../../src/lib/card-pull-requests.tsx';
import { parseLedgerSendRecord, type LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { render } from '../support/react.ts';

const NUDGE = '&F209 PR #1087 CI is red. Fix it, or note on the card why it can stay red.';
const PR_URL = 'https://github.com/atomi/ferretry/pull/1087';
const AT = Date.UTC(2026, 9, 31, 1, 2, 3);

const textOf = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node !== null && typeof node === 'object' && 'children' in node)
      return walk((node as { children: unknown }).children);
    return '';
  };
  return walk(renderer.toJSON());
};

const record = (extra: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'n1',
  acceptedAt: '2026-10-31T01:02:03.000Z',
  message: NUDGE,
  attachmentIds: [],
  fate: 'delivered',
  ...extra,
});

const asUser = (send: LedgerSendRecord | undefined): TranscriptEntry => ({
  id: 'u1',
  kind: 'user',
  text: NUDGE,
  at: AT,
  ...(send === undefined ? {} : { send }),
});

const BOARD = { kind: 'ferretry', feature: 'Board' } as const;

describe('the board’s automatic nudge in a chat', () => {
  test('should be a compact Board row, not the owner’s bubble, when it skipped the queue for an interactive ferret', () => {
    const view = render(<TranscriptRow entry={asUser(record({ senderKind: 'daemon', by: BOARD }))} />);

    const row = view.root.findByProps({ 'data-board-nudge': '' });
    expect(row.props.role).toBe('note');
    expect(row.props['data-transcript-density']).toBe('chrome');
    expect(view.root.findAllByProps({ 'data-transcript-kind': 'user' })).toHaveLength(0);
    expect(textOf(view)).toStartWith('Board');
    expect(textOf(view)).toContain('CI is red. Fix it, or note on the card why it can stay red.');
  });

  test('should be the same Board row when the queue carried it', () => {
    const queued = record({
      senderKind: 'daemon',
      queue: { state: 'delivered', stateAt: '2026-10-31T01:02:03.000Z', revision: 1, by: BOARD },
    });

    const view = render(<TranscriptRow entry={asUser(queued)} />);

    expect(view.root.findAllByProps({ 'data-board-nudge': '' })).toHaveLength(1);
  });

  test('should be the Board row while it travels as a ledger row', () => {
    const entry: TranscriptEntry = {
      id: 'l1',
      kind: 'ledger',
      text: NUDGE,
      ledger: record({ senderKind: 'daemon', by: BOARD, fate: 'accepted' }),
    };

    const view = render(<TranscriptRow entry={entry} />);

    expect(view.root.findAllByProps({ 'data-board-nudge': '' })).toHaveLength(1);
  });

  test('should open the card it names, as any proved task reference does', () => {
    const opened: string[] = [];
    const view = render(
      <ReferenceSurfaceProvider surface={{ taskReferenceResolver: () => true, onTaskOpen: id => opened.push(id) }}>
        <TranscriptRow entry={asUser(record({ senderKind: 'daemon', by: BOARD }))} />
      </ReferenceSurfaceProvider>,
    );

    const card = view.root.findAllByType('a').find(anchor => String(anchor.props.href).includes('kind=task'));
    card?.props.onClick({ button: 0, currentTarget: null, defaultPrevented: false, preventDefault() {} });

    expect(opened).toEqual(['F209']);
  });

  test('should link the PR it names when the card links that pull request', () => {
    const view = render(
      <CardPullRequestsProvider cards={[{ id: 'F209', prs: [{ number: 1087, url: PR_URL }] }]}>
        <TranscriptRow entry={asUser(record({ senderKind: 'daemon', by: BOARD }))} />
      </CardPullRequestsProvider>,
    );

    const pr = view.root.findAllByType('a').find(anchor => anchor.props.href === PR_URL);
    expect(pr).toBeDefined();
    expect(textOf(view)).toContain('PR #1087');
  });

  test('should stay the owner’s bubble when a person typed the same words', () => {
    const view = render(<TranscriptRow entry={asUser(record({ senderKind: 'human' }))} />);

    expect(view.root.findAllByProps({ 'data-board-nudge': '' })).toHaveLength(0);
  });

  test('should not claim a message from another Ferretry feature is the board’s', () => {
    expect(isBoardNudge(record({ senderKind: 'daemon', by: { kind: 'ferretry', feature: 'Warden' } }))).toBe(false);
    expect(isBoardNudge(record({ senderKind: 'human', by: { kind: 'owner', feature: 'Board' } }))).toBe(false);
    expect(isBoardNudge(record({ senderKind: 'daemon', by: BOARD }))).toBe(true);
  });
});

describe('reading who sent a send', () => {
  test('should keep the sender a direct send recorded', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 's',
      acceptedAt: '2026-10-31T01:02:03.000Z',
      message: NUDGE,
      fate: 'delivered',
      senderKind: 'daemon',
      by: { kind: 'ferretry', feature: 'Board', bogus: 1 },
    });

    expect(parsed?.by).toEqual({ kind: 'ferretry', feature: 'Board' });
  });

  test('should drop a sender it cannot read', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 's',
      acceptedAt: '2026-10-31T01:02:03.000Z',
      message: 'x',
      by: { kind: 'robot' },
    });

    expect(parsed?.by).toBeUndefined();
  });
});

describe('naming the pull request a nudge is about', () => {
  const cards = [{ id: 'F209', prs: [{ number: 1087, url: PR_URL }] }];

  test('should link only a PR the named card links', () => {
    expect(linkNudgePullRequests(NUDGE, cards)).toBe(
      `&F209 [PR #1087](${PR_URL}) CI is red. Fix it, or note on the card why it can stay red.`,
    );
    expect(linkNudgePullRequests('&F209 PR #5 CI is red.', cards)).toBe('&F209 PR #5 CI is red.');
    expect(linkNudgePullRequests('&F1 PR #1087 CI is red.', cards)).toBe('&F1 PR #1087 CI is red.');
    expect(linkNudgePullRequests(NUDGE, undefined)).toBe(NUDGE);
  });
});
