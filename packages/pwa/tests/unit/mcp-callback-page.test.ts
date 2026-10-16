/**
 * `public/oauth/mcp-callback.{html,js}`: the page an MCP server's sign-in provider sends the browser back
 * to (docs/mcp-oauth.md).
 *
 * It is a static classic script served unbundled from `public/`, so nothing imports or typechecks it and
 * the coverage ledger never sees it. This suite is what holds it: it runs the REAL FILE, with the page's
 * globals supplied as parameters that shadow the real ones, and asserts what a person would see and what
 * crosses the channel. It also pins the two facts the script restates from `src/` — the channel name and
 * the callback path — and that Pages and the service worker answer the callback path with this page and
 * not the app.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_OAUTH_CALLBACK_PATH } from '@ferretry/protocol';
import { MCP_OAUTH_CHANNEL } from '../../src/features/fleet/components/mcp-sign-in-model.ts';
import { parseReleaseRewrites, releasePathForRequest } from '../../src/lib/release-manifest.ts';

const publicDir = join(import.meta.dir, '../../public');
const script = readFileSync(join(publicDir, 'oauth/mcp-callback.js'), 'utf8');
const page = readFileSync(join(publicDir, 'oauth/mcp-callback.html'), 'utf8');
const redirects = readFileSync(join(publicDir, '_redirects'), 'utf8');

const ORIGIN = 'https://ferretry.pages.dev';

class FakeElement {
  textContent = '';
  hidden = false;
  readonly attributes: Record<string, string> = {};
  readonly listeners: (() => void)[] = [];
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
  click(): void {
    for (const listener of this.listeners) listener();
  }
}

interface Channel {
  readonly name: string;
  readonly posted: unknown[];
  closed: boolean;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface Run {
  readonly elements: Record<'callback' | 'title' | 'message' | 'copy' | 'note', FakeElement>;
  readonly channels: Channel[];
  readonly replaced: string[];
  readonly copied: string[];
  readonly timers: (() => void)[];
  /** Delivers a message to the page from "the Ferretry tab". */
  answer(data: unknown): void;
  state(): string | undefined;
}

interface Options {
  readonly search: string;
  readonly channel?: boolean;
  readonly clipboard?: 'ok' | 'refuse' | 'none';
  readonly replaceThrows?: boolean;
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

const run = ({ search, channel = true, clipboard = 'ok', replaceThrows = false }: Options): Run => {
  const elements = {
    callback: new FakeElement(),
    title: new FakeElement(),
    message: new FakeElement(),
    copy: new FakeElement(),
    note: new FakeElement(),
  };
  elements.copy.hidden = true;
  const channels: Channel[] = [];
  const replaced: string[] = [];
  const copied: string[] = [];
  const timers: (() => void)[] = [];
  const location = { href: `${ORIGIN}${MCP_OAUTH_CALLBACK_PATH}${search}`, search, pathname: MCP_OAUTH_CALLBACK_PATH };
  class FakeBroadcastChannel implements Channel {
    readonly posted: unknown[] = [];
    closed = false;
    onmessage: Channel['onmessage'] = null;
    constructor(readonly name: string) {
      channels.push(this);
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    close(): void {
      this.closed = true;
    }
  }
  const navigator =
    clipboard === 'none'
      ? {}
      : {
          clipboard: {
            writeText: (text: string) => {
              if (clipboard === 'refuse') return Promise.reject(new Error('denied'));
              copied.push(text);
              return Promise.resolve();
            },
          },
        };
  const history = {
    replaceState: (_state: unknown, _title: string, url: string) => {
      if (replaceThrows) throw new Error('refused');
      replaced.push(url);
    },
  };
  new Function('document', 'location', 'history', 'BroadcastChannel', 'navigator', 'crypto', 'setTimeout', script)(
    { getElementById: (id: keyof typeof elements) => elements[id] },
    location,
    history,
    channel ? FakeBroadcastChannel : undefined,
    navigator,
    { randomUUID: () => 'hand-over-id' },
    (callback: () => void) => timers.push(callback),
  );
  return {
    elements,
    channels,
    replaced,
    copied,
    timers,
    answer: data => channels[0]?.onmessage?.({ data }),
    state: () => elements.callback.attributes['data-state'],
  };
};

const CODE = '?code=fixture-code&state=fixture-state';

describe('the MCP callback page — handing the address over', () => {
  it('posts its address on the channel the sheet listens on, and nothing else', () => {
    const page = run({ search: CODE });
    expect(page.channels.map(channel => channel.name)).toEqual([MCP_OAUTH_CHANNEL]);
    expect(page.channels[0]?.posted).toEqual([
      { type: 'callback', id: 'hand-over-id', href: `${ORIGIN}${MCP_OAUTH_CALLBACK_PATH}${CODE}` },
    ]);
    // The page keeps the words it was served with — "Finishing sign-in" — until somebody answers.
    expect(page.state()).toBeUndefined();
    expect(page.elements.copy.hidden).toBe(true);
    expect(page.replaced).toEqual([]);
  });

  it('wipes the code once Ferretry has it, then says how the sign-in ended', () => {
    const page = run({ search: CODE });
    page.answer({ type: 'received', id: 'someone-else' });
    page.answer(null);
    expect(page.replaced).toEqual([]);
    page.answer({ type: 'received', id: 'hand-over-id' });
    expect(page.replaced).toEqual([MCP_OAUTH_CALLBACK_PATH]);
    expect(page.state()).toBe('received');
    // The no-answer timer that fires later changes nothing.
    for (const timer of page.timers) timer();
    expect(page.state()).toBe('received');
    page.answer({ type: 'finished', id: 'hand-over-id', ok: true });
    expect(page.state()).toBe('done');
    expect(page.elements.title.textContent).toBe('Signed in');
    expect(page.elements.message.textContent).toBe('You can close this tab and go back to Ferretry.');
    expect(page.channels[0]?.closed).toBe(true);
  });

  it('says so when Ferretry could not finish', () => {
    const page = run({ search: CODE });
    page.answer({ type: 'received', id: 'hand-over-id' });
    page.answer({ type: 'finished', id: 'hand-over-id', ok: false });
    expect(page.state()).toBe('failed');
    expect(page.elements.message.textContent).toBe(
      'Ferretry couldn’t finish the sign-in. Go back to Ferretry to see why.',
    );
  });

  it('ignores a message of a kind it does not know', () => {
    const page = run({ search: CODE });
    page.answer({ type: 'mystery', id: 'hand-over-id' });
    expect(page.state()).toBeUndefined();
  });
});

describe('the MCP callback page — nobody answered', () => {
  it('asks for the address by hand, keeps it until it is copied, then wipes it', async () => {
    const page = run({ search: CODE });
    expect(page.elements.copy.hidden).toBe(true);
    for (const timer of page.timers) timer();
    expect(page.state()).toBe('fallback');
    expect(page.elements.message.textContent).toBe(
      'Ferretry isn’t open in this browser. Copy this page’s address and paste it into the sign-in sheet.',
    );
    expect(page.elements.copy.hidden).toBe(false);
    expect(page.replaced).toEqual([]);
    page.elements.copy.click();
    await settle();
    expect(page.copied).toEqual([`${ORIGIN}${MCP_OAUTH_CALLBACK_PATH}${CODE}`]);
    expect(page.replaced).toEqual([MCP_OAUTH_CALLBACK_PATH]);
    expect(page.elements.note.textContent).toBe('Copied. Paste it into the sign-in sheet in Ferretry.');
    // A Ferretry tab that answers late still takes it.
    page.answer({ type: 'received', id: 'hand-over-id' });
    expect(page.elements.copy.hidden).toBe(true);
  });

  it('says how to copy it by hand when the clipboard refuses or is missing, and keeps the address', async () => {
    const refused = run({ search: CODE, clipboard: 'refuse' });
    for (const timer of refused.timers) timer();
    refused.elements.copy.click();
    await settle();
    expect(refused.elements.note.textContent).toBe('Couldn’t copy. Select the address in the address bar and copy it.');
    expect(refused.replaced).toEqual([]);

    const missing = run({ search: CODE, clipboard: 'none' });
    missing.elements.copy.click();
    expect(missing.elements.note.textContent).toBe('Couldn’t copy. Select the address in the address bar and copy it.');
  });

  it('asks at once where the browser has no channel', () => {
    const page = run({ search: CODE, channel: false });
    expect(page.state()).toBe('fallback');
    expect(page.timers).toEqual([]);
  });
});

describe('the MCP callback page — nothing to hand over', () => {
  it('says the provider did not finish, and wipes the address, on an error', () => {
    const page = run({ search: '?error=access_denied&error_description=The+user+said+no&state=fixture-state' });
    expect(page.state()).toBe('error');
    expect(page.elements.message.textContent).toBe(
      'The provider did not finish the sign-in. Go back to Ferretry and start again.',
    );
    expect(page.replaced).toEqual([MCP_OAUTH_CALLBACK_PATH]);
    expect(page.channels).toEqual([]);
  });

  it('says there is nothing to finish when opened without a code', () => {
    const page = run({ search: '' });
    expect(page.state()).toBe('empty');
    expect(page.channels).toEqual([]);
  });

  it('carries on when the browser refuses to rewrite its address', () => {
    const page = run({ search: '?error=access_denied', replaceThrows: true });
    expect(page.state()).toBe('error');
  });
});

describe('the MCP callback page — how it is served', () => {
  it('runs one same-origin script and no inline one, as the site policy requires', () => {
    const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gu)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toBe(` src="${MCP_OAUTH_CALLBACK_PATH}.js"`);
    expect(scripts[0]?.[2]).toBe('');
    expect(script).not.toContain('innerHTML');
  });

  it('is what Pages and the service worker answer the callback path with, before the landing fallback', () => {
    const rewrites = parseReleaseRewrites(redirects);
    const files = { 'oauth/mcp-callback.html': 'h', 'oauth/mcp-callback.js': 'j', 'index.html': 'i' };
    expect(releasePathForRequest({ pathname: MCP_OAUTH_CALLBACK_PATH, navigate: true }, files, rewrites)).toBe(
      'oauth/mcp-callback.html',
    );
    expect(releasePathForRequest({ pathname: `${MCP_OAUTH_CALLBACK_PATH}.js`, navigate: false }, files, rewrites)).toBe(
      'oauth/mcp-callback.js',
    );
    const lines = redirects.trim().split('\n');
    expect(lines.indexOf(`${MCP_OAUTH_CALLBACK_PATH} ${MCP_OAUTH_CALLBACK_PATH}.html 200`)).toBe(lines.length - 2);
  });
});
