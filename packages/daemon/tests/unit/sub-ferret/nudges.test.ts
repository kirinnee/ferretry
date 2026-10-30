import { describe, it } from 'bun:test';
import should from 'should';
import { SendReopenMessenger } from '../../../src/adapters/board/send-reopen-messenger.ts';
import { ReopenDeliveryLadder } from '../../../src/lib/board/index.ts';
import type { SendMessageRequest, SendOutcome } from '../../../src/lib/session/send/service.ts';
import {
  isSubFerret,
  nudgeTarget,
  sessionSubFerretDirectory,
  subFerretRefusal,
} from '../../../src/lib/sub-ferret/index.ts';
import { card } from '../board/support.ts';
import { DIRECTORY } from './support.ts';

const sends = () => {
  const sent: SendMessageRequest[] = [];
  return {
    sent,
    port: {
      send: async (request: SendMessageRequest) => {
        sent.push(request);
        return { disposition: 'sent' } as SendOutcome;
      },
    },
  };
};

describe('nudges about a sub-ferret', () => {
  it('should go to its lead, and a lead is nudged itself', async () => {
    // Act
    const targets = await Promise.all(
      ['child', 'grandchild', 'lead', 'stranger'].map(id => nudgeTarget(DIRECTORY, id)),
    );

    // Assert
    should(targets).eql(['lead', 'child', 'lead', 'stranger']);
  });

  it('should reach the lead when a reopen is told to the card’s sub-ferret assignee', async () => {
    // Arrange
    const typed = sends();
    const ladder = new ReopenDeliveryLadder(new SendReopenMessenger(typed.port, DIRECTORY), { warn: () => undefined });

    // Act
    const told = await ladder.deliver({
      task: card({ owner: 'lead', assignee: 'child' }),
      by: 'owner',
      reason: 'it broke',
    } as never);

    // Assert
    should(told).eql({ to: 'child', how: 'delivered' });
    should(typed.sent.map(request => request.id)).eql(['lead']);
  });

  it('should keep telling the assignee when it is a lead', async () => {
    // Arrange
    const typed = sends();
    const ladder = new ReopenDeliveryLadder(new SendReopenMessenger(typed.port, DIRECTORY), { warn: () => undefined });

    // Act
    await ladder.deliver({
      task: card({ owner: 'stranger', assignee: 'stranger' }),
      by: 'owner',
      reason: 'it broke',
    } as never);

    // Assert
    should(typed.sent.map(request => request.id)).eql(['stranger']);
  });
});

describe('the sub-ferret directory over the session registry', () => {
  const registry = sessionSubFerretDirectory({
    get: async id =>
      ({
        lead: { config: { teammate: 'lizzette' } },
        child: { config: { parent: 'lead' } },
        orphan: { config: { parent: '' } },
      })[id],
  });

  it('should read the lead from `parent` and its callsign from `teammate`', async () => {
    // Act
    const refusal = await subFerretRefusal(registry, 'child', 'drop cards');

    // Assert
    should(refusal).equal('Sub-ferrets don\'t drop cards; tell your lead: fy send lizzette "…"');
  });

  it('should treat an empty parent, a lead and an unknown session as leads', async () => {
    // Act
    const answers = await Promise.all(['orphan', 'lead', 'nobody'].map(id => isSubFerret(registry, id)));

    // Assert
    should(answers).eql([false, false, false]);
  });

  it('should fall back to the id when the lead has no callsign, and fail open when the registry throws', async () => {
    // Arrange
    const bare = sessionSubFerretDirectory({
      get: async id => (id === 'child' ? { config: { parent: 'lead' } } : undefined),
    });
    const broken = sessionSubFerretDirectory({
      get: async () => {
        throw new Error('unreadable');
      },
    });

    // Act
    const named = await subFerretRefusal(bare, 'child', 'move cards');
    const open = await subFerretRefusal(broken, 'child', 'move cards');

    // Assert
    should(named).equal('Sub-ferrets don\'t move cards; tell your lead: fy send lead "…"');
    should(open).be.null();
  });
});
