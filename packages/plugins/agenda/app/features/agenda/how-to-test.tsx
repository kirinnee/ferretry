/**
 * HOW TO TEST: the owner's checklist before the answer. A list is drawn as numbered steps (each keeps the number it
 * was written with), each with a box the owner ticks as they read (on this screen only: a tick is a reminder, never a
 * verdict); a heading or label between steps is drawn as a sub-heading above the steps it introduces; anything else
 * is drawn whole. The same markup as Board's card page, so one stylesheet draws both.
 */

import { type ReactNode, useState } from 'react';
import { testSteps } from '../../lib/test-steps.ts';

export function HowToTest({
  text,
  renderProse,
}: {
  readonly text: string;
  readonly renderProse: (text: string) => ReactNode;
}) {
  const parsed = testSteps(text);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  if (parsed === null) return <div className="fy-board-test">{renderProse(text)}</div>;
  const toggle = (step: number): void =>
    setTicked(current => {
      const next = new Set(current);
      if (!next.delete(step)) next.add(step);
      return next;
    });
  const { blocks } = parsed;
  const total = blocks.reduce((count, block) => count + (block.kind === 'steps' ? block.steps.length : 0), 0);
  let place = 0;
  return (
    <div className="fy-board-test" data-test-steps={total}>
      {parsed.lead === null ? null : <div className="fy-board-test__lead">{renderProse(parsed.lead)}</div>}
      {blocks.map((block, at) => {
        if (block.kind === 'section')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a block's place is its identity
            <div className="fy-board-test__section" data-test-section="" key={at}>
              {renderProse(block.text)}
            </div>
          );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a block's place is its identity
          <ol className="fy-board-test__list" key={at}>
            {block.steps.map(step => {
              const index = place++;
              return (
                <li className="fy-board-test__step" data-done={ticked.has(index) ? '' : undefined} key={index}>
                  <input
                    aria-label={`Step ${step.n} checked`}
                    checked={ticked.has(index)}
                    className="fy-attn-step__box"
                    data-test-tick={index}
                    onChange={() => toggle(index)}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="fy-board-test__n">
                    {step.n}
                  </span>
                  <div className="fy-board-test__text">{renderProse(step.text)}</div>
                </li>
              );
            })}
          </ol>
        );
      })}
    </div>
  );
}
