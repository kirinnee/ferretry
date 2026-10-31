import { describe, expect, it } from 'bun:test';
import { reviveRuling, type SessionStatus, SessionStatusSchema, type SessionView } from '@ferretry/protocol';
import {
  CORE_SESSION_ACTIONS,
  type CoreActionContext,
  SESSION_ACTION_IDS,
} from '../../src/features/session-actions/core-actions.ts';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import { keptConversationAction } from '../../src/features/fleet/conversations/continue-model.ts';
import { reviveOffer } from '../../src/shell/revive-offer.ts';
import { rowMenuActionSpecs } from '../../src/shell/agent-sidebar-model.ts';
import { sessionActionSpecs } from '../../src/shell/session-actions.ts';
import { sessionView } from '../support/sessions.ts';

const noop = (): void => undefined;
const STATUSES = SessionStatusSchema.options;

const coreContext = (view: SessionView, canControl = true): CoreActionContext => ({
  view,
  name: 'Hadi',
  canControl,
  copyId: noop,
  openMigrate: noop,
  restart: async () => undefined,
  stop: async () => undefined,
  resume: async () => undefined,
  renderRename: () => null,
  renderFork: () => null,
});

/** Every place the PWA can offer to bring a ferret back, asked about the same view. */
const surfaces: readonly { readonly name: string; readonly offers: (view: SessionView) => boolean }[] = [
  {
    name: 'the chat bar and the sidebar (sessionActionSpecs)',
    offers: view => sessionActionSpecs(view, true).some(spec => spec.action === 'resume'),
  },
  {
    name: 'a list row’s menu',
    offers: view => rowMenuActionSpecs(view, true).some(spec => spec.action === 'resume'),
  },
  {
    name: 'the chat Actions menu',
    offers: view =>
      sessionActionSections(CORE_SESSION_ACTIONS, coreContext(view))
        .flatMap(section => section.entries)
        .some(entry => entry.id === SESSION_ACTION_IDS.resume),
  },
  {
    name: 'Continue a conversation (a kept conversation)',
    offers: view =>
      keptConversationAction({ adoptedBy: view.config.id } as unknown as Parameters<typeof keptConversationAction>[0], [
        view,
      ]) === 'resume',
  },
];

describe('the Resume button, state by state and surface by surface', () => {
  for (const status of STATUSES) {
    for (const surface of surfaces) {
      it(`${surface.name} agrees with the shared rule for a ${status} session`, () => {
        const view = sessionView('s1', { state: { status } });
        expect(surface.offers(view)).toBe(reviveRuling(status).revivable);
      });
    }
  }

  for (const surface of surfaces) {
    it(`${surface.name} follows the daemon’s verdict over the status: revivable while "running"`, () => {
      const view = sessionView('s1', {
        state: { status: 'running' },
        revive: { revivable: true, reason: 'Its CLI is gone.' },
      });
      expect(surface.offers(view)).toBe(true);
    });

    it(`${surface.name} hides Resume when the daemon says no, even for a stopped session`, () => {
      const view = sessionView('s1', {
        state: { status: 'stopped' },
        revive: { revivable: false, reason: 'Its folder is gone.' },
      });
      expect(surface.offers(view)).toBe(false);
    });
  }
});

describe('reviveOffer', () => {
  it('says why for every refusal', () => {
    for (const status of STATUSES as readonly SessionStatus[]) {
      const view = sessionView('s1', { state: { status } });
      expect(reviveOffer(view, true).reason.length).toBeGreaterThan(0);
    }
    expect(reviveOffer(sessionView('s1', { state: { status: 'stopped' } }), false)).toEqual({
      offered: false,
      reason: 'This connection can look but not change anything.',
    });
  });
});
