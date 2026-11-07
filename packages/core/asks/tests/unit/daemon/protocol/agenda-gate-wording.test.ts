import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaGate, AgendaGateOption } from '../../src/lib/agenda.ts';
import {
  GATE_GOOD_LABEL,
  gateAskLine,
  gateButtonLabel,
  gateStyle,
  gateTapOptions,
  gateTypedLabel,
  gateTypedLead,
  gateTypedPlaceholder,
  previewUrlOf,
  tryItText,
} from '../../src/lib/agenda-gate-wording.ts';

const DONE: AgendaGateOption = { id: 'done', label: 'Done', outcome: 'close' };
const NOT_GOOD: AgendaGateOption = { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' };
const OK: AgendaGateOption = { id: 'ok', label: 'OK to build', outcome: 'next' };

const gate = (...options: AgendaGateOption[]): AgendaGate => ({
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 1,
  projectId: 'p-1',
  options,
});

const POINTER = (length: number): string => `too long: ${String(length)}`;
const none = { prs: [] } as const;

describe('a gate’s style comes from its lane’s stage', () => {
  it('is a try-it when an option sends the card back, else an approval', () => {
    should(gateStyle(gate(DONE, NOT_GOOD))).equal('try-it');
    should(gateStyle(gate(OK))).equal('approval');
  });

  it('says Good for a try-it’s default pass and keeps every other label as the lane wrote it', () => {
    const tried = gate(DONE, NOT_GOOD);
    should(gateButtonLabel(tried, DONE)).equal(GATE_GOOD_LABEL);
    should(gateButtonLabel(tried, { ...DONE, label: 'Ship it' })).equal('Ship it');
    should(gateButtonLabel(gate(OK), OK)).equal('OK to build');
    should(gateButtonLabel(gate({ ...OK, label: 'Done' }), { ...OK, label: 'Done' })).equal('Done');
  });

  it('taps every option but the one that is answered in words', () => {
    should(gateTapOptions(gate(DONE, NOT_GOOD))).eql([DONE]);
    should(gateTapOptions(gate(OK))).eql([OK]);
  });

  it('types as Not good at a try-it and as Not yet at an approval, and says so in plain words', () => {
    should(gateTypedLabel(gate(DONE, NOT_GOOD))).equal('Not good');
    should(gateTypedLabel(gate(OK))).equal('Not yet');
    should(gateTypedLabel(gate())).be.undefined();
    should(gateTypedLead(gate(DONE, NOT_GOOD))).match(/Not good\? Type what is wrong/u);
    should(gateTypedLead(gate(OK))).match(/ferret reads your words first/u);
    should(gateTypedPlaceholder(gate(DONE, NOT_GOOD))).equal('What is wrong, or what needs changing?');
    should(gateTypedPlaceholder(gate(OK))).equal('What should change first?');
  });

  it('asks in the lane’s own words: Try it for a test, the option for an approval', () => {
    should(gateAskLine(gate(DONE, NOT_GOOD), 'Badge colour')).equal('Try it: Badge colour');
    should(gateAskLine(gate(OK), 'Badge colour')).equal('OK to build? Badge colour');
    should(gateAskLine(gate(), 'Badge colour')).equal('Ready to try? Badge colour');
  });
});

describe('the preview a card links', () => {
  const card = (...docs: string[]) => ({ links: { prs: [], docs } });

  it('is a Cloudflare Pages preview, never the production host or another site', () => {
    should(previewUrlOf(card('https://abc123.ferretry.pages.dev/inbox'))).equal(
      'https://abc123.ferretry.pages.dev/inbox',
    );
    should(previewUrlOf(card('https://ferretry.pages.dev/'))).be.undefined();
    should(previewUrlOf(card('http://abc.ferretry.pages.dev/'))).be.undefined();
    should(previewUrlOf(card('https://example.com/a'))).be.undefined();
    should(previewUrlOf(card('docs/board.md', ''))).be.undefined();
    should(previewUrlOf({ links: { prs: [] } })).be.undefined();
  });

  it('is the first one linked', () => {
    should(previewUrlOf(card('docs/a.md', 'https://one.ferretry.pages.dev/', 'https://two.ferretry.pages.dev/'))).equal(
      'https://one.ferretry.pages.dev/',
    );
  });
});

describe('everything needed to try it', () => {
  const pr = (state: 'unknown' | 'open' | 'closed' | 'merged', version?: string) => ({
    url: 'https://github.com/kirinnee/ferretry/pull/9',
    state,
    releasedIn: version === undefined ? null : { version },
  });

  it('puts the preview first, then the steps as written, then where the work stands', () => {
    const text = tryItText(
      {
        howToTest: '1. Where: the Inbox\n2. Do: tap Good\n3. See: it closes',
        links: { prs: [pr('merged', '1.2.3')], docs: ['https://abc.ferretry.pages.dev/'] },
      },
      POINTER,
      10_000,
      { repository: 'kirinnee/ferretry', name: 'Ferretry' },
    );
    should(text.indexOf('**Try it on the preview:** https://abc.ferretry.pages.dev/')).equal(0);
    should(text).containEql('1. Where: the Inbox');
    should(text).containEql('Shipped in Ferretry v1.2.3 (https://github.com/kirinnee/ferretry/pull/9)');
    should(text).containEql('fy daemon update');
    should(text.indexOf('1. Where')).be.below(text.indexOf('Shipped in'));
  });

  it('names another project’s release by its repository, and never tells the owner to update the product for it', () => {
    const other = {
      url: 'https://github.com/acme/widgets/pull/4',
      state: 'merged' as const,
      releasedIn: { version: '1.2.3' },
    };
    const text = tryItText({ howToTest: '1. Go', links: { prs: [other] } }, POINTER, 10_000, {
      repository: 'kirinnee/ferretry',
      name: 'Ferretry',
    });
    should(text).containEql('Released in acme/widgets v1.2.3 (https://github.com/acme/widgets/pull/4)');
    should(text).not.containEql('Ferretry');
    should(text).not.containEql('fy daemon update');
    // A guide written with no product of its own names every release by its repository.
    should(tryItText({ howToTest: '1. Go', links: { prs: [pr('merged', '1.2.3')] } }, POINTER, 10_000)).containEql(
      'Released in kirinnee/ferretry v1.2.3',
    );
  });

  it('says where to try it for real when there is no preview', () => {
    const text = tryItText({ howToTest: '1. Open it', links: none }, POINTER, 10_000);
    should(text).startWith('There is no preview for this one. Try it for real: the steps below say where.');
    should(text).containEql('1. Open it');
    should(text).not.containEql('preview:');
  });

  it('says a merged PR is not released yet, an open one is not shipped, and any other is just linked', () => {
    const say = (state: 'unknown' | 'open' | 'closed' | 'merged') =>
      tryItText({ howToTest: '1. Go', links: { prs: [pr(state)] } }, POINTER, 10_000);
    should(say('merged')).containEql('Merged, not released yet: https://github.com/kirinnee/ferretry/pull/9');
    should(say('open')).containEql('Not merged yet, so not shipped');
    should(say('closed')).containEql('Pull request: https://github.com/kirinnee/ferretry/pull/9');
    should(say('unknown')).containEql('Pull request: ');
  });

  it('tells a cold reader there are no steps, and never invents any', () => {
    should(tryItText({ howToTest: null, links: none }, POINTER, 10_000)).containEql('No steps were written yet');
    should(tryItText({ howToTest: '   ', links: none }, POINTER, 10_000)).containEql('No steps were written yet');
  });

  it('points at the card when the steps do not fit, rather than cutting them', () => {
    const steps = `1. ${'x'.repeat(500)}`;
    const text = tryItText({ howToTest: steps, links: none }, POINTER, 300);
    should(text).containEql(`too long: ${String(steps.length)}`);
    should(text).not.match(/x{10}/u);
  });
});
