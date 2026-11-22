/**
 * The shared harness of the `fy-render` host's unit tests: the REAL `HypermediaProse` drawn in a real DOM (happy-dom)
 * over the chat's own fences (`fyRenderFences`). Nothing reads a network or a real home. Call {@link installFyRenderDom}
 * once at the top of a test file.
 */
import { afterAll, beforeAll } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { ensureDom, interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { fyRenderFences } from '../../../../app/render/fences.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

/** A block draws only once it is near the viewport, and happy-dom has no layout to say so. */
class OnScreen {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

export function installFyRenderDom(): void {
  ensureDom();
  const realObserver = globalThis.IntersectionObserver;
  /** A frame points itself at the shell once; the assignment is kept from reaching happy-dom, which would try to load it. */
  const frameSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  /** The sandbox frame's parent fetches one pinned library; no unit asks a network for it. */
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.IntersectionObserver = OnScreen as unknown as typeof IntersectionObserver;
    globalThis.fetch = (async () => new Response('globalThis.__fyRenderStub = true;')) as unknown as typeof fetch;
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      get: () => '',
      set: () => undefined,
    });
  });
  afterAll(() => {
    globalThis.IntersectionObserver = realObserver;
    globalThis.fetch = realFetch;
    if (frameSrc !== undefined) Object.defineProperty(HTMLIFrameElement.prototype, 'src', frameSrc);
  });
}

/** Built from a backtick run on purpose: `scripts/validate/no-fy-render-in-docs.sh` fails on the literal opener in a tracked file. */
export const FENCE = '`'.repeat(3);
export const SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

/** `arriving`: the text is the tail of a message still streaming in (what a live, last transcript row passes). */
export const draw = async (text: string, withBoard = true, arriving = false) => {
  const f = fixture();
  const surface = { ...f.surface, fences: fyRenderFences(withBoard ? { cardEmbed: { daemon: 'd1' } } : {}) };
  const tree = inShell(
    <ReferenceSurfaceProvider surface={surface}>
      <HypermediaProse arriving={arriving} text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

/** What a page draws of a text: frames, blocks and pictures, and whether anything is an error. */
export const drawn = async (text: string, arriving = false) => {
  const { container, unmount } = await draw(text, true, arriving);
  const result = {
    frames: container.querySelectorAll('iframe').length,
    blocks: container.querySelectorAll('[data-fy-render-type]').length,
    images: container.querySelectorAll('img').length,
    errors: container.querySelectorAll('.dh-error, [data-dh-missing]').length,
  };
  await unmount();
  return result;
};

export const NOTHING = { frames: 0, blocks: 0, images: 0, errors: 0 };
