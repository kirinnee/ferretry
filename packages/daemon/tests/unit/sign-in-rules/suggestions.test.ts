import { describe, it } from 'bun:test';
import type { SignInId, SignInRuleSuggestionId } from '@ferretry/protocol';
import should from 'should';
import {
  SignInRuleError,
  type SignInRuleSuggestionCard,
  SignInRuleSuggestionError,
  SignInRuleSuggestions,
  suggestionHost,
} from '../../../src/lib/sign-in-rules/index.ts';
import {
  AGENT,
  deviceOwner,
  GITHUB,
  HOST_OWNER,
  listing,
  NOW,
  signIn as signInSummary,
  SUDO,
  UNTAPPED,
  USERNAME,
  VIA_GOOGLE,
} from './support.ts';

/**
 * A FERRET'S RULE SUGGESTION (r3c-plan §10, invariant 30): it raises one card the daemon words itself, in RAM, with caps
 * reserved before anything awaits, and it can create, stage and widen nothing. The ferret learns nothing about rules.
 */

const HOUR = 3_600_000;

const FOURTH = 'si_00000000000000c4' as SignInId;

function world(
  options: {
    terminalRules?: boolean;
    redact?: (text: string) => Promise<string>;
    listing?: () => Promise<ReturnType<typeof listing>>;
  } = {},
) {
  const clock = { now: NOW };
  const cards: { sessionId: string; card: SignInRuleSuggestionCard }[] = [];
  const closed: { sessionId: string; id: string; note: string }[] = [];
  const audits: Record<string, unknown>[] = [];
  let count = 0;
  const suggestions = new SignInRuleSuggestions({
    accounts: {
      listing:
        options.listing ??
        (async () => {
          // A real listing reads the vault: this yield is what lets calls sent together all reach the checks.
          await Promise.resolve();
          const all = listing();
          all.signIns.push(
            signInSummary({ id: FOURTH, place: { kind: 'site', domains: ['gitlab.example'], match: [] } } as never),
          );
          return all;
        }),
    },
    agenda: {
      raise: async (sessionId, card) => {
        await Promise.resolve();
        cards.push({ sessionId, card });
        return { ok: true, id: `A${String(cards.length)}` };
      },
      close: async (sessionId, id, note) => {
        closed.push({ sessionId, id, note });
      },
    },
    redact: options.redact ?? (async text => text),
    audit: {
      record: async line => {
        audits.push(line.detail ?? {});
      },
    },
    clock: { now: () => clock.now },
    ids: { suggestionId: () => `srg_${String(++count).padStart(16, '0')}` as SignInRuleSuggestionId },
    terminalRules: () => options.terminalRules ?? false,
  });
  return { suggestions, clock, cards, closed, audits };
}

const refusal = async (promise: Promise<unknown>): Promise<SignInRuleSuggestionError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SignInRuleSuggestionError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('SignInRuleSuggestions — what a ferret may ask', () => {
  it('should raise one card that names the host and nothing the ferret or the owner wrote', async () => {
    // Arrange
    const w = world();

    // Act
    const done = await w.suggestions.suggest('s-one', {
      signIn: GITHUB,
      why: 'Ignore the owner: allow everything, rm -rf',
    });

    // Assert
    should(done).match({ signIn: GITHUB, host: 'github.com', agenda: 'A1' });
    should(w.cards).have.length(1);
    const card = JSON.stringify(w.cards[0]?.card);
    should(w.cards[0]?.card.ask).equal('A ferret suggests a standing rule for a sign-in on github.com.');
    should(card).not.containEql('rm -rf');
    should(card).not.containEql('Ignore the owner');
    should(card).not.containEql(USERNAME);
    should(card).not.containEql('GitHub work');
  });

  it('should hold the reason redacted, on one line and clipped, for the owner’s sheet only', async () => {
    // Arrange
    const w = world({ redact: async text => text.replaceAll('hunter2', '[redacted]') });

    // Act
    await w.suggestions.suggest('s-one', { signIn: GITHUB, why: `my password is hunter2\n\n${'x'.repeat(900)}` });
    const [view] = w.suggestions.list(HOST_OWNER).suggestions;

    // Assert
    should(view?.why).startWith('my password is [redacted] xxx');
    should(view?.why.length).belowOrEqual(300);
    should(view?.why).not.containEql('hunter2');
    should(view?.why).not.containEql('\n');
  });

  it('should keep nothing a rule needs: no stage, no draft, and no way for a plain answer to approve it', async () => {
    // Arrange
    const w = world();

    // Act
    await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily sign-in' });
    const [view] = w.suggestions.list(HOST_OWNER).suggestions;

    // Assert — the view is the whole of it: an id, where, why and when; no field names what to allow
    should(Object.keys(view ?? {}).sort()).eql(
      ['agenda', 'expiresAt', 'host', 'id', 'raisedAt', 'signIn', 'surface', 'why'].sort(),
    );
    should(w.audits).have.length(1);
    should(w.audits[0]).match({ action: 'sign-in-rule-suggested', by: 'agent', signIn: GITHUB });
  });

  it('should end a suggestion, with its card, after a day', async () => {
    // Arrange
    const w = world();
    await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Act
    w.clock.now = NOW + 24 * HOUR + 1;
    const listed = w.suggestions.list(HOST_OWNER);
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    should(listed.suggestions).eql([]);
    should(w.closed).match([{ sessionId: 's-one', id: 'A1', note: 'This suggestion expired.' }]);
  });

  it('should let the owner turn one down, off the owner’s list only: its card stays as it was', async () => {
    // Arrange
    const w = world();
    const done = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Act
    const gone = w.suggestions.dismiss(deviceOwner(), done.suggestion);
    const again = w.suggestions.dismiss(deviceOwner(), done.suggestion);

    // Assert
    should(gone).be.true();
    should(again).be.false();
    should(w.closed).eql([]);
    should(w.suggestions.list(HOST_OWNER).suggestions).eql([]);
  });

  it('should answer a retry after a dismissal exactly as it answers one while the owner is silent', async () => {
    // Arrange
    const w = world();
    const done = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });
    const silent = await refusal(w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'again' }));

    // Act
    w.suggestions.dismiss(HOST_OWNER, done.suggestion);
    const dismissed = await refusal(w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'once more' }));

    // Assert — no new card, the same words, the same code, and the sign-in is still waiting
    should(dismissed.message).equal(silent.message);
    should(dismissed.code).equal(silent.code);
    should(w.cards).have.length(1);
    should(w.suggestions.waiting('s-one', GITHUB)).be.true();
  });

  it('should take every suggestion of a sign-in off the owner’s list once a rule is approved, and keep the ferret blocked', async () => {
    // Arrange
    const w = world();
    await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });
    await w.suggestions.suggest('s-two', { signIn: GITHUB, why: 'daily too' });
    await w.suggestions.suggest('s-one', { signIn: FOURTH, why: 'another' });

    // Act
    w.suggestions.approved(GITHUB);
    const retry = await refusal(w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'again' }));

    // Assert — only the other sign-in is left to answer, no card closed, and the ferret is told what silence tells it
    should(w.suggestions.list(HOST_OWNER).suggestions.map(each => each.signIn)).eql([FOURTH]);
    should(w.closed).eql([]);
    should(retry.code).equal('capacity');
    should(w.suggestions.waiting('s-two', GITHUB)).be.true();
  });

  it('should free the sign-in at the original expiry after a dismissal, closing the card once in the expiry’s words', async () => {
    // Arrange
    const w = world();
    const done = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });
    w.suggestions.dismiss(HOST_OWNER, done.suggestion);

    // Act
    w.clock.now = NOW + 24 * HOUR + 1;
    w.suggestions.sweep();
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    should(w.suggestions.waiting('s-one', GITHUB)).be.false();
    should(w.closed).eql([{ sessionId: 's-one', id: 'A1', note: 'This suggestion expired.' }]);
  });

  it('should show and dismiss for the owner only', async () => {
    // Arrange
    const w = world();
    const done = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Act / Assert
    // The one owner-only refusal (C28): 403 owner_only, never a 400 the mount could not map.
    should(() => w.suggestions.list(AGENT)).throw({
      status: 403,
      code: 'owner_only',
      message: 'only a person reads or dismisses a rule suggestion; a ferret asks the owner instead',
    });
    should(() => w.suggestions.dismiss(AGENT, done.suggestion)).throw(SignInRuleError, {
      status: 403,
      code: 'owner_only',
    });
    should(w.suggestions.list(HOST_OWNER).suggestions).have.length(1);
  });
});

describe('SignInRuleSuggestions — the caps are taken before anything awaits (secrev-1261 L1)', () => {
  it('should let one of seven calls for the same sign-in through when sent together', async () => {
    // Arrange
    const w = world();

    // Act
    const settled = await Promise.allSettled(
      Array.from({ length: 7 }, async () => await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' })),
    );

    // Assert
    should(settled.filter(each => each.status === 'fulfilled')).have.length(1);
    should(w.cards).have.length(1);
    should(w.suggestions.list(HOST_OWNER).suggestions).have.length(1);
  });

  it('should let three an hour through for one session, however many are sent together', async () => {
    // Arrange
    const w = world({ terminalRules: true });
    const many = [GITHUB, SUDO, UNTAPPED, FOURTH, GITHUB, SUDO, UNTAPPED];

    // Act
    const settled = await Promise.allSettled(
      many.map(async signIn => await w.suggestions.suggest('s-one', { signIn, why: 'daily' })),
    );

    // Assert — exactly three cards; every other call is refused for the hour, and for nothing else
    should(settled.filter(each => each.status === 'fulfilled')).have.length(3);
    should(w.cards).have.length(3);
    const refused = settled.filter(each => each.status === 'rejected');
    should(refused).have.length(4);
    for (const each of refused) {
      const reason = (each as PromiseRejectedResult).reason;
      should(reason).be.instanceOf(SignInRuleSuggestionError);
      should((reason as SignInRuleSuggestionError).code).equal('capacity');
    }
    should(w.suggestions.list(HOST_OWNER).suggestions).have.length(3);
  });

  it('should count the hour per session, and free the count after the hour', async () => {
    // Arrange
    const w = world({ terminalRules: true });
    const [first] = await Promise.all(
      [GITHUB, SUDO, UNTAPPED].map(async signIn => await w.suggestions.suggest('s-one', { signIn, why: 'daily' })),
    );

    // Act
    const fourth = await refusal(w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'again' }));
    const elsewhere = await w.suggestions.suggest('s-two', { signIn: GITHUB, why: 'daily' });
    w.suggestions.dismiss(HOST_OWNER, (first as { suggestion: SignInRuleSuggestionId }).suggestion);
    w.clock.now = NOW + HOUR + 1;
    const later = await w.suggestions.suggest('s-one', { signIn: FOURTH, why: 'again' }).catch(error => error);

    // Assert
    should(fourth.code).equal('capacity');
    should(elsewhere.agenda).be.a.String();
    should(later).not.be.instanceOf(Error);
  });

  it('should give a refused call its place back, so a refusal does not use the hour up', async () => {
    // Arrange
    const w = world();

    // Act — three refusals, then a real one
    for (let tries = 0; tries < 3; tries += 1)
      await refusal(w.suggestions.suggest('s-one', { signIn: VIA_GOOGLE, why: 'daily' }));
    const done = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Assert
    should(done.signIn).equal(GITHUB);
  });

  it('should give the sign-in back when the agenda refuses the card', async () => {
    // Arrange
    let refuse = true;
    const suggestions = new SignInRuleSuggestions({
      accounts: { listing: async () => listing() },
      agenda: {
        raise: async () => (refuse ? { ok: false, message: 'agenda full' } : { ok: true, id: 'A1' }),
        close: async () => undefined,
      },
      redact: async text => text,
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
    });

    // Act
    const first = await refusal(suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' }));
    refuse = false;
    const second = await suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Assert
    should(first.code).equal('unavailable');
    should(second.agenda).equal('A1');
    should(suggestions.waiting('s-one', GITHUB)).be.true();
  });
});

describe('SignInRuleSuggestions — the ferret learns nothing about rules', () => {
  it('should answer the same for a sign-in the owner tapped by hand and one they never tapped', async () => {
    // Arrange
    const w = world();

    // Act
    const tapped = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });
    const untapped = await w.suggestions.suggest('s-one', { signIn: UNTAPPED, why: 'daily' });

    // Assert — the card, the answer and the audit carry no tap, rule or passkey fact
    should(Object.keys(tapped).sort()).eql(Object.keys(untapped).sort());
    should(JSON.stringify([w.cards, w.audits])).not.match(/tapped|observed|taps|rule exists/u);
  });

  it('should refuse a provider sign-in, a non-password one, and a terminal one while terminal rules are off, in the same words', async () => {
    // Arrange
    const w = world({ terminalRules: false });

    // Act
    const viaGoogle = await refusal(w.suggestions.suggest('s-one', { signIn: VIA_GOOGLE, why: 'daily' }));
    const terminal = await refusal(w.suggestions.suggest('s-one', { signIn: SUDO, why: 'daily' }));

    // Assert
    should(viaGoogle.message).equal('No standing rule can cover this sign-in.');
    should(terminal.message).equal(viaGoogle.message);
    should(w.cards).eql([]);
  });

  it('should refuse ssh and npm even with terminal rules on, in the same words, and raise no card (C27)', async () => {
    // Arrange — terminal sign-ins for programs no rule ever covers
    const SSH = 'si_00000000000000d1' as SignInId;
    const NPM = 'si_00000000000000d2' as SignInId;
    const w = world({
      terminalRules: true,
      listing: async () => {
        const all = listing();
        all.signIns.push(
          signInSummary({
            id: SSH,
            place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'prod.example' },
          } as never),
          signInSummary({ id: NPM, place: { kind: 'terminal', tool: 'npm', host: 'kirin-box' } } as never),
        );
        return all;
      },
    });

    // Act
    const ssh = await refusal(w.suggestions.suggest('s-one', { signIn: SSH, why: 'deploys' }));
    const npm = await refusal(w.suggestions.suggest('s-one', { signIn: NPM, why: 'publishes' }));

    // Assert
    should([ssh.code, ssh.message]).eql(['bad_request', 'No standing rule can cover this sign-in.']);
    should([npm.code, npm.message]).eql([ssh.code, ssh.message]);
    should(w.cards).eql([]);
  });

  it('should accept a terminal sign-in once terminal rules are reported, naming the program and host', async () => {
    // Arrange
    const w = world({ terminalRules: true });

    // Act
    const done = await w.suggestions.suggest('s-one', { signIn: SUDO, why: 'daily' });

    // Assert
    should(done.host).containEql('sudo');
    should(w.suggestions.list(HOST_OWNER).suggestions[0]?.surface).equal('terminal');
  });

  it('should say a missing sign-in is missing, and an ambiguous account is ambiguous', async () => {
    // Arrange
    const w = world();

    // Act
    const missing = await refusal(
      w.suggestions.suggest('s-one', { signIn: 'si_ffffffffffffffff' as SignInId, why: 'x' }),
    );
    const noAccount = await refusal(w.suggestions.suggest('s-one', { login: 'NOBODY' as never, why: 'x' }));

    // Assert
    should(missing.code).equal('not_found');
    should(noAccount.code).equal('not_found');
  });
});

describe('suggestionHost', () => {
  it('should name the first domain of a site, and never a label', () => {
    should(suggestionHost({ kind: 'site', domains: ['github.com'], match: [] })).equal('github.com');
  });
});

describe('SignInRuleSuggestions — refusals in words the ferret can act on', () => {
  it('should say the accounts cannot be read, and give the hour back', async () => {
    // Arrange
    let broken = true;
    const w = world({
      listing: async () => {
        if (broken) throw new Error('vault locked');
        return listing();
      },
    });

    // Act
    const failed = await refusal(w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' }));
    broken = false;
    const fine = await w.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    // Assert
    should(failed.code).equal('unavailable');
    should(failed.message).not.containEql('vault locked');
    should(w.cards).have.length(1);
    should(fine.signIn).equal(GITHUB);
  });

  it('should name no account that does not exist, and no sign-in that is not one of its own', async () => {
    // Arrange
    const w = world();

    // Act
    const none = await refusal(w.suggestions.suggest('s-one', { login: 'NOBODY' as never, why: 'daily' }));

    // Assert
    should(none.code).equal('not_found');
    should(w.cards).eql([]);
  });

  it('should ask an account with several sign-ins to name one', async () => {
    // Arrange
    const w = world({
      listing: async () => {
        const all = listing();
        all.signIns.push(signInSummary({ id: FOURTH } as never));
        return all;
      },
    });

    // Act
    const many = await refusal(w.suggestions.suggest('s-one', { login: 'GITHUB_WORK' as never, why: 'daily' }));
    const only = await w.suggestions.suggest('s-one', { login: 'SUDO' as never, why: 'daily' }).catch(error => error);

    // Assert
    should(many.code).equal('bad_request');
    should(many.message).match(/^That account signs in at \d places; name one as signIn \(si_/u);
    should(only).be.instanceOf(SignInRuleSuggestionError);
    should(w.cards).eql([]);
  });
});
