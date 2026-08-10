/**
 * The browser entry for the real-component `fy-render` evidence, and the ONE
 * source of fixture truth for it.
 *
 * WHY THIS IS A TRACKED FILE RATHER THAN A STRING. It used to be a template
 * literal inside `fy-render-component.visual.test.tsx`, which the test wrote into
 * `.artifacts/` and then handed to `Bun.build`. Three things were wrong with that.
 * The JSX was never typechecked. The test wrote a source file into the repository
 * to build it. And that `Bun.build` call — the only one traversing the real
 * component graph — is the operation an independent diagnosis pinned as the wedge
 * that hung the two-file integration run, which is the configuration
 * `scripts/ci/test.sh int` uses.
 *
 * Now the compile happens in a child process
 * (`scripts/build-fy-render-integration-fixture.ts`) and this module is its
 * entrypoint. It is tracked, so the evidence reproduces; it is typechecked, so the
 * scene cannot drift from the component's props; and no `Bun.build` runs inside the
 * test runner.
 *
 * IT MOUNTS THE SHIPPED COMPONENT AND NOTHING ELSE. No daemon, no transcript, no
 * routing — none of them change what `FyRenderBlock` does, and pulling the app
 * shell in is what made the old scene's module graph large enough to be a problem.
 * `parseFyRender` is the real grammar, so a fixture that would not parse in
 * production fails here too.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FyRenderBlock } from '../../../src/components/fy-render-block.tsx';
import { parseFyRender } from '../../../src/lib/fy-render.ts';
import { FY_RENDER_VISUAL_CASES } from './fy-render-visual-cases.ts';

/**
 * `?case=` selects a fixture; `?count=` mounts it more than once.
 *
 * The count exists for one specific claim. A theme change must create zero new
 * frames and zero new fetches until the reader presses Reload, and "zero" is only
 * meaningful at N > 1 — the defect it replaced remounted every compiled block at
 * once, and a single-block scene cannot tell an unbounded fan-out from a bounded
 * one.
 */
const parameters = new URLSearchParams(location.search);
const which = parameters.get('case') ?? 'mermaid';
const count = Math.min(Math.max(Number(parameters.get('count') ?? '1') || 1, 1), 8);

const source = FY_RENDER_VISUAL_CASES[which];
if (source === undefined) throw new Error(`no such fy-render fixture: ${which}`);

const parsed = parseFyRender(source);
if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);

const root = document.getElementById('root');
if (root === null) throw new Error('the scene has no #root to mount into');

createRoot(root).render(
  <StrictMode>
    <div className="scene-pad">
      {Array.from({ length: count }, (_unused, index) => (
        // The SAME parsed block in every slot: the fan-out claim is about how many
        // frames one theme change creates, not about distinguishing payloads. The index
        // IS the identity here for that reason — the blocks are deliberately identical
        // and the list never reorders.
        // biome-ignore lint/suspicious/noArrayIndexKey: identical blocks in a fixed-length list
        <FyRenderBlock block={parsed.block} key={index} />
      ))}
    </div>
  </StrictMode>,
);
