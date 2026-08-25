/**
 * The credential answer: a profile instead of a sign-in.
 *
 * THE HARD LINE, and every case here is downstream of it: a profile's VALUE is never rendered,
 * logged, returned or echoed. What this browser holds is names and shapes — `docs/secrets.md` is the
 * contract and the daemon has no route that answers a value, so a control that seemed to need one
 * would have to be redesigned rather than fed. What is asserted below is therefore always "which name
 * reaches which sentence", never "what does it hold".
 *
 * NO REAL CREDENTIAL APPEARS HERE. `WORK_KEY` is a secret's NAME, which is exactly what the fleet
 * configuration itself carries and what somebody has to see in order to fix an account reaching for a
 * secret nobody has set.
 */

import { describe, expect, it } from 'bun:test';

import {
  createAccountProposal,
  credentialProblems,
  draftProfiles,
  emptyAccountDraft,
  type FleetAccountDraft,
  type FleetProfileDraft,
  type FleetProfileVariableDraft,
  newProfileProblems,
  profileVariableSourceLabel,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import { profileCatalog } from './fleet-support.ts';

/** A draft complete enough to send, so a case can put back exactly the one thing it is about. */
const draftOf = (overrides: Partial<FleetAccountDraft> = {}): FleetAccountDraft => ({
  ...emptyAccountDraft('claude'),
  name: 'studio',
  modelsText: 'claude-opus-5',
  defaultModel: 'claude-opus-5',
  credential: 'profile',
  ...overrides,
});

const row = (overrides: Partial<FleetProfileVariableDraft> = {}): FleetProfileVariableDraft => ({
  id: 'row-one',
  from: 'secret',
  variable: 'ANTHROPIC_API_KEY',
  detail: 'WORK_KEY',
  ...overrides,
});

/** A profile being written that has nothing wrong with it, so a case can break one thing. */
const written = (overrides: Partial<FleetProfileDraft> = {}): FleetProfileDraft => ({
  name: 'work',
  variables: [row()],
  ...overrides,
});

describe('profileVariableSourceLabel', () => {
  it('should word each answer once, so a refusal and the control it points at cannot disagree', () => {
    // Arrange — the refusal sentences below name the box a person has to go and fill in. Two spellings
    // of that box would send somebody looking for a control that is not on the screen under that name.
    expect(profileVariableSourceLabel('secret')).toBe('Secret in this daemon’s store');
    expect(profileVariableSourceLabel('environment')).toBe('Read from another variable');
    expect(profileVariableSourceLabel('value')).toBe('A plain value, not a credential');
  });
});

describe('newProfileProblems', () => {
  it('should accept a profile that names itself and sets one variable', () => {
    expect(newProfileProblems(written(), ['other'])).toEqual([]);
  });

  it('should ask for a name before anything else about the name', () => {
    // Arrange — one name problem at a time. Four sentences about one box is a person reading a list to
    // find the one that applies.
    expect(newProfileProblems(written({ name: '' }), [])).toEqual(['name this profile']);
    expect(newProfileProblems(written({ name: ' work' }), [])).toEqual([
      'a profile name must not start or end with a space',
    ]);
  });

  it('should refuse a name that would be a path rather than a profile', () => {
    // Arrange — the name becomes a key in the fleet configuration and an argument in a sentence, and
    // the daemon holds it to the same rule an account name is held to.
    for (const name of ['work/other', 'work\\other', '../escape']) {
      expect(newProfileProblems(written({ name }), [])).toEqual([
        'a profile name must not contain a path separator or ".."',
      ]);
    }
  });

  it('should send somebody to the tick box rather than let them write a second profile of that name', () => {
    // Arrange — writing over a profile other accounts compose would re-credential them from a change
    // that says it adds an account. The remedy is in the sentence.
    const problems = newProfileProblems(written({ name: 'work' }), ['base', 'work']);

    // Assert
    expect(problems).toEqual([
      'this fleet already declares a profile named "work" — tick it above instead of writing a second',
    ]);
  });

  it('should refuse a profile that sets nothing, because it would compose nothing', () => {
    expect(newProfileProblems(written({ variables: [] }), [])).toEqual(['a profile has to set at least one variable']);
  });

  it('should name the box each answer needs filled in, in that answer’s own words', () => {
    // Arrange — one field carries three meanings, so the sentence has to say which one is empty.
    expect(newProfileProblems(written({ variables: [row({ detail: '' })] }), [])).toEqual([
      'name the secret this variable takes its value from',
    ]);
    expect(newProfileProblems(written({ variables: [row({ from: 'environment', detail: '' })] }), [])).toEqual([
      'name the variable this one is read from',
    ]);
    expect(newProfileProblems(written({ variables: [row({ from: 'value', detail: '' })] }), [])).toEqual([
      'type the value this variable is set to',
    ]);
  });

  it('should refuse a variable name no shell would accept, and one nobody typed', () => {
    // The detail is still filled in, so the missing NAME is the only problem reported.
    expect(newProfileProblems(written({ variables: [row({ variable: '' })] }), [])).toEqual([
      'name the variable this profile sets',
    ]);
    expect(newProfileProblems(written({ variables: [row({ variable: 'not-a-name' })] }), [])).toEqual([
      '"not-a-name" is not an environment variable name — letters, digits and underscores',
    ]);
  });

  it('should refuse one variable set twice, because one variable carries one value', () => {
    // Arrange — two rows for `ANTHROPIC_API_KEY` is a form where the answer depends on which row the
    // reader looks at, and the daemon would compose one of them with no way to say which.
    const problems = newProfileProblems(
      written({ variables: [row({ id: 'a' }), row({ id: 'b', detail: 'OTHER_KEY' })] }),
      [],
    );

    // Assert
    expect(problems).toEqual(['this profile sets "ANTHROPIC_API_KEY" twice; one variable carries one value']);
  });

  it('should hold a secret’s name to the shape the store enforces, not to a variable’s', () => {
    // Arrange — `${secret:work_key}` matches nothing, stays a literal, and would authenticate a child
    // with the eighteen characters of the reference itself. The lower-case spelling is refused HERE,
    // where somebody can still fix it, rather than at the daemon.
    expect(newProfileProblems(written({ variables: [row({ detail: 'work_key' })] }), [])).toEqual([
      '"work_key" is not a secret name — uppercase letters, digits and underscores',
    ]);
    // And the environment answer takes a variable name, which is the laxer of the two shapes.
    expect(newProfileProblems(written({ variables: [row({ from: 'environment', detail: 'work_key' })] }), [])).toEqual(
      [],
    );
    expect(
      newProfileProblems(written({ variables: [row({ from: 'environment', detail: 'not a name' })] }), []),
    ).toEqual(['"not a name" is not an environment variable name — letters, digits and underscores']);
  });

  it('should say nothing about a plain value, because any text is a value somebody meant', () => {
    // Arrange — the control carries the consequence instead: what is typed there goes into the fleet
    // configuration as text, which is exactly where a credential must not be. That is a warning on the
    // box rather than a refusal, because a base URL is the ordinary reason to use it.
    expect(
      newProfileProblems(written({ variables: [row({ from: 'value', detail: 'https://gateway.invalid' })] }), []),
    ).toEqual([]);
  });
});

describe('credentialProblems', () => {
  it('should say nothing at all when the answer is signing in', () => {
    // Arrange — the profile fields may still hold what somebody ticked before switching back, and none
    // of it is a blocker on an answer they are no longer giving.
    const draft = draftOf({ credential: 'login', profiles: ['gateway'], newProfile: written({ name: '' }) });

    // Act & Assert
    expect(credentialProblems(draft, profileCatalog())).toEqual([]);
  });

  it('should ask for a profile when somebody chose one and has not picked it yet', () => {
    // Arrange — an empty list is not "signing in": it is an unfinished answer, and a field that flipped
    // back to signing in whenever the last tick came off would clear this blocker by changing the answer.
    expect(credentialProblems(draftOf(), profileCatalog())).toEqual([
      'pick a profile to authenticate this account, add one, or choose signing in instead',
    ]);
  });

  it('should refuse a "no login" that would still need one, naming what would have to be true', () => {
    // Arrange — `gateway` sets only a base URL. Somebody who chose "no login" and ticked it would get
    // an account that still needs a sign-in, which is the exact dead end this surface exists to remove.
    const problems = credentialProblems(draftOf({ profiles: ['gateway'] }), profileCatalog());

    // Assert — it names the variables that WOULD authenticate, from the host's own list.
    expect(problems).toEqual([
      'none of these profiles sets a credential for Claude (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN), so this account would still need a sign-in',
    ]);
  });

  it('should name the harness a person is looking at, not the other one', () => {
    // Arrange — `ANTHROPIC_API_KEY` authenticates Claude and says nothing about Codex, so the sentence
    // is per harness or it sends somebody to set the wrong variable.
    const catalog = profileCatalog({
      profiles: [
        {
          name: 'gateway',
          appliesToEveryAccount: false,
          variables: [{ variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } }],
          accounts: [],
          authenticates: [],
        },
      ],
    });

    // Act
    const problems = credentialProblems(draftOf({ harness: 'codex', profiles: ['gateway'] }), catalog);

    // Assert
    expect(problems[0]).toContain('a credential for Codex (OPENAI_API_KEY)');
  });

  it('should accept a profile that does authenticate this harness', () => {
    expect(credentialProblems(draftOf({ profiles: ['work'] }), profileCatalog())).toEqual([]);
  });

  it('should accept a profile being WRITTEN that sets a credential the catalog cannot know about', () => {
    // Arrange — the profile does not exist yet, so `authenticates` cannot answer for it. The rows are
    // read instead, against the same host list, which is what makes "add one and use it" one change.
    const draft = draftOf({ newProfile: written({ name: 'mine' }) });

    // Act & Assert
    expect(credentialProblems(draft, profileCatalog())).toEqual([]);
  });

  it('should still refuse a profile being written that sets no credential', () => {
    // Arrange
    const draft = draftOf({
      newProfile: written({
        name: 'mine',
        variables: [row({ from: 'value', variable: 'ANTHROPIC_BASE_URL', detail: 'https://x.invalid' })],
      }),
    });

    // Act & Assert
    expect(credentialProblems(draft, profileCatalog())).toEqual([
      'none of these profiles sets a credential for Claude (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN), so this account would still need a sign-in',
    ]);
  });

  it('should report what is wrong with the profile being written, against the names the fleet has', () => {
    // Arrange — the collision list comes from the catalog rather than from a second copy, so the
    // refusal here and the daemon's are about the same set of names.
    const draft = draftOf({ newProfile: written({ name: 'work' }) });

    // Act
    const problems = credentialProblems(draft, profileCatalog());

    // Assert — and the "pick a profile" blocker is there too, because the authored name is blank-free
    // but nothing is ticked and a profile that cannot be declared cannot count as picked.
    expect(problems).toContain(
      'this fleet already declares a profile named "work" — tick it above instead of writing a second',
    );
  });

  it('should not refuse on the strength of not knowing, before the catalog has been read', () => {
    // Arrange — an unread catalog cannot tell a profile that authenticates from one that does not, and
    // refusing on that would block a step nobody could clear. The rules that need it are SKIPPED.
    const draft = draftOf({ profiles: ['gateway'] });

    // Act & Assert
    expect(credentialProblems(draft, null)).toEqual([]);
  });

  it('should still say what is wrong with a profile being written when the catalog is unread', () => {
    // Arrange — that check needs no catalog: it is about the rows somebody typed. The declared-name
    // list is empty, so a collision cannot be reported, which is the honest answer rather than a guess.
    const draft = draftOf({ newProfile: written({ name: '' }) });

    // Act
    const problems = credentialProblems(draft, null);

    // Assert
    expect(problems).toContain('name this profile');
  });
});

describe('draftProfiles', () => {
  it('should be empty for a draft that signs in, which is what makes the field ABSENT', () => {
    // Arrange — absent means "leave this login's profiles exactly as they are". A create that sent an
    // empty list would REMOVE the profiles from a login somebody picked in order to add an account to
    // it, which is a change to accounts they never named.
    expect(draftProfiles(draftOf({ credential: 'login', profiles: ['work'] }))).toEqual([]);
  });

  it('should put the profile being written LAST, because it is the one being composed right now', () => {
    // Arrange — order is precedence, so the values somebody is typing are the ones they expect to win.
    const draft = draftOf({ profiles: ['base-ish', 'work'], newProfile: written({ name: 'mine' }) });

    // Act & Assert
    expect(draftProfiles(draft)).toEqual(['base-ish', 'work', 'mine']);
  });

  it('should leave an unnamed profile out of the order, because it has no name to apply under', () => {
    expect(draftProfiles(draftOf({ profiles: ['work'], newProfile: written({ name: '  ' }) }))).toEqual(['work']);
  });
});

describe('a created account that authenticates from a profile', () => {
  it('should send the ticked profiles and declare the written one, in the order they apply', () => {
    // Arrange — the three spellings the daemon accepts, and nothing else. A caller that could send
    // `env` as text could send `${secret:work_key}`, which the grammar does not match.
    const draft = draftOf({
      profiles: ['work'],
      newProfile: {
        name: ' mine ',
        variables: [
          row({ id: 'a', from: 'secret', variable: ' ANTHROPIC_API_KEY ', detail: ' NEW_KEY ' }),
          row({ id: 'b', from: 'environment', variable: 'HTTPS_PROXY', detail: 'OUTER_PROXY' }),
          row({ id: 'c', from: 'value', variable: 'ANTHROPIC_BASE_URL', detail: 'https://gateway.invalid' }),
        ],
      },
    });

    // Act
    const request = createAccountProposal(draft);

    // Assert
    expect(request.mutation).toMatchObject({
      profiles: ['work', 'mine'],
      declareProfiles: [
        {
          name: 'mine',
          variables: [
            { from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'NEW_KEY' },
            { from: 'environment', variable: 'HTTPS_PROXY', source: 'OUTER_PROXY' },
            { from: 'value', variable: 'ANTHROPIC_BASE_URL', value: 'https://gateway.invalid' },
          ],
        },
      ],
    });
  });

  it('should declare nothing when nothing was written, and name the profiles all the same', () => {
    // Act
    const request = createAccountProposal(draftOf({ profiles: ['work'] }));

    // Assert
    expect(request.mutation).not.toHaveProperty('declareProfiles');
    expect(request.mutation).toMatchObject({ profiles: ['work'] });
  });

  it('should send neither field when the answer is signing in, even with a profile still written', () => {
    // Arrange — switching back to "sign in" must not smuggle a declaration into the change. The fields
    // are kept so somebody switching their mind twice does not lose what they typed.
    const draft = draftOf({ credential: 'login', profiles: ['work'], newProfile: written({ name: 'mine' }) });

    // Act
    const request = createAccountProposal(draft);

    // Assert
    expect(request.mutation).not.toHaveProperty('profiles');
    expect(request.mutation).not.toHaveProperty('declareProfiles');
  });
});
