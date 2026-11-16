/**
 * The Warden's two contributions to Ferrets' pages: the `ferret-warden` panel on `ferret.side` (what the Warden said
 * about the ferret it sits beside) and the `ask-warden-row` panel on `ferrets.actions-row` (the Actions ▾ row that asks
 * it to investigate). The half the shell builds is mounted over a scripted daemon client; each panel reads only through
 * that client, for the ferret the slot hands it, and fails closed on a refusal.
 */
import { ACTIONS_ROW_SLOT, type ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { afterEach, describe, expect, it } from 'bun:test';
import { createElement, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { wardenStatus } from '../../support/app/warden.ts';

const MINE = 'mvuc7tsf-0c3d50df';
const OTHER = 'mvuc7tsg-11111111';

interface Scripted extends PluginClient {
  readonly calls: { readonly route: string; readonly body?: unknown }[];
}

/** A daemon answering by route key; an `Error` answer is a refusal, a route it was not given fails like an old daemon. */
const daemon = (answers: Readonly<Record<string, unknown>>): Scripted => {
  const calls: Scripted['calls'][number][] = [];
  return {
    calls,
    call: async (route: string, init?: { readonly body?: unknown }) => {
      calls.push({ route, ...(init?.body === undefined ? {} : { body: init.body }) });
      if (!(route in answers)) throw new Error(`no route ${route}`);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    subscribe: () => () => undefined,
  } as unknown as Scripted;
};

const refusal = (): Error => Object.assign(new Error('refused'), { status: 403, code: 'forbidden' });

const verdict = (target: string, kind: string, at: string, reason: string) => ({
  at,
  target,
  verdict: kind,
  reason,
  reportPath: `/reports/${target}-${at}.md`,
});

const FERRETS = [
  {
    id: MINE,
    name: 'denisha',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/a',
    state: 'working',
    createdAt: '2026-11-07T00:00:00.000Z',
    stateAt: '2026-11-07T00:00:00.000Z',
  },
];

const grantRow = (use: boolean, useRefusal: string) => ({
  capability: 'warden',
  use,
  configure: true,
  granted: { use, configure: true },
  useRefusal,
  configureRefusal: 'granted',
  mayGrant: false,
  origin: 'default',
});
const grants = (use: boolean, useRefusal: string) => ({
  capabilities: [grantRow(use, useRefusal)],
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const panel = (client: PluginClient, id: 'ferret-warden' | 'ask-warden-row') =>
  app.build?.({ manifest, client })?.panels[id];

const drawSide = async (client: PluginClient, subject: string): Promise<HTMLElement> => {
  view = await mount(
    createElement(
      Suspense,
      { fallback: null },
      createElement(panel(client, 'ferret-warden') as never, { subject } satisfies PanelProps),
    ),
  );
  await settle();
  return view.container;
};

describe('the ferret-warden panel', () => {
  it('is declared on ferret.side and built by the half', () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'ferret-warden')).toMatchObject({ slot: 'ferret.side' });
    expect(panel(daemon({}), 'ferret-warden')).toBeDefined();
  });

  it('draws what the Warden said about this ferret only, newest first, read through its own client', async () => {
    const client = daemon({
      'GET /v1/warden/verdicts': [
        verdict(MINE, 'nudged', '2026-11-07T10:00:00.000Z', 'It had stopped typing.'),
        verdict(OTHER, 'killed', '2026-11-07T11:00:00.000Z', 'Not this ferret.'),
        verdict(MINE, 'cleared', '2026-11-07T12:00:00.000Z', 'Healthy.'),
      ],
      'GET /v1/ferrets': FERRETS,
    });
    const root = await drawSide(client, MINE);
    expect(
      [...root.querySelectorAll('[data-ferret-verdict]')].map(node => node.getAttribute('data-ferret-verdict')),
    ).toEqual(['cleared', 'nudged']);
    expect(root.textContent).toContain('Left it alone — healthy');
    expect(root.textContent).toContain('It had stopped typing.');
    expect(root.textContent).not.toContain('Not this ferret.');
    expect(client.calls.map(call => call.route).sort()).toEqual(['GET /v1/ferrets', 'GET /v1/warden/verdicts']);
  });

  it('says the Warden has nothing to say, by the ferret’s name', async () => {
    const root = await drawSide(
      daemon({
        'GET /v1/warden/verdicts': [verdict(OTHER, 'killed', '2026-11-07T11:00:00.000Z', 'x')],
        'GET /v1/ferrets': FERRETS,
      }),
      MINE,
    );
    expect(root.textContent).toContain('The Warden has nothing to say about Denisha.');
  });

  it('fails closed on a refusal: it says the read failed and draws no verdict', async () => {
    const root = await drawSide(daemon({ 'GET /v1/warden/verdicts': refusal(), 'GET /v1/ferrets': FERRETS }), MINE);
    expect(root.querySelector('[data-ferret-warden-failed]')?.textContent).toContain(
      'Couldn’t read the Warden’s verdicts',
    );
    expect(root.querySelector('[data-ferret-verdict]')).toBeNull();
  });
});

describe('the ask-warden-row panel', () => {
  const rows = (client: PluginClient, canControl = true) => {
    const offers: Record<string, ActionsRowOffer | null> = {};
    const offer = (id: string, row: ActionsRowOffer | null): void => {
      offers[id] = row;
    };
    const mounted = async (): Promise<void> => {
      view = await mount(
        createElement(
          Suspense,
          { fallback: null },
          createElement(panel(client, 'ask-warden-row') as never, { ferret: MINE, name: 'denisha', canControl, offer }),
        ),
      );
      await settle();
    };
    return { offers, mounted };
  };

  it('is declared on the ferrets.actions-row slot and built by the half', () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'ask-warden-row')).toMatchObject({ slot: ACTIONS_ROW_SLOT });
    expect(panel(daemon({}), 'ask-warden-row')).toBeDefined();
  });

  it('offers the row when warden.use is open and the caller may control the ferret; withdraws it on unmount', async () => {
    const client = daemon({ 'GET /v1/grants': grants(true, 'granted') });
    const { offers, mounted } = rows(client);
    await mounted();
    expect(offers['warden-investigate']).toMatchObject({ kind: 'run', label: 'Ask the Warden to investigate now…' });
    expect(client.calls.map(call => call.route)).toEqual(['GET /v1/grants']);
    await view?.unmount();
    view = null;
    expect(offers['warden-investigate']).toBeNull();
  });

  it('counts a passkey step-up in the way as open: the carrier asks for it at the request', async () => {
    const { offers, mounted } = rows(daemon({ 'GET /v1/grants': grants(false, 'step-up-required') }));
    await mounted();
    expect(offers['warden-investigate']).not.toBeNull();
  });

  it('offers nothing where warden.use is not granted', async () => {
    const { offers, mounted } = rows(daemon({ 'GET /v1/grants': grants(false, 'not-granted') }));
    await mounted();
    expect(offers['warden-investigate'] ?? null).toBeNull();
  });

  it('offers nothing to a connection that may not control the ferret', async () => {
    const { offers, mounted } = rows(daemon({ 'GET /v1/grants': grants(true, 'granted') }), false);
    await mounted();
    expect(offers['warden-investigate'] ?? null).toBeNull();
  });

  it('fails closed when the grants cannot be read: nothing is offered', async () => {
    const { offers, mounted } = rows(daemon({ 'GET /v1/grants': refusal() }));
    await mounted();
    expect(offers['warden-investigate'] ?? null).toBeNull();
  });

  it('opens the form from the row, asks the Warden about this ferret, and says where the report lands', async () => {
    const client = daemon({
      'GET /v1/grants': grants(true, 'granted'),
      'GET /v1/warden/status': wardenStatus(),
      'POST /v1/warden/investigate': { ferret: MINE, state: 'queued', position: 1, message: 'Queued.' },
    });
    const { offers, mounted } = rows(client);
    await mounted();
    const row = must(offers['warden-investigate'], 'row');
    await interact(() => row.run());
    await settle();
    const root = must(view?.container, 'container');
    expect(root.querySelector('[data-ask-warden-dialog]')?.textContent).toContain(
      'Ask the Warden to investigate denisha',
    );
    await interact(() => must(root.querySelector('form'), 'form').requestSubmit());
    await settle();
    expect(client.calls.find(call => call.route === 'POST /v1/warden/investigate')?.body).toMatchObject({
      ferret: MINE,
    });
    expect(root.querySelector('[data-ask-warden-dialog]')).toBeNull();
    expect(root.querySelector('[data-ask-warden-notice]')?.textContent).toContain('queued');
  });

  it('keeps the form open with the daemon’s refusal when the request is refused', async () => {
    const client = daemon({
      'GET /v1/grants': grants(true, 'granted'),
      'GET /v1/warden/status': wardenStatus(),
      'POST /v1/warden/investigate': refusal(),
    });
    const { offers, mounted } = rows(client);
    await mounted();
    await interact(() => must(offers['warden-investigate'], 'row').run());
    await settle();
    const root = must(view?.container, 'container');
    await interact(() => must(root.querySelector('form'), 'form').requestSubmit());
    await settle();
    expect(root.querySelector('[data-ask-warden-dialog]')).not.toBeNull();
    expect(root.textContent).toContain('No investigation:');
  });
});
