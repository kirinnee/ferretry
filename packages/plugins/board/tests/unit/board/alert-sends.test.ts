import { describe, it } from 'bun:test';
import type { Card, CardId, CardView, PrLink } from '../../../contract/index.ts';
import should from 'should';
import {
  AlertSurface,
  type InteractionMode,
  applyPrUpdate,
  BoardAlerts,
  BoardIndex,
  noticeRecipient,
  nudgeRecipient,
  planSweep,
  EMPTY_SWEEP_MEMORY,
} from '../../../daemon/lib/board/index.ts';
import { card, lanes, liveSession, MACHINE, NOW, PROJECT, rosterOf } from './support.ts';

/**
 * A board alert never reaches the owner's own interactive chat: each producer's real alert, sent to the session the
 * route picked, is journalled on an interactive one and typed into an automatic one as before.
 */

const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

/** The ports, recording what each was asked; `modes` is how each session takes messages. */
const alertWorld = (
  modes: Readonly<Record<string, InteractionMode>>,
  options: { readonly cards?: readonly Card[]; readonly modeFails?: boolean } = {},
) => {
  const sent: string[] = [];
  const withheld: string[] = [];
  const notes: string[] = [];
  const surface = new AlertSurface({
    snapshot: async () => ({
      cards: options.cards ?? [],
      laneSets: new Map([[PROJECT, lanes()]]),
    }),
    note: async (id, text) => {
      notes.push(`${id}: ${text}`);
    },
    machineId: () => MACHINE,
  });
  const alerts = new BoardAlerts({
    mode: async ferret => {
      if (options.modeFails === true) throw new Error('send document is malformed');
      return modes[ferret];
    },
    surface: async (id, message) => await surface.surface(id, message),
    send: async (ferret, message) => {
      sent.push(`${ferret}: ${message}`);
    },
    withheld: async (ferret, message) => {
      withheld.push(`${ferret}: ${message}`);
    },
  });
  return { alerts, sent, withheld, notes };
};

/** The lead the owner chats with, and the helper it started for the card, which has ended. */
const roster = (leadInteractive: boolean) =>
  rosterOf([
    liveSession('lizzette', { interactive: leadInteractive }),
    liveSession('child', { lead: 'lizzette', status: 'stopped' }),
  ]);
const MODES = (leadInteractive: boolean) =>
  ({ lizzette: leadInteractive ? 'interactive' : 'auto', child: 'auto' }) as const;

const link: PrLink = {
  url: 'https://github.com/kirinnee/ferretry/pull/940',
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'pending',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: NOW,
};
const prCard = card({
  laneId: 'review',
  workflow: 'quick',
  owner: 'lizzette',
  assignee: 'child',
  links: { prs: [link], branch: null, commits: [], docs: [] },
});

/** The PR alerts the GitHub watcher raises for one observation of the card's PR. */
const prAlerts = (observed: { readonly state: 'open' | 'closed'; readonly checks: 'pending' | 'failing' }) =>
  applyPrUpdate(
    prCard,
    {
      link: [],
      observed: [{ url: link.url, draft: false, mergedAt: null, mergeSha: null, ...observed }],
      releases: [],
      runningVersion: null,
    },
    {
      now: NOW,
      actor: { kind: 'daemon' },
      standing: 'daemon',
      laneSet: lanes(),
      index: new BoardIndex([prCard], 'machine-1'),
      laneSets: new Map([[PROJECT, lanes()]]),
    },
  ).nudges;

/** Sends each PR alert where the watcher's nudge path routes it. */
const sendPrAlerts = async (leadInteractive: boolean, nudges: ReturnType<typeof prAlerts>) => {
  const world = alertWorld(MODES(leadInteractive));
  const recipient = noticeRecipient(roster(leadInteractive), prCard);
  const outcomes = await Promise.all(
    nudges.map(async nudge => await world.alerts.send(recipient?.ferret ?? 'nobody', nudge.message)),
  );
  return { ...world, outcomes };
};

describe('board alerts to an interactive session', () => {
  it('should journal a red CI on the interactive lead instead of typing it, and type it into an automatic one', async () => {
    // Arrange
    const nudges = prAlerts({ state: 'open', checks: 'failing' });
    const message = '&F1 PR #940 CI is red. Fix it, or note on the card why it can stay red.';
    should(nudges.map(nudge => nudge.message)).eql([message]);

    // Act
    const interactive = await sendPrAlerts(true, nudges);
    const automatic = await sendPrAlerts(false, nudges);

    // Assert
    should(interactive.outcomes).eql(['withheld']);
    should(interactive.sent).be.empty();
    should(interactive.withheld).eql([`lizzette: ${message}`]);
    should(automatic.outcomes).eql(['sent']);
    should(automatic.sent).eql([`lizzette: ${message}`]);
    should(automatic.withheld).be.empty();
  });

  it('should journal a PR closed unmerged on the interactive lead instead of typing it', async () => {
    // Arrange
    const nudges = prAlerts({ state: 'closed', checks: 'pending' });
    const message = '&F1 PR #940 was closed without merging. Reopen it, link its replacement, or drop the card.';
    should(nudges.map(nudge => nudge.message)).eql([message]);

    // Act
    const interactive = await sendPrAlerts(true, nudges);
    const automatic = await sendPrAlerts(false, nudges);

    // Assert
    should(interactive.sent).be.empty();
    should(interactive.withheld).eql([`lizzette: ${message}`]);
    should(automatic.sent).eql([`lizzette: ${message}`]);
  });

  it('should journal a stale nudge on the interactive lead instead of typing it', async () => {
    // Arrange: the card went back to the lead the owner chats with when its ferret ended, and sat there.
    const stale: CardView = {
      ...card({ laneId: 'implement', owner: 'lizzette', assignee: 'lizzette', createdAt: ago(5 * HOUR) }),
      lastTouchedAt: ago(3 * HOUR),
      touchedBy: null,
      activity: 'stale',
      rollup: {
        children: 0,
        byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
        active: 0,
        lastTouchedAt: null,
      },
      suggestedLane: null,
      
      openAsks: [],
      blockedBy: [],
      blocks: [],
      shippedIn: null,
    };
    const send = async (leadInteractive: boolean) => {
      const plan = planSweep(
        EMPTY_SWEEP_MEMORY,
        { views: [stale], laneSets: new Map([[PROJECT, lanes(PROJECT)]]) },
        roster(leadInteractive),
        NOW,
      );
      const world = alertWorld(MODES(leadInteractive));
      for (const nudge of plan.nudges) await world.alerts.send(nudge.ferret, nudge.message);
      return { ...world, planned: plan.nudges };
    };

    // Act
    const interactive = await send(true);
    const automatic = await send(false);

    // Assert: the route still names the lead; what reaches it is decided at the send.
    should(nudgeRecipient(stale, roster(true))).equal('lizzette');
    should(interactive.planned).have.length(1);
    should(interactive.sent).be.empty();
    should(interactive.withheld).eql([`lizzette: ${interactive.planned[0]?.message}`]);
    should(automatic.withheld).be.empty();
    should(automatic.sent).eql([`lizzette: ${automatic.planned[0]?.message}`]);
  });

  it('should send to a session whose mode cannot be read, leaving the refusal to the send path', async () => {
    // Arrange
    const world = alertWorld({});

    // Act
    const outcome = await world.alerts.send('unknown', '&F1 PR #940 CI is red.');

    // Assert
    should(outcome).equal('sent');
    should(world.sent).eql(['unknown: &F1 PR #940 CI is red.']);
    should(world.withheld).be.empty();
  });

  it('should send as before when the mode lookup rejects, to the identical target and text', async () => {
    // Arrange
    const world = alertWorld({ lizzette: 'interactive' }, { modeFails: true });

    // Act
    const outcome = await world.alerts.send('lizzette', '&F1 PR #940 CI is red.', 'F1' as CardId);

    // Assert
    should(outcome).equal('sent');
    should(world.sent).eql(['lizzette: &F1 PR #940 CI is red.']);
    should(world.withheld).be.empty();
    should(world.notes).be.empty();
  });
});

describe('a withheld alert about a private card', () => {
  const parent = card({ id: 'F10', askedBy: 'person', owner: 'lizzette', parent: null });
  const child = card({ id: 'F11', owner: 'lizzette', assignee: 'child', parent: { id: 'F10' } });
  const grandchild = card({ id: 'F12', owner: 'lizzette', assignee: 'child', parent: { id: 'F11' } });
  const redCi = '&F12 PR #940 CI is red. Fix it, or note on the card why it can stay red.';
  const closed = '&F12 PR #940 was closed without merging. Reopen it, link its replacement, or drop the card.';

  it.each([
    ['a red CI', redCi],
    ['a PR closed unmerged', closed],
  ])(
    'should note %s on the nearest public ancestor and type nothing to the interactive lead',
    async (_name, message) => {
      // Arrange
      const world = alertWorld({ lizzette: 'interactive' }, { cards: [parent, child, grandchild] });

      // Act
      const outcome = await world.alerts.send('lizzette', message, 'F12' as CardId);

      // Assert
      should(outcome).equal('withheld');
      should(world.sent).be.empty();
      should(world.withheld).eql([`lizzette: ${message}`]);
      should(world.notes).eql([`F10: sub-card alert, not typed to the interactive lead: ${message}`]);
    },
  );

  it('should note nothing when the interactive lead gets an alert about a public card or one with no public ancestor', async () => {
    // Arrange
    const hiddenRoot = card({ id: 'F20', owner: 'lizzette', visibility: 'private', parent: null });
    const orphan = card({ id: 'F21', owner: 'lizzette', parent: { id: 'F20' } });
    const world = alertWorld({ lizzette: 'interactive' }, { cards: [parent, hiddenRoot, orphan] });

    // Act
    await world.alerts.send('lizzette', '&F10 PR #1 CI is red.', 'F10' as CardId);
    await world.alerts.send('lizzette', '&F21 PR #2 CI is red.', 'F21' as CardId);
    await world.alerts.send('lizzette', '&F10 has had no activity for 3h.');

    // Assert
    should(world.sent).be.empty();
    should(world.withheld).have.length(3);
    should(world.notes).be.empty();
  });

  it.each([
    ['dropped', { dropped: { reason: 'superseded', at: NOW } }],
    ['in a closed lane', { laneId: 'closed' }],
  ])('should walk past an archived public parent (%s) to the open public grandparent', async (_name, archived) => {
    // Arrange: F30 (open, public) > F31 (archived, public) > F32 (private), the card the alert is about.
    const root = card({ id: 'F30', askedBy: 'person', owner: 'lizzette', parent: null });
    const parentCard = card({ id: 'F31', owner: 'lizzette', visibility: 'public', parent: { id: 'F30' }, ...archived });
    const leaf = card({ id: 'F32', owner: 'lizzette', assignee: 'child', parent: { id: 'F31' } });
    const message = '&F32 PR #940 CI is red. Fix it, or note on the card why it can stay red.';
    const world = alertWorld({ lizzette: 'interactive' }, { cards: [root, parentCard, leaf] });

    // Act
    const outcome = await world.alerts.send('lizzette', message, 'F32' as CardId);

    // Assert
    should(outcome).equal('withheld');
    should(world.sent).be.empty();
    should(world.notes).eql([`F30: sub-card alert, not typed to the interactive lead: ${message}`]);
  });

  it('should note nothing when the only public ancestor is archived, and still type nothing', async () => {
    // Arrange: an archived public root > an open private child.
    const root = card({
      id: 'F40',
      askedBy: 'person',
      owner: 'lizzette',
      parent: null,
      dropped: { reason: 'x', at: NOW },
    });
    const leaf = card({ id: 'F41', owner: 'lizzette', assignee: 'child', parent: { id: 'F40' } });
    const message = '&F41 PR #940 was closed without merging. Reopen it, link its replacement, or drop the card.';
    const world = alertWorld({ lizzette: 'interactive' }, { cards: [root, leaf] });

    // Act
    const outcome = await world.alerts.send('lizzette', message, 'F41' as CardId);

    // Assert
    should(outcome).equal('withheld');
    should(world.sent).be.empty();
    should(world.withheld).eql([`lizzette: ${message}`]);
    should(world.notes).be.empty();
  });

  it('should note nothing and type as before for an automatic recipient', async () => {
    // Arrange
    const world = alertWorld({ lizzette: 'auto' }, { cards: [parent, child, grandchild] });

    // Act
    const outcome = await world.alerts.send('lizzette', redCi, 'F12' as CardId);

    // Assert
    should(outcome).equal('sent');
    should(world.sent).eql([`lizzette: ${redCi}`]);
    should(world.notes).be.empty();
  });
});
