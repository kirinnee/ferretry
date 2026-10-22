/**
 * An `html` block as a static fragment: what the sanitizer keeps, what it strips, and how the
 * component puts the result into a closed shadow root.
 *
 * WHAT THIS TIER CAN AND CANNOT SAY. happy-dom parses and serialises, so the STRUCTURE is provable
 * here — no `<script>`, no handler, no frame, no URL outside the three allowed shapes, no CSS that
 * loads. Whether a browser would have RUN anything is a real-engine question, answered in
 * `tests/integration/fy-render-fragment.security.test.ts` under the app's real policy.
 */
import { afterAll, afterEach, describe, test } from 'bun:test';
import should from 'should';
import { FyRenderFragment, neutraliseCss, sanitizeFyRenderFragment } from '../../src/components/fy-render-fragment.tsx';
import { LinkBehaviourProvider, type LinkOpener } from '../../src/features/browser/external-link.tsx';
import { InAppBrowserWorkspace } from '../../src/features/browser/in-app-browser.tsx';
import type { OpenLinksIn } from '../../src/lib/controls.ts';
import type { FyRenderWorkspaceReader } from '../../src/lib/fy-render.ts';
import { interact, mount } from '../support/dom.ts';

/**
 * A HAPPY-DOM GAP, NOT A SANITIZER ONE. DOMPurify reads an element's name through the getter it finds
 * on `Node.prototype`, and happy-dom's base getter there answers `""` for every element — so every
 * tag looks unnamed and nothing is removed. Real engines answer the subclass's name. This dispatches
 * the base getter to the element's own, for this file only, before the purifier is first made; the
 * real-engine proof is `tests/integration/fy-render-fragment.security.test.ts`.
 */
const baseNodeName = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName');
Object.defineProperty(Node.prototype, 'nodeName', {
  configurable: true,
  get(this: Node) {
    for (let at = Object.getPrototypeOf(this); at !== null && at !== Node.prototype; at = Object.getPrototypeOf(at)) {
      const own = Object.getOwnPropertyDescriptor(at, 'nodeName');
      if (own?.get !== undefined) return own.get.call(this);
    }
    return baseNodeName?.get?.call(this);
  },
});
afterAll(() => {
  if (baseNodeName !== undefined) Object.defineProperty(Node.prototype, 'nodeName', baseNodeName);
});

/** The sanitized fragment, serialised — strings only, so a failure diff stays readable. */
const clean = (source: string): string => {
  const box = document.createElement('div');
  box.append(sanitizeFyRenderFragment(source));
  return box.innerHTML;
};

/** Every attribute name and value left anywhere in the result. */
const attributes = (source: string): string[] => {
  const box = document.createElement('div');
  box.append(sanitizeFyRenderFragment(source));
  return Array.from(box.querySelectorAll('*')).flatMap(element =>
    Array.from(element.attributes).map(
      attribute => `${element.nodeName.toLowerCase()}[${attribute.name}=${attribute.value}]`,
    ),
  );
};

/**
 * THE CORPUS HERE IS THE PART HAPPY-DOM CAN PARSE FAITHFULLY. Form controls, `embed`, `meta`, `link`
 * and SVG `use` hit further happy-dom element quirks (and a `link` makes happy-dom fetch it), so they
 * are proven where it matters — in real Chromium, under the app's policy — by
 * `tests/integration/fy-render-fragment.security.test.ts`, with every case below as well.
 */
describe('the fragment sanitizer — what never survives', () => {
  const CORPUS: readonly (readonly [string, string])[] = [
    ['a script element', '<p>a</p><script>globalThis.pwned = 1</script>'],
    ['an image error handler', '<img src="x" onerror="globalThis.pwned = 1">'],
    ['an svg load handler', '<svg onload="globalThis.pwned = 1"><circle r="1"/></svg>'],
    ['a javascript: link', '<a href="javascript:globalThis.pwned=1">x</a>'],
    ['a data: html link', '<a href="data:text/html,<script>1</script>">x</a>'],
    ['a relative app link', '<a href="/v1/sessions">x</a>'],
    ['an iframe with srcdoc', '<iframe srcdoc="<script>1</script>"></iframe>'],
    ['an svg foreignObject', '<svg><foreignObject><p>x</p></foreignObject></svg>'],
    ['an object', '<object data="x.swf"></object>'],
    ['a base', '<base href="https://evil.test/">'],
    ['a form action', '<form action="https://evil.test"></form>'],
    [
      'an svg animation that retargets a link',
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
    ],
    ['a template', '<template><script>1</script></template>'],
    ['a remote image', '<img src="https://evil.test/beacon.png">'],
    ['a srcset', '<img src="data:image/png;base64,AAAA" srcset="https://evil.test/a.png 2x">'],
    ['a media element', '<video src="https://evil.test/a.mp4"></video>'],
  ];

  for (const [name, payload] of CORPUS)
    test(`should strip ${name}`, () => {
      // Act
      const html = clean(payload);
      const left = attributes(payload).join(' ');

      // Assert
      for (const tag of [
        '<script',
        '<iframe',
        '<form',
        '<input',
        '<button',
        '<object',
        '<embed',
        '<base',
        '<meta',
        '<link',
        '<foreignobject',
        '<use',
        '<animate',
        '<template',
        '<video',
      ])
        should(html.toLowerCase()).not.containEql(tag);
      should(left).not.match(/\[on/u);
      should(left).not.match(/javascript:|evil\.test|srcdoc|action=/u);
      should(left).not.match(/a\[href=\/|a\[href=data:/u);
    });
});

describe('the fragment sanitizer — what a static explanation keeps', () => {
  test('should keep structure, tables, details and inline svg', () => {
    // Act
    const html = clean(
      '<details open><summary>More</summary><table><tr><th>a</th><td>1</td></tr></table></details><svg viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>',
    );

    // Assert
    should(html).containEql('<summary>More</summary>');
    should(html).containEql('<table>');
    should(html).containEql('<circle');
  });

  test('should keep an https link and open it in a new tab without an opener or referrer', () => {
    // Act
    const left = attributes('<a href="https://example.com/doc">doc</a>');

    // Assert
    should(left).containEql('a[href=https://example.com/doc]');
    should(left).containEql('a[target=_blank]');
    should(left).containEql('a[rel=noopener noreferrer]');
  });

  test('should keep a data: picture and park a media: one for the reader', () => {
    // Act
    const left = attributes(
      '<img src="data:image/png;base64,AAAA" alt="a"><img src="media:charts/q3.png" alt="b"><img src="media:../x.png">',
    );

    // Assert
    should(left).containEql('img[src=data:image/png;base64,AAAA]');
    should(left).containEql('img[data-fy-media=charts/q3.png]');
    // A media path that could leave the folder is neither parked nor kept.
    should(left.filter(entry => entry.includes('../x.png'))).eql([]);
  });

  test('should neutralise CSS that loads, inline and in a style element', () => {
    // Act
    const html = clean(
      '<style>@import url(https://evil.test/a.css); p { background: url(https://evil.test/b.png) } i { background: url(data:image/png;base64,AA) }</style><p style="background-image: url(\'https://evil.test/c.png\')">x</p>',
    );

    // Assert
    should(html).not.containEql('evil.test');
    should(html).not.containEql('@import');
    should(html).containEql('url(data:image/png;base64,AA)');
  });
});

describe('neutraliseCss', () => {
  test('should turn every loading url and image-set into none and drop imports', () => {
    should(neutraliseCss('a{b:url("x.png")}')).equal('a{b:none}');
    should(neutraliseCss('a{b: -webkit-image-set("x.png" 1x)}')).equal('a{b: none}');
    should(neutraliseCss('@import "x.css"; a{}')).equal(' a{}');
    should(neutraliseCss('a{b:url(data:image/svg+xml,%3Csvg%3E)}')).equal('a{b:url(data:image/svg+xml,%3Csvg%3E)}');
  });
});

describe('FyRenderFragment', () => {
  const realAttach = HTMLElement.prototype.attachShadow;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const roots: ShadowRoot[] = [];
  afterEach(() => {
    HTMLElement.prototype.attachShadow = realAttach;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    roots.length = 0;
  });

  /** Captures the CLOSED root, which nothing else can reach — that is the point of closing it. */
  const capture = (): string[] => {
    const modes: string[] = [];
    HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
      modes.push(init.mode);
      const root = realAttach.call(this, init);
      roots.push(root);
      return root;
    };
    return modes;
  };

  const PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0x49, 0x44, 0x41, 0x54, 0x78, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44,
    0, 0, 0, 0,
  ]);

  test('should put the sanitized fragment and its baseline style into a closed shadow root, named by its description', async () => {
    // Arrange
    const modes = capture();

    // Act
    const page = await mount(
      <FyRenderFragment alt="A comparison" source="<p>hi</p><script>globalThis.pwned=1</script>" />,
    );

    // Assert
    const host = page.container.querySelector('[data-fy-render-fragment="true"]') as HTMLElement;
    should(host.getAttribute('aria-label')).equal('A comparison');
    should(host.tagName).equal('SECTION');
    should(host.shadowRoot).be.null();
    should(modes).eql(['closed']);
    const root = roots[0] as ShadowRoot;
    should(root.firstChild?.nodeName).equal('STYLE');
    should(root.querySelector('p')?.textContent).equal('hi');
    should(root.querySelector('script')).be.null();
    should((globalThis as { pwned?: unknown }).pwned).be.undefined();
    await page.unmount();
  });

  test('should replace the fragment when the source changes, in the same root', async () => {
    // Arrange
    capture();
    const page = await mount(<FyRenderFragment alt="x" source="<p>one</p>" />);

    // Act
    await page.render(<FyRenderFragment alt="x" source="<p>two</p>" />);

    // Assert
    should(roots).have.length(1);
    should((roots[0] as ShadowRoot).querySelectorAll('p')).have.length(1);
    should((roots[0] as ShadowRoot).querySelector('p')?.textContent).equal('two');
    await page.unmount();
  });

  test('should show a media: picture read as the reader, and revoke it on unmount', async () => {
    // Arrange
    capture();
    const minted: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = () => {
      minted.push('blob:https://pwa.example.test/m');
      return 'blob:https://pwa.example.test/m';
    };
    URL.revokeObjectURL = url => {
      revoked.push(url);
    };
    const asked: { path: string; folder: string | undefined }[] = [];
    const reader: FyRenderWorkspaceReader = async (path, _signal, folder) => {
      asked.push({ folder, path });
      return { bytes: PNG as Uint8Array<ArrayBuffer>, ok: true };
    };

    // Act
    const page = await mount(
      <FyRenderFragment
        alt="x"
        readWorkspaceMedia={reader}
        source='<img src="media:card.png" alt="card"><img src="media:notes.txt">'
      />,
    );
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    // Assert — the picture is read from the MEDIA folder; a file that is not a picture is never asked for.
    should(asked).eql([{ folder: 'media', path: 'card.png' }]);
    const image = (roots[0] as ShadowRoot).querySelector('img') as HTMLImageElement;
    should(image.getAttribute('src')).equal('blob:https://pwa.example.test/m');
    should(image.hasAttribute('data-fy-media')).be.false();
    await page.unmount();
    should(revoked).eql(minted);
  });

  test('should leave a media: picture empty when the reader refuses, fails, the bytes are not a picture, or there is no reader', async () => {
    for (const reader of [
      (async () => ({ ok: false, reason: 'missing' })) as FyRenderWorkspaceReader,
      (async () => {
        throw new Error('carrier collapsed');
      }) as FyRenderWorkspaceReader,
      (async () => ({
        bytes: Uint8Array.from([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        ok: true,
      })) as FyRenderWorkspaceReader,
      undefined,
    ]) {
      // Arrange
      capture();
      URL.createObjectURL = () => {
        throw new Error('nothing may be minted');
      };

      // Act
      const page = await mount(
        reader === undefined ? (
          <FyRenderFragment alt="x" source='<img src="media:card.png">' />
        ) : (
          <FyRenderFragment alt="x" readWorkspaceMedia={reader} source='<img src="media:card.png">' />
        ),
      );
      await interact(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      // Assert
      should((roots.at(-1) as ShadowRoot).querySelector('img')?.hasAttribute('src')).be.false();
      await page.unmount();
    }
  });

  test('should mint nothing for bytes that arrive after unmount', async () => {
    // Arrange
    capture();
    let answer: (value: Awaited<ReturnType<FyRenderWorkspaceReader>>) => void = () => {};
    const reader: FyRenderWorkspaceReader = () =>
      new Promise(resolve => {
        answer = resolve;
      });
    URL.createObjectURL = () => {
      throw new Error('nothing may be minted');
    };
    const page = await mount(
      <FyRenderFragment alt="x" readWorkspaceMedia={reader} source='<img src="media:card.png">' />,
    );

    // Act
    await page.unmount();
    answer({ bytes: PNG as Uint8Array<ArrayBuffer>, ok: true });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Assert
    should((roots[0] as ShadowRoot).querySelector('img')?.hasAttribute('src')).be.false();
  });

  describe('links inside the fragment', () => {
    const DOC = 'https://example.com/doc';
    const handedOff: string[] = [];
    const opener: LinkOpener = {
      iosStandalone: () => true,
      handOff: href => handedOff.push(href),
      openTab: () => {},
      unlessLeft: () => () => {},
    };
    /** Our handler's verdict, read on the host before this suite's own navigation guard. */
    const verdicts: boolean[] = [];
    const record = (event: Event): void => {
      verdicts.push(event.defaultPrevented);
    };
    const guard = (event: Event): void => event.preventDefault();
    let realFetch: typeof fetch;

    const scene = (openLinksIn: OpenLinksIn) => (
      <LinkBehaviourProvider openLinksIn={openLinksIn} opener={opener}>
        <InAppBrowserWorkspace compact={false}>
          <FyRenderFragment alt="links" source={`<p>See <a href="${DOC}"><b>the doc</b></a>.</p>`} />
        </InAppBrowserWorkspace>
      </LinkBehaviourProvider>
    );

    /** Clicks the bold text INSIDE the anchor, so the handler has to find its link. */
    const clickLink = async (init: MouseEventInit = {}): Promise<void> => {
      const root = roots[0] as ShadowRoot;
      root.addEventListener('click', record);
      root.addEventListener('click', guard);
      await interact(() =>
        (root.querySelector('b') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
        ),
      );
      root.removeEventListener('click', record);
      root.removeEventListener('click', guard);
    };

    afterEach(() => {
      verdicts.length = 0;
      handedOff.length = 0;
      globalThis.fetch = realFetch;
    });

    test('should open an ordinary tap in the side panel when it is chosen', async () => {
      // Arrange
      capture();
      realFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('fixture')) as unknown as typeof fetch;
      const page = await mount(scene('panel'));

      // Act
      await clickLink();

      // Assert
      should(verdicts).eql([true]);
      should(page.container.querySelector('aside')?.textContent).containEql(DOC);
      await page.unmount();
    });

    test('should hand an ordinary tap to Safari from the installed iOS app by default', async () => {
      // Arrange
      capture();
      realFetch = globalThis.fetch;
      const page = await mount(scene('browser'));

      // Act
      await clickLink();

      // Assert
      should(verdicts).eql([true]);
      should(handedOff).eql([`x-safari-${DOC}`]);
      should(page.container.querySelector('aside')).be.null();
      await page.unmount();
    });

    test('should leave a Cmd-click to the anchor’s own new tab whatever the setting', async () => {
      // Arrange
      capture();
      realFetch = globalThis.fetch;
      const page = await mount(scene('panel'));

      // Act
      await clickLink({ metaKey: true });

      // Assert
      should(verdicts).eql([false]);
      should(handedOff).eql([]);
      should(page.container.querySelector('aside')).be.null();
      await page.unmount();
    });
  });

  test('should render nothing where the host cannot carry a shadow root', async () => {
    // Arrange — an engine without shadow DOM gets an empty, named box rather than unsanitized markup.
    HTMLElement.prototype.attachShadow = undefined as unknown as typeof realAttach;

    // Act
    const page = await mount(<FyRenderFragment alt="x" source="<p>hi</p>" />);

    // Assert
    should(page.container.textContent).equal('');
    await page.unmount();
  });
});
