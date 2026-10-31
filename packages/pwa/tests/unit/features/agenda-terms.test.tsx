import { afterEach, describe, expect, test } from 'bun:test';
import { markTerms, TermLayer } from '../../../src/features/agenda/agenda-terms.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const TERMS = [
  { term: 'login', meaning: 'One signed-in account.' },
  { term: 'turn', meaning: 'One reply cycle.' },
];

describe('marking the terms an agenda card uses', () => {
  test('marks the first use of each term as a term link, whatever its case, and a plural', () => {
    expect(markTerms('Each Login has a limit; a login resets.', TERMS)).toBe(
      'Each [Login](#fy-term-0) has a limit; a login resets.',
    );
    expect(markTerms('Two turns run.', TERMS)).toBe('Two [turns](#fy-term-1) run.');
  });

  test('never marks inside a word, a code span, a link or a URL', () => {
    expect(markTerms('relogin loginx', TERMS)).toBe('relogin loginx');
    expect(markTerms('`login` and [login](https://x.test) https://x.test/login', TERMS)).toBe(
      '`login` and [login](https://x.test) https://x.test/login',
    );
  });

  test('marks a term once across the texts of one card', () => {
    const seen = new Set<number>();
    expect(markTerms('a login', TERMS, seen)).toBe('a [login](#fy-term-0)');
    expect(markTerms('another login', TERMS, seen)).toBe('another login');
  });

  test('leaves text alone when the item spells out no terms, or a term is blank', () => {
    expect(markTerms('a login', [])).toBe('a login');
    expect(markTerms('a login', [{ term: ' ', meaning: 'x' }])).toBe('a login');
  });

  test('does not mark a term inside another term’s mark', () => {
    const nested = [
      { term: 'hard limit', meaning: 'Stops spend.' },
      { term: 'limit', meaning: 'A cap.' },
    ];
    expect(markTerms('the hard limit', nested)).toBe('the [hard limit](#fy-term-0)');
  });
});

describe('the term layer', () => {
  const draw = async () => {
    view = await mount(
      <TermLayer renderProse={text => <span>{text}</span>} terms={TERMS}>
        <a href="#fy-term-1">turn</a>
        <a href="#fy-term-9">ghost</a>
        <a href="https://x.test">elsewhere</a>
      </TermLayer>,
    );
    return must(view.container, 'view');
  };

  test('shows a tapped term’s meaning, and a tap elsewhere hides it', async () => {
    const root = await draw();
    await interact(() => must(root.querySelector<HTMLElement>('a[href="#fy-term-1"]'), 'term').click());
    expect(must(root.querySelector('[data-agenda-term-tip]'), 'tip').textContent).toBe('turn One reply cycle.');
    await interact(() => document.body.click());
    expect(root.querySelector('[data-agenda-term-tip]')).toBeNull();
  });

  test('draws nothing for a mark that names no term, and lets an ordinary link be', async () => {
    const root = await draw();
    await interact(() => must(root.querySelector<HTMLElement>('a[href="#fy-term-9"]'), 'ghost').click());
    expect(root.querySelector('[data-agenda-term-tip]')).toBeNull();
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    must(root.querySelector('a[href="https://x.test"]'), 'link').dispatchEvent(plain);
    expect(root.querySelector('[data-agenda-term-tip]')).toBeNull();
  });
});
