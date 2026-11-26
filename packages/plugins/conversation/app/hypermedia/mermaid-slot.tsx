import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-markdown';
import { type ComponentType, type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE } from '../render/fy-render.ts';
import { type HeldFenceData, MERMAID_BLOCK_NAME } from './held-fence-parse.ts';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { type MermaidStep, stepSource } from './mermaid-steps.ts';

/**
 * A ```mermaid FENCE, DRAWN BY OUR RENDERER, AS A HOST BLOCK NAMED `mermaid`. Durian 0.7.0 removed its mermaid part (a mermaid fence is
 * plain code there), so the name is free and the block is ours: `held-fence-parse.ts` carries the fence's source as data and
 * this draws it. It keeps a diagram written for Durian 0.6.2 drawing in an old message (decision D2: read-only, not taught, to
 * be reviewed in three months); nothing teaches it.
 *
 * It hands the source to the SAME door a ` ```fy-render ` mermaid block goes through (the surface's `fences.draw`), as the
 * block `type: mermaid` would have made: the source is data in an opaque-origin sandbox frame, and what comes back is
 * admitted as text and shown as an `<img src="data:image/svg+xml…">`, the one measured sink. So there is ONE mermaid path
 * in the app, with its size cap, its watchdog, its palette and its fallback, and nothing here parses or draws a diagram.
 *
 * A STEPPED DIAGRAM KEEPS ITS STEPS (U1 review, item 3: D2 says an old diagram "loses nothing"). A diagram with `%% @step <title>` lines
 * (`mermaid-steps.ts`) is drawn one step at a time, as Durian 0.6.2 did: the step's title is its caption and its `alt`, Back and Next and a
 * slider move between them, and the arrow keys do the same. Each step is the head and every line up to the end of the step, with no marker
 * line, handed to the same door as a diagram of its own. A step is a sandbox frame and a library fetch, so one is started when it is first
 * shown and kept after (no redraw on return); the steps already shown stay in place under the active one, so the stage keeps the tallest
 * step's height. The controls use Durian's own control classes (`ctl`, `btn`, `anim-cap`), so the stylesheet that draws every other
 * stepping part draws these.
 *
 * A surface that lent no fences (a reader outside a ferret), a step the door refuses (over the 20,000 character cap) or a
 * source that is not one line of title: the step's SOURCE is shown as code, which is what Durian does with no slot.
 */

/** A header value is one line: no newline may let a title add a header or end the headers. */
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The fence node the existing reader makes for a body (the one shape the surface's fences accept). */
function synthesizedFence(body: string): MarkdownAstFenceNode {
  return {
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { [FY_RENDER_FENCE_ATTRIBUTE]: 'true' },
        // mdast-to-hast ends a fence body with a newline the author did not type; the reader strips it again.
        children: [{ type: 'text', value: `${body}\n` }],
      },
    ],
  };
}

/** The diagram, or its source as code when the surface lent no door or the door refused it. */
function MermaidDiagram({ src, title }: { readonly src: string; readonly title: string }): ReactNode {
  const { fences, onTaskOpen } = useReferenceSurface();
  const drawn = useMemo(() => {
    const alt = oneLine(title) === '' ? 'Mermaid diagram' : oneLine(title);
    // A source line that is exactly the boundary would end the headers early: the existing reader splits on the first one,
    // and the headers here are ours, so the boundary is the one we write.
    const body = ['type: mermaid', `alt: ${alt}`, '---', src].join('\n');
    return fences?.draw({ node: synthesizedFence(body), onTaskOpen }) ?? null;
  }, [fences, onTaskOpen, src, title]);
  return (
    drawn ?? (
      <pre className="fy-hm-mermaid-source">
        <code>{src}</code>
      </pre>
    )
  );
}

/** A step's caption: its own title, else the diagram's, else the word for a diagram. */
const stepAlt = (step: MermaidStep, title: string): string => (oneLine(step.title) === '' ? title : step.title);

/** One step of a stepped diagram, drawn the first time it is shown and kept after; the others are a quiet placeholder of no height. */
function MermaidStepFrame({
  src,
  title,
  shown,
  active,
}: {
  readonly src: string;
  readonly title: string;
  readonly shown: boolean;
  readonly active: boolean;
}): ReactNode {
  return (
    <div className="fy-hm-mermaid-step" data-active={active ? '' : undefined} aria-hidden={active ? undefined : true}>
      {shown ? <MermaidDiagram src={src} title={title} /> : <span className="fy-hm-mermaid-later" />}
    </div>
  );
}

/** A diagram with steps: the active step drawn, its caption, and the controls (Back, a slider, the count, Next). */
function SteppedMermaid({
  body,
  steps,
  title,
}: {
  readonly body: string;
  readonly steps: readonly MermaidStep[];
  readonly title: string;
}): ReactNode {
  const [index, setIndex] = useState(0);
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]));
  const last = steps.length - 1;
  const go = (to: number): void => {
    const next = Math.max(0, Math.min(last, to));
    setIndex(next);
    if (!seen.has(next)) setSeen(new Set([...seen, next]));
  };
  const onKeys = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).closest('input,select,textarea,button')) return;
    if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
    else return;
    event.preventDefault();
  };
  const label = oneLine(title) === '' ? 'Mermaid diagram' : oneLine(title);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the group takes the arrow keys, as every stepping part of Durian does
    // biome-ignore lint/a11y/useSemanticElements: the stepper is one labelled widget of a diagram, a caption and controls; a <fieldset> is a form group and brings borders of its own
    <div className="fy-hm-mermaid-steps" role="group" aria-label={label} tabIndex={0} onKeyDown={onKeys}>
      <div className="fy-hm-mermaid-stage">
        {steps.map((step, at) => (
          <MermaidStepFrame
            key={step.end}
            src={stepSource(body, step)}
            title={stepAlt(step, label)}
            shown={seen.has(at)}
            active={at === index}
          />
        ))}
      </div>
      <div className="anim-cap dh-cap" aria-live="polite">
        <span className="cw-num">{index + 1}</span>
        <span className="dh-step-title">
          {steps.map((step, at) => (
            <span
              key={step.end}
              aria-hidden={at === index ? undefined : true}
              className={at === index ? undefined : 'dh-step-hidden'}
            >
              {oneLine(step.title)}
            </span>
          ))}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: Durian's own control row (`ctl`), a group of buttons and a slider, not a form group */}
      <div className="ctl" role="group" aria-label="Step">
        <button type="button" className="btn" onClick={() => go(index - 1)} disabled={index <= 0}>
          ← Back
        </button>
        <div className="ctl-mid">
          <input
            type="range"
            className="ctl-range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-label="Step"
            aria-valuetext={`Step ${index + 1} / ${steps.length}`}
            onChange={event => go(Number(event.currentTarget.value))}
            style={{ ['--pct' as string]: `${(index / last) * 100}%` }}
          />
          <span className="ctl-count" aria-live="polite">
            {index + 1} / {steps.length}
          </span>
        </div>
        <button type="button" className="btn btn-go" onClick={() => go(index + 1)} disabled={index >= last}>
          Next →
        </button>
      </div>
    </div>
  );
}

/** One `mermaid` fence, drawn, and then the `:::llm` text the author wrote after it (decision C7: author text is never hidden). */
function MermaidPart({ block, data }: { readonly block: HostBlock; readonly data: HeldFenceData }): ReactNode {
  const text = authorTextBeside(block, data.generated);
  return (
    <>
      <div className="dh-mermaid" data-fy-mermaid="">
        {data.steps === undefined || data.steps.length < 2 ? (
          <MermaidDiagram src={data.body} title={block.attrs.title ?? ''} />
        ) : (
          <SteppedMermaid body={data.body} steps={data.steps} title={block.attrs.title ?? ''} />
        )}
      </div>
      {text === null ? null : <LlmOnlyText text={text} />}
    </>
  );
}

/** The renderer half of the `mermaid` host block: module-level and never rebuilt (Durian keys its settings on the array's identity). */
export const MERMAID_COMPONENT_BLOCK: BlockDef<
  HeldFenceData,
  ComponentType<{ block: HostBlock; data: HeldFenceData }>
> = { name: MERMAID_BLOCK_NAME, Component: MermaidPart };
