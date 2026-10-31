import { describe, it } from 'bun:test';
import should from 'should';
import {
  BROWSER_HIGHLIGHT_STYLE,
  type PointerAct,
  type PointerLocator,
  type PointerPage,
  performPointerAct,
  pointerActParam,
  staleRefMessage,
} from '../../../../src/lib/index.ts';

/** A page that records every Playwright call a pointer act makes, in order, one line each. */
class FakePage implements PointerPage {
  readonly calls: string[] = [];
  readonly refs = new Set(['e1', 'e2', 'e3']);
  readonly types = new Map<string, string>();
  textOnPage = true;
  failMove = false;

  private place(selector: string): PointerLocator {
    const page = this;
    const log = (line: string): void => {
      page.calls.push(`${line} @${selector}`);
    };
    const locator: PointerLocator = {
      first: () => locator,
      count: async () => {
        const ref = /^aria-ref=(.+)$/u.exec(selector)?.[1];
        if (ref === undefined) return selector === 'text:missing' && !page.textOnPage ? 0 : 1;
        return page.refs.has(ref) ? 1 : 0;
      },
      click: async () => log('click'),
      fill: async value => log(`fill ${JSON.stringify(value)}`),
      pressSequentially: async text => log(`pressSequentially ${JSON.stringify(text)}`),
      press: async key => log(`press ${key}`),
      getAttribute: async name => {
        if (name === 'data-selector') return selector;
        return name === 'type' ? (page.types.get(selector) ?? null) : null;
      },
      innerText: async () => '',
      ariaSnapshot: async () => '',
      screenshot: async () => new Uint8Array(),
      hover: async () => log('hover'),
      focus: async () => log('focus'),
      dragTo: async target => {
        log(`dragTo ${(await target.getAttribute('data-selector', { timeout: 1 })) ?? '?'}`);
      },
      scrollIntoViewIfNeeded: async () => log('scrollIntoView'),
      selectOption: async values => {
        log(`selectOption ${JSON.stringify(values)}`);
        return values;
      },
      setChecked: async checked => log(`setChecked ${String(checked)}`),
      highlight: async options => {
        log(`highlight ${options.style}`);
        return undefined;
      },
      // The file acts' slice of the port: no pointer act reaches it.
      setInputFiles: async () => log('setInputFiles'),
      evaluate: async () => false,
      boundingBox: async () => null,
    };
    return locator;
  }

  locator(selector: string): PointerLocator {
    return this.place(selector);
  }

  async waitForEvent(): Promise<never> {
    throw new Error('no pointer act waits for a file dialog');
  }

  getByText(text: string): PointerLocator {
    return this.place(this.textOnPage ? `text:${text}` : 'text:missing');
  }

  async evaluate<Arg>(pageFunction: (arg: Arg) => void, arg: Arg): Promise<unknown> {
    const scrolled: unknown[] = [];
    const real = globalThis as unknown as { innerHeight?: number; scrollBy?: unknown };
    const before = { innerHeight: real.innerHeight, scrollBy: real.scrollBy };
    real.innerHeight = 800;
    real.scrollBy = (options: unknown) => scrolled.push(options);
    try {
      pageFunction(arg);
    } finally {
      real.innerHeight = before.innerHeight;
      real.scrollBy = before.scrollBy;
    }
    this.calls.push(`evaluate ${JSON.stringify(scrolled)}`);
    return undefined;
  }

  async hideHighlight(): Promise<void> {
    this.calls.push('hideHighlight');
  }

  async ariaSnapshot(): Promise<string> {
    return '';
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  readonly mouse = {
    click: async () => {},
    move: async (x: number, y: number, options?: { readonly steps?: number }) => {
      if (this.failMove) throw new Error('the page went away');
      this.calls.push(
        `mouse.move ${String(x)},${String(y)}${options?.steps === undefined ? '' : ` steps=${String(options.steps)}`}`,
      );
    },
    down: async (options?: { readonly button?: string }) => {
      this.calls.push(`mouse.down ${options?.button ?? '-'}`);
    },
    up: async (options?: { readonly button?: string }) => {
      this.calls.push(`mouse.up ${options?.button ?? '-'}`);
    },
    wheel: async (x: number, y: number) => {
      this.calls.push(`mouse.wheel ${String(x)},${String(y)}`);
    },
  };

  readonly keyboard = {
    down: async () => {},
    up: async () => {},
    press: async (key: string) => {
      this.calls.push(`keyboard.press ${key}`);
    },
  };
}

const act = (value: Record<string, unknown>): PointerAct => pointerActParam(value);

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the act to be refused');
}

describe('browser pointer acts', () => {
  it('should hover an element, or move the pointer to a point', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'hover', selector: '#menu' }));
    await performPointerAct(page, act({ action: 'hover', x: 4, y: 5 }));

    // Assert
    should(page.calls).deepEqual(['hover @#menu', 'mouse.move 4,5']);
  });

  it('should drag element to element in one gesture, and point to point in steps with the button always released', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'drag', fromRef: 'e1', toSelector: '#bin' }));
    await performPointerAct(page, act({ action: 'drag', fromX: 1, fromY: 2, toX: 30, toY: 2, steps: 7 }));
    await performPointerAct(page, act({ action: 'drag', fromX: 1, fromY: 2, toX: 30, toY: 2 }));

    // Assert
    should(page.calls).deepEqual([
      'dragTo #bin @aria-ref=e1',
      'mouse.move 1,2',
      'mouse.down -',
      'mouse.move 30,2 steps=7',
      'mouse.up -',
      'mouse.move 1,2',
      'mouse.down -',
      'mouse.move 30,2 steps=10',
      'mouse.up -',
    ]);
  });

  it('should release the mouse when a drag by points fails part way', async () => {
    // Arrange
    const page = new FakePage();
    const original = page.mouse.move;
    let moves = 0;
    page.mouse.move = async (x, y, options) => {
      moves += 1;
      if (moves === 2) throw new Error('the page went away');
      await original(x, y, options);
    };

    // Act
    const error = await rejection(performPointerAct(page, act({ action: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 })));

    // Assert
    should(error.message).equal('the page went away');
    should(page.calls.at(-1)).equal('mouse.up -');
  });

  it('should refuse a drag that mixes an element and a point, touching nothing', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const error = await rejection(
      performPointerAct(page, { action: 'drag', fromRef: 'e1', toX: 1, toY: 2 } as unknown as PointerAct),
    );

    // Assert
    should(error.message).equal('drag from an element to an element, or from a point to a point');
    should(page.calls).deepEqual([]);
  });

  it('should move, press, release and wheel the mouse', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'mouse', mouseAction: 'move', x: 9, y: 8 }));
    await performPointerAct(page, act({ action: 'mouse', mouseAction: 'down', button: 'right' }));
    await performPointerAct(page, act({ action: 'mouse', mouseAction: 'up' }));
    await performPointerAct(page, act({ action: 'mouse', mouseAction: 'wheel', x: 1, y: 1, deltaY: -300 }));

    // Assert
    should(page.calls).deepEqual([
      'mouse.move 9,8',
      'mouse.down right',
      'mouse.up left',
      'mouse.move 1,1',
      'mouse.wheel 0,-300',
    ]);
  });

  it('should press each chord in order, focusing the target first', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'press', keys: ['Control+a', 'Delete'], ref: 'e2' }));
    await performPointerAct(page, act({ action: 'press', keys: ['Enter'] }));

    // Assert
    should(page.calls).deepEqual([
      'focus @aria-ref=e2',
      'keyboard.press Control+a',
      'keyboard.press Delete',
      'keyboard.press Enter',
    ]);
  });

  it('should refuse a key outside the grammar before pressing anything', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const error = await rejection(
      performPointerAct(page, { action: 'press', keys: ['Enter', 'Hyper+a'] } as unknown as PointerAct),
    );

    // Assert
    should(error.message).match(/key grammar/u);
    should(page.calls).deepEqual([]);
  });

  it('should refuse a wire act that is not a pointer act, or not valid at all', () => {
    should(() => pointerActParam({ action: 'back' })).throw(/not a pointer act/u);
    should(() => pointerActParam({ action: 'press', keys: ['Hyper+a'] })).throw();
  });

  it('should scroll to an element, to a text, by a distance and by screens', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'scroll', ref: 'e3' }));
    await performPointerAct(page, act({ action: 'scroll', text: 'Terms' }));
    await performPointerAct(page, act({ action: 'scroll', deltaY: 120, deltaX: 5 }));
    await performPointerAct(page, act({ action: 'scroll', pages: -1.5 }));

    // Assert
    should(page.calls).deepEqual([
      'scrollIntoView @aria-ref=e3',
      'scrollIntoView @text:Terms',
      'evaluate [{"left":5,"top":120,"behavior":"instant"}]',
      'evaluate [{"left":0,"top":-1200,"behavior":"instant"}]',
    ]);
  });

  it('should say so when the text to scroll to is not on the page', async () => {
    // Arrange
    const page = new FakePage();
    page.textOnPage = false;

    // Act
    const error = await rejection(performPointerAct(page, act({ action: 'scroll', text: 'Nope' })));

    // Assert
    should(error.message).equal('that text is not on the page');
  });

  it('should select options and tick or untick a box', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'select', ref: 'e1', values: ['uk', 'United States'] }));
    await performPointerAct(page, act({ action: 'check', selector: '#tos', checked: false }));

    // Assert
    should(page.calls).deepEqual(['selectOption ["uk","United States"] @aria-ref=e1', 'setChecked false @#tos']);
  });

  it('should refuse a stale ref with the sentence that says how to get a fresh one', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const error = await rejection(performPointerAct(page, act({ action: 'check', ref: 'e99', checked: true })));

    // Assert
    should(error.message).equal(staleRefMessage('e99'));
    should(page.calls).deepEqual([]);
  });

  it('should fill every field by what it carries, and flag a password field without reporting it unless one was filled', async () => {
    // Arrange
    const page = new FakePage();
    page.types.set('aria-ref=e2', ' Password ');

    // Act
    const plain = await performPointerAct(
      page,
      act({
        action: 'fill-form',
        fields: [
          { ref: 'e1', text: 'hadi' },
          { ref: 'e3', checked: true },
          { selector: '#c', option: 'uk' },
        ],
      }),
    );
    const secret = await performPointerAct(
      page,
      act({
        action: 'fill-form',
        fields: [
          { ref: 'e1', text: 'hadi' },
          { ref: 'e2', text: 'x' },
        ],
      }),
    );

    // Assert
    should(plain).deepEqual({ passwordField: false });
    should(secret).deepEqual({ passwordField: true });
    should(page.calls.slice(0, 3)).deepEqual([
      'fill "hadi" @aria-ref=e1',
      'setChecked true @aria-ref=e3',
      'selectOption ["uk"] @#c',
    ]);
  });

  it('should fill a value field with its value', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'fill-form', fields: [{ ref: 'e1', value: '2026-01-01' }] }));

    // Assert
    should(page.calls).deepEqual(['fill "2026-01-01" @aria-ref=e1']);
  });

  it('should outline an element, and clear the outline', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await performPointerAct(page, act({ action: 'highlight', ref: 'e1' }));
    await performPointerAct(page, act({ action: 'highlight', clear: true }));

    // Assert
    should(page.calls).deepEqual([`highlight ${BROWSER_HIGHLIGHT_STYLE} @aria-ref=e1`, 'hideHighlight']);
  });
});
