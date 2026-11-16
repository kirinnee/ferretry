/**
 * The `agenda.item-opened` hook Access provides: opening an ask closes this device's own lines and makes the seen mark
 * Agenda handed it (Agenda's route, never called by Access itself), and never rejects.
 */
import { describe, expect, it } from 'bun:test';
import { agendaItemPushTag } from '../../../contract/index.ts';
import { agendaItemOpenedHook, pageRegistration } from '../../../app/lib/item-opened-hook.ts';
import { shownTag } from '../../../app/shell-pairing.ts';

const HOME = { daemonId: 'home', label: 'home' };
const itemTag = shownTag(agendaItemPushTag('session-1', 'A3'), HOME);
const stopTag = shownTag('attention-session-1', HOME);

/** A registration holding the item's line and the ferret's stop line, recording what it closed. */
const registrationWith = () => {
  const closed: string[] = [];
  return {
    closed,
    registration: {
      getNotifications: async (options?: { tag: string }) =>
        options !== undefined && [itemTag, stopTag].includes(options.tag) && !closed.includes(options.tag)
          ? [{ close: () => void closed.push(options.tag), timestamp: 0 }]
          : [],
    } as never,
  };
};

describe('agendaItemOpenedHook', () => {
  it('should make the seen mark Agenda handed it and close the line for the ask and the tags the machine names', async () => {
    // Arrange
    const { closed, registration } = registrationWith();
    let marked = 0;
    const opened = agendaItemOpenedHook(async () => registration)({ daemon: 'home' });

    // Act
    await opened('session-1', 'A3', async () => {
      marked += 1;
      return { cleared: true, tags: ['attention-session-1'] };
    });

    // Assert
    expect(marked).toBe(1);
    expect(closed).toEqual([itemTag, stopTag]);
  });

  it('should still close the line here when the machine cannot be told, and not reject', async () => {
    const { closed, registration } = registrationWith();
    const opened = agendaItemOpenedHook(
      async () => registration,
      () => 5,
    )({ daemon: 'home' });
    await opened('session-1', 'A3', async () => {
      throw new Error('offline');
    });
    expect(closed).toEqual([itemTag]);
  });

  it('should treat an answer that is not a seen answer as a mark that did not land', async () => {
    const { closed, registration } = registrationWith();
    const opened = agendaItemOpenedHook(async () => registration)({ daemon: 'home' });
    await opened('session-1', 'A3', async () => ({ cleared: 'maybe' }));
    expect(closed).toEqual([itemTag]);
  });
});

describe('pageRegistration', () => {
  it('should hold no registration in a page with no service worker', async () => {
    expect(await pageRegistration('home' as never)).toBeNull();
  });
});
