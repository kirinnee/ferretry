import { describe, expect, test } from 'bun:test';
import { showsSomething } from '@ferretry/kernel/contract';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const tools = manifest.actions.agentTools;

describe('browsers manifest', () => {
  test("declares today's browser, login-window, proxy and surface routes, the open-url route (G27) and the page stream", () => {
    expect(routes).toHaveLength(10);
    expect(manifest.actions.sockets.map(socket => socket.key)).toEqual(['GET /v1/ferrets/:ferretId/browser/stream']);
  });
  test('the page stream and the per-ferret browser are built inside one Redaction.read', () => {
    expect(manifest.actions.sockets[0]?.guard).toBe('secrets');
    expect(routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/browser')?.guard).toBe('secrets');
  });
  test("declares today's 29 browser tools; an act that shows something is guarded, a write answers an Ack", () => {
    expect(tools).toHaveLength(29);
    for (const entry of tools) {
      if (entry.op === undefined) continue;
      expect(entry.guard === 'secrets').toBe(showsSomething(entry.op));
    }
    expect(tools.find(entry => entry.name === 'browser_eval')?.op).toBe('script');
  });
  test('a ferret may never test the proxy (it dials out with stored credentials)', () => {
    expect(routes.find(route => route.key === 'POST /v1/browser/proxy/test')?.caller).toBe('person');
  });
  describe("browsers.yaml holds a new or re-aimed proxy for the owner (today's browserProxyLoosening)", () => {
    const def = manifest.data.config.find(entry => entry.shape === 'file' && entry.file === 'browsers.yaml');
    const loosens = (before: unknown, after: unknown): readonly string[] =>
      (def as unknown as { loosens: (b: unknown, a: unknown) => readonly string[] }).loosens(before, after);
    const proxy = { url: 'http://proxy.example:8080', bypass: [] as string[] };
    const sentence = 'the agent browser now sends its traffic through the proxy at ';

    test('a proxy newly set, on a first file or an existing one, is held', () => {
      expect(loosens(undefined, { mode: 'headless', proxy })).toEqual([`${sentence}${proxy.url}`]);
      expect(loosens({ mode: 'headless' }, { mode: 'headless', proxy })).toEqual([`${sentence}${proxy.url}`]);
    });
    test('a proxy re-aimed, or given other credentials, is held', () => {
      const before = { mode: 'headless', proxy };
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, url: 'http://other.example:8080' } })).toEqual([
        `${sentence}http://other.example:8080`,
      ]);
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, username: '${secret:PROXY_USER}' } })).toHaveLength(
        1,
      );
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, password: '${secret:PROXY_PASS}' } })).toHaveLength(
        1,
      );
    });
    const stealthSentence = 'the agent browser now passes bot checks and solves captchas for the owner’s identities';
    test('stealth going off → on is held, on a first file or an existing one', () => {
      expect(loosens(undefined, { mode: 'headless', stealth: 'on' })).toEqual([stealthSentence]);
      expect(loosens({ mode: 'headless', stealth: 'off' }, { mode: 'headless', stealth: 'on' })).toEqual([
        stealthSentence,
      ]);
      expect(loosens({ mode: 'headless' }, { mode: 'headless', stealth: 'on' })).toEqual([stealthSentence]);
    });
    test('stealth going on → off, or staying where it was, applies at once', () => {
      expect(loosens({ mode: 'headless', stealth: 'on' }, { mode: 'headless', stealth: 'off' })).toEqual([]);
      expect(loosens({ mode: 'headless', stealth: 'on' }, { mode: 'window', stealth: 'on' })).toEqual([]);
      expect(loosens(undefined, { mode: 'headless', stealth: 'off' })).toEqual([]);
    });
    const identitySentence = 'an identity that opted out of stealth now passes bot checks and solves captchas too';
    test('an identity opting out is a tightening; dropping the opt-out while stealth is on is held, under its own sentence', () => {
      const optedOut = { mode: 'headless', stealth: 'on', identities: { work: { stealth: false } } };
      expect(loosens({ mode: 'headless', stealth: 'on' }, optedOut)).toEqual([]);
      // Not the machine switch's sentence: the Browser tab reads that one as "the switch itself is waiting".
      expect(loosens(optedOut, { mode: 'headless', stealth: 'on' })).toEqual([identitySentence]);
      expect(loosens(optedOut, { mode: 'headless', stealth: 'on', identities: { work: {} } })).toEqual([
        identitySentence,
      ]);
      // Off overall, an identity entry changes nothing.
      expect(loosens(optedOut, { mode: 'headless', stealth: 'off' })).toEqual([]);
    });
    test('a proxy and stealth newly set together are two sentences', () => {
      expect(loosens(undefined, { mode: 'headless', proxy, stealth: 'on' })).toEqual([
        `${sentence}${proxy.url}`,
        stealthSentence,
      ]);
    });
    test('removing the proxy, or editing only its bypass list or the mode, hands an agent nothing', () => {
      const before = { mode: 'headless', proxy };
      expect(loosens(before, { mode: 'headless' })).toEqual([]);
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, bypass: ['<local>'] } })).toEqual([]);
      expect(loosens(before, { mode: 'headed', proxy })).toEqual([]);
      expect(loosens(undefined, { mode: 'headless' })).toEqual([]);
    });
  });
  test('takes the page input target and the %browser reference menu', () => {
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'input.targets:page',
      'reference.catalog:%browser',
    ]);
  });
});
