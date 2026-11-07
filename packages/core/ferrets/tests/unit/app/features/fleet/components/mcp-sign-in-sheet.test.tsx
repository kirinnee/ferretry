import { afterEach, describe, expect, it } from 'bun:test';
import { MCP_OAUTH_PATH, type McpOAuthConnection } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  browserChannel,
  McpSignInSheet,
  type McpSignInSheetProps,
} from '../../../../../src/features/fleet/components/mcp-sign-in-sheet.tsx';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import type { Mounted } from '../../../../support/dom.ts';
import {
  type Answers,
  AUTHORIZE_URL,
  type Call,
  CALLBACK,
  completion,
  factoryFor,
  fakeChannels,
  mcpFlow,
  NOW,
  OTHER_CALLBACK,
} from '../mcp-sign-in-support.ts';
import { click, mountSettled, settle, text, type } from './view-support.tsx';

const FLOW_PATH = `${MCP_OAUTH_PATH}/flows/mcp-flow-one`;
const START_PATH = `${MCP_OAUTH_PATH}/linear`;
const REDIRECT = 'https://pwa.example.test/oauth/mcp-callback';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const unmountSheet = async (): Promise<void> => {
  await mounted?.unmount();
  mounted = undefined;
};

interface Opened {
  readonly root: HTMLElement;
  readonly calls: Call[];
  readonly channels: ReturnType<typeof fakeChannels>['opened'];
  readonly signedIn: McpOAuthConnection[];
  closed: number;
}

const open = async (answers: Answers, props: Partial<McpSignInSheetProps> = {}): Promise<Opened> => {
  const calls: Call[] = [];
  const { factory, opened } = fakeChannels();
  const result: Opened = { root: document.body, calls, channels: opened, signedIn: [], closed: 0 };
  mounted = await mountSettled(
    <McpSignInSheet
      component="linear"
      machineName="studio-mac"
      flow={mcpFlow()}
      redirectUri={REDIRECT}
      connection={daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' })}
      createClient={factoryFor(answers, calls)}
      onSignedIn={connection => result.signedIn.push(connection)}
      onClose={() => {
        result.closed += 1;
      }}
      channel={factory}
      now={() => NOW}
      {...props}
    />,
  );
  return result;
};

const phase = (root: ParentNode): string | null =>
  root.querySelector('[data-mcp-sign-in]')?.getAttribute('data-mcp-sign-in') ?? null;

const pastedValue = (root: ParentNode): string =>
  (root.querySelector('textarea[name="mcp-sign-in-address"]') as HTMLTextAreaElement).value;

describe('McpSignInSheet — coming back by itself', () => {
  it('names the provider and opens its page in a new tab without handing it this page', async () => {
    const { root, channels } = await open({});
    // Every heading in the document, not the first: a suite run in one process can leave another file's
    // heading mounted ahead of this one.
    expect([...root.querySelectorAll('h2')].map(heading => heading.textContent)).toContain('Sign in to linear');
    expect(root.textContent).toContain('With auth.linear.example');
    const link = root.querySelector<HTMLAnchorElement>('[data-mcp-sign-in-open]');
    expect(link?.getAttribute('href')).toBe(AUTHORIZE_URL);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(text(root, '[data-mcp-sign-in-waiting]')).toBe('After you sign in you’ll come back here automatically.');
    expect(channels.map(channel => channel.name)).toEqual(['ferretry-mcp-oauth']);
    expect(root.querySelector('[data-mcp-sign-in-note]')).toBeNull();
  });

  it('takes its own callback, answers without the address, and finishes', async () => {
    const opened = await open({ [`POST ${FLOW_PATH}`]: completion() });
    const channel = opened.channels[0];
    await settle();
    channel?.deliver({ type: 'callback', id: 'other-tab', href: OTHER_CALLBACK });
    channel?.deliver({ type: 'noise' });
    await settle();
    expect(opened.calls).toEqual([]);
    expect(channel?.posted).toEqual([]);

    channel?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();

    expect(opened.calls).toEqual([{ path: FLOW_PATH, method: 'POST', body: { callback: CALLBACK } }]);
    expect(channel?.posted).toEqual([
      { type: 'received', id: 'hand-over' },
      { type: 'finished', id: 'hand-over', ok: true },
    ]);
    expect(JSON.stringify(channel?.posted)).not.toContain('fixture-code');
    expect(phase(opened.root)).toBe('done');
    expect(opened.root.textContent).toContain('Signed in · expires in 59m.');
    expect(opened.signedIn).toHaveLength(1);

    // A second hand-over after the sign-in finished is not forwarded again.
    channel?.deliver({ type: 'callback', id: 'again', href: CALLBACK });
    await settle();
    expect(opened.calls).toHaveLength(1);

    await click(opened.root, '[data-mcp-sign-in-done]');
    expect(opened.closed).toBe(1);
  });

  it('shows the daemon’s refusal and tells the callback page it did not finish', async () => {
    const opened = await open({
      [`POST ${FLOW_PATH}`]: new FyHttpError('That address is for a different sign-in.', 409, 'conflict'),
    });
    opened.channels[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    expect(text(opened.root, '[data-mcp-sign-in-refusal]')).toBe('That address is for a different sign-in.');
    expect(opened.channels[0]?.posted.at(-1)).toEqual({ type: 'finished', id: 'hand-over', ok: false });
    expect(phase(opened.root)).toBe('waiting');
    expect(opened.signedIn).toEqual([]);
  });

  it('offers a fresh sign-in after a refusal, the same way round, and clears the refusal', async () => {
    const opened = await open({
      [`POST ${FLOW_PATH}`]: new FyHttpError('That sign-in was already used.', 409, 'conflict'),
      [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: false },
      [`POST ${START_PATH}`]: mcpFlow({ flowId: 'mcp-flow-two' }),
    });
    expect(opened.root.querySelector('[data-mcp-sign-in-restart]')).toBeNull();
    opened.channels[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    await click(opened.root, '[data-mcp-sign-in-restart]');
    expect(opened.calls.at(-1)).toEqual({ path: START_PATH, method: 'POST', body: { redirectUri: REDIRECT } });
    expect(opened.root.querySelector('[data-mcp-sign-in-refusal]')).toBeNull();
    expect(opened.root.querySelector('[data-mcp-sign-in-restart]')).toBeNull();
  });

  it('pastes the address by hand from the disclosure, and empties the box whatever the answer', async () => {
    const opened = await open({ [`POST ${FLOW_PATH}`]: new Error('down') });
    const disclosure = opened.root.querySelector<HTMLDetailsElement>('[data-mcp-sign-in-paste-disclosure]');
    expect(disclosure?.open).toBe(false);
    await click(opened.root, '[data-mcp-sign-in-paste-disclosure] summary');
    await type(opened.root, 'textarea[name="mcp-sign-in-address"]', `  ${CALLBACK}  `);
    await click(opened.root, '[data-mcp-sign-in-paste] button[type="submit"]');

    expect(opened.calls[0]?.body).toEqual({ callback: CALLBACK });
    expect(pastedValue(opened.root)).toBe('');
    expect(text(opened.root, '[data-mcp-sign-in-refusal]')).toContain('didn’t answer');
    // Nothing went over the channel for a pasted address.
    expect(opened.channels[0]?.posted).toEqual([]);
  });

  it('sends nothing for an empty box', async () => {
    const opened = await open({});
    await type(opened.root, 'textarea[name="mcp-sign-in-address"]', '   ');
    const form = opened.root.querySelector('[data-mcp-sign-in-paste]') as HTMLFormElement;
    await settle();
    form.requestSubmit();
    await settle();
    expect(opened.calls).toEqual([]);
  });

  it('starts again the paste way when the provider refuses the return address', async () => {
    const opened = await open({
      [`DELETE ${FLOW_PATH}`]: new Error('gone already'),
      [`POST ${START_PATH}`]: mcpFlow({
        flowId: 'mcp-flow-two',
        mode: 'paste',
        redirectUri: 'http://127.0.0.1/oauth/mcp-callback',
        note: 'linear only allows a loopback address, so the browser won’t come back by itself.',
      }),
    });
    await click(opened.root, '[data-mcp-sign-in-use-paste]');

    expect(opened.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      `DELETE ${FLOW_PATH}`,
      `POST ${START_PATH}`,
    ]);
    expect(opened.calls[1]?.body).toEqual({});
    expect(opened.channels[0]?.closed).toBe(true);
    expect(opened.root.querySelector('[data-mcp-sign-in-mode="paste"]')).not.toBeNull();
    expect(text(opened.root, '[data-mcp-sign-in-note]')).toContain('only allows a loopback address');
    expect(opened.root.textContent).toContain(
      'After you sign in, the page will fail to load. Copy its address from the address bar and paste it here.',
    );
    expect(opened.root.querySelector('[data-mcp-sign-in-paste-disclosure]')).toBeNull();
  });

  it('says so when starting again is refused, and stays where it was', async () => {
    const opened = await open({
      [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: true },
      [`POST ${START_PATH}`]: new FyHttpError('linear has no registration endpoint.', 409, 'conflict'),
    });
    await click(opened.root, '[data-mcp-sign-in-use-paste]');
    expect(text(opened.root, '[data-mcp-sign-in-refusal]')).toBe('linear has no registration endpoint.');
    expect(phase(opened.root)).toBe('waiting');
  });

  it('cancels the flow on Cancel and on a dismiss, and closes even when the machine does not answer', async () => {
    const opened = await open({ [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: true } });
    await click(opened.root, '[data-mcp-sign-in-cancel]');
    expect(opened.calls).toEqual([{ path: FLOW_PATH, method: 'DELETE', body: undefined }]);
    expect(opened.closed).toBe(1);

    await mounted?.unmount();
    const dead = await open({});
    await click(dead.root, 'button[aria-label="Close sign-in"]');
    expect(dead.calls.map(call => call.method)).toEqual(['DELETE']);
    expect(dead.closed).toBe(1);
  });
});

describe('McpSignInSheet — the paste way and expiry', () => {
  it('asks for the address up front in paste mode and listens on no channel', async () => {
    const opened = await open({}, { flow: mcpFlow({ mode: 'paste' }) });
    expect(opened.channels).toEqual([]);
    expect(opened.root.querySelector('[data-mcp-sign-in-waiting]')).toBeNull();
    expect(opened.root.textContent).toContain('2 · Bring the address back');
  });

  it('says an expired sign-in has to start again, and starts it again the same way', async () => {
    const expired = Date.parse(mcpFlow().expiresAt) + 1;
    const opened = await open(
      {
        [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: false },
        [`POST ${START_PATH}`]: mcpFlow({ flowId: 'mcp-flow-two', expiresAt: '2026-10-16T10:20:00.000Z' }),
      },
      { now: () => expired },
    );
    await settle();
    expect(phase(opened.root)).toBe('expired');
    expect(opened.root.textContent).toContain('This sign-in expired. Start again.');

    await click(opened.root, '[data-mcp-sign-in-restart]');
    expect(opened.calls[1]?.body).toEqual({ redirectUri: REDIRECT });
    expect(phase(opened.root)).toBe('waiting');
    await click(opened.root, '[data-mcp-sign-in-cancel]');
    expect(opened.closed).toBe(1);
  });

  it('ignores an answer that lands after the sheet is gone', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const opened = await open({ [`POST ${FLOW_PATH}`]: () => new Promise(resolve => (finish = resolve)) });
    opened.channels[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    expect(text(opened.root, '[data-mcp-sign-in-waiting]')).toBe('Finishing sign-in…');
    await unmountSheet();
    finish(completion());
    await settle();
    expect(opened.signedIn).toEqual([]);
  });

  it('ignores a refusal or a restart that lands after the sheet is gone', async () => {
    let refuse: (value: unknown) => void = () => undefined;
    const opened = await open({ [`POST ${FLOW_PATH}`]: () => new Promise(resolve => (refuse = resolve)) });
    await type(opened.root, 'textarea[name="mcp-sign-in-address"]', CALLBACK);
    await click(opened.root, '[data-mcp-sign-in-paste] button[type="submit"]');
    await unmountSheet();
    refuse(new Error('late'));
    await settle();

    let restart: (value: unknown) => void = () => undefined;
    const again = await open({
      [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: true },
      [`POST ${START_PATH}`]: () => new Promise(resolve => (restart = resolve)),
    });
    await click(again.root, '[data-mcp-sign-in-use-paste]');
    await unmountSheet();
    restart(mcpFlow());
    await settle();

    let late: (value: unknown) => void = () => undefined;
    const third = await open({
      [`DELETE ${FLOW_PATH}`]: { flowId: 'mcp-flow-one', cancelled: true },
      [`POST ${START_PATH}`]: () => new Promise(resolve => (late = resolve)),
    });
    await click(third.root, '[data-mcp-sign-in-use-paste]');
    await unmountSheet();
    late(new Error('late'));
    await settle();
    expect(again.calls.map(call => call.method)).toEqual(['DELETE', 'POST']);
  });

  it('works without a channel at all, where the browser has none', async () => {
    const opened = await open({}, { channel: () => undefined });
    expect(opened.root.querySelector('[data-mcp-sign-in-paste-disclosure]')).not.toBeNull();
  });
});

describe('the browser channel', () => {
  it('is a real BroadcastChannel where the browser has one, and none where it does not', () => {
    const real = globalThis.BroadcastChannel;
    try {
      class Fake {
        constructor(readonly name: string) {}
      }
      (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = Fake;
      expect((browserChannel('ferretry-mcp-oauth') as unknown as Fake).name).toBe('ferretry-mcp-oauth');
      (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = undefined;
      expect(browserChannel('ferretry-mcp-oauth')).toBeUndefined();
    } finally {
      (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = real;
    }
  });
});
