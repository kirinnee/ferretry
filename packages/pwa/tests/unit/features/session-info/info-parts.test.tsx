/** Info's shared row/section/chip/meter/note pieces: the vocabulary every tab is built from. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  InfoChip,
  InfoMeter,
  InfoNote,
  InfoRow,
  InfoSection,
} from '../../../../src/features/session-info/info-parts.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('InfoRow', () => {
  it('is a label and a value, with no copy button and no hint toggle when neither is given', async () => {
    mounted = await mount(<InfoRow label="Task">Fix the thing</InfoRow>);
    const root = mounted.container;
    expect(root.querySelector('[data-info-row="Task"]')).not.toBeNull();
    expect(root.textContent).toContain('Fix the thing');
    expect(root.querySelector('[data-info-hint-toggle]')).toBeNull();
    expect(root.querySelector('button[aria-label^="Copy"]')).toBeNull();
    expect(root.querySelector('[data-mono]')).toBeNull();
  });

  it('writes a mono value with a copy button that uses the writer it was handed', async () => {
    const written: string[] = [];
    mounted = await mount(
      <InfoRow copy="/work/app" label="Folder" mono write={async text => void written.push(text)}>
        /work/app
      </InfoRow>,
    );
    const root = mounted.container;
    expect(root.querySelector('dd')?.getAttribute('data-mono')).toBe('');
    const copy = must(root.querySelector<HTMLButtonElement>('button[aria-label="Copy Folder"]'), 'the copy button');
    await interact(() => copy.click());
    expect(written).toEqual(['/work/app']);
  });

  it('offers no copy button when only one of copy/write is given', async () => {
    mounted = await mount(
      <InfoRow copy="/work/app" label="Folder">
        /work/app
      </InfoRow>,
    );
    expect(mounted.container.querySelector('button[aria-label^="Copy"]')).toBeNull();
  });

  it('opens and closes its one-line explainer from the ? toggle', async () => {
    mounted = await mount(
      <InfoRow hint="Worktree: a separate checkout." label="Worktree">
        main
      </InfoRow>,
    );
    const root = mounted.container;
    const toggle = must(root.querySelector<HTMLButtonElement>('[data-info-hint-toggle]'), 'the hint toggle');
    expect(toggle.getAttribute('aria-label')).toBe('What is Worktree?');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[role="note"]')).toBeNull();

    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(must(root.querySelector('[role="note"]'), 'the hint').textContent).toBe('Worktree: a separate checkout.');

    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[role="note"]')).toBeNull();
  });
});

describe('InfoSection', () => {
  it('titles a run of rows, and renders untitled when none is given', async () => {
    mounted = await mount(
      <InfoSection title="Login quota · claude-default">
        <InfoRow label="State">At its limit</InfoRow>
      </InfoSection>,
    );
    expect(mounted.container.querySelector('h3')?.textContent).toBe('Login quota · claude-default');

    await mounted.unmount();
    mounted = await mount(
      <InfoSection>
        <InfoRow label="State">Fine</InfoRow>
      </InfoSection>,
    );
    expect(mounted.container.querySelector('h3')).toBeNull();
  });
});

describe('InfoChip', () => {
  it('defaults to a muted tone, and carries whichever tone it is given', async () => {
    mounted = await mount(<InfoChip>idle</InfoChip>);
    expect(mounted.container.querySelector('.fy-info-chip')?.getAttribute('data-tone')).toBe('muted');

    await mounted.unmount();
    mounted = await mount(<InfoChip tone="warn">uncommitted changes</InfoChip>);
    expect(mounted.container.querySelector('.fy-info-chip')?.getAttribute('data-tone')).toBe('warn');
  });
});

describe('InfoMeter', () => {
  it('clamps the percentage to 0–100 and says it as a meter', async () => {
    mounted = await mount(<InfoMeter label="Context used" percent={142} />);
    const meter = must(mounted.container.querySelector('[role="meter"]'), 'the meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(meter.getAttribute('aria-label')).toBe('Context used');
    expect(meter.getAttribute('data-high')).toBe('');
    expect(mounted.container.querySelector('strong')?.textContent).toBe('100%');

    await mounted.unmount();
    mounted = await mount(<InfoMeter label="5 hours quota used" percent={-12} />);
    const low = must(mounted.container.querySelector('[role="meter"]'), 'the meter');
    expect(low.getAttribute('aria-valuenow')).toBe('0');
    expect(low.getAttribute('data-high')).toBeNull();
  });
});

describe('InfoNote', () => {
  it('reads its children as a note', async () => {
    mounted = await mount(<InfoNote>Not reported yet</InfoNote>);
    expect(mounted.container.querySelector('p')?.textContent).toBe('Not reported yet');
  });
});
