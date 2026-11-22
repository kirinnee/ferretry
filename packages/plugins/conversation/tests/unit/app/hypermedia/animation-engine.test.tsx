/**
 * r12 H8 fix — THE 2D ANIMATION ENGINE IS A LAZY CHUNK: until it has arrived, an animation fence is read as the code it is
 * (never a blank, never an error); once it has, the same text is read as an animation. A message with no animation never asks
 * for it. The bundle half (the compiler and the 2D stage are in no first load) is `tests/perf/hypermedia-size.test.ts`; the
 * browser half (the chunk is fetched for an animation and only then) is `hypermedia-engines.visual.test.ts`.
 *
 * ONE PROCESS, ONE ORDER: the engine's state is the module's, and it only ever goes from "not here" to "here".
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { animationEngineReady, loadAnimationEngine } from '../../../../app/hypermedia/animation-engine.ts';
import { holdsAnimation } from '../../../../app/hypermedia/held-fence-parse.ts';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { mustRead } from './must-read.ts';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');
const ANIMATION = fence('animation', 'array a: 5 2 8 1', '@step 5 and 2 swap.', 'swap a.0 a.1');
const types = (text: string): readonly string[] =>
  mustRead(text, 'x-', false, animationEngineReady()).doc.blocks.map(block => block.type);

const draw = async (text: string) => {
  const tree = inShell(
    <ReferenceSurfaceProvider surface={fixture().surface}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

describe('holdsAnimation', () => {
  it('is true for an animation fence at any depth, and for nothing that only says the word', () => {
    expect(holdsAnimation(ANIMATION)).toBe(true);
    expect(holdsAnimation([':::tabs', '#### A', ANIMATION, ':::'].join('\n'))).toBe(true);
    expect(holdsAnimation('An animation is nice.')).toBe(false);
    expect(holdsAnimation(fence('ts', 'const animation = 1;'))).toBe(false);
    expect(holdsAnimation('plain')).toBe(false);
  });
});

describe('the animation engine', () => {
  it('is not asked for by a message with no animation (or one that only says the word)', async () => {
    const { unmount } = await draw('Just prose, `code`, and the word animation.');
    expect(animationEngineReady()).toBe(false);
    await unmount();
  });

  it('is not here at first: a message READ without it shows an animation as the code it is', () => {
    expect(animationEngineReady()).toBe(false);
    const read = mustRead(ANIMATION, 'x-');
    expect(read.doc.blocks.map(block => block.type)).toEqual(['host']);
    expect(read.doc.problems).toEqual([]);
  });

  it('is NOT asked for by a message that holds an animation (r12 H11): the worker has no compiler, so it is shown as the code it is', async () => {
    const { container, unmount } = await draw(ANIMATION);
    await interact(() => Promise.resolve());
    expect(animationEngineReady()).toBe(false);
    expect(container.querySelector('[data-fy-animation]')).toBeNull();
    expect(container.querySelector('.dh-doc code')?.textContent).toContain('swap a.0 a.1');
    await unmount();
  });

  it('once loaded, still does not draw an animation: the hold is the one value `ANIMATION_DRAWS`', async () => {
    await loadAnimationEngine();
    expect(animationEngineReady()).toBe(true);
    expect(types(ANIMATION)).toEqual(['host']);
    // The engine's own compile path is exercised directly: a read that is told the engine is here, with drawing on, is the
    // path r12 H11 turns back on; here the value is off, so it is a host block whatever the engine says.
    expect(mustRead(ANIMATION, 'x-', false, true).doc.blocks.map(block => block.type)).toEqual(['host']);
  });
});
