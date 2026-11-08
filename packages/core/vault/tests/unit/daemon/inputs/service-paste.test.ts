import { describe, it } from 'bun:test';
import should from 'should';
import type { InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { terminal } from './grant-fixtures.ts';
import { AGENT, COPY_VALUE, OWNER, PASTE_RAISE, PAGE_LOGIN, refusal, SUDO_RAISE, world } from './world.ts';

/**
 * A secure copy pasted as an input request (docs/secure-copy.md), and the owner's pre-approval rules that paste it
 * unasked: what the card says, what a refusal types, and what the agent is told. The copies and rules are fakes; the
 * service is the real one.
 */

const VERCEL: InputTargetFacts = {
  ...terminal(),
  foreground: { pid: 5100, pgid: 5100, comm: 'vercel', argv: 'vercel env add TOKEN production' },
  program: 'vercel',
  promptLine: '? What’s the value of TOKEN?',
  recognisedConsumer: false,
};

const SECRET_STORE = (exists: boolean): InputTargetFacts => ({ kind: 'secret', name: 'TOKEN', exists });
const STORE_RAISE = {
  ...PASTE_RAISE,
  target: { kind: 'secret', key: 'TOKEN' },
  sensitivity: 'secret',
} as const;

describe('raising a paste', () => {
  it('should refuse the secret store without a secure copy, and a paste of more than one field', async () => {
    const w = world({ withSealed: true, facts: SECRET_STORE(false) });
    w.copy();

    const bare = await refusal(w.service.raise(SESSION_ID, { ...STORE_RAISE, source: undefined }));
    const many = await refusal(
      w.service.raise(SESSION_ID, {
        target: { kind: 'page', key: 'app' },
        prompt: 'paste the token',
        fields: [
          { id: 'a', sensitivity: 'secret', element: { kind: 'selector', selector: '#a' } },
          { id: 'b', sensitivity: 'secret', element: { kind: 'selector', selector: '#b' } },
        ],
        submit: 'owner-default',
        source: { kind: 'sealed', name: 'vercel' },
      }),
    );

    should(bare.code).equal('bad_request');
    should(bare.message).containEql('secure copy');
    should(many.code).equal('bad_request');
    should(many.message).equal('a paste fills one field: raise it with one field');
    should(w.cards).eql([]);
  });

  it('should refuse a paste of a copy that is not live, and a daemon that keeps no copies, raising no card', async () => {
    const none = world({ withSealed: true, facts: VERCEL });
    const bare = world({ facts: VERCEL });

    const missing = await refusal(none.service.raise(SESSION_ID, PASTE_RAISE));
    const unwired = await refusal(bare.service.raise(SESSION_ID, PASTE_RAISE));

    should(missing.code).equal('not_found');
    should(missing.message).containEql('sealed:vercel');
    should(unwired.code).equal('not_found');
    should(none.cards.length + bare.cards.length).equal(0);
  });

  it('should raise a paste card as a secret, naming the copy and where it came from, with nothing to type', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();

    const view = await w.service.raise(SESSION_ID, PASTE_RAISE);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(w.cards[0]).match({
      title: 'Wants to paste a secure copy',
      ask: `Allow pasting sealed:vercel (${String(COPY_VALUE.length)} characters from /usr/bin/vercel) into the terminal. You type nothing.`,
    });
    should(request.sensitivity).equal('secret');
    should(request.source).eql({
      kind: 'sealed',
      name: 'vercel',
      from: { kind: 'command', program: 'vercel', path: '/usr/bin/vercel' },
    });
    should(w.events.map(event => event.sealed)).eql(['vercel']);
  });

  it('should make every field of a paste a secret, whatever the agent called it', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();

    await w.service.raise(SESSION_ID, {
      ...PASTE_RAISE,
      sensitivity: undefined,
      fields: [{ id: 'value', label: 'Token', sensitivity: 'plain' }],
    });

    should((await w.pending()).fields.map(field => field.sensitivity)).eql(['secret']);
  });

  it('should say where a copy goes: a secret it would replace, a page field, or the terminal', async () => {
    const store = world({ withSealed: true, facts: SECRET_STORE(true) });
    store.copy();
    await store.service.raise(SESSION_ID, STORE_RAISE);
    const browser = world({ withSealed: true, facts: githubPageFacts() });
    browser.copy({ from: { kind: 'browser', origin: 'https://vercel.com' } });
    await browser.service.raise(SESSION_ID, {
      target: { kind: 'page', key: 'app' },
      prompt: 'paste the token',
      fields: [{ id: 'pass', sensitivity: 'secret', element: { kind: 'selector', selector: '#password' } }],
      submit: 'owner-default',
      source: { kind: 'sealed', name: 'vercel' },
    });

    should(store.cards[0]?.ask).containEql('into the secret TOKEN, replacing its value.');
    should(browser.cards[0]?.ask).containEql('from https://vercel.com) into a field on github.com.');
  });

  it('should flag a copy the ferret had already seen, whatever else the terminal says', async () => {
    const w = world({ withSealed: true, facts: { ...VERCEL, recognisedConsumer: true } });
    w.copy({ exposure: { transcript: 'found' } });

    await w.service.raise(SESSION_ID, PASTE_RAISE);

    should((await w.pending()).risk).eql({
      level: 'amber',
      reason: 'The ferret saw this value before it was sealed, so it is not protected; consider rotating it.',
    });
  });
});

describe('allowing a paste', () => {
  it('should type the copy once when the owner allows it, count the use, and tell the agent it was pasted', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();
    const view = await w.service.raise(SESSION_ID, PASTE_RAISE);
    const request = await w.pending();

    const result = await w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER);
    const after = await w.service.agentView(SESSION_ID, view.id, 0);

    should(result).match({ state: 'delivered', submitted: true });
    should(w.writes.map(write => write.values)).eql([[COPY_VALUE]]);
    should(w.used).eql([{ copy: 'vercel' }]);
    should(after).match({ state: 'delivered', source: 'sealed' });
    should(w.told.at(-1)).containEql('sealed:vercel was pasted into %terminal:dev');
    should(w.events.at(-1)).match({ state: 'delivered', sealed: 'vercel' });
  });

  it('should refuse a typed value on a paste card, and a paste body on an ordinary card, typing nothing', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();
    await w.service.raise(SESSION_ID, PASTE_RAISE);
    const paste = await w.pending();

    const typed = await refusal(
      w.service.deliver(SESSION_ID, paste.id, w.send(paste, { padded: padInputValue('guess') }), OWNER),
    );
    await w.service.cancel(SESSION_ID, paste.id, OWNER);
    await w.service.raise(SESSION_ID, SUDO_RAISE);
    const ordinary = await w.pending();
    const sealed = await refusal(w.service.deliver(SESSION_ID, ordinary.id, w.send(ordinary, { sealed: true }), OWNER));

    should(typed.message).equal('this card pastes sealed:vercel: allow it, there is nothing to type');
    should(sealed.message).equal('this card pastes no secure copy; type the value instead');
    should(w.writes).eql([]);
  });

  it('should refuse an agent allowing its own paste', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();
    await w.service.raise(SESSION_ID, PASTE_RAISE);
    const request = await w.pending();

    const error = await refusal(w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), AGENT));

    should(error.code).equal('forbidden');
    should(w.writes).eql([]);
  });

  it('should end the request, typing nothing, when the copy was discarded before the owner allowed it', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy();
    await w.service.raise(SESSION_ID, PASTE_RAISE);
    const request = await w.pending();
    w.copies.clear();

    const error = await refusal(w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER));

    should(error.code).equal('gone');
    should(w.writes).eql([]);
    should(w.events.at(-1)).match({ state: 'cancelled', reason: 'copy_gone' });
    should(w.closed.at(-1)).containEql('copy gone');
  });

  it('should refuse to paste a copy with a line break, which would press keys, typing nothing', async () => {
    const w = world({ withSealed: true, facts: VERCEL });
    w.copy({}, 'line one\nline two');
    await w.service.raise(SESSION_ID, PASTE_RAISE);
    const request = await w.pending();

    const error = await refusal(w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER));

    should(error.code).equal('bad_request');
    should(error.message).containEql('line break');
    should(w.writes).eql([]);
  });

  it('should save a pasted copy as the secret and audit it, then tell the agent it can use it by name', async () => {
    const w = world({ withSealed: true, facts: SECRET_STORE(false) });
    w.copy();
    const view = await w.service.raise(SESSION_ID, STORE_RAISE);
    const request = await w.pending();

    await w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER);

    should(w.writes.map(write => write.values)).eql([[COPY_VALUE]]);
    should(w.stores).match([{ name: 'TOKEN', replaced: false }]);
    should(w.told.at(-1)).containEql('was saved as the secret TOKEN');
    should(view.state).equal('pending');
  });

  it('should end a paste into the secret store as interrupted when the write may be partial, auditing it as uncertain', async () => {
    const w = world({ withSealed: true, facts: SECRET_STORE(true) });
    w.copy();
    await w.service.raise(SESSION_ID, STORE_RAISE);
    const request = await w.pending();
    w.state.typed = 'uncertain';

    const error = await refusal(w.service.deliver(SESSION_ID, request.id, w.send(request, { sealed: true }), OWNER));

    should(error.code).equal('unavailable');
    should(w.stores).match([{ name: 'TOKEN', replaced: true, uncertain: true }]);
    should(w.told.at(-1)).containEql('was interrupted while sealed:vercel was being saved as the secret TOKEN');
  });

  it('should tell the agent a paste into the secret store that ended without a value did not save it', async () => {
    const w = world({ withSealed: true, facts: SECRET_STORE(false) });
    w.copy();
    await w.service.raise(SESSION_ID, STORE_RAISE);
    const request = await w.pending();

    await w.service.cancel(SESSION_ID, request.id, OWNER);

    should(w.told.at(-1)).containEql('ended without saving sealed:vercel (cancelled');
  });
});

describe('a paste a rule approved in advance', () => {
  it('should paste unasked under a reserved rule, closing the card at once, and spend the rule', async () => {
    const w = world({ withSealed: true, withRules: true, facts: { ...VERCEL, echo: 'off' } });
    w.copy();
    w.state.ruleId = 'rule-1';

    const view = await w.service.raise(SESSION_ID, PASTE_RAISE);

    should(view.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[COPY_VALUE]]);
    should(w.ruleLog.spent).eql(['rule-1']);
    should(w.ruleLog.released).eql([]);
    should(await w.service.agentView(SESSION_ID, view.id, 0)).match({
      note: 'Pasted under a rule the owner approved in advance.',
    });
  });

  it('should name the owner’s profile program when no program was proved, in the write and the log', async () => {
    const profile = { name: 'vercel', path: '/home/kirin/.nix-profile/bin/vercel' };
    const w = world({
      withSealed: true,
      withRules: true,
      observe: () => ({
        ok: true,
        facts: { ...VERCEL, program: undefined, echo: 'off' },
        profileProgram: profile,
      }),
    });
    w.copy();
    w.state.ruleId = 'rule-1';

    await w.service.raise(SESSION_ID, PASTE_RAISE);

    should(w.writes[0]?.options?.profileProgram).eql(profile);
    should(w.ruleLog.reserved[0]?.[3]).equal('vercel');
  });

  it('should give a rule back and leave the card to the owner when nothing was typed', async () => {
    const w = world({ withSealed: true, withRules: true, facts: { ...VERCEL, echo: 'off' } });
    w.copy();
    w.state.ruleId = 'rule-1';
    w.state.typed = 'target_changed';

    const view = await w.service.raise(SESSION_ID, PASTE_RAISE);

    should(view.state).equal('pending');
    should(w.ruleLog.released).eql(['rule-1']);
    should(w.ruleLog.spent).eql([]);
    should(w.notes).eql(["A paste rule you approved didn't apply here, so you're asked as usual."]);
  });

  it('should spend a rule whose write may be partial: the use is not given back', async () => {
    const w = world({ withSealed: true, withRules: true, facts: { ...VERCEL, echo: 'off' } });
    w.copy();
    w.state.ruleId = 'rule-1';
    w.state.typed = 'uncertain';

    await w.service.raise(SESSION_ID, PASTE_RAISE);

    should(w.ruleLog.spent).eql(['rule-1']);
    should(w.ruleLog.released).eql([]);
  });

  it('should never reserve a rule for a paste it must not make unasked', async () => {
    const seen = world({ withSealed: true, withRules: true, facts: { ...VERCEL, echo: 'off' } });
    seen.copy({ exposure: { transcript: 'found' } });
    const echoing = world({ withSealed: true, withRules: true, facts: { ...VERCEL, echo: 'on' } });
    echoing.copy();
    const replacing = world({ withSealed: true, withRules: true, facts: SECRET_STORE(true) });
    replacing.copy();
    const fresh = world({ withSealed: true, withRules: true, facts: SECRET_STORE(false) });
    fresh.copy();
    for (const each of [seen, echoing, replacing, fresh]) each.state.ruleId = 'rule-1';

    await seen.service.raise(SESSION_ID, PASTE_RAISE);
    await echoing.service.raise(SESSION_ID, PASTE_RAISE);
    await replacing.service.raise(SESSION_ID, STORE_RAISE);
    await fresh.service.raise(SESSION_ID, STORE_RAISE);

    should(seen.ruleLog.reserved).eql([]);
    should(echoing.ruleLog.reserved).eql([]);
    should(replacing.ruleLog.reserved).eql([]);
    should(fresh.ruleLog.reserved).have.length(1);
  });

  it('should leave a paste into a page to the owner unless the card would be green for every field', async () => {
    const green = world({ withSealed: true, withRules: true, facts: githubPageFacts() });
    const challenged = world({
      withSealed: true,
      withRules: true,
      facts: { ...githubPageFacts(), challenge: 'captcha' } as never,
    });
    for (const each of [green, challenged]) {
      each.copy();
      each.state.ruleId = 'rule-1';
    }
    const raise = {
      target: { kind: 'page', key: 'app' },
      prompt: 'paste the token',
      fields: [{ id: 'pass', sensitivity: 'secret', element: { kind: 'selector', selector: '#password' } }],
      submit: 'owner-default',
      source: { kind: 'sealed', name: 'vercel' },
    } satisfies InputRaise;

    await green.service.raise(SESSION_ID, raise);
    await challenged.service.raise(SESSION_ID, raise);

    should(green.ruleLog.reserved).have.length(1);
    should(challenged.ruleLog.reserved).eql([]);
  });
});

const SESSION_ID = 'mvv6b4qw-49d0158d';

function githubPageFacts(): InputTargetFacts {
  return {
    kind: 'page',
    pageId: 'p1',
    origin: 'https://github.com',
    secure: true,
    navigationId: 'n1',
    fields: [
      {
        fieldId: 'pass',
        frameOrigin: 'https://github.com',
        frameId: 'main',
        backendNodeId: 12,
        field: { tag: 'input', type: 'password', name: 'password' },
        box: { x: 0, y: 0, w: 100, h: 30 },
        visible: true,
      },
    ],
  };
}

void PAGE_LOGIN;
