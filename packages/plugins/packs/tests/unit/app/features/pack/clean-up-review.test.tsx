import { afterEach, describe, expect, it } from 'bun:test';
import { type Mounted, mount } from '../../../support/dom.ts';
import { RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
import { mockUi } from '../../../support/ui-doubles.tsx';

mockUi();
const { CleanUpJobCard, CleanUpReview } = await import('../../../../../app/features/pack/clean-up-review.tsx');

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
      <CleanUpJobCard job={RUNNING_JOB} nowMs={Date.parse(RUNNING_JOB.startedAt)} readError="offline" />,
    );

    // Assert
    expect(shown.container.textContent).toContain('Could not read the clean-up just now (offline) — trying again.');
    expect(shown.container.querySelector('[data-clean-up-job="running"]') === null).toBe(false);
  });
});

describe('the clean-up job card without a model', () => {
  it('names only the runtime when the run carries no model', async () => {
    // Arrange
    const { model: _model, ...withoutModel } = RUNNING_JOB;

    // Act
    shown = await mount(
      <CleanUpJobCard job={withoutModel} nowMs={Date.parse(RUNNING_JOB.startedAt)} readError={null} />,
    );

    // Assert
    const line = Array.from(shown.container.querySelectorAll('p')).find(p => p.textContent?.startsWith('On '));
    expect(line?.textContent).toBe('On codex-main · running for 0s');
    expect(shown.container.textContent).not.toContain('gpt-6-astra');
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
