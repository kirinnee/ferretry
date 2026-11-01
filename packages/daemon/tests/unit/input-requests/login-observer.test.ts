import { describe, it } from 'bun:test';
import type { InputRequestField, InputTargetFacts, LoginObservation } from '@ferretry/protocol';
import should from 'should';
import {
  identityOf,
  InputLoginProbe,
  type LoginDelivery,
  LoginObserver,
  maskedAt,
  placeOf,
} from '../../../src/lib/input-requests/login-observer.ts';

const PASSWORD = 'hunter2-UNIQUE-pw';
/** The sign-in the Google account was typed at: where its facts go. */
const SI_GOOGLE = 'si_00000000000000d1';

const page = (type = 'password', navigationId = 'doc-1'): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'p',
  origin: 'https://accounts.google.com',
  secure: true,
  navigationId,
  fields: [
    {
      fieldId: 'value',
      frameOrigin: 'https://accounts.google.com',
      frameId: 'f',
      backendNodeId: 1,
      field: { tag: 'input', type, name: 'Passwd' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
  ],
});

const terminal = (echo: 'off' | 'on' = 'off', recognised = true): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 1 },
  foreground: { pid: 2, pgid: 2, comm: 'sudo', argv: 'sudo -v' },
  echo,
  cursorRow: 0,
  promptLine: '',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: recognised,
});

const field = (sensitivity: InputRequestField['sensitivity']): InputRequestField =>
  ({ id: 'value', sensitivity }) as unknown as InputRequestField;

/** When the write returned in these worlds, and when its request was raised. */
const DELIVERED = 1_000_000;
const RAISED = DELIVERED - 10_000;

/** A clock that moves only when the observer sleeps, and a page that goes where the script says. */
function world(script: {
  shows?: boolean | ((elapsed: number) => boolean | undefined);
  where?: (elapsed: number) => { navigationId: string; host: string } | undefined;
}) {
  let now = DELIVERED;
  const start = now;
  const seen: { id: string; observation: LoginObservation }[] = [];
  const observer = new LoginObserver({
    sink: { observeSignIn: async (id, observation) => void seen.push({ id, observation }) },
    probe: {
      shows: async () => (typeof script.shows === 'function' ? script.shows(now - start) : script.shows),
      where: async () => script.where?.(now - start),
    },
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
  });
  return { observer, seen, advance: (ms: number) => (now += ms) };
}

const delivery = (extra: Partial<LoginDelivery> = {}): LoginDelivery => ({
  sessionId: 's1',
  login: 'GOOGLE',
  signIn: SI_GOOGLE,
  domains: ['accounts.google.com'],
  target: { kind: 'browser', key: 'app' },
  facts: page(),
  fields: [field('secret')],
  secrets: [PASSWORD],
  submitted: true,
  surfaces: ['app', 'page-1'],
  since: RAISED,
  deliveredAt: DELIVERED,
  ...extra,
});

const facts = (seen: readonly { observation: LoginObservation }[]) =>
  Object.assign({}, ...seen.map(entry => entry.observation)) as LoginObservation;

describe('what is seen at the write', () => {
  it('should call a password input on a page masked, and a text input not', () => {
    should(maskedAt(page(), [field('secret')])).be.true();
    should(maskedAt(page('text'), [field('secret')])).be.false();
  });

  it('should call a terminal masked only with echo off and a recognised program', () => {
    should(maskedAt(terminal(), [field('secret')])).be.true();
    should(maskedAt(terminal('on'), [field('secret')])).be.false();
    should(maskedAt(terminal('off', false), [field('secret')])).be.false();
  });

  it('should give a field another identity when what it is changes', () => {
    should(identityOf(page(), 'accounts.google.com')).equal(identityOf(page(), 'accounts.google.com'));
    should(identityOf(page('text'), 'accounts.google.com')).not.equal(identityOf(page(), 'accounts.google.com'));
    should(identityOf(page(), 'accounts.google.com')).match(/^[0-9a-f]{16}$/u);
  });
});

describe('what is seen after a submit', () => {
  it('should record no echo, moving on and no 2FA when the page left the sign-in hosts at once', async () => {
    const w = world({
      shows: false,
      where: elapsed =>
        elapsed < 3_000
          ? { navigationId: 'doc-1', host: 'accounts.google.com' }
          : { navigationId: 'doc-2', host: 'vercel.com' },
    });
    await w.observer.delivered(delivery());
    should(w.seen.every(entry => entry.id === SI_GOOGLE)).be.true();
    should(facts(w.seen)).containDeep({
      at: 'accounts.google.com',
      surface: 'page',
      masked: true,
      noEchoAfterSubmit: true,
      navigatedAway: true,
      secondFactor: 'none',
    });
  });

  it('should record an approval when the page waited on the sign-in host before it left', async () => {
    const w = world({
      shows: false,
      where: elapsed =>
        elapsed < 2_000
          ? { navigationId: 'doc-1', host: 'accounts.google.com' }
          : elapsed < 40_000
            ? { navigationId: 'doc-2', host: 'accounts.google.com' }
            : { navigationId: 'doc-3', host: 'vercel.com' },
    });
    await w.observer.delivered(delivery());
    should(facts(w.seen)).containDeep({ navigatedAway: true, secondFactor: 'push' });
  });

  it('should record a code when a one-time code follows on the same login', async () => {
    let typed: Promise<void> | undefined;
    const w = world({
      shows: false,
      where: elapsed => {
        // The owner types the code the page asks for while the daemon is still watching the password's submit.
        if (elapsed >= 5_000 && typed === undefined)
          typed = w.observer.delivered(
            delivery({
              login: undefined,
              signIn: undefined,
              fields: [field('private')],
              submitted: false,
              facts: page('text', 'doc-2'),
            }),
          );
        return { navigationId: 'doc-2', host: 'accounts.google.com' };
      },
    });
    await w.observer.delivered(delivery());
    await typed;
    const codes = w.seen.filter(entry => entry.observation.secondFactor !== undefined);
    should(codes.map(entry => [entry.id, entry.observation.secondFactor])).deepEqual([[SI_GOOGLE, 'code']]);
  });

  it('should record the value echoed when it shows', async () => {
    const w = world({ shows: true, where: () => ({ navigationId: 'doc-1', host: 'accounts.google.com' }) });
    await w.observer.delivered(delivery());
    should(facts(w.seen)).containDeep({ noEchoAfterSubmit: false, navigatedAway: false });
  });

  it('should keep no after-submit fact when the ferret drove a page meanwhile', async () => {
    const w = world({
      shows: false,
      where: () => {
        w.observer.acted('s1', 'browser');
        return { navigationId: 'doc-2', host: 'vercel.com' };
      },
    });
    await w.observer.delivered(delivery());
    const kept = facts(w.seen);
    should(kept.masked).be.true();
    should(kept).not.have.property('navigatedAway');
    should(kept).not.have.property('secondFactor');
  });

  it('should keep no echo fact for a terminal the ferret typed into before the look', async () => {
    const seen: LoginObservation[] = [];
    const observer: LoginObserver = new LoginObserver({
      sink: { observeSignIn: async (_id, observation) => void seen.push(observation) },
      probe: { shows: async () => false, where: async () => undefined },
      now: () => Date.now(),
      sleep: async () => observer.acted('s1', 'terminal'),
    });
    await observer.delivered(
      delivery({
        target: { kind: 'terminal', key: 'dev' },
        facts: terminal(),
        matchKey: 'sudo@kirin-box',
        domains: [],
      }),
    );
    should(seen).deepEqual([{ at: 'sudo@kirin-box', surface: 'terminal', identity: seen[0]?.identity, masked: true }]);
  });

  it('should record nothing after a write that was not submitted, and nothing for a value no login typed', async () => {
    const w = world({ shows: false });
    await w.observer.delivered(delivery({ submitted: false }));
    should(w.seen.map(entry => Object.keys(entry.observation).sort())).deepEqual([
      ['at', 'identity', 'masked', 'surface'],
    ]);
    const none = world({ shows: false });
    await none.observer.delivered(delivery({ login: undefined, signIn: undefined }));
    should(none.seen).deepEqual([]);
  });

  it('should keep nothing for an account picked by hand where it has no sign-in', async () => {
    const w = world({ shows: false, where: () => ({ navigationId: 'doc-2', host: 'vercel.com' }) });
    await w.observer.delivered(delivery({ signIn: undefined }));
    should(w.seen).deepEqual([]);
  });
});

describe('two accounts that sign in on one host', () => {
  const SI_WORK = 'si_00000000000000d2';

  it('should keep each one’s facts on its own sign-in', async () => {
    const w = world({ shows: false, where: () => ({ navigationId: 'doc-1', host: 'accounts.google.com' }) });
    await w.observer.delivered(delivery({ submitted: false }));
    await w.observer.delivered(
      delivery({ login: 'GOOGLE_WORK', signIn: SI_WORK, facts: page('text'), submitted: false }),
    );
    should(w.seen.map(entry => [entry.id, entry.observation.masked])).deepEqual([
      [SI_GOOGLE, true],
      [SI_WORK, false],
    ]);
  });

  it('should give a code made from one account to that account’s sign-in only', async () => {
    let typed: Promise<void> | undefined;
    const w = world({
      shows: false,
      where: elapsed => {
        if (elapsed >= 5_000 && typed === undefined)
          typed = w.observer.delivered(
            delivery({ fields: [field('private')], submitted: false, facts: page('text', 'doc-2') }),
          );
        return { navigationId: 'doc-2', host: 'accounts.google.com' };
      },
    });
    await Promise.all([
      w.observer.delivered(delivery()),
      w.observer.delivered(delivery({ login: 'GOOGLE_WORK', signIn: SI_WORK })),
    ]);
    await typed;
    const codes = w.seen.filter(entry => entry.observation.secondFactor === 'code').map(entry => entry.id);
    should(codes).deepEqual([SI_GOOGLE]);
  });
});

describe("the daemon's own look for the value", () => {
  it('should answer only whether a value is on the page or the screen', async () => {
    const probe = new InputLoginProbe(
      { where: async () => undefined, text: async () => `Welcome ${PASSWORD}` },
      { screen: async () => 'Password: \n$ ' },
    );
    should(await probe.shows('s', { kind: 'browser', key: 'app' }, ['page-1'], [PASSWORD])).be.true();
    should(await probe.shows('s', { kind: 'terminal', key: 'dev' }, ['t1'], [PASSWORD])).be.false();
    should(await probe.shows('s', { kind: 'terminal', key: 'dev' }, ['t1'], [])).be.undefined();
  });
});

describe('where a delivery’s facts belong', () => {
  const secretStore: InputTargetFacts = { kind: 'secret', name: 'GITHUB_TOKEN', exists: false } as InputTargetFacts;

  it('should keep nothing for a page with no host, nor for the secret store', async () => {
    should(placeOf({ ...page(), origin: 'null' } as InputTargetFacts, undefined)).be.undefined();
    should(placeOf(secretStore, undefined)).be.undefined();
    should(identityOf(secretStore, 'x')).be.undefined();
    should(maskedAt(secretStore, [field('secret')])).be.undefined();
    should(identityOf(terminal(), 'sudo@kirin-box')).match(/^[0-9a-f]{16}$/u);
    const w = world({ shows: false });
    await w.observer.delivered(delivery({ facts: { ...page(), origin: 'null' } as InputTargetFacts }));
    should(w.seen).deepEqual([]);
  });

  it('should pass the page’s place through, and say nothing it could not read', async () => {
    const probe = new InputLoginProbe(
      { where: async () => ({ navigationId: 'n', host: 'h' }), text: async () => undefined },
      undefined,
    );
    should(await probe.where('s', 'app', ['page-1'])).deepEqual({ navigationId: 'n', host: 'h' });
    should(await probe.shows('s', { kind: 'browser', key: 'app' }, ['page-1'], [PASSWORD])).be.undefined();
    should(await probe.shows('s', { kind: 'terminal', key: 'dev' }, ['t1'], [PASSWORD])).be.undefined();
    should(await probe.shows('s', { kind: 'secret', key: 'X' }, [], [PASSWORD])).be.undefined();
  });
});

describe('what the ferret could have steered', () => {
  const away = { navigationId: 'doc-2', host: 'vercel.com' };

  it('should void the after-submit facts for an act made after the raise, even before the write', async () => {
    const w = world({ shows: false, where: () => away });
    w.observer.acted('s1', 'browser');
    await w.observer.delivered(delivery({ since: DELIVERED - 1 }));
    should(facts(w.seen)).not.have.property('noEchoAfterSubmit');
    should(facts(w.seen)).not.have.property('navigatedAway');
  });

  it('should keep them for an act made before the request was raised', async () => {
    const w = world({ shows: false, where: () => away });
    w.observer.acted('s1', 'browser');
    await w.observer.delivered(delivery({ since: DELIVERED + 1 }));
    should(facts(w.seen)).containDeep({ noEchoAfterSubmit: true, navigatedAway: true });
  });

  it('should never keep a page fact for a session that ran a page script, whenever it ran', async () => {
    const w = world({ shows: false, where: () => away });
    w.observer.acted('s1', 'browser', true);
    await w.observer.delivered(delivery({ since: DELIVERED + 1 }));
    should(facts(w.seen)).not.have.property('navigatedAway');
    should(w.observer.sessions()).deepEqual(['s1']);
    w.observer.forget('s1');
    should(w.observer.sessions()).deepEqual([]);
  });

  it('should say nothing about the page moving when the page under the name is no longer the one typed into', async () => {
    const w = world({ shows: false, where: () => undefined });
    await w.observer.delivered(delivery());
    const kept = facts(w.seen);
    should(kept.noEchoAfterSubmit).be.true();
    should(kept).not.have.property('navigatedAway');
    should(kept).not.have.property('secondFactor');
  });

  it('should look twice, and count a value that shows on the second look', async () => {
    const w = world({ shows: elapsed => elapsed >= 5_000, where: () => away });
    await w.observer.delivered(delivery());
    should(facts(w.seen).noEchoAfterSubmit).be.false();
    const blind = world({ shows: () => undefined, where: () => away });
    await blind.observer.delivered(delivery());
    should(facts(blind.seen)).not.have.property('noEchoAfterSubmit');
  });
});

describe('each fact is decided at its own moment', () => {
  it('should keep the page moving on and the second factor, decided before a later act, and drop the echo decided after it', async () => {
    let now = DELIVERED;
    const seen: LoginObservation[] = [];
    let release: () => void = () => undefined;
    const echoLooked = new Promise<void>(resolve => {
      release = resolve;
    });
    const observer: LoginObserver = new LoginObserver({
      sink: {
        observeSignIn: async (_id, observation) => {
          seen.push(observation);
          // The ferret acts once the page has left the sign-in hosts, before the echo looks are in.
          if (observation.secondFactor !== undefined) {
            observer.acted('s1', 'browser');
            release();
          }
        },
      },
      probe: {
        shows: async () => {
          await echoLooked;
          return false;
        },
        where: async () => ({ navigationId: 'doc-2', host: 'vercel.com' }),
      },
      now: () => now,
      sleep: async ms => {
        now += ms;
      },
    });
    await observer.delivered(delivery());
    const kept = Object.assign({}, ...seen) as LoginObservation;
    should(kept).containDeep({ navigatedAway: true, secondFactor: 'none' });
    should(kept).not.have.property('noEchoAfterSubmit');
  });

  it('should record a page that stayed put through its window as not moving on', async () => {
    const w = world({ shows: false, where: () => ({ navigationId: 'doc-1', host: 'accounts.google.com' }) });
    await w.observer.delivered(delivery());
    should(facts(w.seen)).containDeep({ navigatedAway: false, noEchoAfterSubmit: true });
    should(facts(w.seen)).not.have.property('secondFactor');
  });

  it('should say nothing about the echo when only one look could tell', async () => {
    const w = world({
      shows: elapsed => (elapsed < 5_000 ? false : undefined),
      where: () => ({ navigationId: 'doc-2', host: 'vercel.com' }),
    });
    await w.observer.delivered(delivery());
    should(facts(w.seen)).not.have.property('noEchoAfterSubmit');
  });

  it('should keep no after-submit fact when the raise time cannot be read', async () => {
    const w = world({ shows: false, where: () => ({ navigationId: 'doc-2', host: 'vercel.com' }) });
    await w.observer.delivered(delivery({ since: Number.NaN }));
    should(facts(w.seen)).not.have.property('navigatedAway');
    should(facts(w.seen)).not.have.property('noEchoAfterSubmit');
  });
});

describe('whether the ferret could have steered a surface, for the lock', () => {
  it('should count a page script ever run, an act since a time, and an unreadable time', () => {
    const w = world({});
    should(w.observer.tainted('s1', 'browser', 0)).be.false();
    w.observer.acted('s1', 'terminal');
    should(w.observer.tainted('s1', 'terminal', DELIVERED)).be.true();
    should(w.observer.tainted('s1', 'terminal', DELIVERED + 1)).be.false();
    should(w.observer.tainted('s1', 'browser', Number.NaN)).be.true();
    w.observer.acted('s1', 'browser', true);
    should(w.observer.tainted('s1', 'browser', Number.POSITIVE_INFINITY)).be.true();
    should(w.observer.tainted('s1', 'terminal', Number.POSITIVE_INFINITY)).be.false();
  });
});

describe('checked by use: did a code Ferretry made go through?', () => {
  const FACTOR = 'tf_0000000000a1';
  /** A world whose terminal shows `line` at the cursor, and whose sink keeps each verdict on a key. */
  function checking(script: {
    where?: (elapsed: number) => { navigationId: string; host: string } | undefined;
    line?: (elapsed: number) => string | undefined;
  }) {
    let now = DELIVERED;
    const verdicts: unknown[][] = [];
    const observer = new LoginObserver({
      sink: {
        observeSignIn: async () => undefined,
        checkedByUse: async (...args) => void verdicts.push(args),
      },
      probe: {
        shows: async () => undefined,
        where: async () => script.where?.(now - DELIVERED),
        ...(script.line === undefined ? {} : { prompt: async () => script.line?.(now - DELIVERED) }),
      },
      now: () => now,
      sleep: async ms => {
        now += ms;
      },
    });
    return { observer, verdicts, at: (ms: number) => (now = DELIVERED + ms) };
  }
  const code = (facts: InputTargetFacts, target: LoginDelivery['target']) => ({
    sessionId: 's1',
    account: 'GITHUB',
    factor: FACTOR,
    target,
    facts,
    surfaces: ['app', 'page-1'],
    deliveredAt: DELIVERED,
  });
  const onPage = code(page('text'), { kind: 'browser', key: 'app' });
  const prompt = { ...terminal(), promptLine: 'Verification code:' } as InputTargetFacts;
  const atPrompt = code(prompt, { kind: 'terminal', key: 'dev' });

  it('should call a code that moved the page within the window one that worked, and keep it on the key', async () => {
    const w = checking({
      where: elapsed => ({ navigationId: elapsed >= 3_000 ? 'doc-2' : 'doc-1', host: 'github.com' }),
    });
    should(await w.observer.codeTyped(onPage)).be.true();
    should(w.verdicts).deepEqual([['GITHUB', FACTOR, true]]);
  });

  it('should call a page that stayed for the whole window a code that did not', async () => {
    const w = checking({ where: () => ({ navigationId: 'doc-1', host: 'github.com' }) });
    should(await w.observer.codeTyped(onPage)).be.false();
    should(w.verdicts).deepEqual([['GITHUB', FACTOR, false]]);
  });

  it('should keep nothing when the ferret acted on a page since the write, ran a script, or the page went away', async () => {
    const acted = checking({ where: () => ({ navigationId: 'doc-1', host: 'github.com' }) });
    acted.at(500);
    acted.observer.acted('s1', 'browser');
    should(await acted.observer.codeTyped(onPage)).be.undefined();
    const scripted = checking({ where: () => ({ navigationId: 'doc-2', host: 'github.com' }) });
    scripted.observer.acted('s1', 'browser', true);
    scripted.at(0);
    should(await scripted.observer.codeTyped({ ...onPage, deliveredAt: DELIVERED + 1 })).be.undefined();
    const gone = checking({ where: () => undefined });
    should(await gone.observer.codeTyped(onPage)).be.undefined();
    should([...acted.verdicts, ...scripted.verdicts, ...gone.verdicts]).deepEqual([]);
  });

  it('should call the same prompt again a code that did not go through, and any other line one that did', async () => {
    const again = checking({ line: () => 'Verification code:  ' });
    should(await again.observer.codeTyped(atPrompt)).be.false();
    const moved = checking({ line: elapsed => (elapsed >= 10_000 ? 'kirin@bastion:~$' : 'Verification code:') });
    should(await moved.observer.codeTyped(atPrompt)).be.true();
    should([...again.verdicts, ...moved.verdicts]).deepEqual([
      ['GITHUB', FACTOR, false],
      ['GITHUB', FACTOR, true],
    ]);
  });

  it('should judge nothing typed into the secret store: there is no sign-in to watch', async () => {
    const w = checking({ where: () => ({ navigationId: 'doc-2', host: 'github.com' }) });
    const stored = code({ kind: 'secret', name: 'X', exists: false } as InputTargetFacts, { kind: 'secret', key: 'X' });
    should(await w.observer.codeTyped(stored)).be.undefined();
    should(w.verdicts).deepEqual([]);
  });

  it('should keep nothing for a terminal it cannot read, or one the ferret typed into since', async () => {
    const unread = checking({});
    should(await unread.observer.codeTyped(atPrompt)).be.undefined();
    const typed = checking({ line: () => 'kirin@bastion:~$' });
    typed.at(1);
    typed.observer.acted('s1', 'terminal');
    should(await typed.observer.codeTyped(atPrompt)).be.undefined();
    should([...unread.verdicts, ...typed.verdicts]).deepEqual([]);
  });

  it('should read the prompt line from the terminal through the live probe', async () => {
    const probe = new InputLoginProbe(
      { where: async () => undefined, text: async () => undefined },
      { screen: async () => undefined, promptLine: async () => 'Verification code:' },
    );
    should(await probe.prompt('s1', 'dev', ['dev'])).equal('Verification code:');
    should(
      await new InputLoginProbe({ where: async () => undefined, text: async () => undefined }, undefined).prompt(
        's1',
        'dev',
        [],
      ),
    ).be.undefined();
  });
});
