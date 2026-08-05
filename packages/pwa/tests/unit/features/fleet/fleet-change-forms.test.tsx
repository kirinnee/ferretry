import { describe, expect, it } from 'bun:test';

import {
  FleetAccountForm,
  FleetLayerFields,
  FleetLayerForm,
  FleetProblems,
} from '../../../../src/features/fleet/fleet-change-forms.tsx';
import {
  emptyAccountDraft,
  emptyLayerDraft,
  type FleetAccountDraft,
  type FleetLayerDraft,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import { mount } from '../../../support/dom.ts';
import { area, button, choose, click, field, form, pick, submit, type } from './fleet-support.ts';

const noop = (): void => undefined;

/** Mounts the layer fields with a live draft, so a test can assert what a keystroke produced. */
const layerHarness = async (initial: FleetLayerDraft = emptyLayerDraft(), disabled = false) => {
  let current = initial;
  const mounted = await mount(
    <FleetLayerFields
      layer={current}
      onChange={next => {
        current = next;
      }}
      disabled={disabled}
    />,
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

  it('labels each section once, and scopes its ids so two copies can share a document', async () => {
    const mounted = await mount(
      <>
        <FleetLayerFields layer={emptyLayerDraft()} onChange={noop} disabled={false} />
        <FleetLayerFields layer={emptyLayerDraft()} onChange={noop} disabled={false} />
      </>,
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
    const mounted = await mount(<FleetProblems problems={[]} />);
    expect(mounted.container.textContent).toBe('');
    await mounted.unmount();
  });

  it('lists every problem it was given', async () => {
    const mounted = await mount(<FleetProblems problems={['first thing', 'second thing']} />);
    expect(pick(mounted.container, '[data-fleet-problems]').getAttribute('data-fleet-problems')).toBe('2');
    expect(mounted.container.textContent).toContain('second thing');
    await mounted.unmount();
  });
});

describe('the new account form', () => {
  const accountHarness = async (overrides: Partial<FleetAccountDraft> = {}, problems: readonly string[] = []) => {
    let current: FleetAccountDraft = { ...emptyAccountDraft('claude'), ...overrides };
    let submitted = 0;
    let cancelled = 0;
    const element = () => (
      <FleetAccountForm
        draft={current}
        onChange={next => {
          current = next;
        }}
        onSubmit={() => {
          submitted += 1;
        }}
        onCancel={() => {
          cancelled += 1;
        }}
        problems={problems}
        disabled={false}
        suggestion="codex"
        variants={['default', 'auto']}
      />
    );
    const mounted = await mount(element());
    return {
      ...mounted,
      rerender: async () => await mounted.render(element()),
      latest: () => current,
      counts: () => ({ submitted, cancelled }),
    };
  };

  it('chooses a harness, names the account and shows the wrapper the daemon will derive', async () => {
    const harness = await accountHarness();
    expect(
      pick(harness.container, '[data-fleet-harness-choice="claude"]').getAttribute('data-fleet-harness-selected'),
    ).toBe('true');
    expect(harness.container.textContent).toContain('suggested');
    // H1: the sr-only radio means this chip is the ONLY selection affordance a sighted person has, and
    // `.kt-tab` is defined after `@tailwind utilities`, so the treatment has to override it.
    const chosen = pick(harness.container, '[data-fleet-harness-selected="true"]');
    expect(chosen.className).toContain('!border-accent');
    expect(chosen.className).toContain('!bg-accent-soft');
    expect(chosen.className).toContain('!text-accent');
    expect(pick(harness.container, '[data-fleet-harness-selected="false"]').className).not.toContain('!border-accent');

    await click(pick(harness.container, '[data-fleet-harness-choice="codex"] input'));
    expect(harness.latest().harness).toBe('codex');
    await harness.rerender();

    await type(field(harness.container, '-account-name'), 'studio');
    await harness.rerender();
    await choose(chooserOf(harness.container, '-account-variant'), 'auto');
    await harness.rerender();
    expect(pick(harness.container, '[data-fleet-derived-wrapper]').textContent).toBe('codex-auto-studio');
    await harness.unmount();
  });

  it('carries the display name, the mode, the models and the default model', async () => {
    const harness = await accountHarness();
    await type(field(harness.container, '-account-display-name'), 'Studio Claude');
    await harness.rerender();
    await choose(chooserOf(harness.container, '-account-mode'), 'interactive');
    await harness.rerender();
    expect(harness.latest().mode).toBe('interactive');

    // With no models named there is nothing to default to, so the chooser stays shut.
    expect(chooserOf(harness.container, '-account-default-model').hasAttribute('disabled')).toBe(true);
    await type(area(harness.container, '-account-models'), 'opus, sonnet');
    await harness.rerender();
    const models = chooserOf(harness.container, '-account-default-model');
    expect([...models.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'Choose a model',
      'opus',
      'sonnet',
    ]);
    await choose(models, 'sonnet');
    expect(harness.latest().defaultModel).toBe('sonnet');
    expect(harness.latest().displayName).toBe('Studio Claude');
    await harness.unmount();
  });

  it('switches the mode back to auto when auto is chosen again', async () => {
    const harness = await accountHarness({ mode: 'interactive' });
    await choose(chooserOf(harness.container, '-account-mode'), 'auto');
    expect(harness.latest().mode).toBe('auto');
    await harness.unmount();
  });

  it('edits the layer through the same fields the layer editor uses', async () => {
    const harness = await accountHarness();
    await type(field(harness.container, '-instructions-path'), 'instructions/studio.md');
    expect(harness.latest().layer.instructions.path).toBe('instructions/studio.md');
    await harness.unmount();
  });

  it('previews on submit and discards on cancel, and refuses to preview an unresolved draft', async () => {
    const clean = await accountHarness();
    await submit(form(clean.container, '[data-fleet-account-form]'));
    expect(clean.counts().submitted).toBe(1);
    await click(button(clean.container, 'Discard draft'));
    expect(clean.counts().cancelled).toBe(1);
    await clean.unmount();

    const broken = await accountHarness({}, ['name the provider account this lane belongs to']);
    expect(button(broken.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await broken.unmount();
  });
});

describe('the layer form', () => {
  const layerFormHarness = async (problems: readonly string[] = [], loading = false) => {
    let submitted = 0;
    let cancelled = 0;
    const mounted = await mount(
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

/** Local alias so the select helper reads the same as the input one at every call site. */
function chooserOf(container: HTMLElement, id: string): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>(`[id$="${id}"]`) as HTMLSelectElement;
}
