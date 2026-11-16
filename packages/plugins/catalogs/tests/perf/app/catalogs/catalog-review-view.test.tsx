import { describe, expect, it } from 'bun:test';
import { mount } from '@ferretry/app/testing';
import { ReviewBody } from '../../../../app/features/catalogs/catalog-review-view.tsx';

// The speed half of `tests/unit/app/catalogs/catalog-review-view.test.tsx`: a 2 MiB file of zero-width spaces mounts
// closed, within a bound. The unit file proves what is on screen without a clock.
describe('large files and long runs', () => {
  const ZWSP = String.fromCodePoint(0x200b);

  it('shows a 2 MiB file of zero-width spaces closed within 3 s', async () => {
    const started = performance.now();
    const view = await mount(
      <ReviewBody entries={[{ label: 'Skill file SKILL.md', text: ZWSP.repeat(2 * 1024 * 1024), document: true }]} />,
    );
    expect(performance.now() - started).toBeLessThan(3000);
    await view.unmount();
  });
});
