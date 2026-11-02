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

describe('a task plan card in the Inbox', () => {
  const REF = { planId: 'c'.repeat(32) };
  const COPY = { planId: 'b'.repeat(32) };
  const notice = (extra: Record<string, unknown>) =>
    inboxCard(agendaItem('A10', { kind: 'permission', ask: undefined, raisedBy: 'daemon', ...extra } as never));

  const draw = async (extra: Record<string, unknown>, connected = true) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[notice(extra)]}
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

  it('is answered by the plan form for the daemon’s own task plan reference, and for nothing else', async () => {
    expect((await draw({ taskPlan: REF })).container.querySelector('[data-agenda-plan-form]')).not.toBeNull();
    expect((await draw({ taskPlan: REF }, false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect((await draw({})).container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });

  it('prefers the task plan over a paste plan on the same card', async () => {
    const view = await draw({ taskPlan: REF, copyPlan: COPY });
    expect(view.container.querySelectorAll('[data-agenda-plan-form]')).toHaveLength(1);
  });
});

describe('an approve-on-phone card in the Inbox', () => {
  const REF = { id: `pa_${'0'.repeat(23)}1` };
  const info = (ref: boolean) =>
    inboxCard(
      agendaItem('A9', {
        kind: 'info',
        ask: undefined,
        raisedBy: 'agent',
        subject: 'Approve on your phone: Tap 42 on your phone',
        ...(ref ? { phoneApproval: REF } : {}),
      } as never),
    );

  const draw = async (ref: boolean, connected = true) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[info(ref)]}
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

  it('is drawn only from the daemon’s own reference, never from a ferret’s words copying its title', async () => {
    const copied = await draw(false);
    expect(copied.container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect(copied.container.querySelector('[data-phone-approval]')).toBeNull();

    expect((await draw(true)).container.querySelector('[data-agenda-plan-form]')).not.toBeNull();
    expect((await draw(true, false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});

describe('a staged 2FA seed card in the Inbox', () => {
  const REF = { stage: `st_${'a'.repeat(24)}`, account: 'GITHUB' };
  const seed = (ref: boolean) =>
    inboxCard(
      agendaItem('A10', {
        kind: 'permission',
        ask: undefined,
        raisedBy: 'daemon',
        subject: 'Save automatic codes to your account on github.com?',
        ...(ref ? { twoFactorSeed: REF } : {}),
      } as never),
    );

  const draw = async (ref: boolean, connected = true) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[seed(ref)]}
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

  it('is answered on its own card from the daemon’s reference, never from a title a ferret copied', async () => {
    expect((await draw(false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect((await draw(true)).container.querySelector('[data-agenda-plan-form]')).not.toBeNull();
    expect((await draw(true, false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});

describe('a standing sign-in rule card in the Inbox', () => {
  const info = (extra: Record<string, unknown>) =>
    inboxCard(
      agendaItem('A12', {
        kind: 'info',
        ask: undefined,
        raisedBy: 'daemon',
        subject: 'Your standing rule for github work was suspended',
        ...extra,
      } as never),
    );

  const draw = async (extra: Record<string, unknown>) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[info(extra)]}
        fake={fake}
        render={inbox => (
          <AgendaNeedsYou
            clock={fake.clock.now}
            daemonId={WORKSHOP.daemonId}
            inbox={{ ...inbox, connectionFor: id => (id === WORKSHOP.daemonId ? WORKSHOP : undefined) }}
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

  it('draws a suspension reference plain: suspension is shown owner-side, never as a session card', async () => {
    const view = await draw({ signInRuleSuspended: { rule: `sr_${'a'.repeat(24)}` } });
    expect(view.container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect(view.container.querySelector('[data-rule-suggestion]')).toBeNull();
    expect(view.container.querySelector('[data-rule]')).toBeNull();
  });

  it('draws no suggestion card from a ferret’s words alone', async () => {
    const view = await draw({ subject: 'Suggested standing rule for github.com', raisedBy: 'agent' });
    expect(view.container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});

describe('a sign-in rule suggestion card in the Inbox', () => {
  const REF = { suggestion: 'srg_aaaaaaaaaaaaaaaa' };
  const suggestion = (ref: boolean) =>
    inboxCard(
      agendaItem('A11', {
        kind: 'info',
        ask: undefined,
        raisedBy: 'agent',
        subject: 'Make a standing rule for GitHub?',
        ...(ref ? { signInRuleSuggestion: REF } : {}),
      } as never),
    );

  const draw = async (ref: boolean, connected = true) => {
    const fake = fakeInbox();
    const view = await mount(
      <InboxHarness
        cards={[suggestion(ref)]}
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

  it('is answered by the suggestion form only from the daemon’s own reference, on a machine paired here', async () => {
    expect((await draw(true)).container.querySelector('[data-agenda-plan-form]')).not.toBeNull();
    expect((await draw(true, false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
    expect((await draw(false)).container.querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});
