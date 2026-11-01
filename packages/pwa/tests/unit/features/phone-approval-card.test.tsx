import { afterEach, describe, expect, it } from 'bun:test';
import {
  DAEMON_FEATURES,
  PHONE_APPROVAL_TITLE,
  PHONE_APPROVAL_WARNING,
  type PhoneApproval,
  PhoneApprovalSchema,
} from '@ferretry/protocol';
import { PhoneApprovalCard } from '../../../src/features/input-request/phone-approval-card.tsx';
import { PhoneApprovalHost } from '../../../src/features/input-request/phone-approval-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../src/lib/store.tsx';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { healthOf } from '../../support/health.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const AT = '2026-10-31T14:02:00.000Z';
const ID = `pa_${'0'.repeat(23)}1`;
const SESSION = 'mvwxxxhv-11b529cb';

const BASE = {
  id: ID,
  sessionId: SESSION,
  agentName: 'lizzette',
  surface: 'browser',
  origin: 'https://company.okta.com',
  signIn: 'si_0123456789abcdef',
  account: { id: 'CLICKUP', label: 'ClickUp' },
  username: 'a@gmail.com',
  via: { id: 'OKTA', label: 'Okta' },
  raisedAt: AT,
  expiresAt: '2026-10-31T14:04:00.000Z',
  state: 'waiting',
};
const approval = (over: Record<string, unknown> = {}): PhoneApproval =>
  PhoneApprovalSchema.parse({
    ...BASE,
    number: { value: '42', from: 'okta', direction: 'tap-on-phone', readAt: AT },
    ...over,
  });
const noNumber = (numberMissing: string, over: Record<string, unknown> = {}): PhoneApproval =>
  PhoneApprovalSchema.parse({ ...BASE, numberMissing, ...over });

const draw = async (value: PhoneApproval, onRefuse = async () => undefined, onViewPage?: () => void) => {
  const view = await mount(
    <PhoneApprovalCard approval={value} onRefuse={onRefuse} {...(onViewPage === undefined ? {} : { onViewPage })} />,
  );
  mounted.push(view);
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { view, q, text: () => view.container.textContent ?? '' };
};

describe('the approve-on-phone card', () => {
  it('draws the number large with the direction line, from the daemon’s own fields', async () => {
    const card = await draw(approval());

    expect(card.q('[data-phone-approval-number]')?.textContent).toBe('42');
    expect(card.q('[data-phone-approval-direction]')?.textContent).toBe('Tap 42 on your phone');
    expect(card.q('[data-phone-approval-title]')?.textContent).toBe(PHONE_APPROVAL_TITLE);
    expect(card.q('[data-phone-approval-who]')?.textContent).toBe('ClickUp · a@gmail.com');
    expect(card.q('[data-phone-approval-where]')?.textContent).toBe('ClickUp via Okta on company.okta.com');
    expect(card.q('[data-phone-approval-warning]')?.textContent).toBe(PHONE_APPROVAL_WARNING);
  });

  it('tells a Duo code to be entered in Duo Mobile, not tapped', async () => {
    const card = await draw(
      approval({ via: undefined, number: { value: '123', from: 'duo', direction: 'type-on-phone', readAt: AT } }),
    );

    expect(card.q('[data-phone-approval-number]')?.textContent).toBe('123');
    expect(card.q('[data-phone-approval-direction]')?.textContent).toBe('Enter 123 in Duo Mobile');
  });

  it('shows no number and offers "View the page" when the page had none', async () => {
    let viewed = 0;
    const card = await draw(
      noNumber('none-found'),
      async () => undefined,
      () => {
        viewed += 1;
      },
    );

    expect(card.q('[data-phone-approval-number]')).toBeNull();
    expect(card.q('[data-phone-approval-no-number]')?.textContent).toContain("Ferretry couldn't read a number");
    expect(card.text()).toContain(PHONE_APPROVAL_WARNING);
    await click(card.q('[data-phone-approval-view]'));
    expect(viewed).toBe(1);
  });

  it('says a steered page is not read, and never shows a number for it', async () => {
    const card = await draw(noNumber('steered'));

    expect(card.q('[data-phone-approval-no-number="steered"]')?.textContent).toContain(
      'acted on the page after asking',
    );
    expect(card.q('[data-phone-approval-number]')).toBeNull();
  });

  it('draws a terminal with no number, no page link and the terminal words', async () => {
    const card = await draw(
      noNumber('terminal', {
        surface: 'terminal',
        origin: undefined,
        via: undefined,
        account: undefined,
        username: undefined,
      }),
      async () => undefined,
      () => undefined,
    );

    expect(card.q('[data-phone-approval-no-number="terminal"]')?.textContent).toContain('Check the terminal');
    expect(card.q('[data-phone-approval-view]')).toBeNull();
    expect(card.q('[data-phone-approval-number]')).toBeNull();
  });

  it('has no way to be handed a number or words by a ferret: the card renders only the approval’s own fields', async () => {
    const card = await draw(noNumber('none-found', { agentName: 'lizzette' }));

    // A ferret's name is the one thing it supplies, and the card does not print it as a number or a prompt.
    expect(card.text()).not.toMatch(/[0-9]{2,}/u);
    expect(card.text()).not.toContain('lizzette');
  });

  it('is answered only by "Not me — stop": no button says the owner approved', async () => {
    let refused = 0;
    const card = await draw(approval(), async () => {
      refused += 1;
    });

    const labels = [...card.view.container.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toEqual(['Not me — stop']);
    await click(card.q('[data-phone-approval-refuse]'));
    expect(refused).toBe(1);
  });

  it('says what happened once the daemon has settled it, and offers no stop then', async () => {
    const card = await draw(approval({ state: 'moved-on' }));

    expect(card.q('[data-phone-approval-settled]')?.textContent).toBe('The sign-in moved on.');
    expect(card.q('[data-phone-approval-refuse]')).toBeNull();
    expect(card.q('[data-phone-approval-number]')).toBeNull();
  });

  it('says why "Not me" failed rather than pretending it worked', async () => {
    const card = await draw(approval(), async () => {
      throw new Error('The daemon refused it.');
    });

    await click(card.q('[data-phone-approval-refuse]'));

    expect(card.q('[data-phone-approval-failure]')?.textContent).toBe('The daemon refused it.');
  });
});

describe('the approve-on-phone host', () => {
  const served = (features: string[] | undefined, approvals: PhoneApproval[]) => {
    const paths: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        paths.push(path);
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', features));
        return schema.parse({ approvals });
      },
    };
    return { paths, factory: async () => client as never };
  };

  const host = async (machine: ReturnType<typeof served>) => {
    const view = await mount(
      <DaemonClientProvider client={machine.factory}>
        <PhoneApprovalHost approvalId={ID} connection={CONNECTION} sessionId={SESSION} />
      </DaemonClientProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 5; tries += 1) await settle();
    return view;
  };

  it('draws nothing, and asks for nothing, against a daemon that does not report approve-on-phone', async () => {
    const machine = served(['messages.tail.1'], [approval()]);

    const view = await host(machine);

    expect(view.container.querySelector('[data-phone-approval]')).toBeNull();
    expect(machine.paths).not.toContain('/v1/phone-approvals');
  });

  it('draws the daemon’s approval where the daemon reports the feature', async () => {
    const machine = served([DAEMON_FEATURES.phoneApproval], [approval()]);

    const view = await host(machine);

    expect(view.container.querySelector('[data-phone-approval-number]')?.textContent).toBe('42');
    expect(machine.paths).toContain('/v1/phone-approvals');
  });

  it('draws nothing for an approval the daemon does not list for this session', async () => {
    const machine = served([DAEMON_FEATURES.phoneApproval], [approval({ sessionId: 'someone-else' })]);

    const view = await host(machine);

    expect(view.container.querySelector('[data-phone-approval]')).toBeNull();
  });
});
