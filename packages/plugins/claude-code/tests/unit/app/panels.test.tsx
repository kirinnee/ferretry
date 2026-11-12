/**
 * The two cards above the composer, built by the half the shell builds and mounted over a scripted daemon client. Each
 * panel reads what the ferret is stopped on through the prompt route, draws its card for a recorded request, answers
 * through the existing POST, and draws nothing for a ferret that is stopped on nothing. Fixed fake data only.
 */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { afterEach, describe, expect, it } from 'bun:test';
import { createElement, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

const FERRET = 'mvuc7tsf-0c3d50df';
const ID = '0123456789abcdef';

const PERMISSION = {
  id: ID,
  harness: 'claude-code',
  tool: 'Read',
  action: 'read',
  what: '/work/example/notes.txt',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from example/ during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

const DIALOG = {
  id: 'fedcba9876543210',
  harness: 'claude-code',
  kind: 'directory-trust',
  title: 'Do you trust the files in this folder?',
  body: 'The folder /work/example has not been opened here before.',
  options: [
    { number: 1, label: 'Yes, I trust this folder', grantsTrust: true },
    { number: 2, label: 'No, exit', grantsTrust: false },
  ],
  selected: 2,
};

interface Scripted extends PluginClient {
  readonly calls: { readonly route: string; readonly params?: unknown; readonly body?: unknown }[];
  /** Fires `ferrets.changed` for this ferret, as the daemon's feed does. */
  readonly wake: () => void;
}

/** Answers the prompt route from `prompts` in order (the last repeats); every other route by key. */
const daemon = (prompts: readonly unknown[], answers: Readonly<Record<string, unknown>> = {}): Scripted => {
  const calls: Scripted['calls'][number][] = [];
  const listeners: ((payload: { ferret: string; generation: number }) => void)[] = [];
  let read = 0;
  return {
    calls,
    wake: () => {
      for (const listener of listeners) listener({ ferret: FERRET, generation: 1 });
    },
    call: async (route: string, init?: { readonly params?: unknown; readonly body?: unknown }) => {
      calls.push({
        route,
        ...(init?.params === undefined ? {} : { params: init.params }),
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
      if (route === 'GET /v1/ferrets/:ferretId/prompt') {
        const next = prompts[Math.min(read, prompts.length - 1)];
        read += 1;
        if (next instanceof Error) throw next;
        return next;
      }
      if (route === 'GET /v1/ferrets/:ferretId') return { id: FERRET, name: 'denisha' };
      if (!(route in answers)) throw new Error(`no route ${route}`);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    subscribe: (event: { name: string }, listener: (payload: never) => void) => {
      if (event.name === FerretsChanged.name) listeners.push(listener as never);
      return () => undefined;
    },
  } as unknown as Scripted;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 60; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const panel = (client: PluginClient, id: 'permission-request' | 'harness-dialog') =>
  app.build?.({ manifest, client })?.panels[id];

const draw = async (client: PluginClient, id: 'permission-request' | 'harness-dialog'): Promise<HTMLElement> => {
  view = await mount(
    createElement(
      Suspense,
      { fallback: null },
      createElement(panel(client, id) as never, { subject: FERRET } satisfies PanelProps),
    ),
  );
  await settle();
  return view.container;
};

const click = async (node: Element): Promise<void> => {
  await interact(() => (node as HTMLElement).click());
  await settle();
};

describe('the permission-request panel', () => {
  it('draws the card for the request the ferret is stopped on, in the ferret’s name, with one button per row', async () => {
    const client = daemon([{ turnState: 'needs-input', permissionRequest: PERMISSION }]);

    const root = await draw(client, 'permission-request');

    const card = must(root.querySelector(`[data-permission-request="${ID}"]`), 'the permission card');
    expect(card.textContent).toContain('denisha wants to read');
    expect(card.textContent).toContain('/work/example/notes.txt');
    expect([...card.querySelectorAll('[data-permission-option]')].map(node => node.textContent)).toEqual([
      'Allow once',
      expect.stringContaining('Always allow'),
      'Deny',
    ]);
    expect(client.calls.some(call => call.route === 'GET /v1/ferrets/:ferretId/prompt')).toBe(true);
    expect(client.calls.find(call => call.route === 'GET /v1/ferrets/:ferretId/prompt')?.params).toEqual({
      ferretId: FERRET,
    });
  });

  it('answers through the existing permission POST with the request id and the number picked, and says it waits', async () => {
    const client = daemon([{ turnState: 'needs-input', permissionRequest: PERMISSION }], {
      'POST /v1/ferrets/:ferretId/permission': { requestId: ID, cleared: true },
    });
    const root = await draw(client, 'permission-request');

    await click(must(root.querySelector('[data-permission-option="1"]'), 'allow once'));

    const posts = client.calls.filter(call => call.route === 'POST /v1/ferrets/:ferretId/permission');
    expect(posts).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/permission',
        params: { ferretId: FERRET },
        body: { kind: 'choice', requestId: ID, number: 1 },
      },
    ]);
    expect(root.textContent).toContain('Answered, waiting for denisha to continue.');
  });

  it('is gone once the ferret has moved on: a later read of the same ferret says nothing is asked', async () => {
    const client = daemon([{ turnState: 'needs-input', permissionRequest: PERMISSION }, { turnState: 'working' }]);
    const root = await draw(client, 'permission-request');
    expect(root.querySelector('[data-permission-request]')).not.toBeNull();

    await interact(() => client.wake());
    await settle();

    expect(root.querySelector('[data-permission-request]')).toBeNull();
    expect(root.textContent).toBe('');
  });

  it('draws nothing for a ferret stopped on nothing (an empty record)', async () => {
    const root = await draw(daemon([{}]), 'permission-request');

    expect(root.textContent).toBe('');
    expect(root.querySelector('section')).toBeNull();
  });

  it.each([
    ['a read the daemon refused', new Error('refused')],
    ['a request that does not fit the contract', { turnState: 'needs-input', permissionRequest: { id: 'nope' } }],
    ['an answer that is not an object', 'oops'],
  ])('draws nothing for %s, rather than a card it cannot stand behind', async (_name, answer) => {
    const root = await draw(daemon([answer]), 'permission-request');

    expect(root.textContent).toBe('');
  });

  it('does not draw a dialog’s card, only a permission request’s', async () => {
    const root = await draw(daemon([{ turnState: 'needs-input', dialog: DIALOG }]), 'permission-request');

    expect(root.textContent).toBe('');
  });
});

describe('the harness-dialog panel', () => {
  it('draws the card for the dialog the ferret is stopped on, marking the default row and the trust it grants', async () => {
    const root = await draw(daemon([{ turnState: 'needs-input', dialog: DIALOG }]), 'harness-dialog');

    const card = must(root.querySelector(`[data-harness-dialog="${DIALOG.id}"]`), 'the dialog card');
    expect(card.getAttribute('data-dialog-kind')).toBe('directory-trust');
    expect(card.textContent).toContain('The folder /work/example has not been opened here before.');
    expect(must(card.querySelector('[data-dialog-option="2"]'), 'row 2').textContent).toContain('default');
    expect(must(card.querySelector('[data-dialog-option="1"]'), 'row 1').querySelector('small')).not.toBeNull();
  });

  it('answers through the existing dialog POST with the dialog id and the number picked', async () => {
    const client = daemon([{ turnState: 'needs-input', dialog: DIALOG }], {
      'POST /v1/ferrets/:ferretId/dialog': { dialogId: DIALOG.id, cleared: true },
    });
    const root = await draw(client, 'harness-dialog');

    await click(must(root.querySelector('[data-dialog-option="2"]'), 'no, exit'));

    expect(client.calls.filter(call => call.route === 'POST /v1/ferrets/:ferretId/dialog')).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/dialog',
        params: { ferretId: FERRET },
        body: { kind: 'choice', dialogId: DIALOG.id, number: 2 },
      },
    ]);
  });

  it('says the dialog is gone, sending nothing, when the daemon says the pane no longer shows it', async () => {
    const gone = Object.assign(new Error('that dialog is gone'), { status: 409, code: 'harness_dialog_gone' });
    const client = daemon(
      [
        { turnState: 'needs-input', dialog: DIALOG },
        { turnState: 'needs-input', dialog: DIALOG },
      ],
      {
        'POST /v1/ferrets/:ferretId/dialog': gone,
      },
    );
    const root = await draw(client, 'harness-dialog');

    await click(must(root.querySelector('[data-dialog-option="1"]'), 'trust'));

    expect(client.calls.filter(call => call.route === 'POST /v1/ferrets/:ferretId/dialog')).toHaveLength(1);
  });

  it('draws nothing for a ferret stopped on nothing, and nothing for a permission request', async () => {
    const empty = await draw(daemon([{}]), 'harness-dialog');
    expect(empty.textContent).toBe('');
    await view?.unmount();

    const permission = await draw(
      daemon([{ turnState: 'needs-input', permissionRequest: PERMISSION }]),
      'harness-dialog',
    );
    expect(permission.textContent).toBe('');
  });
});

describe('both panels', () => {
  it('draw nothing without a ferret to read, and read nothing', async () => {
    const client = daemon([{ turnState: 'needs-input', permissionRequest: PERMISSION }]);
    view = await mount(
      createElement(Suspense, { fallback: null }, createElement(panel(client, 'permission-request') as never, {})),
    );
    await settle();

    expect(view.container.textContent).toBe('');
    expect(client.calls).toEqual([]);
  });
});

describe('what Ferrets records', () => {
  it('names the harness `claude`; the cards still draw, and answer under the id as recorded', async () => {
    const recordedRequest = { ...PERMISSION, harness: 'claude' };
    const recordedDialog = { ...DIALOG, harness: 'claude' };
    const client = daemon([{ turnState: 'needs-input', permissionRequest: recordedRequest, dialog: recordedDialog }], {
      'POST /v1/ferrets/:ferretId/permission': { requestId: ID, cleared: true },
    });

    const permission = await draw(client, 'permission-request');
    expect(permission.querySelector(`[data-permission-request="${ID}"]`)).not.toBeNull();
    await click(must(permission.querySelector('[data-permission-option="3"]'), 'deny'));

    expect(client.calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/permission')?.body).toEqual({
      kind: 'choice',
      requestId: ID,
      number: 3,
    });
    await view?.unmount();
    const dialog = await draw(client, 'harness-dialog');
    expect(dialog.querySelector(`[data-harness-dialog="${DIALOG.id}"]`)).not.toBeNull();
  });
});
