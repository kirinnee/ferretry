import { afterEach, describe, expect, it } from 'bun:test';
import { CleanUpJobCard, CleanUpReview } from '../../../../src/features/pack/clean-up-review.tsx';
import { type Mounted, mount } from '../../../support/dom.ts';
import { RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
import { alpha } from '../config-files/config-files-support.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

const idle = (): undefined => undefined;

describe('the clean-up job card', () => {
  it('says a read of the run failed and that it will try again, keeping the run on screen', async () => {
    // Act
    shown = await mount(
      <CleanUpJobCard
        connection={alpha}
        job={RUNNING_JOB}
        nowMs={Date.parse(RUNNING_JOB.startedAt)}
        readError="offline"
      />,
    );

    // Assert
    expect(shown.container.textContent).toContain('Could not read the clean-up just now (offline) — trying again.');
    expect(shown.container.querySelector('[data-clean-up-job="running"]') === null).toBe(false);
  });
});

describe('the clean-up review', () => {
  it('says so when the rewrite says exactly what was written', async () => {
    // Act
    shown = await mount(
      <CleanUpReview
        suggestion={{ ...SUGGESTION, after: SUGGESTION.before, notes: [] }}
        busy={false}
        onAccept={idle}
        onEdit={idle}
        onDiscard={idle}
      />,
    );

    // Assert
    expect(shown.container.querySelector('[data-clean-up-unchanged]')?.textContent).toBe(
      'The rewrite says exactly what you wrote.',
    );
  });
});
