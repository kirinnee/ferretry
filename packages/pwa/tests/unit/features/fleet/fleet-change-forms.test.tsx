import { afterEach, describe, expect, it } from 'bun:test';

import { FleetLayerFields, FleetLayerForm, FleetProblems } from '../../../../src/features/fleet/fleet-change-forms.tsx';
import { emptyLayerDraft, type FleetLayerDraft } from '../../../../src/features/fleet/fleet-change-model.ts';
import { type Mounted, mount } from '../../../support/dom.ts';
import { area, button, click, field, form, pick, submit, type } from './fleet-support.ts';

const noop = (): void => undefined;

/**
 * Every mount this file makes, unmounted whether or not its test got as far as saying so.
 *
 * A failing assertion skips the explicit `unmount()` at the end of a test, and the leaked root keeps
 * rendering into a live document — so the NEXT test fails too, and the real failure is buried under
 * consequences of it.
 */
const live: Mounted[] = [];
const tracked = <T extends Mounted>(mounted: T): T => {
  live.push(mounted);
  return mounted;
};

afterEach(async () => {
  for (const mounted of live.splice(0)) {
    // Already unmounted by a passing test is the ordinary case; a second unmount must not fail the run.
    await mounted.unmount().catch(() => undefined);
  }
});

/** Mounts the layer fields with a live draft, so a test can assert what a keystroke produced. */
const layerHarness = async (initial: FleetLayerDraft = emptyLayerDraft(), disabled = false) => {
  let current = initial;
  const mounted = tracked(
    await mount(
      <FleetLayerFields
        layer={current}
        onChange={next => {
          current = next;
        }}
        disabled={disabled}
      />,
    ),
  );
  const rerender = async (): Promise<void> => {
    await mounted.render(
      <FleetLayerFields
        layer={current}
        onChange={next => {
          current = next;
        }}
        disabled={disabled}
      />,
    );
  };
  return { ...mounted, rerender, latest: () => current };
};

describe('the layer fields', () => {
  it('edits the instructions path and its text', async () => {
    const harness = await layerHarness();
    await type(field(harness.container, '-instructions-path'), 'instructions/studio.md');
    expect(harness.latest().instructions.path).toBe('instructions/studio.md');
    await harness.rerender();
    await type(area(harness.container, '-instructions-text'), '# be careful');
    expect(harness.latest().instructions).toEqual({ path: 'instructions/studio.md', text: '# be careful' });
    await harness.unmount();
  });

  it('adds, edits and removes skill documents under a named directory', async () => {
    const harness = await layerHarness();
    await type(field(harness.container, '-skills-directory'), 'skills/studio');
    await harness.rerender();
    await click(button(harness.container, 'Add skill document'));
    await harness.rerender();
    expect(harness.latest().skills).toHaveLength(1);
    expect(harness.latest().skills[0]?.id).not.toBe('');

    await type(field(harness.container, '-skill-path-0'), 'skills/studio/review.md');
    await harness.rerender();
    await type(area(harness.container, '-skill-text-0'), 'Review carefully.');
    await harness.rerender();
    expect(harness.latest().skills[0]).toMatchObject({ path: 'skills/studio/review.md', text: 'Review carefully.' });

    await click(pick(harness.container, 'button[aria-label="Remove skill document 1"]'));
    expect(harness.latest().skills).toHaveLength(0);
    await harness.unmount();
  });

  it('keeps two skill rows independent, so a second row does not edit the first', async () => {
    const harness = await layerHarness({
      ...emptyLayerDraft(),
      skillsDirectory: 'skills/studio',
      skills: [
        { id: 'a', path: 'skills/studio/a.md', text: 'A' },
        { id: 'b', path: 'skills/studio/b.md', text: 'B' },
      ],
    });
    await type(area(harness.container, '-skill-text-1'), 'B edited');
    expect(harness.latest().skills.map(skill => skill.text)).toEqual(['A', 'B edited']);
    await harness.unmount();
  });

  it('edits inline settings as text, leaving the parsing to the model', async () => {
    const harness = await layerHarness();
    await type(area(harness.container, '-settings-text'), '{"model":"opus"}');
    expect(harness.latest().settingsText).toBe('{"model":"opus"}');
    await harness.unmount();
  });

  it('adds, edits and removes environment variables', async () => {
    const harness = await layerHarness();
    await click(button(harness.container, 'Add variable'));
    await harness.rerender();
    await type(field(harness.container, '-env-name-0'), 'FY_LANE');
    await harness.rerender();
    await type(field(harness.container, '-env-value-0'), 'studio');
    await harness.rerender();
    expect(harness.latest().env[0]).toMatchObject({ name: 'FY_LANE', value: 'studio' });

    await click(pick(harness.container, 'button[aria-label="Remove environment variable 1"]'));
    expect(harness.latest().env).toHaveLength(0);
    await harness.unmount();
  });

  it('names the fields it does not offer, and says they are carried through unchanged', async () => {
    const harness = await layerHarness({
      ...emptyLayerDraft(),
      preserved: { flags: ['--skip'], mcp: 'mcp/studio.json' },
    });
    expect(pick(harness.container, '[data-fleet-preserved]').getAttribute('data-fleet-preserved')).toBe('2');
    // The FIELD NAMES are named, not their values: a value is what the operator wrote on the host.
    expect(harness.container.textContent).toContain('This lane also declares flags, mcp');
    expect(harness.container.textContent).toContain('carried through this change exactly as they are');
    expect(harness.container.textContent).not.toContain('mcp/studio.json');
    await harness.unmount();
  });

  it('shows no preserved notice when the layer declares nothing else', async () => {
    const harness = await layerHarness();
    expect(harness.container.querySelector('[data-fleet-preserved]')).toBeNull();
    await harness.unmount();
  });

  it('keeps focus in the list when a row is removed, rather than dropping it to the document', async () => {
    const harness = await layerHarness({
      ...emptyLayerDraft(),
      skillsDirectory: 'skills/studio',
      skills: [{ id: 'a', path: 'skills/studio/a.md', text: 'A' }],
      env: [{ id: 'e', name: 'FY_LANE', value: 'studio' }],
    });

    // Removing a row unmounts the button that was clicked; without a landing place the browser drops
    // focus to <body> and a keyboard reader loses the form.
    await click(pick(harness.container, 'button[aria-label="Remove skill document 1"]'));
    await harness.rerender();
    expect(document.activeElement).toBe(button(harness.container, 'Add skill document'));
    expect(document.activeElement).not.toBe(document.body);

    await click(pick(harness.container, 'button[aria-label="Remove environment variable 1"]'));
    await harness.rerender();
    expect(document.activeElement).toBe(button(harness.container, 'Add variable'));
    await harness.unmount();
  });

  it('labels each section once, and scopes its ids so two copies can share a document', async () => {
    const mounted = tracked(
      await mount(
        <>
          <FleetLayerFields layer={emptyLayerDraft()} onChange={noop} disabled={false} />
          <FleetLayerFields layer={emptyLayerDraft()} onChange={noop} disabled={false} />
        </>,
      ),
    );
    // M6: every id unique across BOTH copies, so `<label for>` resolves within its own form.
    const ids = [...mounted.container.querySelectorAll('[id]')].map(node => node.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of mounted.container.querySelectorAll('label[for]')) {
      const target = mounted.container.querySelectorAll(`[id="${label.getAttribute('for')}"]`);
      expect(target).toHaveLength(1);
    }
    // M5: one heading per section, not a visible one plus an sr-only copy of the same words.
    const headings = [...mounted.container.querySelectorAll('h4')].map(node => node.textContent);
    expect(headings).toEqual([
      'Instructions',
      'Skills',
      'Settings',
      'Environment',
      'Instructions',
      'Skills',
      'Settings',
      'Environment',
    ]);
    expect(mounted.container.querySelectorAll('.sr-only')).toHaveLength(0);
    await mounted.unmount();
  });

  it('disables every control while a change is in flight', async () => {
    const harness = await layerHarness(
      {
        ...emptyLayerDraft(),
        skillsDirectory: 'skills/studio',
        skills: [{ id: 'a', path: 'skills/studio/a.md', text: 'A' }],
        env: [{ id: 'e', name: 'FY_LANE', value: 'studio' }],
      },
      true,
    );
    const controls = [...harness.container.querySelectorAll('input, textarea, button')];
    expect(controls.length).toBeGreaterThan(6);
    expect(controls.every(control => control.hasAttribute('disabled'))).toBe(true);
    await harness.unmount();
  });
});

describe('problems', () => {
  it('renders nothing at all when there are none', async () => {
    const mounted = tracked(await mount(<FleetProblems problems={[]} />));
    expect(mounted.container.textContent).toBe('');
    await mounted.unmount();
  });

  it('lists every problem it was given', async () => {
    const mounted = tracked(await mount(<FleetProblems problems={['first thing', 'second thing']} />));
    expect(pick(mounted.container, '[data-fleet-problems]').getAttribute('data-fleet-problems')).toBe('2');
    expect(mounted.container.textContent).toContain('second thing');
    await mounted.unmount();
  });
});

describe('the layer form', () => {
  const layerFormHarness = async (problems: readonly string[] = [], loading = false) => {
    let submitted = 0;
    let cancelled = 0;
    const mounted = tracked(
      await mount(
        <FleetLayerForm
          wrapper="claude-studio"
          layer={emptyLayerDraft()}
          onChange={noop}
          onSubmit={() => {
            submitted += 1;
          }}
          onCancel={() => {
            cancelled += 1;
          }}
          problems={problems}
          disabled={loading}
          loading={loading}
        />,
      ),
    );
    return { ...mounted, counts: () => ({ submitted, cancelled }) };
  };

  it('names the exact wrapper whose layer is being edited', async () => {
    const harness = await layerFormHarness();
    expect(pick(harness.container, '[data-fleet-layer-form]').getAttribute('data-fleet-layer-form')).toBe(
      'claude-studio',
    );
    expect(harness.container.textContent).toContain('cannot leak onto another lane');
    await harness.unmount();
  });

  it('says it is still reading the assets, and will not stage until it has', async () => {
    const harness = await layerFormHarness(['"skills/a.md" could not be read'], true);
    expect(pick(harness.container, '[data-fleet-layer-loading]')).toBeDefined();
    // The same truth in the attribute assistive technology reads, on both forms.
    expect(form(harness.container, '[data-fleet-layer-form]').getAttribute('aria-busy')).toBe('true');
    expect(button(harness.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    expect(harness.container.textContent).toContain('could not be read');
    await harness.unmount();
  });

  it('previews and discards', async () => {
    const harness = await layerFormHarness();
    await submit(form(harness.container, '[data-fleet-layer-form]'));
    await click(button(harness.container, 'Discard draft'));
    expect(harness.counts()).toEqual({ submitted: 1, cancelled: 1 });
    await harness.unmount();
  });
});
