import { afterEach, describe, expect, it } from 'bun:test';
import { INPUT_ERROR_CODES, type InputRequest } from '@ferretry/protocol';
import { InputCardHost } from '../../../src/features/input-request/input-card-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { InputClient } from '../../../src/lib/input-api.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { request } from '../../support/input-fixtures.ts';

const CONNECTION = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const REQUEST_ID = 'ab'.repeat(16);
const mounted: Mounted[] = [];
// The host passes no clock, so the card counts against the real one: its request must outlive the test run.
const open = (): InputRequest => request({ expiresAt: '2099-01-01T00:00:00.000Z' });

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

/** A client whose list answer is whatever `listed` returns now, and which records every path it was asked. */
const clientFor = (listed: () => readonly InputRequest[] | Error) => {
  const paths: string[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
      paths.push(path);
      const answer = listed();
      if (answer instanceof Error) throw answer;
      return schema.parse(path.endsWith('/cancel') ? {} : { requests: answer });
    },
  } as unknown as InputClient;
  return { client, paths };
};

const show = async (
  client: Promise<InputClient>,
  onDone?: () => void,
  item: object = { input: { requestId: REQUEST_ID } },
) => {
  const view = await mount(
    <InputCardHost
      agentName="Hadi"
      connection={CONNECTION}
      createClient={async () => await client}
      item={item}
      sessionId="sess-1"
      {...(onDone === undefined ? {} : { onDone })}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

describe('the input card host', () => {
  it('reads the request the item points at and draws the card for it', async () => {
    const { client, paths } = clientFor(() => [open()]);
    const view = await show(Promise.resolve(client));

    expect(paths).toEqual(['/v1/sessions/sess-1/input-requests']);
    const card = view.container.querySelector('[data-input-request]');
    expect(card?.getAttribute('aria-label')).toBe('!A7 · Hadi needs a password');
    expect(card?.hasAttribute('data-input-embedded')).toBe(true);
    expect(view.container.querySelector('[data-input-title]')).toBeNull();
  });

  it('draws nothing for an item that names no request', async () => {
    const { client } = clientFor(() => []);
    const view = await show(Promise.resolve(client), undefined, {});

    expect(view.container.textContent).toBe('');
  });

  it('says it is reading until the client is ready', async () => {
    const view = await show(new Promise<InputClient>(() => undefined));

    expect(view.container.textContent).toBe('Reading the request…');
  });

  it('says a request the daemon no longer lists is not open', async () => {
    const { client } = clientFor(() => []);
    const view = await show(Promise.resolve(client));

    expect(view.container.querySelector('[data-input-gone]')?.textContent).toBe('This request is no longer open.');
  });

  it('says why the client could not be made, whether it threw an error or a bare value', async () => {
    const error = await show(Promise.reject(new Error('no route to the machine')));
    expect(error.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not read this request: no route to the machine',
    );

    const bare = await show(Promise.reject('offline'));
    expect(bare.container.querySelector('[role="alert"]')?.textContent).toBe('Could not read this request: offline');
  });

  it('says why the read failed, with the cause as an error or as a bare value', async () => {
    const error = await show(Promise.resolve(clientFor(() => new Error('the daemon is restarting')).client));
    expect(error.container.querySelector('[role="alert"]')?.textContent).toContain('the daemon is restarting');

    const bare = await show(
      Promise.resolve({
        request: async () => {
          throw 'boom';
        },
      } as unknown as InputClient),
    );
    expect(bare.container.querySelector('[role="alert"]')?.textContent).toContain('boom');
  });

  it('keeps the card on screen when a re-read fails or no longer lists it, and reports done once cancelled', async () => {
    let answer: readonly InputRequest[] | Error = [open()];
    const done: string[] = [];
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        if (path.endsWith('/deliver')) throw { status: 409, code: INPUT_ERROR_CODES.targetChanged };
        if (answer instanceof Error) throw answer;
        return schema.parse(path.endsWith('/cancel') ? {} : { requests: answer });
      },
    } as unknown as InputClient;
    const view = await show(Promise.resolve(client), () => done.push('done'));
    const send = async (): Promise<void> => {
      await typeInto(view.container.querySelector('[data-input-value]'), 'correct-horse-battery');
      await click(view.container.querySelector('[data-input-send]'));
      await settle();
    };

    answer = new Error('the daemon is restarting');
    await send();
    expect(view.container.querySelector('[data-input-request]')).not.toBeNull();

    answer = [];
    await send();
    expect(view.container.querySelector('[data-input-request]')).not.toBeNull();
    expect(view.container.querySelector('[data-input-gone]')).toBeNull();

    answer = [open()];
    await click(view.container.querySelector('[data-input-cancel]'));
    await settle();
    expect(done).toEqual(['done']);
  });
});
