import { describe, it } from 'bun:test';
import should from 'should';
import {
  BROWSER_INPUT_SHOT_MARGIN,
  BROWSER_INPUT_SHOT_MAX_SIDE,
  type BrowserInputFacts,
  describeInputDocument,
  type InputCdp,
  type InputCdpSession,
  type InputFrame,
  InputFrameSessions,
  type InputHandle,
  type InputLocator,
  type InputablePage,
  type InputSubject,
  INPUT_REFIND_MAX_CANDIDATES,
  inputFieldAttributes,
  inputFieldSelector,
  isSecureUrl,
  observeInputFields,
  originOfUrl,
  PLAYWRIGHT_REACHED_VERSION,
  playwrightNodeOf,
  refindInputFields,
  shootInputFields,
  typeInputFields,
} from '../../../../src/lib/index.ts';

const PAGE_URL = 'http://localhost:3000/login';
const SECRET = 'Tr0ub4dor&3-the-secret-value';

interface FakeElement {
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

class FakeFrame implements InputFrame {
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
class FakeSession implements InputCdpSession {
  readonly calls: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  readonly typed: { readonly backendNodeId: number | undefined; readonly text: string }[] = [];
  readonly keys: string[] = [];
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
    switch (method) {
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
        if (!this.isolatedObjects.has(objectId)) {
          this.pageWorld.push('Runtime.callFunctionOn');
          if (this.pageSelectMovesFocusTo !== undefined) this.focused = this.pageSelectMovesFocusTo;
        }
        return { result: {} };
      }
      case 'Input.insertText':
        this.typed.push({ backendNodeId: this.focused, text: String(params.text) });
        return {};
      case 'Input.dispatchKeyEvent':
        this.keys.push(`${String(params.type)}:${String(params.key)}`);
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

class FakeWorld {
  loaderId = 'loader-1';
  closed = false;
  readonly elements: FakeElement[] = [];
  readonly refs = new Set<string>();
  readonly sessions = new Map<string, FakeSession>();
  readonly disposed: FakeElement[] = [];
  readonly main = new FakeFrame(PAGE_URL, 'page-target');
  frames: FakeFrame[] = [this.main];
  pageUrl = PAGE_URL;
  title = 'Sign in';
  viewport: Record<string, number> = { clientWidth: 800, clientHeight: 500, pageX: 0, pageY: 0 };
  /** The element each selector or ref points at. */
  readonly pointers = new Map<string, FakeElement>();
  /** The nodes each handle was asked about, in order: the identity comes from the handle, not the page. */
  readonly described: number[] = [];

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
    return { pageId: 'pg-1', page: this.page, cdp: this.cdp, sessions: this.remembered };
  }
}

const target = (selector: string) => ({ id: selector, target: { kind: 'selector' as const, selector } });

function loginWorld(): { world: FakeWorld; user: FakeElement; password: FakeElement } {
  const world = new FakeWorld();
  const user = world.element('#user', 11, [
    'type',
    'text',
    'name',
    'username',
    'id',
    'user',
    'autocomplete',
    'username',
  ]);
  const password = world.element('#pw', 12, ['type', 'password', 'name', 'pw', 'autocomplete', 'current-password']);
  return { world, user, password };
}

async function observed(world: FakeWorld, ids: readonly string[]): Promise<BrowserInputFacts> {
  const result = await observeInputFields(world.subject, ids.map(target));
  if (!result.ok) throw new Error(`not observed: ${JSON.stringify(result)}`);
  return result.facts;
}

const insertions = (world: FakeWorld): number =>
  [...world.sessions.values()].reduce((sum, session) => sum + session.count('Input.insertText'), 0);

describe('observeInputFields', () => {
  it('describes the page and each field from what the browser reports', async () => {
    const { world } = loginWorld();
    const facts = await observed(world, ['#user', '#pw']);
    should(facts.kind).equal('browser');
    should(facts.pageId).equal('pg-1');
    should(facts.origin).equal('http://localhost:3000');
    should(facts.secure).equal(true);
    should(facts.navigationId).equal('loader-1');
    should(facts.challenge).be.undefined();
    should(facts.fields.map(field => field.fieldId)).eql(['#user', '#pw']);
    const [user, password] = facts.fields;
    should(user?.backendNodeId).equal(11);
    should(user?.frameId).equal('page-target');
    should(user?.frameOrigin).equal('http://localhost:3000');
    should(user?.field).eql({ tag: 'input', type: 'text', autocomplete: 'username', name: 'username', id: 'user' });
    should(user?.box).eql({ x: 10, y: 20, w: 100, h: 24 });
    should(user?.visible).equal(true);
    should(user?.covered).be.undefined();
    should(password?.field).eql({ tag: 'input', type: 'password', autocomplete: 'current-password', name: 'pw' });
  });

  it('asks the handle which node it holds, never the page, and disposes every handle', async () => {
    const { world } = loginWorld();
    await observed(world, ['#user', '#pw']);
    const session = world.session('page-target');
    should(world.described).eql([11, 12]);
    should(session.count('DOM.performSearch')).equal(0);
    should(session.calls.filter(call => call.method === 'DOM.describeNode').map(call => call.params)).eql([
      { backendNodeId: 11 },
      { backendNodeId: 12 },
    ]);
    should(world.disposed.length).equal(2);
  });

  it('disposes the handle even when the look fails', async () => {
    const { world } = loginWorld();
    world.session('page-target').failOn = method => (method === 'DOM.describeNode' ? new Error('boom') : undefined);
    await observeInputFields(world.subject, [target('#user')]).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      () => undefined,
    );
    should(world.disposed.length).equal(1);
  });

  describe('refuses a field whose identity is not proved', () => {
    const refused = async (world: FakeWorld, pointer = '#user'): Promise<void> => {
      await observeInputFields(world.subject, [target(pointer)]).then(
        () => should.fail(undefined, undefined, 'it should reject'),
        error => should((error as Error).message).equal('the browser could not identify that field on the page'),
      );
      should(world.remembered.get('page-target')).be.undefined();
    };

    it('when the handle cannot say which node it holds', async () => {
      const { world, user } = loginWorld();
      user.held = new Error('the handle is gone');
      await refused(world);
      user.held = { nodeName: 'INPUT', attributes: [] };
      await refused(world);
      user.held = { backendNodeId: 0, nodeName: 'INPUT', attributes: [] };
      await refused(world);
    });

    it('when the session the write uses describes that node differently', async () => {
      const { world, user } = loginWorld();
      user.held = { backendNodeId: 11, nodeName: 'INPUT', attributes: ['type', 'password'] };
      await refused(world);
      user.held = { backendNodeId: 11, nodeName: 'TEXTAREA', attributes: user.attributes };
      await refused(world);
    });

    it('when the node is not in the session that owns the handle’s frame', async () => {
      const { world, user } = loginWorld();
      user.held = { backendNodeId: 99, nodeName: 'INPUT', attributes: user.attributes };
      await refused(world);
    });

    it('when the node has no usable id', async () => {
      const world = new FakeWorld();
      world.element('#odd', 0, ['type', 'password']);
      await refused(world, '#odd');
    });
  });

  describe('flags, never refuses, a proved field that is covered or off screen', () => {
    it('the review combination: a would-be marker redirect AND a same-box overlay on top — the handle’s node, covered', async () => {
      const { world, user, password } = loginWorld();
      password.box = user.box;
      world.session('page-target').onTop = password;
      const field = (await observed(world, ['#user'])).fields[0];
      should(field?.backendNodeId).equal(11);
      should(field?.field.type).equal('text');
      should(field?.covered).equal(true);
      should(field?.visible).equal(true);
    });

    it('when the hit test finds nothing at all, or DevTools cannot measure the node', async () => {
      const { world } = loginWorld();
      const session = world.session('page-target');
      session.failOn = method =>
        method === 'DOM.getNodeForLocation' ? new Error('No node found at given location') : undefined;
      should((await observed(world, ['#user'])).fields[0]?.covered).equal(true);
      session.failOn = method => (method === 'DOM.getBoxModel' ? new Error('Could not compute box model.') : undefined);
      should((await observed(world, ['#user'])).fields[0]?.covered).equal(true);
      session.failOn = undefined;
      session.quad = [1, 2, 3];
      should((await observed(world, ['#user'])).fields[0]?.covered).equal(true);
      session.quad = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      should((await observed(world, ['#user'])).fields[0]?.covered).equal(true);
    });
  });

  it('takes the box Playwright measured for the element it holds, and hit-tests the centre DevTools measured', async () => {
    const { world, user } = loginWorld();
    user.claimedBox = { x: 10.6, y: 19.5, width: 100.9, height: 23.2 };
    const facts = await observed(world, ['#user']);
    should(facts.fields[0]?.box).eql({ x: 10.6, y: 19.5, w: 100.9, h: 23.2 });
    const session = world.session('page-target');
    should(session.calls.find(call => call.method === 'DOM.getBoxModel')?.params).eql({ backendNodeId: 11 });
    should(session.calls.find(call => call.method === 'DOM.getNodeForLocation')?.params).eql({
      x: 60,
      y: 32,
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    });
  });

  it('hit-tests the centre of a rotated node’s border quad', async () => {
    const { world, user } = loginWorld();
    user.box = { x: 5, y: 10, width: 40, height: 30 };
    world.session('page-target').quad = [5, 20, 25, 10, 45, 30, 25, 40];
    await observed(world, ['#user']);
    should(
      world.session('page-target').calls.find(call => call.method === 'DOM.getNodeForLocation')?.params,
    ).containEql({ x: 25, y: 25 });
  });

  it('names a field whose element is not on the page, for a stale ref and for a selector alike', async () => {
    const { world } = loginWorld();
    const stale = await observeInputFields(world.subject, [
      target('#user'),
      { id: 'code', target: { kind: 'ref', ref: 'e99' } },
    ]);
    should(stale).eql({ ok: false, missing: 'code' });
    const gone = await observeInputFields(world.subject, [target('#nothing')]);
    should(gone).eql({ ok: false, missing: '#nothing' });
  });

  it('reads an out-of-process frame through the frame own session', async () => {
    const { world } = loginWorld();
    const cross = new FakeFrame('https://pay.example.com/card', 'frame-target', true);
    world.element('#card', 7, ['name', 'cardnumber', 'autocomplete', 'cc-number'], cross);
    const facts = await observed(world, ['#card']);
    const field = facts.fields[0];
    should(field?.frameId).equal('frame-target');
    should(field?.frameOrigin).equal('https://pay.example.com');
    should(field?.backendNodeId).equal(7);
    should(facts.origin).equal('http://localhost:3000');
    should(world.session('frame-target').count('DOM.describeNode')).equal(1);
    should(world.session('page-target').count('DOM.describeNode')).equal(0);
    should(world.remembered.get('frame-target')).equal(world.session('frame-target'));
  });

  it('the review combination in a frame of its own: two same-sized inputs, the handle’s one is observed', async () => {
    const { world } = loginWorld();
    const cross = new FakeFrame('https://pay.example.com/card', 'frame-target', true);
    cross.offset = { x: 300, y: 200 };
    const card = world.element('#card', 7, ['name', 'cardnumber'], cross);
    const other = world.element('#other', 8, ['name', 'decoy'], cross);
    card.box = { x: 310, y: 220, width: 100, height: 24 };
    other.box = { x: 310, y: 260, width: 100, height: 24 };
    const field = (await observed(world, ['#card'])).fields[0];
    should(field?.backendNodeId).equal(7);
    should(field?.field.name).equal('cardnumber');
    should(field?.box).eql({ x: 310, y: 220, w: 100, h: 24 });
    should(field?.covered).be.undefined();
    should(
      world.session('frame-target').calls.find(call => call.method === 'DOM.getNodeForLocation')?.params,
    ).containEql({ x: 60, y: 32 });
    should(world.session('page-target').count('DOM.getNodeForLocation')).equal(0);
  });

  it('falls back to the page session for a frame that shares its process', async () => {
    const { world } = loginWorld();
    const same = new FakeFrame('http://localhost:3000/inner', 'page-target');
    world.element('#inner', 9, ['name', 'inner'], same);
    const facts = await observed(world, ['#inner']);
    should(facts.fields[0]?.frameId).equal('page-target');
    should(world.session('page-target').count('DOM.describeNode')).equal(1);
  });

  it('lets go of a frame session a later look replaces', async () => {
    const { world } = loginWorld();
    const cross = new FakeFrame('https://pay.example.com/card', 'frame-target', true);
    world.element('#card', 7, ['name', 'cardnumber'], cross);
    await observed(world, ['#card']);
    const first = world.session('frame-target');
    world.sessions.delete('frame-target');
    await observed(world, ['#card']);
    should(first.detached).equal(true);
    world.remembered.release();
    should(world.session('frame-target').detached).equal(true);
    should(world.remembered.get('frame-target')).be.undefined();
  });

  it('reports a box of zeros and not visible for an element with no area', async () => {
    const { world, user } = loginWorld();
    user.box = null;
    const hidden = await observed(world, ['#user']);
    should(hidden.fields[0]?.box).eql({ x: 0, y: 0, w: 0, h: 0 });
    should(hidden.fields[0]?.visible).equal(false);
    should(hidden.fields[0]?.covered).equal(true);
    user.box = { x: 1, y: 2, width: 0, height: 10 };
    should((await observed(world, ['#user'])).fields[0]?.visible).equal(false);
    user.box = { x: 1, y: 2, width: 50, height: 10 };
    user.visible = false;
    should((await observed(world, ['#user'])).fields[0]?.visible).equal(false);
  });

  it('still describes a page whose title cannot be read, with no human check guessed from it', async () => {
    const { world } = loginWorld();
    const page = world.page;
    const subject = {
      ...world.subject,
      page: {
        ...page,
        title: async () => {
          throw new Error('the page is navigating');
        },
      },
    };

    const result = await observeInputFields(subject, [target('#user')]);

    should(result.ok).be.true();
    should(result.ok && result.facts.challenge).be.undefined();
  });

  it('flags a page that appears to ask for a human check', async () => {
    const { world } = loginWorld();
    world.frames.push(new FakeFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile', 'x'));
    should((await observed(world, ['#user'])).challenge).eql({ provider: 'cloudflare' });
  });

  it('says a page is not secure unless it is https or on this machine', async () => {
    const { world } = loginWorld();
    world.pageUrl = 'http://example.com/login';
    should((await observed(world, ['#user'])).secure).equal(false);
    world.pageUrl = 'https://example.com/login';
    should((await observed(world, ['#user'])).secure).equal(true);
  });

  it('reads the navigation id from the main frame loader', async () => {
    const { world } = loginWorld();
    world.loaderId = 'loader-77';
    should((await observed(world, ['#user'])).navigationId).equal('loader-77');
  });
});

describe('inputFieldAttributes', () => {
  it('cuts each attribute to its bound, drops control characters and omits empty ones', () => {
    const field = inputFieldAttributes({
      nodeName: 'INPUT',
      attributes: [
        'TYPE',
        'Password',
        'name',
        'n'.repeat(300),
        'id',
        '',
        'autocomplete',
        'a\u0000b​c',
        'inputmode',
        'x'.repeat(40),
      ],
    });
    should(field).eql({
      tag: 'input',
      type: 'Password',
      autocomplete: 'abc',
      name: 'n'.repeat(128),
      inputmode: 'x'.repeat(32),
    });
  });

  it('answers a tag for a node that has none', () => {
    should(inputFieldAttributes({}).tag).equal('unknown');
  });
});

describe('originOfUrl and isSecureUrl', () => {
  it('answers null for an address with no origin', () => {
    should(originOfUrl('data:text/html,hi')).equal('null');
    should(originOfUrl('not a url')).equal('null');
    should(originOfUrl('https://a.example:8443/x?y#z')).equal('https://a.example:8443');
  });

  it('treats https and loopback http as secure and nothing else', () => {
    should(isSecureUrl('https://a.example/')).equal(true);
    should(isSecureUrl('http://127.0.0.1:8080/')).equal(true);
    should(isSecureUrl('http://[::1]:8080/')).equal(true);
    should(isSecureUrl('http://localhost/')).equal(true);
    should(isSecureUrl('http://a.example/')).equal(false);
    should(isSecureUrl('ftp://localhost/')).equal(false);
    should(isSecureUrl('garbage')).equal(false);
  });
});

describe('describeInputDocument', () => {
  it('answers the main frame loader and looks at no field', async () => {
    const { world } = loginWorld();
    world.loaderId = 'loader-5';
    should(await describeInputDocument(world.subject)).eql({ navigationId: 'loader-5' });
    should(world.session('page-target').calls.map(call => call.method)).eql(['Page.getFrameTree']);
  });

  it('refuses a closed page', async () => {
    const { world } = loginWorld();
    world.closed = true;
    await describeInputDocument(world.subject).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      () => undefined,
    );
  });
});

describe('typeInputFields', () => {
  async function ready(): Promise<{ world: FakeWorld; facts: BrowserInputFacts }> {
    const { world } = loginWorld();
    const facts = await observed(world, ['#user', '#pw']);
    for (const session of world.sessions.values()) session.calls.length = 0;
    return { world, facts };
  }

  const values = [
    { field: '#user', text: 'alice@example.com' },
    { field: '#pw', text: SECRET },
  ];

  it('focuses, selects and inserts each value in order, and answers typed', async () => {
    const { world, facts } = await ready();
    should(await typeInputFields(world.subject, facts, values, false)).equal('typed');
    const session = world.session('page-target');
    should(session.typed).eql([
      { backendNodeId: 11, text: 'alice@example.com' },
      { backendNodeId: 12, text: SECRET },
    ]);
    should(session.calls.map(call => call.method)).eql([
      'Page.getFrameTree',
      'DOM.describeNode',
      'DOM.describeNode',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'DOM.resolveNode',
      'DOM.focus',
      'Runtime.callFunctionOn',
      'Page.getFrameTree',
      'Runtime.evaluate',
      'DOM.describeNode',
      'Input.insertText',
      'Page.getFrameTree',
      'DOM.resolveNode',
      'DOM.focus',
      'Runtime.callFunctionOn',
      'Page.getFrameTree',
      'Runtime.evaluate',
      'DOM.describeNode',
      'Input.insertText',
    ]);
    should(session.keys).eql([]);
    should(session.pageWorld).eql([]);
  });

  it('selects with the native select in an isolated world and proves focus from that world', async () => {
    const { world, facts } = await ready();
    should(await typeInputFields(world.subject, facts, values.slice(0, 1), false)).equal('typed');
    const session = world.session('page-target');
    const created = session.calls.find(call => call.method === 'Page.createIsolatedWorld');
    should(created?.params).eql({ frameId: world.main.id, worldName: 'ferretry-input' });
    const resolved = session.calls.find(call => call.method === 'DOM.resolveNode');
    should(resolved?.params.backendNodeId).equal(11);
    const select = session.calls.find(call => call.method === 'Runtime.callFunctionOn');
    should(select?.params.objectId).equal('iso-node-11');
    should(String(select?.params.functionDeclaration)).containEql('HTMLInputElement.prototype');
    should(String(select?.params.functionDeclaration)).containEql('p.select.call(this)');
    const evaluated = session.calls.find(call => call.method === 'Runtime.evaluate');
    should(evaluated?.params.contextId).equal(resolved?.params.executionContextId);
    should(session.pageWorld).eql([]);
  });

  it('makes every insert the very next call after the focus proof, and one isolated world per frame', async () => {
    const { world, facts } = await ready();
    should(await typeInputFields(world.subject, facts, values, false)).equal('typed');
    const session = world.session('page-target');
    const methods = session.calls.map(call => call.method);
    methods.forEach((method, index) => {
      if (method !== 'Input.insertText') return;
      should(methods.slice(index - 3, index)).eql(['Page.getFrameTree', 'Runtime.evaluate', 'DOM.describeNode']);
    });
    should(session.count('Page.createIsolatedWorld')).equal(1);
  });

  it('is not redirected by a page whose own select moves focus to another field', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    session.pageSelectMovesFocusTo = 12;
    should(await typeInputFields(world.subject, facts, values, false)).equal('typed');
    should(session.typed).eql([
      { backendNodeId: 11, text: 'alice@example.com' },
      { backendNodeId: 12, text: SECRET },
    ]);
    should(session.pageWorld).eql([]);
  });

  it('writes nothing and answers target_changed when focus moves between the select and the proof', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    session.failOn = method => {
      if (method === 'Runtime.callFunctionOn') session.focused = 12;
      return undefined;
    };
    should(await typeInputFields(world.subject, facts, values, true)).equal('target_changed');
    should(insertions(world)).equal(0);
    should(session.count('Input.dispatchKeyEvent')).equal(0);
  });

  it('writes nothing and answers target_changed when the page navigates between the select and the proof', async () => {
    const { world, facts } = await ready();
    world.session('page-target').failOn = method => {
      if (method === 'Runtime.callFunctionOn') world.loaderId = 'loader-2';
      return undefined;
    };
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('writes nothing when nothing has focus at the proof', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    const original = session.send.bind(session);
    session.send = async (method, params) =>
      method === 'Runtime.evaluate' ? { result: { type: 'object', subtype: 'null' } } : await original(method, params);
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('finds a field of a frame that shares the process in that frame own world, and proves focus from the root', async () => {
    const { world } = loginWorld();
    const inner = new FakeFrame('http://localhost:3000/inner', 'page-target');
    world.element('#inner', 9, ['name', 'inner'], inner);
    const facts = await observed(world, ['#inner']);
    const session = world.session('page-target');
    session.calls.length = 0;
    should(await typeInputFields(world.subject, facts, [{ field: '#inner', text: 'x' }], false)).equal('typed');
    should(session.typed).eql([{ backendNodeId: 9, text: 'x' }]);
    should(session.count('Page.createIsolatedWorld')).equal(2);
    const resolves = session.calls.filter(call => call.method === 'DOM.resolveNode');
    should(resolves.length).equal(2);
    const evaluated = session.calls.find(call => call.method === 'Runtime.evaluate');
    should(evaluated?.params.contextId).equal(resolves[0]?.params.executionContextId);
    should(session.pageWorld).eql([]);
  });

  describe('writes nothing and answers target_changed when no trusted world can hold the node', () => {
    const cases: readonly [string, (session: FakeSession, world: FakeWorld) => void][] = [
      [
        'the frame tree has no frame',
        session => {
          const original = session.send.bind(session);
          session.send = async (method, params) =>
            method === 'Page.getFrameTree' && session.count('Page.getFrameTree') > 0
              ? { frameTree: {} }
              : await original(method, params);
        },
      ],
      [
        'the world is made without a context',
        session => {
          const original = session.send.bind(session);
          session.send = async (method, params) =>
            method === 'Page.createIsolatedWorld' ? {} : await original(method, params);
        },
      ],
      [
        'the world cannot be made for the root frame',
        session => {
          session.failOn = method => (method === 'Page.createIsolatedWorld' ? new Error('no world') : undefined);
        },
      ],
      [
        'no frame can resolve the node',
        session => {
          session.failOn = method => (method === 'DOM.resolveNode' ? new Error('gone') : undefined);
        },
      ],
      [
        'the node resolves to no object',
        session => {
          const original = session.send.bind(session);
          session.send = async (method, params) =>
            method === 'DOM.resolveNode' ? { object: {} } : await original(method, params);
        },
      ],
    ];
    for (const [name, change] of cases)
      it(name, async () => {
        const { world, facts } = await ready();
        change(world.session('page-target'), world);
        should(await typeInputFields(world.subject, facts, values, true)).equal('target_changed');
        should(insertions(world)).equal(0);
        should(world.session('page-target').count('DOM.focus')).equal(0);
      });
  });

  it('presses Enter on the last field session only after the last value', async () => {
    const { world, facts } = await ready();
    should(await typeInputFields(world.subject, facts, values, true)).equal('typed');
    const methods = world.session('page-target').calls.map(call => call.method);
    should(methods.slice(-3)).eql(['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    should(methods.filter(method => method === 'Input.dispatchKeyEvent').length).equal(2);
    const enter = world.session('page-target').calls.filter(call => call.method === 'Input.dispatchKeyEvent');
    should(enter[0]?.params).containEql({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    should(enter[1]?.params).containEql({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    should(world.session('page-target').keys).eql(['keyDown:Enter', 'keyUp:Enter']);
  });

  it('writes each value on the session that owns its frame', async () => {
    const { world } = loginWorld();
    const cross = new FakeFrame('https://pay.example.com/card', 'frame-target', true);
    world.element('#card', 7, ['name', 'cardnumber'], cross);
    const facts = await observed(world, ['#user', '#card']);
    const outcome = await typeInputFields(
      world.subject,
      facts,
      [
        { field: '#user', text: 'alice' },
        { field: '#card', text: '4242' },
      ],
      true,
    );
    should(outcome).equal('typed');
    should(world.session('page-target').typed).eql([{ backendNodeId: 11, text: 'alice' }]);
    should(world.session('frame-target').typed).eql([{ backendNodeId: 7, text: '4242' }]);
    should(world.session('frame-target').keys).eql(['keyDown:Enter', 'keyUp:Enter']);
    should(world.session('page-target').keys).eql([]);
  });

  it('answers target_gone for a closed page and touches nothing', async () => {
    const { world, facts } = await ready();
    world.closed = true;
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_gone');
    should([...world.sessions.values()].every(session => session.calls.length === 0)).equal(true);
  });

  const at = (world: FakeWorld, pointer: string): FakeElement => {
    const element = world.pointers.get(pointer);
    if (element === undefined) throw new Error(`no fake element ${pointer}`);
    return element;
  };
  const changes: readonly [string, (world: FakeWorld) => void][] = [
    [
      'the page navigated',
      world => {
        world.loaderId = 'loader-2';
      },
    ],
    [
      'the origin changed',
      world => {
        world.pageUrl = 'https://evil.example/login';
      },
    ],
    [
      'a field type changed',
      world => {
        at(world, '#pw').attributes = ['type', 'text', 'name', 'pw', 'autocomplete', 'current-password'];
      },
    ],
    [
      'a field name changed',
      world => {
        at(world, '#user').attributes = ['type', 'text', 'name', 'other', 'id', 'user', 'autocomplete', 'username'];
      },
    ],
    [
      'a field autocomplete changed',
      world => {
        at(world, '#user').attributes = ['type', 'text', 'name', 'username', 'id', 'user'];
      },
    ],
    [
      'a field id changed',
      world => {
        at(world, '#user').attributes = ['type', 'text', 'name', 'username', 'id', 'x', 'autocomplete', 'username'];
      },
    ],
    [
      'a field inputmode appeared',
      world => {
        at(world, '#user').attributes.push('inputmode', 'numeric');
      },
    ],
    [
      'a field became another element',
      world => {
        at(world, '#user').nodeName = 'TEXTAREA';
      },
    ],
    [
      'a node is gone',
      world => {
        world.elements.splice(world.elements.indexOf(at(world, '#pw')), 1);
      },
    ],
    [
      'a node cannot be described',
      world => {
        world.session('page-target').failOn = method => (method === 'DOM.describeNode' ? new Error('gone') : undefined);
      },
    ],
  ];
  for (const [name, change] of changes)
    it(`writes nothing and answers target_changed when ${name}`, async () => {
      const { world, facts } = await ready();
      change(world);
      should(await typeInputFields(world.subject, facts, values, true)).equal('target_changed');
      should(insertions(world)).equal(0);
      should(world.session('page-target').count('DOM.focus')).equal(0);
      should(world.session('page-target').count('Input.dispatchKeyEvent')).equal(0);
    });

  it('writes nothing for a value whose field the owner was not shown', async () => {
    const { world, facts } = await ready();
    should(await typeInputFields(world.subject, facts, [{ field: 'other', text: 'x' }], false)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('writes nothing when no session is held for an expected frame', async () => {
    const { world, facts } = await ready();
    world.remembered.release();
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('answers target_changed with nothing typed when focus lands elsewhere on the first field', async () => {
    const { world, facts } = await ready();
    world.session('page-target').focusLandsOn = 12;
    should(await typeInputFields(world.subject, facts, values, true)).equal('target_changed');
    should(insertions(world)).equal(0);
    should(world.session('page-target').count('Input.dispatchKeyEvent')).equal(0);
  });

  it('answers uncertain when focus lands elsewhere after a value was typed', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    session.failOn = (method, params) => {
      if (method === 'DOM.focus' && params.backendNodeId === 12) session.focusLandsOn = 11;
      return undefined;
    };
    should(await typeInputFields(world.subject, facts, values, true)).equal('uncertain');
    should(session.typed).eql([{ backendNodeId: 11, text: 'alice@example.com' }]);
    should(session.count('Input.dispatchKeyEvent')).equal(0);
  });

  it('answers target_changed when the first focus itself fails, and when the first select does', async () => {
    const { world, facts } = await ready();
    world.session('page-target').failOn = method => (method === 'DOM.focus' ? new Error('not focusable') : undefined);
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_changed');
    world.session('page-target').failOn = method => (method === 'Runtime.callFunctionOn' ? new Error('no') : undefined);
    should(await typeInputFields(world.subject, facts, values, false)).equal('target_changed');
    should(insertions(world)).equal(0);
  });

  it('answers uncertain, and never retries, when the first insertion fails', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    session.failOn = method => (method === 'Input.insertText' ? new Error('detached') : undefined);
    should(await typeInputFields(world.subject, facts, values, true)).equal('uncertain');
    should(session.count('Input.insertText')).equal(1);
    should(session.count('Input.dispatchKeyEvent')).equal(0);
  });

  it('answers uncertain when the Enter key fails after everything was typed', async () => {
    const { world, facts } = await ready();
    const session = world.session('page-target');
    session.failOn = method => (method === 'Input.dispatchKeyEvent' ? new Error('no key') : undefined);
    should(await typeInputFields(world.subject, facts, values, true)).equal('uncertain');
    should(session.typed.length).equal(2);
  });

  it('answers uncertain, not target_gone, when the page closes mid-write', async () => {
    const { world, facts } = await ready();
    world.session('page-target').failOn = method => {
      if (method !== 'Input.insertText') return undefined;
      world.closed = true;
      return new Error('closed');
    };
    should(await typeInputFields(world.subject, facts, values, false)).equal('uncertain');
  });

  it('never carries a value in anything it returns, throws, or logs, even when DevTools errors echo it', async () => {
    for (const failing of [
      'Page.createIsolatedWorld',
      'DOM.resolveNode',
      'DOM.focus',
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
      'Input.insertText',
      'Input.dispatchKeyEvent',
    ]) {
      const { world, facts } = await ready();
      world.session('page-target').failOn = method =>
        method === failing ? new Error(`bad text "${SECRET}" (${SECRET.length} chars)`) : undefined;
      const logged: string[] = [];
      const originals = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info,
        debug: console.debug,
      };
      for (const key of Object.keys(originals) as (keyof typeof originals)[])
        console[key] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
      let outcome: unknown;
      let thrown: unknown;
      try {
        outcome = await typeInputFields(world.subject, facts, values, true);
      } catch (error) {
        thrown = error;
      } finally {
        Object.assign(console, originals);
      }
      should(thrown).be.undefined();
      should(['typed', 'target_changed', 'target_gone', 'uncertain']).containEql(outcome as string);
      should(JSON.stringify(outcome)).not.containEql(SECRET);
      should(JSON.stringify(outcome)).not.containEql(String(SECRET.length));
      should(logged.join('\n')).not.containEql(SECRET);
    }
  });
});

describe('shootInputFields', () => {
  const factsAt = (...boxes: { x: number; y: number; w: number; h: number }[]): BrowserInputFacts => {
    return {
      kind: 'browser',
      pageId: 'pg-1',
      origin: 'http://localhost:3000',
      secure: true,
      navigationId: 'loader-1',
      fields: boxes.map((box, index) => ({
        fieldId: `f${index}`,
        frameOrigin: 'http://localhost:3000',
        frameId: 'page-target',
        backendNodeId: index + 1,
        field: { tag: 'input' },
        box,
        visible: true,
      })),
    };
  };

  it('takes the union of the boxes plus the margin, as a png at scale 1', async () => {
    const world = new FakeWorld();
    const session = world.session('page-target');
    const shot = await shootInputFields(
      session,
      factsAt({ x: 100, y: 200, w: 100, h: 20 }, { x: 150, y: 240, w: 200, h: 20 }),
    );
    const m = BROWSER_INPUT_SHOT_MARGIN;
    should(shot.clip).eql({ x: 100 - m, y: 200 - m, w: 250 + 2 * m, h: 60 + 2 * m });
    should(shot.pngBase64).equal('cG5n');
    const capture = session.calls.find(call => call.method === 'Page.captureScreenshot');
    should(capture?.params).eql({
      format: 'png',
      clip: { x: 100 - m, y: 200 - m, width: 250 + 2 * m, height: 60 + 2 * m, scale: 1 },
      captureBeyondViewport: false,
    });
  });

  it('clamps to the viewport edges', async () => {
    const world = new FakeWorld();
    const shot = await shootInputFields(
      world.session('page-target'),
      factsAt({ x: 5, y: 3, w: 100, h: 20 }, { x: 700, y: 480, w: 95, h: 15 }),
    );
    should(shot.clip).eql({ x: 0, y: 0, w: 800, h: 500 });
  });

  it('clamps to the longest side', async () => {
    const world = new FakeWorld();
    world.viewport = { clientWidth: 2000, clientHeight: 2000, pageX: 0, pageY: 0 };
    const shot = await shootInputFields(world.session('page-target'), factsAt({ x: 100, y: 100, w: 1500, h: 1500 }));
    should(shot.clip.w).equal(BROWSER_INPUT_SHOT_MAX_SIDE);
    should(shot.clip.h).equal(BROWSER_INPUT_SHOT_MAX_SIDE);
  });

  it('asks for page coordinates when the page is scrolled but answers in viewport coordinates', async () => {
    const world = new FakeWorld();
    world.viewport = { clientWidth: 800, clientHeight: 500, pageX: 30, pageY: 560 };
    const session = world.session('page-target');
    const shot = await shootInputFields(session, factsAt({ x: 100, y: 200, w: 100, h: 20 }));
    const m = BROWSER_INPUT_SHOT_MARGIN;
    should(shot.clip.x).equal(100 - m);
    should(shot.clip.y).equal(200 - m);
    const clip = session.calls.find(call => call.method === 'Page.captureScreenshot')?.params.clip as {
      x: number;
      y: number;
    };
    should(clip.x).equal(100 - m + 30);
    should(clip.y).equal(200 - m + 560);
  });

  it('ignores fields with no area and refuses a shot of none', async () => {
    const world = new FakeWorld();
    const session = world.session('page-target');
    const shot = await shootInputFields(session, factsAt({ x: 0, y: 0, w: 0, h: 0 }, { x: 300, y: 300, w: 50, h: 20 }));
    should(shot.clip.x).equal(300 - BROWSER_INPUT_SHOT_MARGIN);
    await shootInputFields(session, factsAt({ x: 0, y: 0, w: 0, h: 0 })).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      error => should((error as Error).message).equal('none of the fields has a visible area to take a picture of'),
    );
  });

  it('refuses a picture of a page whose viewport has no size', async () => {
    const world = new FakeWorld();
    world.viewport = { clientWidth: 0, clientHeight: 0, pageX: 0, pageY: 0 };
    await shootInputFields(world.session('page-target'), factsAt({ x: 10, y: 10, w: 50, h: 20 })).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      error => should((error as Error).message).equal('the browser took no picture'),
    );
  });

  it('refuses a capture that came back empty', async () => {
    const world = new FakeWorld();
    const session = world.session('page-target');
    const original = session.send.bind(session);
    session.send = async (method, params) =>
      method === 'Page.captureScreenshot' ? {} : await original(method, params);
    await shootInputFields(session, factsAt({ x: 10, y: 10, w: 50, h: 20 })).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      error => should((error as Error).message).equal('the browser took no picture'),
    );
  });
});

describe('playwrightNodeOf', () => {
  /** A Playwright client handle over its in-process server handle and the DevTools session that holds it. */
  const handleOver = (server: unknown) => ({
    _connection: { toImpl: (object: unknown) => (object ? server : undefined) },
  });
  const sessionAnswering = (node: unknown, seen: unknown[] = [], targetId: unknown = 'page-target') => ({
    _targetId: targetId,
    _client: {
      send: async (method: string, params: unknown) => {
        seen.push({ method, params });
        return { node };
      },
    },
  });

  it('describes the remote object Playwright holds, through the session that holds it', async () => {
    const seen: unknown[] = [];
    const node = { backendNodeId: 11, nodeName: 'INPUT', attributes: ['type', 'password'] };
    const server = {
      _objectId: 'obj-1',
      _page: { delegate: { _sessionForHandle: () => sessionAnswering(node, seen) } },
    };

    should(await playwrightNodeOf(handleOver(server))).eql({ node, targetId: 'page-target' });
    should(seen).eql([{ method: 'DOM.describeNode', params: { objectId: 'obj-1' } }]);
  });

  it('refuses when any part of the way to that session is missing', async () => {
    const node = { backendNodeId: 11 };
    const missing = [
      null,
      {},
      { _connection: {} },
      handleOver({ _page: { delegate: { _sessionForHandle: () => sessionAnswering(node) } } }),
      handleOver({ _objectId: 'obj-1', _page: { delegate: {} } }),
      handleOver({ _objectId: 'obj-1', _page: { delegate: { _sessionForHandle: () => ({ _client: {} }) } } }),
      handleOver({
        _objectId: 'obj-1',
        _page: { delegate: { _sessionForHandle: () => sessionAnswering(node, [], null) } },
      }),
    ];
    for (const handle of missing)
      await playwrightNodeOf(handle).then(
        () => should.fail(undefined, undefined, 'it should reject'),
        error => should((error as Error).message).equal('the browser could not identify that field on the page'),
      );
  });
});

describe('the Playwright release the identity reach was written against', () => {
  it('is the one installed: a bump must check the private reach in playwrightNodeOf again', async () => {
    const manifest = Bun.resolveSync('playwright-core/package.json', import.meta.dir);
    const installed = (JSON.parse(await Bun.file(manifest).text()) as { version: string }).version;
    // A failure here is the cue: re-read toImpl, _sessionForHandle, _targetId and _objectId in the new release,
    // then move PLAYWRIGHT_REACHED_VERSION.
    should(installed).equal(PLAYWRIGHT_REACHED_VERSION);
  });
});

describe('review regressions: the write is bound to the target that holds the handle', () => {
  /** A cross-site frame in its own process, and the page session carrying a node with the same id and attributes. */
  function collidingWorld() {
    const world = new FakeWorld();
    const oopif = new FakeFrame('https://pay.example.com/card', 'frame-target', true);
    const decoy = world.element('#decoy', 7, ['type', 'password', 'name', 'pw']);
    return { world, oopif, decoy };
  }

  it('binds a same-process frame nested inside an out-of-process one to that frame’s target, never the page', async () => {
    const { world, oopif } = collidingWorld();
    const nested = new FakeFrame('https://pay.example.com/inner', 'frame-target');
    nested.parent = oopif;
    world.frames.push(oopif);
    world.element('#card', 7, ['type', 'password', 'name', 'pw'], nested);

    const facts = await observed(world, ['#card']);
    const field = facts.fields[0];

    should(field?.frameId).equal('frame-target');
    should(field?.frameOrigin).equal('https://pay.example.com');
    should(world.remembered.get('frame-target')).equal(world.session('frame-target'));
    should(world.session('page-target').count('DOM.describeNode')).equal(0);
    const outcome = await typeInputFields(world.subject, facts, [{ field: '#card', text: SECRET }], false);
    should(outcome).equal('typed');
    should(world.session('page-target').typed).eql([]);
    should(world.session('frame-target').typed).eql([{ backendNodeId: 7, text: SECRET }]);
  });

  it('refuses a field whose frame’s own session cannot be attached, rather than reading the page’s colliding node', async () => {
    const { world, oopif } = collidingWorld();
    oopif.failAttach = true;
    world.element('#card', 7, ['type', 'password', 'name', 'pw'], oopif);

    await observeInputFields(world.subject, [target('#card')]).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      error => should((error as Error).message).equal('the browser could not identify that field on the page'),
    );
    should(world.session('page-target').count('DOM.describeNode')).equal(0);
    should(world.session('page-target').typed).eql([]);
  });

  it('lets go of a frame session that is not the target, and refuses when no session is', async () => {
    const { world, oopif } = collidingWorld();
    const card = world.element('#card', 7, ['type', 'password', 'name', 'pw'], oopif);
    card.heldTarget = 'some-other-target';

    await observeInputFields(world.subject, [target('#card')]).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      error => should((error as Error).message).equal('the browser could not identify that field on the page'),
    );
    should(world.session('frame-target').detached).equal(true);
    card.heldTarget = '';
    await observeInputFields(world.subject, [target('#card')]).then(
      () => should.fail(undefined, undefined, 'it should reject'),
      () => undefined,
    );
  });
});

describe('refindInputFields (#B100)', () => {
  /** A 2FA page: one code input, pointed at by a ref from the agent's snapshot. */
  function codeWorld() {
    const world = new FakeWorld();
    const code = world.element('aria-ref=e7', 21, [
      'type',
      'text',
      'name',
      'otp',
      'autocomplete',
      'one-time-code',
      'inputmode',
      'numeric',
    ]);
    return { world, code };
  }
  const pointer = { id: 'code', target: { kind: 'ref' as const, ref: 'e7' } };
  const look = async (world: FakeWorld) => {
    const result = await observeInputFields(world.subject, [pointer]);
    if (!result.ok) throw new Error('not observed');
    return result.facts;
  };

  it('should show WHICH part of the facts a re-render changes: the node only', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    // The agent reads the page again: its fresh snapshot names the new node e7.
    world.pointers.set('aria-ref=e7', world.rerender(code, 77));
    world.refs.add('e7');
    const after = await look(world);

    should(after.fields[0]?.backendNodeId).equal(77);
    should({ ...after, fields: [{ ...after.fields[0], backendNodeId: 21 }] }).eql(before);
  });

  it("should answer missing for the agent's stale ref, then find the re-rendered field and type into the new node", async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);

    const stale = await observeInputFields(world.subject, [pointer]);
    const again = await refindInputFields(world.subject, before, [pointer]);
    if (!again.ok) throw new Error('not refound');
    const outcome = await typeInputFields(world.subject, again.facts, [{ field: 'code', text: '123456' }], true);

    should(stale).eql({ ok: false, missing: 'code' });
    should(again.facts.fields[0]?.backendNodeId).equal(77);
    should(again.facts.fields[0]?.field).eql(before.fields[0]?.field);
    should(outcome).equal('typed');
    should(world.session('page-target').typed).eql([{ backendNodeId: 77, text: '123456' }]);
    // The identity came from the handle Playwright holds, exactly as a first look proves it.
    should(world.described.at(-1)).equal(77);
  });

  it('should still refuse to type into the old node: the write after a re-render is target_changed', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);

    should(await typeInputFields(world.subject, before, [{ field: 'code', text: '123456' }], true)).equal(
      'target_changed',
    );
    should(insertions(world)).equal(0);
  });

  it("should use the agent's pointer when it still names exactly that field", async () => {
    const world = new FakeWorld();
    world.element('#otp', 21, ['type', 'text', 'name', 'otp']);
    world.extra(30, ['type', 'text', 'name', 'otp']);
    const selector = { id: 'code', target: { kind: 'selector' as const, selector: '#otp' } };
    const first = await observeInputFields(world.subject, [selector]);
    if (!first.ok) throw new Error('not observed');

    const again = await refindInputFields(world.subject, first.facts, [selector]);

    should(again.ok && again.facts.fields[0]?.backendNodeId).equal(21);
  });

  it('should call the search ambiguous when a look-alike cannot be held: the page is changing under it', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);
    world.extra(78, [...code.attributes], { handleFails: true });

    should(await refindInputFields(world.subject, before, [pointer])).eql({ ok: false, ambiguous: 'code' });
  });

  it('should not let the pointer decide a search the page disturbed', async () => {
    const world = new FakeWorld();
    const code = world.element('#otp', 21, ['type', 'text', 'name', 'otp']);
    const selector = { id: 'code', target: { kind: 'selector' as const, selector: '#otp' } };
    const first = await observeInputFields(world.subject, [selector]);
    if (!first.ok) throw new Error('not observed');
    world.rerender(code, 77);
    world.extra(78, ['type', 'text', 'name', 'otp'], { handleFails: true });

    should(await refindInputFields(world.subject, first.facts, [selector])).eql({ ok: false, ambiguous: 'code' });
  });

  it('should keep the node the owner approved while it is still there, whatever the pointer now names', async () => {
    const world = new FakeWorld();
    world.element('#otp', 21, ['type', 'text', 'name', 'otp']);
    const selector = { id: 'code', target: { kind: 'selector' as const, selector: '#otp' } };
    const first = await observeInputFields(world.subject, [selector]);
    if (!first.ok) throw new Error('not observed');
    world.pointers.set('#otp', world.extra(30, ['type', 'text', 'name', 'otp']));

    const again = await refindInputFields(world.subject, first.facts, [selector]);

    should(again.ok && again.facts.fields[0]?.backendNodeId).equal(21);
  });

  it('should follow a selector to the re-rendered node, even beside a look-alike, once the approved node is gone', async () => {
    const world = new FakeWorld();
    const code = world.element('#otp', 21, ['type', 'text', 'name', 'otp']);
    const selector = { id: 'code', target: { kind: 'selector' as const, selector: '#otp' } };
    const first = await observeInputFields(world.subject, [selector]);
    if (!first.ok) throw new Error('not observed');
    world.rerender(code, 77);
    world.extra(78, ['type', 'text', 'name', 'otp']);

    const again = await refindInputFields(world.subject, first.facts, [selector]);

    should(again.ok && again.facts.fields[0]?.backendNodeId).equal(77);
  });

  it('should refuse two visible look-alikes as ambiguous, choosing neither', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);
    world.extra(78, [...code.attributes]);

    should(await refindInputFields(world.subject, before, [pointer])).eql({ ok: false, ambiguous: 'code' });
  });

  it('should pass over a hidden look-alike and a look-alike in another frame', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);
    world.extra(78, [...code.attributes], { visible: false });
    const other = new FakeFrame('https://evil.example/frame', 'evil-target', true);
    world.element('#elsewhere', 79, [...code.attributes], other);

    const again = await refindInputFields(world.subject, before, [pointer]);

    should(again.ok && again.facts.fields[0]?.backendNodeId).equal(77);
  });

  it('should refuse more look-alikes than it will look at', async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77, { visible: false });
    for (let n = 0; n < INPUT_REFIND_MAX_CANDIDATES; n += 1)
      world.extra(100 + n, [...code.attributes], { visible: false });

    should(await refindInputFields(world.subject, before, [pointer])).eql({ ok: false, ambiguous: 'code' });
  });

  const changed: readonly [string, Partial<FakeElement>][] = [
    ['a password field that became a text field', {}],
    ['a field that is now hidden', { visible: false }],
  ];
  for (const [name, change] of changed) {
    it(`should answer missing for ${name}`, async () => {
      const world = new FakeWorld();
      const password = world.element('aria-ref=e9', 31, ['type', 'password', 'name', 'pw']);
      const ref = { id: 'pw', target: { kind: 'ref' as const, ref: 'e9' } };
      const first = await observeInputFields(world.subject, [ref]);
      if (!first.ok) throw new Error('not observed');
      world.rerender(password, 32, {
        ...change,
        attributes: name.startsWith('a password') ? ['type', 'text', 'name', 'pw'] : password.attributes,
      });

      should(await refindInputFields(world.subject, first.facts, [ref])).eql({ ok: false, missing: 'pw' });
    });
  }

  it('should refuse two fields of the card that land on one node', async () => {
    const world = new FakeWorld();
    world.element('#a', 41, ['type', 'text']);
    const pointers = [
      { id: 'one', target: { kind: 'selector' as const, selector: '#a' } },
      { id: 'two', target: { kind: 'selector' as const, selector: '#a' } },
    ];
    const first = await observeInputFields(world.subject, pointers);
    if (!first.ok) throw new Error('not observed');

    should(await refindInputFields(world.subject, first.facts, pointers)).eql({ ok: false, ambiguous: 'two' });
  });

  it("should describe the page as it is now: a reload's new document is in the facts", async () => {
    const { world, code } = codeWorld();
    const before = await look(world);
    world.rerender(code, 77);
    world.loaderId = 'loader-2';

    const again = await refindInputFields(world.subject, before, [pointer]);

    should(again.ok && again.facts.navigationId).equal('loader-2');
  });

  it('should build a CSS selector a value cannot break out of, matching a cut value by its start', () => {
    should(inputFieldSelector({ tag: 'input', type: 'text', name: 'a"] , *[x="' })).equal(
      'css=input[type="text"][name="a\\"] , *[x=\\""]',
    );
    should(inputFieldSelector({ tag: 'input', name: 'n'.repeat(128) })).equal(`css=input[name^="${'n'.repeat(128)}"]`);
    should(inputFieldSelector({ tag: 'unknown tag' })).equal('css=*');
  });
});
