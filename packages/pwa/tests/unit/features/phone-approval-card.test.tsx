import { afterEach, describe, expect, it, spyOn } from 'bun:test';
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
  expiresAt: '2099-10-31T14:04:00.000Z',
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

  it('says when it was asked and by which ferret, from the daemon’s own fields', async () => {
    const card = await draw(approval());

    expect(card.q('[data-phone-approval-asked]')?.textContent).toMatch(/^Asked \d{1,2}:\d{2}.* by lizzette$/u);
  });

  it('never draws a number a ferret pointed at, as if none had been read', async () => {
    const card = await draw(
      approval({ number: { value: '77', from: 'pointed', direction: 'tap-on-phone', readAt: AT } }),
    );

    expect(card.q('[data-phone-approval-number]')).toBeNull();
    expect(card.text()).not.toContain('77');
    expect(card.q('[data-phone-approval-no-number]')?.textContent).toContain("Ferretry couldn't read a number");
  });

  it('keeps a fresh number before expiry, and across a re-read of the same approval', async () => {
    const live = { expiresAt: '2026-10-31T14:04:00.000Z' };
    const before = Date.parse('2026-10-31T14:03:59.000Z');
    const view = await mount(
      <PhoneApprovalCard approval={approval(live)} now={before} onRefuse={async () => undefined} />,
    );
    mounted.push(view);
    const number = () => view.container.querySelector('[data-phone-approval-number]')?.textContent;
    expect(number()).toBe('42');

    await view.render(
      <PhoneApprovalCard
        approval={approval({
          ...live,
          number: { value: '42', from: 'okta', direction: 'tap-on-phone', readAt: '2026-10-31T14:03:00.000Z' },
        })}
        now={before}
        onRefuse={async () => undefined}
      />,
    );
    expect(number()).toBe('42');
  });

  it('drops the number once the approval has expired, even before the daemon settles it', async () => {
    const view = await mount(
      <PhoneApprovalCard
        approval={approval({ expiresAt: '2026-10-31T14:04:00.000Z' })}
        now={Date.parse('2026-10-31T14:04:01.000Z')}
        onRefuse={async () => undefined}
      />,
    );
    mounted.push(view);

    expect(view.container.querySelector('[data-phone-approval-number]')).toBeNull();
    expect(view.container.textContent).not.toContain('42');
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

  it('draws no number when reading the approvals fails', async () => {
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', [DAEMON_FEATURES.phoneApproval]));
        throw new Error('unreachable');
      },
    };

    const view = await host({ paths: [], factory: async () => client as never });

    expect(view.container.querySelector('[data-phone-approval-number]')).toBeNull();
  });

  it('drops a number it was showing the moment the next read fails', async () => {
    let reads = 0;
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', [DAEMON_FEATURES.phoneApproval]));
        reads += 1;
        if (reads > 1) throw new Error('unreachable');
        return schema.parse({ approvals: [approval()] });
      },
    };
    const polls: Array<() => void> = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 2_000) {
        polls.push(fn);
        return 0 as never;
      }
      return real(fn, ms);
    }) as never);
    try {
      const view = await host({ paths: [], factory: async () => client as never });
      expect(view.container.querySelector('[data-phone-approval-number]')?.textContent).toBe('42');

      for (const poll of polls.splice(0)) poll();
      for (let tries = 0; tries < 5; tries += 1) await settle();

      expect(reads).toBeGreaterThan(1);
      expect(view.container.querySelector('[data-phone-approval-number]')).toBeNull();
      expect(view.container.textContent).not.toContain('42');
    } finally {
      spy.mockRestore();
    }
  });

  it('drops the last approval’s number the moment the approval it shows changes', async () => {
    const machine = served([DAEMON_FEATURES.phoneApproval], [approval()]);
    const view = await host(machine);
    expect(view.container.querySelector('[data-phone-approval-number]')?.textContent).toBe('42');
    const stuck = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', [DAEMON_FEATURES.phoneApproval]));
        return await new Promise(() => undefined);
      },
    };

    await view.render(
      <DaemonClientProvider client={async () => stuck as never}>
        <PhoneApprovalHost approvalId={`pa_${'0'.repeat(23)}2`} connection={CONNECTION} sessionId={SESSION} />
      </DaemonClientProvider>,
    );
    await settle();

    expect(view.container.querySelector('[data-phone-approval]')).toBeNull();
  });

  it('sends the refusal to this approval’s own route, then shows it settled and tells the page', async () => {
    const sent: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        if (path === '/v1/health') return schema.parse(healthOf('9.9.9', [DAEMON_FEATURES.phoneApproval]));
        if (init?.method === 'POST') {
          sent.push(path);
          return schema.parse({});
        }
        return schema.parse({ approvals: [approval()] });
      },
    };
    let done = 0;
    const view = await mount(
      <DaemonClientProvider client={async () => client as never}>
        <PhoneApprovalHost
          approvalId={ID}
          connection={CONNECTION}
          onDone={() => {
            done += 1;
          }}
          sessionId={SESSION}
        />
      </DaemonClientProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 5; tries += 1) await settle();

    await click(view.container.querySelector('[data-phone-approval-refuse]'));
    await settle();

    expect(sent).toEqual([`/v1/sessions/${SESSION}/phone-approvals/${ID}/refuse`]);
    expect(done).toBe(1);
    expect(view.container.querySelector('[data-phone-approval-refuse]')).toBeNull();
    expect(view.container.querySelector('[data-phone-approval-number]')).toBeNull();
  });

  it('draws nothing for an approval the daemon does not list for this session', async () => {
    const machine = served([DAEMON_FEATURES.phoneApproval], [approval({ sessionId: 'someone-else' })]);

    const view = await host(machine);

    expect(view.container.querySelector('[data-phone-approval]')).toBeNull();
  });
});
