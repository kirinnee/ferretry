import { describe, it } from 'bun:test';
import type { Card, CardGate, PrLink } from '../../../contract/index.ts';
import should from 'should';
import { nothingToTryReason, saysNothingToTry, tryItVerdict } from '../../../daemon/lib/board/index.ts';
import { card } from './support.ts';

const TRY_IT: Pick<CardGate, 'options'> = {
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-ask' },
  ],
};
const PLAN: Pick<CardGate, 'options'> = { options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }] };

const pr = (number: number, changes?: PrLink['changes'], state: PrLink['state'] = 'merged'): PrLink => ({
  url: `https://github.com/ferretry/ferretry/pull/${String(number)}`,
  number,
  repo: 'ferretry/ferretry',
  state,
  draft: false,
  checks: 'passing',
  mergedAt: state === 'merged' ? '2026-10-30T09:00:00.000Z' : null,
  mergeSha: state === 'merged' ? 'a'.repeat(40) : null,
  releasedIn: null,
  polledAt: '2026-10-30T09:00:00.000Z',
  ...(changes === undefined ? {} : { changes }),
});

/** A card a person asked for, with steps to try and no PR: the case that is asked. */
const tryable = (overrides: Partial<Card> = {}): Card =>
  card({
    ask: { text: 'make it', source: 'owner' },
    createdBy: { kind: 'ferret', name: 'lead', ferret: 'lead' },
    howToTest: '1. Open the Inbox\n2. Tap Done',
    ...overrides,
  });

const withPrs = (...prs: PrLink[]): Partial<Card> => ({
  links: { prs, branch: null, commits: [], docs: [] },
});

describe('tryItVerdict', () => {
  it('asks for a public card with steps and no PR: exactly as before', () => {
    should(tryItVerdict(tryable(), TRY_IT)).eql({ kind: 'ask' });
  });

  it('never touches the plan gate: it asks even for a private card with no steps', () => {
    const plain = tryable({ visibility: 'private', visibilitySource: 'chosen', howToTest: '' });
    should(tryItVerdict(plain, PLAN)).eql({ kind: 'ask' });
    should(tryItVerdict({ ...plain, blockedBy: [{ id: 'F2' }] }, PLAN)).eql({ kind: 'ask' });
  });

  describe('wait', () => {
    it('waits while an open dependency holds the card, before anything else is looked at', () => {
      const held = { ...tryable({ visibility: 'private', visibilitySource: 'chosen' }), blockedBy: [{ id: 'F2' }] };
      should(tryItVerdict(held, TRY_IT)).match({ kind: 'wait', why: 'it waits on 1 other card' });
      should(tryItVerdict({ ...held, blockedBy: [{ id: 'F2' }, { id: 'F3' }] }, TRY_IT)).match({
        kind: 'wait',
        why: 'it waits on 2 other cards',
      });
    });

    it('waits while the card is blocked by hand', () => {
      const held = tryable({
        blocked: { on: 'external', reason: 'waiting on the vendor', since: '2026-10-30T09:00:00Z' },
      });
      should(tryItVerdict(held, TRY_IT)).eql({ kind: 'wait', why: 'it is blocked: waiting on the vendor' });
    });

    it('waits on an umbrella card while its sub-cards are still being built, even with steps and a code PR', () => {
      const umbrella = { ...tryable(withPrs(pr(1536, 'code'))), building: 1 };
      should(tryItVerdict(umbrella, TRY_IT)).eql({
        kind: 'wait',
        why: 'it is an umbrella card: 1 of its sub-cards is still being built',
      });
      should(tryItVerdict({ ...umbrella, building: 3 }, TRY_IT)).match({
        why: 'it is an umbrella card: 3 of its sub-cards are still being built',
      });
    });

    it('decides as for any card once no sub-card is still being built', () => {
      should(tryItVerdict({ ...tryable(), building: 0 }, TRY_IT)).eql({ kind: 'ask' });
    });

    it('does not wait for a dependency list that is empty', () => {
      should(tryItVerdict({ ...tryable(), blockedBy: [] }, TRY_IT)).eql({ kind: 'ask' });
    });
  });

  describe('nothing', () => {
    it('finds nothing to try in internal work (a chore), even with steps and a code PR', () => {
      should(tryItVerdict(tryable({ kind: 'chore', ...withPrs(pr(1536, 'code')) }), TRY_IT)).eql({
        kind: 'nothing',
        why: 'it is internal work, with nothing a person sees',
      });
      should(tryItVerdict(tryable({ kind: 'feature' }), TRY_IT)).eql({ kind: 'ask' });
    });

    it('finds nothing to try on a private card, however it came to be private', () => {
      should(tryItVerdict(tryable({ visibility: 'private', visibilitySource: 'chosen' }), TRY_IT)).eql({
        kind: 'nothing',
        why: 'it is a private card',
      });
      // No stored visibility: a ferret's own card reads as private by the daemon's default.
      should(tryItVerdict(tryable({ ask: { text: 'tidy', source: 'session:lead' }, askedBy: 'agent' }), TRY_IT)).match({
        kind: 'nothing',
        why: 'it is a private card',
      });
    });

    it('asks for a card made public, whoever asked', () => {
      should(
        tryItVerdict(tryable({ ask: { text: 'tidy', source: 'session:lead' }, visibility: 'public' }), TRY_IT),
      ).eql({ kind: 'ask' });
    });

    it('finds nothing to try when there are no steps', () => {
      for (const howToTest of ['', '   \n ']) {
        should(tryItVerdict(tryable({ howToTest }), TRY_IT)).eql({ kind: 'nothing', why: 'it has no steps to try' });
      }
    });

    it('finds nothing to try when the steps say so', () => {
      should(tryItVerdict(tryable({ howToTest: 'Nothing to try: unit suites pass.' }), TRY_IT)).eql({
        kind: 'nothing',
        why: 'its steps say there is nothing to try',
      });
    });

    it('finds nothing to try when every merged PR changed only docs and tests', () => {
      should(tryItVerdict(tryable(withPrs(pr(1, 'docs-tests'), pr(2, 'docs-tests'))), TRY_IT)).eql({
        kind: 'nothing',
        why: 'its PRs change only docs and tests',
      });
    });

    it('asks when any merged PR changed code, or its kind is unknown (read as code)', () => {
      should(tryItVerdict(tryable(withPrs(pr(1, 'docs-tests'), pr(2, 'code'))), TRY_IT)).eql({ kind: 'ask' });
      should(tryItVerdict(tryable(withPrs(pr(1, 'docs-tests'), pr(2))), TRY_IT)).eql({ kind: 'ask' });
      should(tryItVerdict(tryable(withPrs(pr(1))), TRY_IT)).eql({ kind: 'ask' });
    });

    it('needs at least one merged PR: none linked is not "only docs"', () => {
      should(tryItVerdict(tryable(withPrs()), TRY_IT)).eql({ kind: 'ask' });
    });

    it('does not count a PR that is not merged', () => {
      should(tryItVerdict(tryable(withPrs(pr(1, 'docs-tests', 'open'))), TRY_IT)).eql({ kind: 'ask' });
      // An open code PR beside merged docs PRs does not stop the card from having nothing merged to try.
      should(tryItVerdict(tryable(withPrs(pr(1, 'docs-tests'), pr(2, 'code', 'open'))), TRY_IT)).eql({
        kind: 'nothing',
        why: 'its PRs change only docs and tests',
      });
    });
  });
});

describe('saysNothingToTry', () => {
  it('reads the closed grammar of complete no-testing declarations', () => {
    for (const text of [
      '',
      '   ',
      'Nothing to try',
      'Nothing to try.',
      'NOTHING TO TEST',
      'Nothing for you to try.',
      'Nothing for the owner to test',
      'No user-visible change',
      'No user visible change.',
      'No user-facing behaviour change.',
      'No user facing behavior change',
      'No app behaviour change',
      'No PWA behaviour change.',
      'No behavior change.',
      'No behaviour change',
      'Docs only',
      'Tests only.',
      'Docs and tests only.',
      'Nothing to try: docs only.',
      'Nothing to try; tests only',
      'Nothing to try, docs and tests only',
      'Nothing to try \u2014 internal refactor',
      'Nothing to test: refactor only.',
      'Nothing to try: CI only',
      'Nothing to try: unit suites pass.',
      'No behaviour change: unit suites pass',
      'No user-visible change; nothing to try.',
      'No user-visible change; nothing to test.',
      'Nothing to try: unit suites pass; no PWA behaviour change.',
    ]) {
      should([text, saysNothingToTry(text)]).eql([text, true]);
    }
    should(saysNothingToTry(undefined)).be.true();
    should(saysNothingToTry(null)).be.true();
  });

  it('asks for everything outside the grammar — a verb is never what decides', () => {
    for (const text of [
      'No PWA change after toggling the setting.',
      'No change should appear while typing in the password field.',
      'No change in scrolling after switching tabs.',
      'No change in scrolling',
      'No change',
      'Nothing to try after the migration',
      'Nothing to try here',
      'nothing to test here',
      'Nothing to try when the flag is off.',
      'Nothing to try until the PR merges',
      'No behaviour change in the CLI',
      'No behaviour change on the settings page',
      'No user-visible change during login',
      'Docs only, then check the page',
      'Docs only if you skim them',
      'Docs only. Then open the page.',
      'Nothing to try. Nothing to test.',
      'Nothing to try — confirm the build is green.',
      'No behaviour change. Run `fy agenda list` and check the output.',
      'Nothing to try: it should still work',
      'Nothing to try: docs only, tests only, CI only, unit suites pass',
      'Docs only\nthen check the page',
      '- Docs only\n- Nothing to test',
      '1. Open Settings. 2. Toggle the new switch. 3. Confirm no behaviour change in keyboard navigation.',
      '1. Open the Inbox\n2. Tap Done',
      'There is nothing wrong with the badge; open it and look.',
      'Try the new button; it changes behaviour.',
      'Open Settings, toggle the switch: nothing to test after that.',
    ]) {
      should([text.slice(0, 60), saysNothingToTry(text)]).eql([text.slice(0, 60), false]);
    }
  });

  it('asks (does not close) the card whose How to test is such a near-miss', () => {
    for (const howToTest of [
      'No PWA change after toggling the setting.',
      'No change should appear while typing in the password field.',
      'No change in scrolling after switching tabs.',
      '1. Open Settings. 2. Toggle the new switch. 3. Confirm no behaviour change in keyboard navigation.',
      'No PWA behaviour change. Run `fy agenda list` and check the output.',
    ]) {
      should(tryItVerdict(tryable({ howToTest }), TRY_IT)).eql({ kind: 'ask' });
    }
  });

  it('closes the card whose How to test is a complete declaration', () => {
    for (const howToTest of ['Docs only.', 'No user-visible change; nothing to try.']) {
      should(tryItVerdict(tryable({ howToTest }), TRY_IT)).eql({
        kind: 'nothing',
        why: 'its steps say there is nothing to try',
      });
    }
  });
});

describe('nothingToTryReason', () => {
  it('is the one line the card closes with', () => {
    should(nothingToTryReason('its PRs change only docs and tests')).equal(
      'Nothing to try: its PRs change only docs and tests',
    );
  });
});
