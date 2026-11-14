import {
  type InputCdp,
  type InputCdpSession,
  type InputFrame,
  InputFrameSessions,
  type InputHandle,
  type InputLocator,
  type InputablePage,
  type InputSubject,
} from '../../daemon/target/lib/fields.ts';

/**
 * A page and its DevTools sessions, faked for the page input seam (`daemon/target/lib/fields.ts`): the real field code
 * runs over it, and every DevTools call is recorded. Shared by the field tests and the Vault conformance suite.
 */

export const PAGE_URL = 'http://localhost:3000/login';

export interface FakeElement {
  readonly backendNodeId: number;
  nodeName: string;
  attributes: string[];
  readonly frame: FakeFrame;
  /** What the handle's own DevTools session says the handle holds, when it is not this element itself. */
  held?: unknown;
  /** The target that session says it is, when it is not the one this element's frame runs in. */
  heldTarget?: unknown;
  box: { x: number; y: number; width: number; height: number } | null;
  /** Playwright cannot take a hold on it (the element went away mid-call). */
  handleFails?: true;
  /** What Playwright measures for the element it holds, when it is not the box DevTools measures. */
  claimedBox?: { x: number; y: number; width: number; height: number } | null;
  visible: boolean;
}

export class FakeFrame implements InputFrame {
  /** Where an out-of-process frame sits in the page; its own coordinates are relative to this. */
  offset = { x: 0, y: 0 };
  /** The frame this one is inside; a frame made without one is put inside the main frame. */
  parent: FakeFrame | null = null;
  /** An out-of-process frame whose own session cannot be attached right now. */
  failAttach = false;
  readonly id: string;
  constructor(
    readonly address: string,
    readonly sessionName: string,
    readonly outOfProcess = false,
  ) {
    this.id = outOfProcess ? sessionName : `frame-${address}`;
  }
  url(): string {
    return this.address;
  }
  parentFrame(): FakeFrame | null {
    return this.parent;
  }
}

/** A DevTools session over a small document of elements; every call is recorded as `method {params}`. */
export class FakeSession implements InputCdpSession {
  /** Nodes a pagehide clear was armed on, in order. */
  readonly armed: number[] = [];
  readonly calls: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  readonly typed: { readonly backendNodeId: number | undefined; readonly text: string }[] = [];
  readonly keys: string[] = [];
  /** What each field holds, as typing and Backspace leave it. */
  readonly values = new Map<number, string>();
  focused: number | undefined;
  detached = false;
  /** Where focus really lands when asked for a node: another node, to play a page that moves focus. */
  focusLandsOn: number | undefined;
  /** The node that answers a hit test at its centre instead of the one there, to play something stacked on top. */
  onTop: FakeElement | undefined;
  /** What a page's own `select` override does when run in the page's world: focus moves to this node. */
  pageSelectMovesFocusTo: number | undefined;
  /** CDP calls that reached the page's own world: an evaluate with no context, a resolve with no isolated one. */
  readonly pageWorld: string[] = [];
  private readonly contexts = new Map<number, string>();
  private readonly isolatedObjects = new Set<string>();
  private nextContext = 100;
  failOn: ((method: string, params: Record<string, unknown>) => Error | undefined) | undefined;

  constructor(
    readonly name: string,
    private readonly world: FakeWorld,
  ) {}

  count(method: string): number {
    return this.calls.filter(call => call.method === method).length;
  }

  async send(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push({ method, params: { ...params } });
    const failure = this.failOn?.(method, params);
    if (failure !== undefined) throw failure;
    const own = this.world.elements.filter(element => element.frame.sessionName === this.name);
    // The pairing-screen look describes the two meta nodes it searched for (ids 9001 and 9002), strictly by node.
    if (method === 'DOM.describeNode' && (params.nodeId === 9001 || params.nodeId === 9002))
      return {
        node: {
          nodeType: 1,
          nodeName: 'META',
          attributes:
            params.nodeId === 9001
              ? ['name', 'ferretry-pairing-screen', 'content', 'shown']
              : ['name', 'ferretry-pairing-screen-seen', 'content', String(this.world.pairing.seen)],
        },
      };
    switch (method) {
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } };
      // The pairing-screen look (`daemon/target/lib/pairing-screen.ts`): a search for the marker's or the counter's
      // element, answered from what the world says its documents show. Node ids 9001 and 9002 stand for those two.
      case 'DOM.performSearch': {
        const marker = String(params.query).includes('screen-seen') ? 9002 : 9001;
        const present = marker === 9001 ? this.world.pairing.marked : this.world.pairing.seen > 0;
        return { searchId: String(marker), resultCount: present ? 1 : 0 };
      }
      case 'DOM.getSearchResults':
        return { nodeIds: [Number(params.searchId)] };
      case 'DOM.discardSearchResults':
        return {};
      case 'DOM.getOuterHTML':
        return { outerHTML: this.world.markup };
      case 'Page.getFrameTree': {
        const frames = this.world.frames.filter(frame => frame.sessionName === this.name);
        const [root, ...inner] = frames;
        return {
          frameTree: {
            frame: { id: root?.id, loaderId: this.world.loaderId },
            childFrames: inner.map(frame => ({ frame: { id: frame.id }, childFrames: [] })),
          },
        };
      }
      case 'Page.createIsolatedWorld': {
        if (params.worldName !== 'ferretry-input') throw new Error('not the trusted world');
        this.nextContext += 1;
        this.contexts.set(this.nextContext, String(params.frameId));
        return { executionContextId: this.nextContext };
      }
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: this.name } };
      case 'DOM.getBoxModel': {
        const element = own.find(candidate => candidate.backendNodeId === params.backendNodeId);
        if (element?.box == null) throw new Error('Could not compute box model.');
        const { x, y, width, height } = this.local(element);
        return { model: { border: this.quad ?? [x, y, x + width, y, x + width, y + height, x, y + height] } };
      }
      case 'DOM.getNodeForLocation': {
        if (params.includeUserAgentShadowDOM !== false || params.ignorePointerEventsNone !== true)
          throw new Error('the hit test must see the field, not its inner editor, through pointer-events: none');
        const at = (element: FakeElement): boolean => {
          if (element.box == null) return false;
          const { x, y, width, height } = this.local(element);
          return (
            Number(params.x) >= x &&
            Number(params.x) <= x + width &&
            Number(params.y) >= y &&
            Number(params.y) <= y + height
          );
        };
        const hit = this.onTop !== undefined && at(this.onTop) ? this.onTop : own.find(at);
        if (hit === undefined) throw new Error('No node found at given location');
        return { backendNodeId: hit.backendNodeId, frameId: hit.frame.id };
      }
      case 'DOM.describeNode': {
        if (typeof params.objectId === 'string' && params.objectId.startsWith('page-')) throw new Error('not a node');
        const id =
          typeof params.nodeId === 'number'
            ? params.nodeId - 1000
            : typeof params.objectId === 'string'
              ? this.focused
              : (params.backendNodeId as number);
        const element = own.find(candidate => candidate.backendNodeId === id);
        if (element === undefined) throw new Error('No node with given id found');
        return {
          node: { nodeName: element.nodeName, backendNodeId: element.backendNodeId, attributes: element.attributes },
        };
      }
      case 'DOM.focus':
        this.focused = this.focusLandsOn ?? (params.backendNodeId as number);
        return {};
      case 'Runtime.evaluate': {
        if (typeof params.contextId !== 'number' || !this.contexts.has(params.contextId)) {
          this.pageWorld.push('Runtime.evaluate');
          return { result: { objectId: 'page-active' } };
        }
        return { result: { objectId: 'active' } };
      }
      case 'DOM.resolveNode': {
        const context =
          typeof params.executionContextId === 'number' ? this.contexts.get(params.executionContextId) : undefined;
        const element = own.find(candidate => candidate.backendNodeId === params.backendNodeId);
        if (context === undefined) {
          this.pageWorld.push('DOM.resolveNode');
        } else if (element === undefined || element.frame.id !== context) {
          throw new Error('Node with given id does not belong to the document');
        }
        const objectId = `${context === undefined ? 'page' : 'iso'}-node-${String(params.backendNodeId)}`;
        if (context !== undefined) this.isolatedObjects.add(objectId);
        return { object: { objectId } };
      }
      case 'Runtime.callFunctionOn': {
        const objectId = String(params.objectId);
        const node = Number(objectId.split('-').at(-1));
        // The grant fill's pagehide clear, armed from the trusted world only.
        if (String(params.functionDeclaration).includes('pagehide')) {
          if (!this.isolatedObjects.has(objectId)) this.pageWorld.push('Runtime.callFunctionOn');
          this.armed.push(node);
          return { result: { value: !this.world.armFails } };
        }
        // The check before the hold ends: whatever the field holds is emptied, from the trusted world only.
        if (String(params.functionDeclaration).includes('isConnected')) {
          if (!this.isolatedObjects.has(objectId)) this.pageWorld.push('Runtime.callFunctionOn');
          if (this.world.clearThrows) return { exceptionDetails: { text: 'the page threw' }, result: {} };
          if ((this.values.get(node) ?? '') === '') return { result: { value: 'moved' } };
          this.values.set(node, '');
          return { result: { value: 'cleared' } };
        }
        if (String(params.functionDeclaration).includes('view.top')) return { result: { value: !this.world.framed } };
        if (String(params.functionDeclaration).includes('getOwnPropertyDescriptor')) {
          if (!this.world.unclearable) this.values.set(Number(objectId.split('-').at(-1)), '');
          return { result: {} };
        }
        if (String(params.functionDeclaration).includes('this.value'))
          return { result: { value: this.values.get(Number(objectId.split('-').at(-1))) ?? '' } };
        if (!this.isolatedObjects.has(objectId)) {
          this.pageWorld.push('Runtime.callFunctionOn');
          if (this.pageSelectMovesFocusTo !== undefined) this.focused = this.pageSelectMovesFocusTo;
        }
        return { result: {} };
      }
      case 'Input.insertText':
        this.typed.push({ backendNodeId: this.focused, text: String(params.text) });
        if (this.focused !== undefined) this.values.set(this.focused, String(params.text));
        this.world.onInput?.();
        return {};
      case 'Input.dispatchKeyEvent':
        this.keys.push(`${String(params.type)}:${String(params.key)}`);
        if (params.type === 'keyDown' && params.key === 'Backspace' && this.focused !== undefined && !this.world.sticky)
          this.values.set(this.focused, '');
        return {};
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: this.world.viewport };
      case 'Page.captureScreenshot':
        return { data: 'cG5n' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  }

  /** Overrides the border quad DevTools answers with, to play an answer that is not a quad. */
  quad: unknown;

  /** An element's box in this session's own coordinates: an out-of-process frame's are relative to the frame. */
  local(element: FakeElement): { x: number; y: number; width: number; height: number } {
    const box = element.box as { x: number; y: number; width: number; height: number };
    const { x, y } = element.frame.outOfProcess ? element.frame.offset : { x: 0, y: 0 };
    return { ...box, x: box.x - x, y: box.y - y };
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

export class FakeWorld {
  loaderId = 'loader-1';
  closed = false;
  readonly elements: FakeElement[] = [];
  readonly refs = new Set<string>();
  readonly sessions = new Map<string, FakeSession>();
  readonly disposed: FakeElement[] = [];
  readonly main = new FakeFrame(PAGE_URL, 'page-target');
  frames: FakeFrame[] = [this.main];
  pageUrl = PAGE_URL;
  bodyText = 'Welcome back';
  /** The page shows what its fields hold in its text (a page that echoes). */
  reflects = false;
  /** Backspace does not empty a field. */
  sticky = false;
  /** The probed field sits in a frame, not the main document. */
  framed = false;
  /** Not even the native value setter empties it. */
  unclearable = false;
  /** The trusted world could not arm the pagehide clear. */
  armFails = false;
  /** The page threw while the clear ran in it. */
  clearThrows = false;
  /** WebSockets the page holds open, and how many it ever opened. */
  sockets = 0;
  socketsEver = 0;
  /** Runs on every insert: a page that fires a request or navigates as you type. */
  onInput: (() => void) | undefined;
  readonly listeners = new Set<() => void>();
  listening = true;
  aria = '- textbox "Email": kirin@example.test';
  markup: unknown = '<html><body><input title="hello"></body></html>';
  title = 'Sign in';
  viewport: Record<string, number> = { clientWidth: 800, clientHeight: 500, pageX: 0, pageY: 0 };
  /** The element each selector or ref points at. */
  readonly pointers = new Map<string, FakeElement>();
  /** The nodes each handle was asked about, in order: the identity comes from the handle, not the page. */
  readonly described: number[] = [];

  /** What the page's documents say about a pairing code: the marker is in one, and how many codes they have shown. */
  readonly pairing = { marked: false, seen: 0 };

  session(name: string): FakeSession {
    let session = this.sessions.get(name);
    if (session === undefined) {
      session = new FakeSession(name, this);
      this.sessions.set(name, session);
    }
    return session;
  }

  element(
    pointer: string,
    backendNodeId: number,
    attributes: string[],
    frame: FakeFrame = this.main,
    nodeName = 'INPUT',
  ): FakeElement {
    const element: FakeElement = {
      backendNodeId,
      nodeName,
      attributes,
      frame,
      box: { x: 10, y: 20 + 40 * this.elements.length, width: 100, height: 24 },
      visible: true,
    };
    this.elements.push(element);
    this.pointers.set(pointer, element);
    if (pointer.startsWith('aria-ref=')) this.refs.add(pointer.slice('aria-ref='.length));
    if (frame !== this.main && frame.parent === null) frame.parent = this.main;
    if (!this.frames.includes(frame)) this.frames.push(frame);
    return element;
  }

  /**
   * The page re-renders an element: a NEW node with the same tag and attributes takes its place, and the old one is
   * gone from the document. A ref to it goes stale (Playwright drops a ref whose element is not connected); a
   * selector now finds the new node.
   */
  rerender(old: FakeElement, backendNodeId: number, change: Partial<FakeElement> = {}): FakeElement {
    const element: FakeElement = { ...old, backendNodeId, ...change };
    this.elements.splice(this.elements.indexOf(old), 1, element);
    for (const [pointer, at] of [...this.pointers]) {
      if (at !== old) continue;
      if (pointer.startsWith('aria-ref=')) {
        this.pointers.delete(pointer);
        this.refs.delete(pointer.slice('aria-ref='.length));
      } else this.pointers.set(pointer, element);
    }
    return element;
  }

  /** A field that is on the page and that no pointer names: a look-alike only a search can find. */
  extra(backendNodeId: number, attributes: string[], change: Partial<FakeElement> = {}): FakeElement {
    const element: FakeElement = {
      backendNodeId,
      nodeName: 'INPUT',
      attributes,
      frame: this.main,
      box: { x: 10, y: 20 + 40 * this.elements.length, width: 100, height: 24 },
      visible: true,
      ...change,
    };
    this.elements.push(element);
    return element;
  }

  /** The main frame's elements a `css=tag[attr="value"]…` selector matches, in document order (open shadow roots too). */
  private matching(selector: string): FakeElement[] {
    const css = selector.slice('css='.length);
    const tag = /^([a-z*][a-z0-9-]*)/u.exec(css)?.[1] ?? '';
    const parts = [...css.slice(tag.length).matchAll(/\[([a-z]+)(\^?=)"((?:[^"\\]|\\.)*)"\]/gu)].map(match => ({
      name: match[1] as string,
      prefix: match[2] === '^=',
      value: (match[3] as string).replace(/\\(.)/gu, '$1'),
    }));
    return this.elements.filter(element => {
      if (element.frame !== this.main) return false;
      if (tag !== '*' && element.nodeName.toLowerCase() !== tag) return false;
      return parts.every(part => {
        const at = element.attributes.findIndex((name, index) => index % 2 === 0 && name === part.name);
        const value = at < 0 ? undefined : element.attributes[at + 1];
        return value !== undefined && (part.prefix ? value.startsWith(part.value) : value === part.value);
      });
    });
  }

  get page(): InputablePage {
    const resolve = (selector: string): FakeElement[] => {
      if (selector.startsWith('css=')) return this.matching(selector);
      const element = this.pointers.get(selector);
      return element === undefined ? [] : [element];
    };
    const locatorOf = (selector: string, index?: number): InputLocator => ({
      first: () => locatorOf(selector, index ?? 0),
      nth: at => locatorOf(selector, at),
      innerText: async () =>
        selector === 'body'
          ? [this.bodyText, ...(this.reflects ? this.session('page-target').values.values() : [])].join(' ')
          : '',
      ariaSnapshot: async () => (selector === 'body' ? this.aria : ''),
      count: async () => {
        const ref = /^aria-ref=(.+)$/u.exec(selector)?.[1];
        if (ref !== undefined) return this.refs.has(ref) ? 1 : 0;
        const found = resolve(selector);
        return index === undefined ? found.length : found[index] === undefined ? 0 : 1;
      },
      elementHandle: async () => {
        const element = resolve(selector)[index ?? 0];
        if (element === undefined) return null;
        if (element.handleFails === true) throw new Error('Element is not attached to the DOM');
        const handle: InputHandle = {
          ownerFrame: async () => element.frame,
          describe: async () => {
            this.described.push(element.backendNodeId);
            if (element.held instanceof Error) throw element.held;
            return {
              node: element.held ?? {
                nodeName: element.nodeName,
                backendNodeId: element.backendNodeId,
                attributes: element.attributes,
              },
              targetId: element.heldTarget ?? element.frame.sessionName,
            };
          },
          boundingBox: async () => (element.claimedBox === undefined ? element.box : element.claimedBox),
          isVisible: async () => element.visible,
          dispose: async () => {
            this.disposed.push(element);
          },
        };
        return handle;
      },
    });
    return {
      locator: locatorOf,
      isClosed: () => this.closed,
      url: () => this.pageUrl,
      title: async () => this.title,
      mainFrame: () => this.main,
      frames: () => this.frames,
      ...(this.listening
        ? {
            on: (_event: 'request', listener: () => void) => this.listeners.add(listener),
            off: (_event: 'request', listener: () => void) => this.listeners.delete(listener),
            openSockets: () => this.sockets,
            socketsOpened: () => this.socketsEver,
          }
        : {}),
    };
  }

  get cdp(): InputCdp {
    return {
      page: async () => this.session('page-target'),
      frame: async frame => {
        const fake = frame as FakeFrame;
        if (!fake.outOfProcess || fake.failAttach) throw new Error('This frame does not have a separate CDP session');
        return this.session(fake.sessionName);
      },
    };
  }

  readonly remembered = new InputFrameSessions();

  get subject(): InputSubject {
    return {
      pageId: 'pg-1',
      page: this.page,
      cdp: this.cdp,
      sessions: this.remembered,
      wait: async ms => await Bun.sleep(ms),
    };
  }
}
