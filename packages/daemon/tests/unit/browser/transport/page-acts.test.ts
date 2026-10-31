import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ActableCdp,
  type ActableLocator,
  type ActablePage,
  BROWSER_MAX_FIND_LINES,
  BROWSER_MAX_READ_CHARS,
  browserElementParam,
  browserTargetParam,
  clickOn,
  findSnapshotLines,
  PDF_NEEDS_HEADLESS,
  printPdf,
  readPage,
  shootPage,
  staleRefMessage,
  typeInto,
  uploadFiles,
} from '../../../../src/lib/index.ts';

const SNAPSHOT = [
  '- main [ref=e1]:',
  '  - button "Sign in" [ref=e2]',
  '  - link "Sign up" [ref=e3]',
  '  - textbox "Email" [ref=e4]',
].join('\n');

/**
 * A page that records every Playwright call an act makes, in order, as one line each. A ref resolves
 * only while it is in `refs` — what the page's latest snapshot knew.
 */
class FakePage implements ActablePage {
  readonly calls: string[] = [];
  readonly refs = new Set(['e1', 'e2', 'e3', 'e4']);
  /** A count that throws, as Playwright can for a ref it cannot parse against the page. */
  countThrows = false;
  failMouse = false;
  /** The `type` attribute each selector's element carries; none for an unlisted one. */
  readonly types = new Map<string, string>();
  text = 'Welcome back';
  snapshot = SNAPSHOT;
  /** Whether the element is a file input. */
  fileInput = false;
  /** The element's box; `null` is an element with nothing to see. */
  box: { x: number; y: number; width: number; height: number } | null = { x: 100, y: 200, width: 60, height: 40 };
  /** Whether a click opens a file dialog. */
  opensChooser = true;

  locator(selector: string): ActableLocator {
    const page = this;
    const locator: ActableLocator = {
      first: () => locator,
      count: async () => {
        if (page.countThrows) throw new Error('Invalid ref');
        const ref = /^aria-ref=(.+)$/u.exec(selector)?.[1];
        return ref === undefined || page.refs.has(ref) ? 1 : 0;
      },
      click: async options => {
        page.calls.push(`click ${selector} ${JSON.stringify(options)}`);
      },
      fill: async value => {
        page.calls.push(`fill ${selector} ${JSON.stringify(value)}`);
      },
      pressSequentially: async text => {
        page.calls.push(`pressSequentially ${selector} ${JSON.stringify(text)}`);
      },
      press: async key => {
        page.calls.push(`press ${selector} ${key}`);
      },
      getAttribute: async name => (name === 'type' ? (page.types.get(selector) ?? null) : null),
      innerText: async () => {
        page.calls.push(`innerText ${selector}`);
        return page.text;
      },
      ariaSnapshot: async options => {
        page.calls.push(`ariaSnapshot ${selector} ${JSON.stringify(options)}`);
        return page.snapshot;
      },
      screenshot: async options => {
        page.calls.push(`screenshot ${selector} ${options.type}`);
        return new Uint8Array([1, 2, 3]);
      },
      setInputFiles: async files => {
        page.calls.push(`setInputFiles ${selector} ${JSON.stringify(files)}`);
      },
      evaluate: async () => page.fileInput,
      scrollIntoViewIfNeeded: async () => {
        page.calls.push(`scrollIntoView ${selector}`);
      },
      boundingBox: async () => page.box,
    };
    return locator;
  }

  async ariaSnapshot(options: Parameters<ActablePage['ariaSnapshot']>[0]): Promise<string> {
    this.calls.push(`page.ariaSnapshot ${JSON.stringify(options)}`);
    return this.snapshot;
  }

  async screenshot(options: Parameters<ActablePage['screenshot']>[0]): Promise<Uint8Array> {
    this.calls.push(`page.screenshot ${options.type} fullPage=${String(options.fullPage)}`);
    return new Uint8Array([4, 5, 6]);
  }

  async waitForEvent(event: 'filechooser'): Promise<{ setFiles(files: string[]): Promise<void> }> {
    this.calls.push(`waitForEvent ${event}`);
    if (!this.opensChooser) throw new Error('Timeout 30000ms exceeded waiting for event "filechooser"');
    return {
      setFiles: async files => {
        this.calls.push(`chooser.setFiles ${JSON.stringify(files)}`);
      },
    };
  }

  readonly mouse = {
    click: async (x: number, y: number, options: { readonly button?: string; readonly clickCount?: number }) => {
      if (this.failMouse) throw new Error('the page went away');
      this.calls.push(`mouse.click ${String(x)},${String(y)} ${JSON.stringify(options)}`);
    },
  };

  readonly keyboard = {
    down: async (key: string) => {
      this.calls.push(`down ${key}`);
    },
    up: async (key: string) => {
      this.calls.push(`up ${key}`);
    },
  };
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the act to be refused');
}

describe('browser page acts — click', () => {
  it('should click a selector once with the left button by default', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await clickOn(page, { kind: 'selector', selector: '#go' });

    // Assert
    should(page.calls).deepEqual(['click #go {"timeout":30000,"button":"left","clickCount":1}']);
  });

  it('should click a ref through its aria-ref, double and with modifiers held', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await clickOn(page, { kind: 'ref', ref: 'e2' }, { double: true, button: 'right', modifiers: ['Shift'] });

    // Assert
    should(page.calls).deepEqual([
      'click aria-ref=e2 {"timeout":30000,"button":"right","clickCount":2,"modifiers":["Shift"]}',
    ]);
  });

  it('should refuse a ref the latest snapshot does not know, with the fix, and act on nothing', async () => {
    // Arrange
    const page = new FakePage();
    const unparsable = new FakePage();
    unparsable.countThrows = true;

    // Act
    const stale = await rejection(clickOn(page, { kind: 'ref', ref: 'e9' }));
    const thrown = await rejection(clickOn(unparsable, { kind: 'ref', ref: 'e2' }));

    // Assert
    should(stale.message).equal(staleRefMessage('e9'));
    should(stale.message).containEql('mode "snapshot"');
    should(thrown.message).equal(staleRefMessage('e2'));
    should(page.calls).deepEqual([]);
    should(unparsable.calls).deepEqual([]);
  });

  it('should click a point with the modifiers pressed around it, and release them even when it fails', async () => {
    // Arrange
    const page = new FakePage();
    const failing = new FakePage();
    failing.failMouse = true;

    // Act
    await clickOn(page, { kind: 'point', x: 120, y: 340 }, { modifiers: ['Control', 'Shift'] });
    const failure = await rejection(clickOn(failing, { kind: 'point', x: 1, y: 2 }, { modifiers: ['Alt'] }));

    // Assert
    should(page.calls).deepEqual([
      'down Control',
      'down Shift',
      'mouse.click 120,340 {"button":"left","clickCount":1}',
      'up Shift',
      'up Control',
    ]);
    should(failure.message).equal('the page went away');
    should(failing.calls).deepEqual(['down Alt', 'up Alt']);
  });
});

describe('browser page acts — type', () => {
  it('should replace what a field holds at once, and press Enter only when asked', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await typeInto(page, { kind: 'ref', ref: 'e4' }, 'hadi@example.test');
    await typeInto(page, { kind: 'selector', selector: '#q' }, 'ferretry', { submit: true });

    // Assert
    should(page.calls).deepEqual(['fill aria-ref=e4 "hadi@example.test"', 'fill #q "ferretry"', 'press #q Enter']);
  });

  it('should clear and then type key by key when asked to go slowly', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await typeInto(page, { kind: 'selector', selector: '#q' }, 'abc', { slowly: true });

    // Assert
    should(page.calls).deepEqual(['fill #q ""', 'pressSequentially #q "abc"']);
  });

  it('should say a password field is one, and not flag any other', async () => {
    // Arrange
    const page = new FakePage();
    page.types.set('#pw', ' Password ');
    page.types.set('#q', 'search');

    // Act
    const secret = await typeInto(page, { kind: 'selector', selector: '#pw' }, 'x');
    const plain = await typeInto(page, { kind: 'selector', selector: '#q' }, 'x');

    // Assert
    should(secret).deepEqual({ passwordField: true });
    should(plain).deepEqual({ passwordField: false });
  });
});

describe('browser page acts — read', () => {
  it('should read the visible text of the page, or of one element', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const whole = await readPage(page);
    const part = await readPage(page, { target: { kind: 'selector', selector: 'main' } });

    // Assert
    should(whole).equal('Welcome back');
    should(part).equal('Welcome back');
    should(page.calls).deepEqual(['innerText body', 'innerText main']);
  });

  it('should read the accessibility tree in its plain form for a11y', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await readPage(page, { mode: 'a11y' });

    // Assert
    should(page.calls).deepEqual(['ariaSnapshot body {"timeout":30000}']);
  });

  it('should take a page snapshot in the ai mode that hands out refs, with depth and boxes', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const snapshot = await readPage(page, { mode: 'snapshot', depth: 3, boxes: true });
    await readPage(page, { mode: 'snapshot', target: { kind: 'ref', ref: 'e1' } });

    // Assert
    should(snapshot).equal(SNAPSHOT);
    should(page.calls).deepEqual([
      'page.ariaSnapshot {"timeout":30000,"mode":"ai","depth":3,"boxes":true}',
      'ariaSnapshot aria-ref=e1 {"timeout":30000,"mode":"ai"}',
    ]);
  });

  it('should keep only the snapshot lines that contain the text, each with its ref', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const found = await readPage(page, { mode: 'snapshot', find: 'SIGN' });
    const none = await readPage(page, { mode: 'snapshot', find: 'checkout' });

    // Assert
    should(found).equal('- button "Sign in" [ref=e2]\n- link "Sign up" [ref=e3]');
    should(none).equal('');
  });

  it('should bound what a read hands back', async () => {
    // Arrange
    const page = new FakePage();
    page.text = 'x'.repeat(BROWSER_MAX_READ_CHARS + 10);

    // Act
    const read = await readPage(page);

    // Assert
    should(read.length).equal(BROWSER_MAX_READ_CHARS);
  });

  it('should stop finding after the most lines one answer carries', () => {
    // Arrange
    const snapshot = Array.from({ length: BROWSER_MAX_FIND_LINES + 5 }, (_, index) => `- item ${String(index)}`).join(
      '\n',
    );

    // Act
    const found = findSnapshotLines(snapshot, 'item');

    // Assert
    should(found.split('\n').length).equal(BROWSER_MAX_FIND_LINES);
  });
});

describe('browser page acts — screenshot', () => {
  it('should shoot the viewport as PNG by default, the full page when asked, and one element as JPEG', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    const viewport = await shootPage(page);
    const full = await shootPage(page, { fullPage: true });
    const element = await shootPage(page, { target: { kind: 'ref', ref: 'e2' }, format: 'jpeg' });

    // Assert
    should(viewport).deepEqual({ base64: 'BAUG', format: 'png' });
    should(full.format).equal('png');
    should(element).deepEqual({ base64: 'AQID', format: 'jpeg' });
    should(page.calls).deepEqual([
      'page.screenshot png fullPage=false',
      'page.screenshot png fullPage=true',
      'screenshot aria-ref=e2 jpeg',
    ]);
  });
});

describe('browser page acts — the worker’s own check of a target', () => {
  it('should accept each target kind as the daemon sends it', () => {
    should(browserTargetParam(undefined)).be.undefined();
    should(browserTargetParam({ kind: 'ref', ref: 'f1e3' })).deepEqual({ kind: 'ref', ref: 'f1e3' });
    should(browserTargetParam({ kind: 'selector', selector: '#a' })).deepEqual({ kind: 'selector', selector: '#a' });
    should(browserTargetParam({ kind: 'point', x: 0, y: 10_000 })).deepEqual({ kind: 'point', x: 0, y: 10_000 });
  });

  it('should refuse anything else, and a point where only an element will do', () => {
    // Arrange
    const bad: unknown[] = [
      'e1',
      [],
      { kind: 'ref', ref: 'button' },
      { kind: 'selector', selector: '' },
      { kind: 'point', x: -1, y: 0 },
      { kind: 'point', x: 1, y: Number.NaN },
      { kind: 'script', body: '1' },
    ];

    // Act
    const refused = bad.map(value => {
      try {
        browserTargetParam(value);
        return false;
      } catch {
        return true;
      }
    });

    // Assert
    should(refused.every(Boolean)).be.true();
    should(browserElementParam({ kind: 'ref', ref: 'e1' })).deepEqual({ kind: 'ref', ref: 'e1' });
    should(browserElementParam(undefined)).be.undefined();
    should(() => browserElementParam({ kind: 'point', x: 1, y: 1 })).throw(/not a point/u);
    should(browserElementParam({ kind: 'ref', ref: 'e1' })).deepEqual({ kind: 'ref', ref: 'e1' });
  });
});

class FakeCdp implements ActableCdp {
  readonly sent: { readonly method: string; readonly params: Readonly<Record<string, unknown>> }[] = [];
  failWith: Error | undefined;
  async send(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.sent.push({ method, params });
    if (this.failWith !== undefined) throw this.failWith;
    return { data: 'JVBERi0=' };
  }
}

describe('browser page acts — upload', () => {
  it('should set the files straight onto a file input', async () => {
    // Arrange
    const page = new FakePage();
    page.fileInput = true;

    // Act
    await uploadFiles(page, new FakeCdp(), { kind: 'selector', selector: '#file' }, ['/a/one.txt', '/a/two.txt']);

    // Assert
    should(page.calls).deepEqual(['setInputFiles #file ["/a/one.txt","/a/two.txt"]']);
  });

  it('should click anything else while awaiting the file dialog, and answer the dialog', async () => {
    // Arrange
    const page = new FakePage();

    // Act
    await uploadFiles(page, new FakeCdp(), { kind: 'ref', ref: 'e2' }, ['/a/one.txt']);

    // Assert
    should(page.calls).deepEqual([
      'waitForEvent filechooser',
      'click aria-ref=e2 {"timeout":30000}',
      'chooser.setFiles ["/a/one.txt"]',
    ]);
  });

  it('should refuse in the dialog’s own words when the click opened none', async () => {
    const page = new FakePage();
    page.opensChooser = false;

    const error = await rejection(uploadFiles(page, new FakeCdp(), { kind: 'selector', selector: 'button' }, ['/a']));

    should(error.message).containEql('filechooser');
  });

  it('should drop on the centre of the element: enter, over, then drop, each carrying the files', async () => {
    // Arrange
    const page = new FakePage();
    const cdp = new FakeCdp();

    // Act
    await uploadFiles(page, cdp, { kind: 'selector', selector: '.zone' }, ['/a/one.txt'], 'drop');

    // Assert
    should(page.calls).deepEqual(['scrollIntoView .zone']);
    should(cdp.sent.map(entry => [entry.method, entry.params.type, entry.params.x, entry.params.y])).deepEqual([
      ['Input.dispatchDragEvent', 'dragEnter', 130, 220],
      ['Input.dispatchDragEvent', 'dragOver', 130, 220],
      ['Input.dispatchDragEvent', 'drop', 130, 220],
    ]);
    should(cdp.sent[2]?.params.data).deepEqual({ items: [], files: ['/a/one.txt'], dragOperationsMask: 1 });
  });

  it('should refuse to drop on an element with no visible area', async () => {
    const page = new FakePage();
    page.box = null;

    const error = await rejection(
      uploadFiles(page, new FakeCdp(), { kind: 'selector', selector: '.zone' }, ['/a'], 'drop'),
    );

    should(error.message).containEql('no visible area');
  });

  it('should refuse an upload of nothing, and a stale ref before touching the page', async () => {
    const page = new FakePage();
    page.refs.delete('e2');

    const none = await rejection(uploadFiles(page, new FakeCdp(), { kind: 'selector', selector: '#f' }, []));
    const stale = await rejection(uploadFiles(page, new FakeCdp(), { kind: 'ref', ref: 'e2' }, ['/a']));

    should(none.message).containEql('nothing to upload');
    should(stale.message).equal(staleRefMessage('e2'));
    should(page.calls).deepEqual([]);
  });
});

describe('browser page acts — pdf', () => {
  it('should print with backgrounds and hand back the base64 body', async () => {
    const cdp = new FakeCdp();

    const body = await printPdf(cdp);

    should(body).equal('JVBERi0=');
    should(cdp.sent).deepEqual([
      { method: 'Page.printToPDF', params: { printBackground: true, transferMode: 'ReturnAsBase64' } },
    ]);
  });

  it('should turn a window-mode browser’s "not implemented" into the one-sentence refusal', async () => {
    const cdp = new FakeCdp();
    cdp.failWith = new Error('PrintToPDF is not implemented');

    const error = await rejection(printPdf(cdp));

    should(error.message).equal(PDF_NEEDS_HEADLESS);
  });

  it('should let any other failure through as it is, and refuse an empty print', async () => {
    const cdp = new FakeCdp();
    cdp.failWith = new Error('the target closed');
    should((await rejection(printPdf(cdp))).message).equal('the target closed');
    cdp.failWith = undefined;
    cdp.send = async () => ({ data: '' });
    should((await rejection(printPdf(cdp))).message).containEql('printed nothing');
  });
});
