import { afterEach, describe, expect, test } from 'bun:test';
import { ferret, type TestHost } from '@ferretry/kernel/testing';
import { type InputRaise, type SecretName, targetRef } from '@ferretry/core-vault/contract';
import { FakeInputHolds, FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { Actor, CallContext, FerretId, InputHolds } from '@ferretry/kernel/contract';
import { type ActRecord, TestMintedIds, testActRunner } from '@ferretry/kernel/testing';
import { err, ok } from '@ferretry/std';
import { pageHoldTarget } from '../../../daemon/holds/index.ts';
import { handoverHost } from '../../support/handover-host.ts';
import type { Tabs } from '../../support/tabs.ts';
import { TypedIdentities } from '../../../daemon/target/sign-in/identities.ts';
import {
  type ActedPage,
  type PageCaller,
  type PageInputAction,
  type PageInputOutcome,
  type PageToolDeps,
  type PageToolHost,
  pageInputTools,
  type ResolvedPage,
} from '../../../daemon/target/tools/index.ts';

const FERRET = 'f1' as FerretId;
const PAGE: ResolvedPage = { id: 'pg-1', name: 'app' };
const CALL = {} as CallContext;
const SECRET = 'hunter2-the-value';

interface World {
  readonly holds: FakeInputHolds;
  readonly acts: ActRecord[];
  readonly typed: PageInputAction[];
  readonly asked: (string | undefined)[];
  readonly raised: InputRaise[];
  readonly placed: (ActedPage | undefined)[];
  readonly told: string[];
  readonly identities: TypedIdentities;
  readonly tools: ReturnType<typeof pageInputTools>;
}

/** The four tools over the kernel's test act runner, the Vault's fake holds and redaction, and a fake browser. */
function world(
  options: {
    readonly caller?: PageCaller | undefined;
    readonly actor?: Actor;
    readonly outcome?: PageInputOutcome;
    readonly fails?: Error;
    readonly noHolds?: true;
    readonly raise?: 'refuse';
    /** Runs inside the act, before it answers or fails: a hold that begins while the page is being driven. */
    readonly during?: (holds: FakeInputHolds) => void;
  } = {},
): World {
  const holds = new FakeInputHolds();
  const acts: ActRecord[] = [];
  const typed: PageInputAction[] = [];
  const asked: (string | undefined)[] = [];
  const raised: InputRaise[] = [];
  const placed: (ActedPage | undefined)[] = [];
  const told: string[] = [];
  const caller: PageCaller | undefined =
    'caller' in options ? options.caller : { kind: 'agent', ferret: FERRET, name: 'kit' };
  const host: PageToolHost = {
    caller: () => caller,
    resolve: async (_caller, key) => {
      told.push(`resolve:${key}`);
      if (key !== 'app' && key !== 'pg-1') throw new Error(`there is no page ${key} in this session`);
      return PAGE;
    },
    act: async (_caller, _page, action) => {
      told.push('act');
      typed.push(action);
      options.during?.(holds);
      if (options.fails !== undefined) throw options.fails;
      return options.outcome ?? {};
    },
    askOwner: async (_caller, _page, message) => {
      asked.push(message);
    },
    actedPage: async (_caller, page) => ({ id: page.id, hosts: ['accounts.example.test'] }),
  };
  const identities = new TypedIdentities(() => 1_000);
  const deps: PageToolDeps = {
    kernel: {
      act: testActRunner({
        holds: () => (options.noHolds === true ? undefined : (holds as InputHolds)),
        actor: () => options.actor ?? 'ferret',
        minted: new TestMintedIds(),
        record: entry => acts.push(entry),
      }),
      redaction: new FakeRedaction(new Map([['PW' as SecretName, SECRET]])),
    },
    host,
    identities,
    vault: {
      raiseInput: async (_ferret, raise) => {
        raised.push(raise);
        return options.raise === 'refuse' ? err('three requests are already pending') : ok('a'.repeat(32));
      },
    },
    acts: {
      acted: (_ferret, script) => {
        told.push(`acted:${String(script)}`);
        return { placed: page => placed.push(page) };
      },
    },
  };
  return { holds, acts, typed, asked, raised, placed, told, identities, tools: pageInputTools(deps) };
}

const TYPE = { name: 'app', ref: 'e3', text: 'kit@example.test' };
const FILL = { name: 'app', fields: [{ ref: 'e3', text: 'kit@example.test' }] };
const target = pageHoldTarget(PAGE.id);

describe('browser_type and browser_fill_form', () => {
  test('type and fill act through kernel.act on the page hold target with their declared Op', async () => {
    const w = world();
    expect((await w.tools.browser_type(CALL, TYPE)).isError).toBeUndefined();
    expect((await w.tools.browser_fill_form(CALL, FILL)).isError).toBeUndefined();
    expect(w.acts.map(a => `${String(a.target.kind)}:${a.target.key}:${a.op}:${String(a.outcome)}`)).toEqual([
      'page:pg-1:type:ran',
      'page:pg-1:fill:ran',
    ]);
  });

  test('the answer is a fixed sentence, never what the page holds or where it went', async () => {
    const w = world({ outcome: { identifierHost: 'accounts.example.test' } });
    const answer = await w.tools.browser_type(CALL, TYPE);
    expect(answer.text).toBe('Done on %browser:app.');
  });

  test('a type or fill into a password field answers the same strict Done, saying nothing of the field', async () => {
    const w = world({ outcome: { passwordField: true } });
    expect(await w.tools.browser_type(CALL, TYPE)).toEqual({ text: 'Done on %browser:app.' });
    expect(await w.tools.browser_fill_form(CALL, FILL)).toEqual({ text: 'Done on %browser:app.' });
  });

  test('a body that names no element, or two, is refused before anything runs', async () => {
    const w = world();
    const none = await w.tools.browser_type(CALL, { name: 'app', text: 'x' });
    const both = await w.tools.browser_type(CALL, { name: 'app', ref: 'e3', selector: '#u', text: 'x' });
    expect(none.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(w.typed).toHaveLength(0);
  });

  test('I118 a pending card with a non-code field refuses browser_type and browser_fill_form on that page', async () => {
    const w = world();
    w.holds.pendingCard(target, { codeOnly: false });
    const typed = await w.tools.browser_type(CALL, TYPE);
    const filled = await w.tools.browser_fill_form(CALL, FILL);
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain('an input request is pending on %browser:app');
    expect(filled.isError).toBe(true);
    expect(w.typed).toHaveLength(0);
  });

  test('I118 a code-only card keeps I32: browser_type goes through, browser_fill_form waits', async () => {
    const w = world();
    w.holds.pendingCard(target, { codeOnly: true });
    expect((await w.tools.browser_type(CALL, TYPE)).isError).toBeUndefined();
    expect((await w.tools.browser_fill_form(CALL, FILL)).isError).toBe(true);
    expect(w.typed.map(action => action.action)).toEqual(['type']);
  });

  test('I116 a page hold refuses no write: typing and filling still land on a held page', async () => {
    const w = world();
    w.holds.pageHold(target, { onHeldDocument: true });
    expect((await w.tools.browser_type(CALL, TYPE)).isError).toBeUndefined();
    expect((await w.tools.browser_fill_form(CALL, FILL)).isError).toBeUndefined();
  });

  test('I119 the hold is decided inside the page queue for every caller, owner-tools included', async () => {
    const w = world({ caller: { kind: 'person', ferret: FERRET }, actor: 'owner-tools' });
    w.holds.pendingCard(target, { codeOnly: false });
    expect((await w.tools.browser_type(CALL, TYPE)).isError).toBe(true);
    expect(w.acts).toEqual([{ target, op: 'type', actor: 'owner-tools', outcome: { refused: 'input_pending' } }]);
  });

  test('I119 with no InputHolds bound every act fails closed and nothing is typed', async () => {
    const w = world({ noHolds: true });
    const answer = await w.tools.browser_type(CALL, TYPE);
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe('The hold check is unavailable, so nothing may act here.');
    expect(w.typed).toHaveLength(0);
  });

  test('I120 a failure under a hold that began meanwhile answers with the hold, not the error', async () => {
    // The hold begins while the act runs, and the act then fails: the failure is answered with the hold.
    const w = world({
      fails: new Error(`the page said ${SECRET}`),
      during: holds => holds.pendingCard(target, { codeOnly: false }),
    });
    const answer = await w.tools.browser_type(CALL, TYPE);
    expect(w.typed).toHaveLength(1);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('an input request is pending');
    expect(answer.text).not.toContain(SECRET);
  });

  test('I120 any other failure passes the redactor: a value it echoes is masked', async () => {
    const w = world({ fails: new Error(`the page said ${SECRET}`) });
    const answer = await w.tools.browser_type(CALL, TYPE);
    expect(answer.isError).toBe(true);
    expect(answer.text).not.toContain(SECRET);
    expect(answer.text).toContain('the page said');
  });

  test('I121 page holds use their own names: a hold on terminal app never touches page app', async () => {
    const w = world();
    w.holds.pendingCard(targetRef('terminal', 'app'), { codeOnly: false });
    w.holds.pendingCard(targetRef('page', 'app'), { codeOnly: false });
    // The page is held by its daemon id, so neither a terminal nor a name another page once had seals it.
    expect((await w.tools.browser_type(CALL, TYPE)).isError).toBeUndefined();
  });

  test('I154 an identifier typed by the ferret is kept for that page and host; a password field is never kept', async () => {
    const w = world({ outcome: { identifierHost: 'accounts.example.test' } });
    await w.tools.browser_type(CALL, TYPE);
    expect(w.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBe('kit@example.test');
    const secret = world({ outcome: { identifierHost: 'accounts.example.test', passwordField: true } });
    await secret.tools.browser_type(CALL, TYPE);
    expect(secret.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBeUndefined();
  });

  test('I154 one identifier box of a form is kept; two, or a person filling, is not', async () => {
    const one = world({ outcome: { identifierFields: [{ index: 0, host: 'accounts.example.test' }] } });
    await one.tools.browser_fill_form(CALL, FILL);
    expect(one.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBe('kit@example.test');
    const two = world({
      outcome: {
        identifierFields: [
          { index: 0, host: 'accounts.example.test' },
          { index: 1, host: 'accounts.example.test' },
        ],
      },
    });
    await two.tools.browser_fill_form(CALL, {
      name: 'app',
      fields: [
        { ref: 'e3', text: 'kit@example.test' },
        { ref: 'e4', text: 'other@example.test' },
      ],
    });
    expect(two.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBeUndefined();
    const person = world({
      caller: { kind: 'person', ferret: FERRET },
      outcome: { identifierHost: 'accounts.example.test' },
    });
    await person.tools.browser_type(CALL, TYPE);
    expect(person.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBeUndefined();
  });

  test('I155 an act that failed partway clears who the page signs in', async () => {
    const w = world({ fails: new Error('the worker fell over') });
    w.identities.typed(FERRET, PAGE.id, 'accounts.example.test', 'kit@example.test');
    await w.tools.browser_type(CALL, TYPE);
    expect(w.identities.at(FERRET, PAGE.id, 'accounts.example.test')).toBeUndefined();
  });

  test('I100 a ferret act is told before it runs and placed on its page only once the call is over', async () => {
    const w = world();
    await w.tools.browser_type(CALL, TYPE);
    expect(w.told).toEqual(['acted:false', 'resolve:app', 'act']);
    expect(w.placed).toEqual([{ id: 'pg-1', hosts: ['accounts.example.test'] }]);
  });

  test('I100 an act on a page that cannot be looked up is placed nowhere, so it counts on every page', async () => {
    const w = world();
    await w.tools.browser_type(CALL, { ...TYPE, name: 'gone' });
    expect(w.placed).toEqual([undefined]);
  });

  test('I99 an act refused by a hold is still told, and placed on the page it was aimed at', async () => {
    const w = world();
    w.holds.pendingCard(target, { codeOnly: false });
    await w.tools.browser_fill_form(CALL, FILL);
    expect(w.told).toEqual(['acted:false', 'resolve:app']);
    expect(w.placed).toEqual([{ id: 'pg-1', hosts: ['accounts.example.test'] }]);
  });

  test('a person act is never told to the sign-in lock', async () => {
    const w = world({ caller: { kind: 'person', ferret: FERRET } });
    await w.tools.browser_type(CALL, TYPE);
    expect(w.told).toEqual(['resolve:app', 'act']);
  });
});

describe('browser_request_input', () => {
  const REQUEST = {
    name: 'app',
    prompt: 'Sign in to the dashboard',
    fields: [
      { id: 'user', sensitivity: 'plain', ref: 'e3' },
      { id: 'password', label: 'Password', sensitivity: 'secret', selector: '#pw' },
    ],
  };

  test('raises a card through the Vault on the page, each field with its element, never a value', async () => {
    const w = world();
    const answer = await w.tools.browser_request_input(CALL, REQUEST);
    expect(answer.text).toBe(
      `Asked the owner for 2 values (${'a'.repeat(32)}) for %browser:app. Wait with input_wait; do not type into those fields yourself.`,
    );
    expect(w.raised).toEqual([
      {
        target: { kind: 'page', key: 'app' },
        prompt: 'Sign in to the dashboard',
        fields: [
          { id: 'user', sensitivity: 'plain', element: { kind: 'ref', ref: 'e3' } },
          { id: 'password', label: 'Password', sensitivity: 'secret', element: { kind: 'selector', selector: '#pw' } },
        ],
        submit: 'offer-owner',
      },
    ]);
    expect(w.acts).toHaveLength(0);
  });

  test('only a ferret asks; a refused raise answers the Vault sentence', async () => {
    expect(
      (await world({ caller: { kind: 'person', ferret: FERRET } }).tools.browser_request_input(CALL, REQUEST)).text,
    ).toBe('Only an agent asks its owner for values; you already have the page.');
    const refused = await world({ raise: 'refuse' }).tools.browser_request_input(CALL, REQUEST);
    expect(refused).toEqual({ text: 'three requests are already pending', isError: true });
  });

  test('a push approval with no approvals bound says so, and raises nothing', async () => {
    const w = world();
    const answer = await w.tools.browser_request_input(CALL, { push: true, name: 'app' });
    expect(answer.isError).toBe(true);
    expect(w.raised).toHaveLength(0);
  });

  test('two fields with one id are refused', async () => {
    const answer = await world().tools.browser_request_input(CALL, {
      ...REQUEST,
      fields: [REQUEST.fields[0], REQUEST.fields[0]],
    });
    expect(answer.isError).toBe(true);
  });
});

describe('browser_ask_owner', () => {
  test('hands the page to the owner with what to do, and acts on nothing', async () => {
    const w = world();
    const answer = await w.tools.browser_ask_owner(CALL, { name: 'app', message: 'Solve the check, please' });
    expect(answer.text).toBe(
      'Asked the owner to take over %browser:app and told them what to do. Wait for them: read the surface to see when they are done.',
    );
    expect(w.asked).toEqual(['Solve the check, please']);
    expect(w.acts).toHaveLength(0);
  });

  test('a person already has the page; a caller the daemon cannot place is refused', async () => {
    expect(
      (await world({ caller: { kind: 'person', ferret: FERRET } }).tools.browser_ask_owner(CALL, { name: 'app' }))
        .isError,
    ).toBe(true);
    expect((await world({ caller: undefined }).tools.browser_ask_owner(CALL, { name: 'app' })).isError).toBe(true);
  });

  test('a page of another session is not there, and the sentence names nothing else', async () => {
    const answer = await world().tools.browser_ask_owner(CALL, { name: 'other' });
    expect(answer).toEqual({ text: 'there is no page other in this session', isError: true });
  });
});

/**
 * The four tools over the REAL browser tools and daemon half, on a page a person took over: the checks the page tools
 * make are the browser tools' own (`pageToolHost`), so a held page is refused here exactly as it is by `browser_click`.
 */
describe('a page a person took over', () => {
  const TAKEN = 'A person has taken over %browser:app; wait or ask them.';
  let running: TestHost | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  async function opened(): Promise<{ host: TestHost; tabs: Tabs }> {
    const world = await handoverHost();
    running = world.host;
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, world.as('f1'));
    return world;
  }

  const control = (host: TestHost, action: 'takeover' | 'handback') =>
    host.request('POST', '/v1/sessions/f1/surfaces/browser/control', { body: { action, key: 'app' } });

  test('browser_type, browser_fill_form, browser_request_input and browser_ask_owner are all refused as taken over', async () => {
    const { host, tabs } = await opened();
    expect((await control(host, 'takeover')).status).toBe(200);
    const as = { as: ferret('f1') };

    const answers = [
      await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as),
      await host.tool('browser_fill_form', { name: 'app', fields: [{ selector: '#user', text: 'alice' }] }, as),
      await host.tool(
        'browser_request_input',
        { name: 'app', prompt: 'Sign in', fields: [{ id: 'pw', sensitivity: 'secret', selector: '#pw' }] },
        as,
      ),
      await host.tool('browser_ask_owner', { name: 'app', message: 'Your turn' }, as),
    ];

    expect(answers.map(answer => answer.isError)).toEqual([true, true, true, true]);
    expect(answers.map(answer => answer.text)).toEqual([TAKEN, TAKEN, TAKEN, TAKEN]);
    expect(tabs.typed).toEqual([]);
  });

  test('the same four tools work again once the person hands the page back', async () => {
    const { host, tabs } = await opened();
    await control(host, 'takeover');
    await control(host, 'handback');
    const as = { as: ferret('f1') };

    const typed = await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as);
    const asked = await host.tool('browser_ask_owner', { name: 'app' }, as);

    expect(typed).toEqual({ text: 'Done on %browser:app.' });
    expect(asked.isError).toBeUndefined();
    expect(tabs.typed).toEqual([{ pageId: 'p1', text: 'alice' }]);
  });

  test('a type already queued behind another act when the person takes the page over is refused inside the page’s queue', async () => {
    const { host, tabs } = await opened();
    const as = { as: ferret('f1') };
    // A click holds the page's queue; the type waits its turn behind it, having already passed the first check.
    const turn = () => new Promise<void>(resolve => setImmediate(resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let inPage: () => void = () => undefined;
    const clickInPage = new Promise<void>(resolve => {
      inPage = resolve;
    });
    const click = tabs.automation.click;
    tabs.automation.click = async (...args) => {
      inPage();
      await gate;
      return await click(...args);
    };
    const clicking = host.tool('browser_click', { name: 'app', selector: '#go' }, as);
    await clickInPage;
    const typing = host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as);
    await turn();

    // Act — the takeover lands while the type is queued.
    expect((await control(host, 'takeover')).status).toBe(200);
    release();
    const [clicked, typed] = await Promise.all([clicking, typing]);

    // Assert
    expect(clicked.isError).toBeUndefined();
    expect(typed.isError).toBe(true);
    expect(typed.text).toBe(TAKEN);
    expect(tabs.typed).toEqual([]);
  });
});
