import { describe, it } from 'bun:test';
import should from 'should';
import { renderPairingRedirectPage } from '../../../src/lib/pair/redirect-page';
import { CODE, PAIR_URL } from './fixtures';

/** The one line of script the page runs, which is the whole of what it does. */
// The two Unicode line separators, spelled by code so no invisible character sits in this source.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const scriptOf = (page: string): string => /<script>([\s\S]*?)<\/script>/u.exec(page)?.[1] ?? '';

describe('pairing redirect page', () => {
  it('should replace itself with the link, fragment and all, so the code never has to travel in an argv', () => {
    const script = scriptOf(renderPairingRedirectPage(PAIR_URL));
    should(script).startWith('location.replace(');
    // The link is a JSON string literal: evaluating the argument gives back exactly the link the daemon minted.
    const literal = script.slice('location.replace('.length, script.lastIndexOf(')'));
    should(JSON.parse(literal)).equal(PAIR_URL);
    should(PAIR_URL).containEql(`code=${CODE}`);
  });

  it('should keep a hostile link as text rather than let it close the script', () => {
    const hostile = `https://ferretry.example.invalid/pair#v1;x=</script><script>alert(1)//&${LS}${PS}`;
    const page = renderPairingRedirectPage(hostile);
    // Exactly one script element survives, and its literal still decodes to the original text.
    should(page.match(/<script>/gu)).have.length(1);
    should(page.match(/<\/script>/gu)).have.length(1);
    should(page).not.containEql(LS);
    should(page).not.containEql(PS);
    const script = scriptOf(page);
    should(JSON.parse(script.slice('location.replace('.length, script.lastIndexOf(')')))).equal(hostile);
  });

  it('should refuse a link that would run as code or is not a URL at all', () => {
    should(() => renderPairingRedirectPage('javascript:alert(1)')).throw('the pairing link must use http or https');
    should(() => renderPairingRedirectPage('data:text/html,hi')).throw('the pairing link must use http or https');
    should(() => renderPairingRedirectPage('ferretry.pages.dev/pair')).throw('the pairing link is not an absolute URL');
  });

  it('should tell the browser not to send a referrer, so the page it came from is not announced to the app', () => {
    should(renderPairingRedirectPage(PAIR_URL)).containEql('<meta name="referrer" content="no-referrer">');
  });
});
