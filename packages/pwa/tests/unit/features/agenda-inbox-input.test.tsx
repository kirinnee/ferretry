import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaNeedsYou } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount } from '../../support/dom.ts';
import { settle } from '../../support/dom-form.ts';

const WORKSHOP = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const inputCard = inboxCard(
  agendaItem('A7', { kind: 'input', ask: undefined, input: { requestId: 'ab'.repeat(16) } } as never),
);

const show = async (connected: boolean) => {
  const fake = fakeInbox();
  const view = await mount(
    <InboxHarness
      cards={[inputCard]}
      fake={fake}
      render={inbox => (
        <AgendaNeedsYou
          clock={fake.clock.now}
          daemonId={WORKSHOP.daemonId}
          inbox={{ ...inbox, connectionFor: id => (connected && id === WORKSHOP.daemonId ? WORKSHOP : undefined) }}
          now={NOW}
          onNavigate={() => undefined}
        />
      )}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

describe('an input card in the Inbox', () => {
  it('is answered by the input form for a machine paired here', async () => {
    const view = await show(true);

    expect(view.container.querySelector('[data-agenda-input-form]')).not.toBeNull();
  });

  it('carries no form for a machine this browser is not paired with', async () => {
    const view = await show(false);

    expect(view.container.querySelector('[data-agenda-input-form]')).toBeNull();
  });
});

describe('a paste plan card in the Inbox', () => {
  const notice = (planned: boolean) =>
    inboxCard(
      agendaItem('A8', {
        kind: 'permission',
        ask: undefined,
        raisedBy: 'daemon',
        ...(planned ? { copyPlan: { planId: 'b'.repeat(32) } } : {}),
      } as never),
    );

  const draw = async (planned: boolean, connected = true) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[notice(planned)]}
        fake={fake}
        render={inbox => (
          <AgendaNeedsYou
            clock={fake.clock.now}
            daemonId={WORKSHOP.daemonId}
            inbox={{ ...inbox, connectionFor: id => (connected && id === WORKSHOP.daemonId ? WORKSHOP : undefined) }}
            now={NOW}
            onNavigate={() => undefined}
          />
        )}
      />,
    );
    mounted.push(view);
    await settle();
    return view;
  };

  it('carries the plan form for a card with a plan from a machine paired here, and none otherwise', async () => {
    expect((await draw(true)).container.querySelector('[data-agenda-plan-form]')).not.toBeNull();
    expect((await draw(false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect((await draw(true, false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});
