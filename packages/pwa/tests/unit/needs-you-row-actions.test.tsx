import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { needsYouActions, needsYouReason } from '../../src/lib/needs-you-reason.ts';
import { AttentionInboxContext } from '../../src/hooks/use-attention-inbox.ts';
import { SessionsBarNeedsYou } from '../../src/shell/sessions-bar-needs-you.tsx';
import { attentionItem, fakeInbox, InboxHarness, inboxCard } from '../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const view = sessionView('s-1', {
  config: { teammate: 'zoe', label: 'Fix the build' },
  state: { attention: { open: 1, first: 'a1', ask: 'Ship it?', latestAt: '2026-10-16T12:00:00.000Z' } },
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('needs-you reason', () => {
  test('items on the deck are an attention reason with Done and Dismiss', () => {
    const card = inboxCard(attentionItem('a1'), view, 'Workshop', DAEMON);
    const reason = needsYouReason([card], false);
    expect(reason.kind).toBe('attention');
    expect(needsYouActions(reason, DAEMON, view).map(a => a.kind)).toEqual(['done', 'dismiss']);
  });
  test('no items while reading is reading, with Open only', () => {
    const reason = needsYouReason([], true);
    expect(reason.kind).toBe('reading');
    expect(needsYouActions(reason, DAEMON, view).map(a => a.kind)).toEqual(['open']);
  });
  test('no items and not reading is stale, with Open and Hide', () => {
    const reason = needsYouReason([], false);
    expect(reason.kind).toBe('stale');
    expect(needsYouActions(reason, DAEMON, view).map(a => a.kind)).toEqual(['open', 'hide']);
  });
});

describe('SessionsBarNeedsYou row actions', () => {
  const rows = [{ daemonId: DAEMON, view }];
  const draw = async (cards: ReturnType<typeof inboxCard>[], fake = fakeInbox(), reading = false) => {
    mounted = await mount(
      <InboxHarness
        cards={cards}
        fake={fake}
        reading={reading}
        render={inbox => (
          <AttentionInboxContext.Provider value={inbox}>
            <SessionsBarNeedsYou isActive={() => false} learns={() => false} onNavigate={() => {}} rows={rows} />
          </AttentionInboxContext.Provider>
        )}
      />,
    );
    return { fake, root: mounted.container };
  };

  test('Done schedules the item into the undo window', async () => {
    const card = inboxCard(attentionItem('a1'), view, 'Workshop', DAEMON);
    const { fake, root } = await draw([card]);
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-needs-you-action="done"]'), 'done').click());
    expect(fake.deferred.getSnapshot().pending.map(p => p.key)).toEqual([card.key]);
  });

  test('Dismiss schedules the item too', async () => {
    const card = inboxCard(attentionItem('a1'), view, 'Workshop', DAEMON);
    const { fake, root } = await draw([card]);
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-needs-you-action="dismiss"]'), 'dismiss').click(),
    );
    expect(fake.deferred.getSnapshot().pending).toHaveLength(1);
  });

  test('a stale row says the machine needs an update and Hide removes it', async () => {
    const { root } = await draw([]);
    expect(must(root.querySelector('[data-needs-you-reason]'), 'row').getAttribute('data-needs-you-reason')).toBe(
      'stale',
    );
    expect(root.textContent).toContain('needs an update');
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-needs-you-action="hide"]'), 'hide').click());
    expect(root.querySelector('[data-sbar-needs-you-group]')).toBeNull();
  });

  test('a row still being read offers Open and nothing destructive', async () => {
    const { root } = await draw([], fakeInbox(), true);
    expect(root.querySelector('[data-needs-you-action="open"]')).not.toBeNull();
    expect(root.querySelector('[data-needs-you-action="done"]')).toBeNull();
  });
});
