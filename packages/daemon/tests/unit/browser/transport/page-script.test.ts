import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ActableCdp,
  type ActableLocator,
  type ActablePage,
  PAGE_SCRIPT_MAX_RESULT_CHARS,
  PAGE_SCRIPT_WORLD,
  pageScriptExpression,
  runPageScript,
  staleRefMessage,
} from '../../../../src/lib/index.ts';

/** A DevTools session that answers the three calls a page script makes, and records each. */
class FakeCdp implements ActableCdp {
  readonly sent: { readonly method: string; readonly params: Readonly<Record<string, unknown>> }[] = [];
  answer: unknown = { result: { value: '"Welcome"' } };
  frame: unknown = { frameTree: { frame: { id: 'frame-1' } } };
  world: unknown = { executionContextId: 7 };
  /** Never settle the evaluation, as a script that only waits never does. */
  hang = false;

  async send(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === 'Page.getFrameTree') return this.frame;
    if (method === 'Page.createIsolatedWorld') return this.world;
    if (this.hang) return await new Promise(() => undefined);
    return this.answer;
  }
}

/** A page whose elements record the marks a script call puts on them and takes off them. */
class FakePage implements Pick<ActablePage, 'locator'> {
  readonly evaluated: string[] = [];
  readonly refs = new Set(['e1']);

  locator(selector: string): ActableLocator {
    const unused = async (): Promise<never> => {
      throw new Error('not used by a page script');
    };
    const locator = {
      first: () => locator,
      count: async () => {
        const ref = /^aria-ref=(.+)$/u.exec(selector)?.[1];
        return ref === undefined || this.refs.has(ref) ? 1 : 0;
      },
      // The real page function runs, on an element that records what was done to it.
      evaluate: async (pageFunction: (element: never, arg: string) => unknown, arg: string) => {
        const element = {
          setAttribute: (name: string, value: string) => this.evaluated.push(`${selector} set ${name}=${value}`),
          removeAttribute: (name: string) => this.evaluated.push(`${selector} remove ${name}`),
        };
        return (pageFunction as (element: unknown, arg: string) => unknown)(element, arg);
      },
      click: unused,
      fill: unused,
      pressSequentially: unused,
      press: unused,
      innerText: unused,
      ariaSnapshot: unused,
      screenshot: unused,
      getAttribute: unused,
      setInputFiles: unused,
      scrollIntoViewIfNeeded: unused,
      boundingBox: unused,
    } as unknown as ActableLocator;
    return locator;
  }
}

const page = (): FakePage => new FakePage();
const asPage = (fake: FakePage): ActablePage => fake as unknown as ActablePage;

describe('runPageScript', () => {
  it('should run the script in an isolated world on the main frame, by value, and answer its JSON', async () => {
    // Arrange
    const cdp = new FakeCdp();

    // Act
    const ran = await runPageScript(asPage(page()), cdp, { source: '() => document.title' }, () => 'mark-1');

    // Assert
    should(ran).deepEqual({ text: '"Welcome"' });
    should(cdp.sent.map(call => call.method)).deepEqual([
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    should(cdp.sent[1]?.params).deepEqual({
      frameId: 'frame-1',
      worldName: PAGE_SCRIPT_WORLD,
      grantUniveralAccess: false,
    });
    should(cdp.sent[2]?.params).match({ contextId: 7, awaitPromise: true, returnByValue: true, timeout: 5_000 });
    should(String(cdp.sent[2]?.params.expression)).containEql('() => document.title');
  });

  it('should hand the script its element by a one-time mark, and take the mark off afterwards', async () => {
    // Arrange
    const cdp = new FakeCdp();
    const fake = page();

    // Act
    await runPageScript(
      asPage(fake),
      cdp,
      { source: '(element) => element.textContent', target: { kind: 'ref', ref: 'e1' } },
      () => 'mark-7',
    );

    // Assert
    should(fake.evaluated).deepEqual([
      'aria-ref=e1 set data-ferretry-script=mark-7',
      'aria-ref=e1 remove data-ferretry-script',
    ]);
    should(String(cdp.sent[2]?.params.expression)).containEql(
      'document.querySelector("[data-ferretry-script=\\"mark-7\\"]")',
    );
  });

  it('should take the mark off even when the script throws, and say what it threw in one line', async () => {
    // Arrange
    const cdp = new FakeCdp();
    cdp.answer = {
      exceptionDetails: { exception: { description: 'TypeError: x is not a function\n    at <anonymous>:1:1' } },
    };
    const fake = page();

    // Act
    const failure = await runPageScript(
      asPage(fake),
      cdp,
      { source: '(e) => x()', target: { kind: 'selector', selector: '#a' } },
      () => 'm',
    )
      .then(() => undefined)
      .catch((error: unknown) => error as Error);

    // Assert
    should(failure?.message).equal('the script threw: TypeError: x is not a function');
    should(fake.evaluated.at(-1)).equal('#a remove data-ferretry-script');
  });

  it('should say DevTools refused the script when it names no exception', async () => {
    // Arrange
    const cdp = new FakeCdp();
    cdp.answer = { exceptionDetails: { text: 'Uncaught SyntaxError: Unexpected token' } };

    // Act
    const failure = await runPageScript(asPage(page()), cdp, { source: '() =>' }, () => 'm').catch(
      (error: unknown) => error as Error,
    );

    // Assert
    should((failure as Error).message).equal('the script threw: Uncaught SyntaxError: Unexpected token');
  });

  it('should still say the script failed when DevTools names nothing at all', async () => {
    // Arrange
    const cdp = new FakeCdp();
    cdp.answer = { exceptionDetails: {} };

    // Act
    const failure = await runPageScript(asPage(page()), cdp, { source: '() => 1' }, () => 'm').catch(
      (error: unknown) => error as Error,
    );

    // Assert
    should((failure as Error).message).equal('the script threw: the script failed');
  });

  it('should refuse a ref the page no longer knows before marking or running anything', async () => {
    // Arrange
    const cdp = new FakeCdp();
    const fake = page();

    // Act
    const failure = await runPageScript(
      asPage(fake),
      cdp,
      { source: '(e) => 1', target: { kind: 'ref', ref: 'e9' } },
      () => 'm',
    ).catch((error: unknown) => error as Error);

    // Assert
    should((failure as Error).message).equal(staleRefMessage('e9'));
    should(fake.evaluated).deepEqual([]);
    should(cdp.sent).deepEqual([]);
  });

  it('should stop a script that only waits, at its timeout', async () => {
    // Arrange
    const cdp = new FakeCdp();
    cdp.hang = true;

    // Act
    const failure = await runPageScript(
      asPage(page()),
      cdp,
      { source: '() => new Promise(() => {})', timeoutMs: 20 },
      () => 'm',
    ).catch((error: unknown) => error as Error);

    // Assert
    should((failure as Error).message).equal('the script ran past 20 ms and was stopped');
    should(cdp.sent[2]?.params.timeout).equal(20);
  });

  it('should hold the timeout inside its bounds', async () => {
    // Arrange
    const cdp = new FakeCdp();

    // Act
    await runPageScript(asPage(page()), cdp, { source: '() => 1', timeoutMs: 60_000 }, () => 'm');

    // Assert
    should(cdp.sent[2]?.params.timeout).equal(10_000);
  });

  it('should refuse a page with no frame, or a world the browser did not make', async () => {
    // Arrange
    const noFrame = new FakeCdp();
    noFrame.frame = {};
    const noWorld = new FakeCdp();
    noWorld.world = {};

    // Act
    const frameless = await runPageScript(asPage(page()), noFrame, { source: '() => 1' }, () => 'm').catch(
      (error: unknown) => error as Error,
    );
    const worldless = await runPageScript(asPage(page()), noWorld, { source: '() => 1' }, () => 'm').catch(
      (error: unknown) => error as Error,
    );

    // Assert
    should((frameless as Error).message).equal('the page has no frame to run a script in');
    should((worldless as Error).message).equal('the browser made no world to run the script in');
  });

  it('should answer a value that is not text as its string, and bound a long one', async () => {
    // Arrange
    const odd = new FakeCdp();
    odd.answer = { result: { value: 42 } };
    const long = new FakeCdp();
    long.answer = { result: { value: 'x'.repeat(PAGE_SCRIPT_MAX_RESULT_CHARS + 5) } };

    // Act
    const number = await runPageScript(asPage(page()), odd, { source: '() => 42' }, () => 'm');
    const clipped = await runPageScript(asPage(page()), long, { source: '() => 1' }, () => 'm');

    // Assert
    should(number.text).equal('42');
    should(clipped.text.length).equal(PAGE_SCRIPT_MAX_RESULT_CHARS);
  });
});

/** Runs a script expression here, as the isolated world would run it. */
const runHere = (expression: string): Promise<unknown> => new Function(`return ${expression};`)() as Promise<unknown>;

describe('pageScriptExpression', () => {
  it('should call the function with no element when none was named, and turn what it returns into text', async () => {
    // Arrange
    const expression = pageScriptExpression('() => ({ a: 1 })', undefined);

    // Act
    const value = await runHere(expression);

    // Assert
    should(value).equal('{"a":1}');
    should(await runHere(pageScriptExpression('() => undefined', undefined))).equal('undefined');
    should(await runHere(pageScriptExpression('() => 10n', undefined))).equal('10');
    should(await runHere(pageScriptExpression('async () => [1, 2]', undefined))).equal('[1,2]');
  });

  it('should refuse a script that is not a function, and keep a trailing comment from swallowing the call', async () => {
    // Act
    const notAFunction = await runHere(pageScriptExpression('42', undefined)).catch((error: unknown) => error as Error);
    const commented = await runHere(pageScriptExpression('() => 7 // the answer', undefined));

    // Assert
    should((notAFunction as Error).message).startWith('the script is not a function');
    should(commented).equal('7');
  });
});
