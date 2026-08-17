import { afterEach, describe, expect, it } from 'bun:test';

import {
  FleetAccountForm,
  type FleetInstructionsControl,
  FleetLayerFields,
  FleetLayerForm,
  FleetProblems,
} from '../../../../src/features/fleet/fleet-change-forms.tsx';
import {
  emptyAccountDraft,
  emptyLayerDraft,
  type FleetAccountDraft,
  type FleetHarnessDetection,
  type FleetLayerDraft,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import { mount, type Mounted } from '../../../support/dom.ts';
import { absent, area, button, choose, click, field, form, pick, submit, type } from './fleet-support.ts';

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

const DETECTION_DETAIL = 'Detected codex at /usr/local/bin/codex.';

const INSTRUCTIONS_CHOICES: FleetInstructionsControl['choices'] = [
  {
    value: 'new-imported',
    label: 'New — instructions/codex-studio.md, imported',
    detail: 'Imported — /home/pilot/.codex/AGENTS.md (40 bytes).',
  },
  { value: 'new-blank', label: 'New — instructions/codex-studio.md, empty', detail: 'A new, empty document.' },
  { value: 'asset:instructions/house-rules.md', label: 'instructions/house-rules.md', detail: 'Already in the tree.' },
];

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

describe('the new account form', () => {
  const accountHarness = async (
    overrides: Partial<FleetAccountDraft> = {},
    problems: readonly string[] = [],
    loading = false,
    extra: {
      readonly detection?: FleetHarnessDetection;
      readonly instructions?: Partial<FleetInstructionsControl>;
    } = {},
  ) => {
    let current: FleetAccountDraft = { ...emptyAccountDraft('claude'), ...overrides };
    let submitted = 0;
    let cancelled = 0;
    let chosen: string | null = null;
    const detection: FleetHarnessDetection = extra.detection ?? {
      harness: 'codex',
      detail: DETECTION_DETAIL,
      noneInstalled: false,
    };
    const instructions: FleetInstructionsControl = {
      choices: INSTRUCTIONS_CHOICES,
      value: 'new-imported',
      onChoose: value => {
        chosen = value;
      },
      loading: false,
      ...extra.instructions,
    };
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
        disabled={loading}
        loading={loading}
        detection={detection}
        instructions={instructions}
        variants={['default', 'auto']}
      />
    );
    const mounted = tracked(await mount(element()));
    return {
      ...mounted,
      rerender: async () => await mounted.render(element()),
      latest: () => current,
      chosen: () => chosen,
      counts: () => ({ submitted, cancelled }),
    };
  };

  it('chooses a harness, names the account and shows the wrapper the daemon will derive', async () => {
    const harness = await accountHarness();
    expect(
      pick(harness.container, '[data-fleet-harness-choice="claude"]').getAttribute('data-fleet-harness-selected'),
    ).toBe('true');
    expect(harness.container.textContent).toContain('detected');
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

  it('stops shouting every field label, and keeps one hierarchy the eye can land in', async () => {
    // Arrange — HARNESS, PROVIDER ACCOUNT NAME, LANE, DISPLAY NAME, MODE, MODELS THIS ACCOUNT CAN SERVE,
    // DEFAULT MODEL, ASSET PATH, CONTENTS. Uppercase on all nine removed the hierarchy it exists to
    // create: everything shouted equally and nothing read as more important than anything else.
    const harness = await accountHarness();

    // Assert — no field label carries the eyebrow role any more.
    const labels = [...harness.container.querySelectorAll<HTMLElement>('label, fieldset > span')];
    expect(labels.length).toBeGreaterThan(6);
    for (const label of labels) expect(label.className).not.toContain('kt-label');
    // They carry the shared type scale instead: one step under a section heading, darker than prose.
    const named = labels.filter(label => label.textContent !== null && label.textContent.trim() !== '');
    for (const label of named) {
      if (label.className.includes('kt-tab')) continue; // the harness chips are controls, not labels
      expect(label.className).toContain('text-cell');
      expect(label.className).toContain('text-fg');
    }
    // A section heading still outranks them, and the prose beneath is still the quietest thing.
    expect(pick(harness.container, '[id$="-instructions"]').className).toContain('text-ui');
    expect(pick(harness.container, '[id$="-instructions"]').className).toContain('font-semibold');
    await harness.unmount();
  });

  it('says what was detected on this host, above every field the detection filled in', async () => {
    // Arrange — the sentence is the whole safety argument for prefilling anything: a person can see
    // WHICH harness was found and where, so they can tell a detection from a guess.
    const harness = await accountHarness();

    // Assert
    expect(pick(harness.container, '[data-fleet-harness-detection="detected"]').textContent).toContain(
      '/usr/local/bin/codex',
    );
    await harness.unmount();
  });

  it('warns, and does not block, when NO harness is installed on this host', async () => {
    // Arrange — the state this form used to hide completely. It is a warning rather than a refusal
    // because installing a harness minutes later is ordinary: `Preview this change` stays live.
    const harness = await accountHarness({}, [], false, {
      detection: { detail: 'Neither claude nor codex is on this host’s PATH.', noneInstalled: true },
    });

    // Assert
    const banner = pick(harness.container, '[data-fleet-harness-detection="none-installed"]');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Neither claude nor codex');
    expect(button(harness.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    // And NO harness is marked detected, because nothing was.
    expect(absent(harness.container, '[data-fleet-prefill="harness"]')).toBe(true);
    await harness.unmount();
  });

  it('shows where each prefilled value came from, and drops the note when the person types over it', async () => {
    // Arrange — provenance per field. RED before this: a prefilled box was indistinguishable from a
    // typed one, so a wrong prefill was worse than an empty field.
    const harness = await accountHarness({
      modelsText: 'claude-opus-5',
      defaultModel: 'claude-opus-5',
      prefilled: {
        models: 'Detected — read from /home/pilot/.claude/settings.json.',
        defaultModel: 'Detected — read from /home/pilot/.claude/settings.json.',
        instructionsText: 'Imported — /home/pilot/.claude/CLAUDE.md (86 bytes).',
      },
    });

    // Assert
    expect(pick(harness.container, '[data-fleet-prefill="models"]').textContent).toContain(
      '/home/pilot/.claude/settings.json',
    );
    expect(pick(harness.container, '[data-fleet-prefill="instructionsText"]').textContent).toContain('Imported');

    // Act — the note is keyed to the draft, so a draft that no longer claims a field says nothing about
    // it. This is what the surface's reconciliation produces after a keystroke.
    await harness.render(
      <FleetAccountForm
        draft={{ ...emptyAccountDraft('claude'), modelsText: 'mine', prefilled: {} }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
        problems={[]}
        disabled={false}
        loading={false}
        detection={{ harness: 'claude', detail: DETECTION_DETAIL, noneInstalled: false }}
        instructions={{ choices: INSTRUCTIONS_CHOICES, value: 'new-blank', onChoose: noop, loading: false }}
        variants={['default']}
      />,
    );

    // Assert
    expect(absent(harness.container, '[data-fleet-prefill="models"]')).toBe(true);
    await harness.unmount();
  });

  it('chooses which instructions document this account reads, and says what the choice means', async () => {
    // Arrange — the fleet can hold more than one instructions document, so an account picks rather than
    // types. The detail line belongs to the SELECTED option: three explanations in the list at once is
    // the clutter this panel was called out for.
    const harness = await accountHarness();
    const chooser = chooserOf(harness.container, '-instructions-choice');

    // Assert
    expect([...chooser.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'New — instructions/codex-studio.md, imported',
      'New — instructions/codex-studio.md, empty',
      'instructions/house-rules.md',
    ]);
    expect(pick(harness.container, '[data-fleet-instructions-detail]').textContent).toContain('AGENTS.md');

    // Act
    await choose(chooser, 'asset:instructions/house-rules.md');

    // Assert — the form reports the choice and changes nothing itself: reading the document is the
    // surface's job, because only the surface holds a client.
    expect(harness.chosen()).toBe('asset:instructions/house-rules.md');
    await harness.unmount();
  });

  it('says it is reading a chosen document rather than showing a stale explanation', async () => {
    // Arrange — between choosing an existing document and its text arriving, the contents box is empty.
    // Saying so is the difference between "still loading" and "that document is empty".
    const harness = await accountHarness({}, [], false, { instructions: { loading: true } });

    // Assert
    expect(pick(harness.container, '[data-fleet-instructions-detail]').textContent).toContain('Reading');
    await harness.unmount();
  });

  it('folds skills, settings and environment behind one disclosure on the create form only', async () => {
    // Arrange — the owner has twice called this panel too complicated. Three of the four layer concerns
    // are set AFTER an account exists, so creating one meets the part that must be filled in.
    const create = await accountHarness();

    // Assert — one fold, and everything inside it still in the document and still reachable.
    expect(pick(create.container, '[data-fleet-advanced]').tagName).toBe('DETAILS');
    expect(create.container.querySelectorAll('[data-fleet-advanced]')).toHaveLength(1);
    expect(field(create.container, '-skills-directory')).toBeDefined();
    expect(area(create.container, '-settings-text')).toBeDefined();
    // The instructions section stays OUTSIDE the fold: it is the one this whole change is about.
    expect(
      pick(create.container, '[data-fleet-advanced]').contains(field(create.container, '-instructions-path')),
    ).toBe(false);
    await create.unmount();

    // Act — the layer editor is the screen where those three ARE the point, so it keeps them inline.
    const layer = await layerHarness();

    // Assert
    expect(absent(layer.container, '[data-fleet-advanced]')).toBe(true);
    await layer.unmount();
  });

  it('says why it is inert while the asset listing is in flight', async () => {
    // F1: a new account writes asset text, so the form cannot judge a path until the daemon has said what
    // is already there. RED before this: every control was disabled with no text and no aria-busy, so on a
    // relayed connection the form read as broken rather than as loading.
    const waiting = await accountHarness({}, [], true);
    expect(pick(waiting.container, '[data-fleet-account-loading]').textContent).toContain(
      'Reading what is already in the asset tree',
    );
    expect(form(waiting.container, '[data-fleet-account-form]').getAttribute('aria-busy')).toBe('true');
    expect(field(waiting.container, '-account-name').hasAttribute('disabled')).toBe(true);
    expect(button(waiting.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await waiting.unmount();

    const ready = await accountHarness();
    expect(absent(ready.container, '[data-fleet-account-loading]')).toBe(true);
    expect(form(ready.container, '[data-fleet-account-form]').getAttribute('aria-busy')).toBe('false');
    expect(field(ready.container, '-account-name').hasAttribute('disabled')).toBe(false);
    await ready.unmount();
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

/** Local alias so the select helper reads the same as the input one at every call site. */
function chooserOf(container: HTMLElement, id: string): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>(`[id$="${id}"]`) as HTMLSelectElement;
}
