import { expect, test } from 'bun:test';
import { DaemonClient } from '@ferretry/app/testing';
import { AccountsSurface } from '../../../app/features/accounts/accounts-surface.tsx';
import { buttonNamed, click, mount, q, settle, settleUntil } from '../../support/app-dom.ts';
import { EXPIRES, FAKE_USER_CODE, hubot, NOW } from '../../support/scripted-github.ts';

/** The smallest compiled package the client needs: an id, a contract hash and the routes it may call. */
function surface(id: string, routes: readonly string[] = [], core = false) {
  const entry = (key: string) => ({ key, minimum: 'authenticated', caller: 'any', audit: 'skip' });
  const manifest = {
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core,
    kinds: [],
    actions: { routes: routes.map(entry), sockets: [] },
  };
  return { id, title: id, core, contract: `h-${id}`, consumes: [], manifest };
}
const CORE = ['kernel', 'gate', 'vault', 'ferrets', 'asks'].map(id => surface(id, [], true));
const inventoryOf = (entries: readonly { id: string; contract: string }[]) => ({
  protocol: 1,
  plugins: entries.map(entry => ({ id: entry.id, on: true, contract: entry.contract })),
});
const json = (body: unknown, status = 200) => ({ status, headers: {}, body });
interface Request {
  readonly method: string;
  readonly path: string;
}

/** A scripted transport: records every request and answers from a handler; the event feed and sockets stay silent. */
class FakeTransport {
  readonly requests: Request[] = [];
  constructor(readonly answer: (request: Request) => ReturnType<typeof json>) {}
  async request(request: Request) {
    this.requests.push(request);
    return this.answer(request);
  }
  events() {
    return () => {};
  }
  socket() {
    return { send: () => {}, close: () => {} };
  }
  onReconnect() {
    return () => {};
  }
  paths() {
    return this.requests.map(request => `${request.method} ${request.path}`);
  }
}
const list = 'GET /v1/git-accounts';
const start = 'POST /v1/git-accounts/github/device';
const poll = 'GET /v1/git-accounts/github/device/:flowId';
const flowId = 'flow_0123456789abcdef';
const surfaces = [...CORE, surface('git-accounts', [list, start, poll])];
const grants = Object.freeze({ 'secrets.configure': 'confirm', 'secrets.use': 'allow', stepUpWindowMinutes: 0 });
const codeSelector = '[data-testid="git-user-code"]';
const confirmSelector = '[data-testid="git-step-up"]';

for (const scenario of [
  { name: 'idle browser after Continue', active: false, forceQuiet: false },
  { name: 'unrelated click on the visible GitHub code', active: true, forceQuiet: false },
  { name: 'unrelated click with quiet:true on the timer request', active: true, forceQuiet: true },
]) {
  test(scenario.name, async () => {
    let proof = false;
    let connected = false;
    let personActing = false;
    const prompts: string[] = [];
    const transport = new FakeTransport(request => {
      if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      if (request.method === 'GET' && request.path === '/v1/grants') return json(grants);
      const route = `${request.method} ${request.path}`;
      if (route === list) return json(connected ? [hubot] : []);
      if (route !== start && route !== poll.replace(':flowId', flowId)) throw new Error(`Unexpected ${route}`);
      if (!proof) return json({ code: 'grant_step_up_required', error: 'Confirm with your passkey' }, 403);
      proof = false;
      if (route === start)
        return json({
          provider: 'github',
          flowId,
          userCode: FAKE_USER_CODE,
          expiresAt: EXPIRES,
          verificationUri: 'https://github.com/login/device',
          interval: 1,
        });
      connected = true;
      return json({ status: 'done', accountId: hubot.id, login: hubot.login });
    });
    const client = new DaemonClient({
      transport,
      surfaces: surfaces as never, // the minimal entries above stand in for the app's registry type
      personActing: () => personActing,
      passkey: {
        daemon: { daemonId: 'fake', name: 'fake' } as never,
        handler: {
          need: refusal => (refusal.status === 403 ? { kind: 'step-up' } : undefined),
          confirm: async (_daemon, _need, origin) => {
            prompts.push(origin);
            proof = true;
            return true;
          },
          ask: async () => false,
          focus: () => {},
          locked: () => [],
          subscribe: () => () => {},
        },
      },
    });
    await client.start();
    const plugin = client.forPackage('git-accounts');
    const mounted = await mount(
      <AccountsSurface
        client={
          scenario.forceQuiet
            ? {
                call: (route, init) =>
                  plugin.call(route, route === poll && init?.quiet !== false ? { ...init, quiet: true } : init),
              }
            : plugin
        }
        pollDelay={() => 100}
        now={() => NOW}
      />,
    );
    try {
      const before = (await client.readGrants({ noPause: true })).answer?.body;
      await settle();
      await click(buttonNamed(mounted.container, 'Connect a GitHub account'));
      await click(buttonNamed(mounted.container, 'Continue to GitHub'));
      expect(q(mounted.container, codeSelector).textContent).toBe(FAKE_USER_CODE);
      expect(prompts).toEqual(['explicit']);
      if (scenario.active) {
        personActing = true;
        await click(q(mounted.container, codeSelector));
      }
      await settleUntil(() => mounted.container.querySelector(confirmSelector) !== null || prompts.length > 1);
      expect(prompts).toEqual(['explicit']);
      expect(q(mounted.container, codeSelector).textContent).toBe(FAKE_USER_CODE);
      expect(mounted.container.querySelector(confirmSelector)).not.toBeNull();
      await click(buttonNamed(mounted.container, 'Confirm with your passkey to finish'));
      expect(prompts).toEqual(['explicit', 'explicit']);
      expect(q(mounted.container, '[data-testid="git-done"]').textContent).toContain('Connected @hubot-fake');
      const paths = transport.paths();
      expect(paths.filter(path => path === start)).toHaveLength(2); // One refusal, one confirmed start.
      expect(paths.filter(path => path.startsWith('GET /v1/git-accounts/github/device/'))).toEqual(
        Array(3).fill(poll.replace(':flowId', flowId)),
      );
      expect((await client.readGrants({ noPause: true })).answer?.body).toEqual(before);
      expect(
        transport.requests.filter(request => request.path === '/v1/grants').every(request => request.method === 'GET'),
      ).toBe(true);
    } finally {
      await mounted.unmount();
      client.stop();
    }
  });
}
