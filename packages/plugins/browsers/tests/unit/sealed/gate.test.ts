import { describe, it } from 'bun:test';
import should from 'should';
import {
  contentDependentSelector,
  isPasteChord,
  originOnly,
  SealedGate,
  SealedRefusal,
  selectorsOf,
  type SealedPageProbe,
} from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';

/** Never a real credential: it appears only in what a page shows, and must be in no sentence the gate says. */
const SENTINEL = 'FAKE-SC-7f3a91';
const SOURCE = 'https://keys.example.test';
const UNTIL = Date.UTC(2026, 10, 13, 12);

/** A timer for the registry's wait, as the kernel's clock gives the daemon one. */
const TIMERS = {
  after: (ms: number, action: () => void) => {
    const handle = setTimeout(action, ms);
    return () => clearTimeout(handle);
  },
};

function build(masks: (text: string) => string = text => text.replaceAll(SENTINEL, '[sealed:token]')) {
  const sealed = new SealedPages(TIMERS);
  const gate = new SealedGate({ sealed, mask: async text => masks(text) });
  return { sealed, gate };
}

/** A page as the gate sees it from inside the page's queue. */
const probe = (over: SealedPageProbe = {}): SealedPageProbe => ({ host: async () => 'docs.example.test', ...over });

async function said(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    should(error).be.instanceOf(SealedRefusal);
    return (error as Error).message;
  }
}

describe('FINDING 5: a selector that depends on what a page says is not allowed on a page that holds a sealed value', () => {
  const REFUSED = [
    'text=Save',
    'text="FAKE"',
    'button:has-text("x")',
    ':text("a")',
    ':text-is("a")',
    ':text-matches("a.*")',
    '[value^="FAKE"]',
    '[value*=FAKE]',
    '[aria-label*=key]',
    '[title="x"]',
    '[href$=".pdf"]',
    '[data-secret="abc"]',
    '[placeholder="a" i]',
    'input[value=a]',
    'xpath=//div[contains(text(), "a")]',
    '//input[@value="x"]',
    '//*[starts-with(@id, "a")]',
    '//div[text()="a"]',
    'role=button[name="Save"]',
    'role=textbox[name=/key/i]',
    'internal:text="x"',
    'internal:label="x"',
    'a >> text=foo',
    'label=Name',
    'div[class="a"',
  ];
  const ALLOWED = [
    '#save',
    '.btn.primary',
    'button',
    'form > button:nth-child(2)',
    'ul li:first-child',
    '[type=submit]',
    '[name=email]',
    '[data-testid=save]',
    '[id="x"]',
    '[disabled]',
    'input[type="text"]',
    'role=button',
    'role=checkbox[checked]',
    'role=heading[level=2]',
    'xpath=//div[2]/button',
    '//ul/li[3]',
    'id=save',
    'css=.save',
    'nth=0',
    '#a >> .b',
  ];

  for (const selector of REFUSED)
    it(`should call ${JSON.stringify(selector)} content-dependent`, () => {
      should(contentDependentSelector(selector)).equal(true);
    });
  for (const selector of ALLOWED)
    it(`should let ${JSON.stringify(selector)} through: it is structure`, () => {
      should(contentDependentSelector(selector)).equal(false);
    });

  it('should collect every selector a call names, a drag’s end and a form field’s included', () => {
    should(
      selectorsOf({
        tool: 'browser.drag',
        selector: '#a',
        endSelector: '#b',
        fields: [{ selector: '#c', value: 'x' }],
      }),
    ).eql(['#a', '#b', '#c']);
  });

  it('should refuse a content-dependent selector on a page that holds a value, with a sentence that names no value, and allow structure', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const refused = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.click',
        reference: '%browser:keys',
        address: `${SOURCE}/new`,
        selectors: ['text=Copy', '#save'],
      }),
    );
    const allowed = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.click',
        reference: '%browser:keys',
        address: `${SOURCE}/new`,
        selectors: ['#save', 'button.primary'],
      }),
    );

    should(refused).containEql('depends on what the page says');
    should(refused).containEql('Name the element by structure');
    should(refused).not.containEql(SENTINEL);
    should(allowed).equal(undefined);
  });

  it('should not restrict selectors on a page no copy covers, nor for a copy that has ended', async () => {
    const { sealed, gate } = build();
    let ends: number | undefined = UNTIL;
    sealed.hold('s1', 'token', [SOURCE], () => ends);

    const other = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.click',
        reference: '%browser:docs',
        address: 'https://docs.example.test/',
        selectors: ['text=Go'],
      }),
    );
    ends = undefined;
    const after = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.click',
        reference: '%browser:keys',
        address: `${SOURCE}/`,
        selectors: ['text=Go'],
      }),
    );

    should(other).equal(undefined);
    should(after).equal(undefined);
  });
});

describe('FINDING 5: the words of a closed page are withheld from what an act brings back', () => {
  it('should cut an address to its origin, whatever its path, query or fragment carries', () => {
    should(originOnly('https://keys.example.test:8443/a/b?token=abc#frag')).equal('https://keys.example.test:8443/…');
    should(originOnly('about:blank')).equal('about:…');
    should(originOnly('not a url')).equal('…');
  });
});

describe('FINDING 6: a frame inside the page counts as much as the page does', () => {
  it('should close a page of another site that embeds a frame of the protected site, by every frame’s host', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const sentence = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.read',
        reference: '%browser:blog',
        address: 'https://blog.example.test/',
        page: probe({ hosts: async () => ['blog.example.test', 'keys.example.test'] }),
      }),
    );
    const clean = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.read',
        reference: '%browser:blog',
        address: 'https://blog.example.test/',
        page: probe({ hosts: async () => ['blog.example.test', 'ads.example.test'] }),
      }),
    );

    should(sentence).containEql('browser.read is refused on %browser:blog');
    should(clean).equal(undefined);
  });

  it('should fail closed when a frame cannot be told (the page’s hosts cannot be read)', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const sentence = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.read',
        reference: '%browser:blog',
        address: 'https://blog.example.test/',
        page: probe({ hosts: async () => undefined }),
      }),
    );

    should(sentence).containEql('browser.read is refused');
  });

  it('should withhold a picture of a page whose FRAME shows the value, when the text check sees every frame’s text', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const sentence = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.screenshot',
        reference: '%browser:blog',
        address: 'https://blog.example.test/',
        page: probe({
          hosts: async () => ['blog.example.test', 'ads.example.test'],
          text: async () => `article\n${SENTINEL}\nfooter`,
        }),
      }),
    );

    should(sentence).containEql('browser.screenshot is withheld on %browser:blog');
    should(sentence).containEql('sealed:token');
    should(sentence).not.containEql(SENTINEL);
  });

  it('should withhold a picture when a frame’s text cannot be read, never guess', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const sentence = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.screenshot',
        reference: '%browser:blog',
        address: 'https://blog.example.test/',
        page: probe({ hosts: async () => ['blog.example.test'], text: async () => undefined }),
      }),
    );

    should(sentence).containEql("could not read this page's text (and its frames')");
  });
});

describe('FINDING 7: the guard is the browser’s, not the ferret’s', () => {
  it('should refuse every ferret that uses the browser on a page one ferret’s copy sits on, naming no other ferret’s copy', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const second = await said(
      gate.check({ ferret: 's2', tool: 'browser.read', reference: '%browser:keys', address: `${SOURCE}/` }),
    );

    should(second).containEql('browser.read is refused on %browser:keys');
    should(second).containEql('a value another ferret sealed');
    should(second).not.containEql('sealed:token');
  });

  it('should withhold a picture of ANY page that shows another ferret’s live copy, and name it only as another ferret’s', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const sentence = await said(
      gate.check({
        ferret: 's2',
        tool: 'browser.screenshot',
        reference: '%browser:dash',
        address: 'https://dash.example.test/',
        page: probe({ text: async () => `key ${SENTINEL}` }),
      }),
    );

    should(sentence).containEql('is withheld on %browser:dash');
    should(sentence).containEql('another ferret sealed');
    should(sentence).not.containEql('sealed:token');
    should(sentence).not.containEql(SENTINEL);
  });

  it('should still pass a page no live copy of anyone’s covers', async () => {
    const { sealed, gate } = build();
    sealed.hold('s1', 'token', [SOURCE], () => UNTIL);

    const ok = await said(
      gate.check({
        ferret: 's2',
        tool: 'browser.screenshot',
        reference: '%browser:docs',
        address: 'https://docs.example.test/',
        page: probe({ text: async () => 'Documentation' }),
      }),
    );

    should(ok).equal(undefined);
  });
});

describe('FINDING 8: a pending capture is checked where the script runs, and waits for scripts already running', () => {
  it('should refuse a script at the execution boundary when a capture began after the call was admitted', async () => {
    const { sealed, gate } = build();
    const admitted = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.eval',
        reference: '%browser:docs',
        address: 'https://docs.example.test/',
      }),
    );

    const done = sealed.capturing('s2');
    const inQueue = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.eval',
        reference: '%browser:docs',
        address: 'https://docs.example.test/',
        page: probe(),
      }),
    );
    done();
    const after = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.eval',
        reference: '%browser:docs',
        address: 'https://docs.example.test/',
        page: probe(),
      }),
    );

    should(admitted).equal(undefined);
    should(inQueue).containEql('browser.eval is refused while a clipboard capture is running in this browser');
    should(after).equal(undefined);
  });

  it('should make a capture wait for a script that was already running, and say so when it does not finish', async () => {
    const { sealed } = build();
    const ended = sealed.scriptRunning();
    sealed.capturing('s1');

    const early = sealed.idle(5);
    const timedOut = await early;
    const waiting = sealed.idle(1_000);
    ended();
    const finished = await waiting;

    should(timedOut).equal(false);
    should(finished).equal(true);
    should(await sealed.idle(1)).equal(true);
  });

  it('should count a script BEFORE its checks, so no script can slip between the capture’s wait and the check', async () => {
    const { sealed, gate } = build();
    const order: string[] = [];
    // The script registers (as the tools do), then asks the gate; the capture begins in between.
    const ended = sealed.scriptRunning();
    order.push('registered');
    const done = sealed.capturing('s1');
    order.push('capturing');
    const refused = await said(
      gate.check({
        ferret: 's1',
        tool: 'browser.eval',
        reference: '%browser:a',
        address: 'https://a.test/',
        page: probe(),
      }),
    );
    ended();
    order.push('script released');

    should(order).eql(['registered', 'capturing', 'script released']);
    should(refused).containEql('clipboard capture is running');
    should(await sealed.idle(10)).equal(true);
    done();
  });
});

describe('FINDING 2: a clipboard that could not be emptied keeps its pages closed and its keyboard paste refused', () => {
  it('should refuse a keyboard paste, and keep the capture’s page closed after the copy ended, until a retry empties it', async () => {
    const { sealed, gate } = build();
    let clear = false;
    let tries = 0;
    sealed.keepClipboard('s1', 'clipboard', [SOURCE], async () => {
      tries += 1;
      return clear;
    });

    const paste = await said(
      gate.check({
        ferret: 's2',
        tool: 'browser.press',
        reference: '%browser:form',
        address: 'https://form.example.test/',
        keys: ['Control+V'],
      }),
    );
    const read = await said(
      gate.check({ ferret: 's2', tool: 'browser.read', reference: '%browser:keys', address: `${SOURCE}/` }),
    );
    const typing = await said(
      gate.check({
        ferret: 's2',
        tool: 'browser.press',
        reference: '%browser:form',
        address: 'https://form.example.test/',
        keys: ['Enter'],
      }),
    );
    clear = true;
    const later = await said(
      gate.check({
        ferret: 's2',
        tool: 'browser.press',
        reference: '%browser:form',
        address: 'https://form.example.test/',
        keys: ['Control+V'],
      }),
    );
    const reopened = await said(
      gate.check({ ferret: 's2', tool: 'browser.read', reference: '%browser:keys', address: `${SOURCE}/` }),
    );

    should(paste).containEql('keyboard paste is refused');
    should(paste).containEql('clipboard could not be emptied');
    should(read).containEql('browser.read is refused');
    should(read).containEql("until the browser's clipboard has been emptied");
    should(typing).equal(undefined);
    should(later).equal(undefined);
    should(reopened).equal(undefined);
    should(tries).be.aboveOrEqual(3);
    should(sealed.clipboardKept()).equal(false);
  });

  it('should recognise every spelling of a paste chord, and no other key', () => {
    for (const chord of [
      'Control+V',
      'ctrl+v',
      'Meta+V',
      'Cmd+V',
      'ControlOrMeta+V',
      'Shift+Insert',
      'Control+Shift+V',
    ])
      should(isPasteChord(chord)).equal(true);
    for (const chord of ['V', 'Enter', 'Control+C', 'Control+A', 'Insert', 'Shift+Tab', ''])
      should(isPasteChord(chord)).equal(false);
  });
});
