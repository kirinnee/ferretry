import { afterEach, describe, expect, it } from 'bun:test';

import { FleetAccountStepper } from '../../../../src/features/fleet/fleet-account-stepper.tsx';
import {
  emptyAccountDraft,
  type FleetAccountDraft,
  type FleetHarnessDetection,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import {
  FLEET_STEP_IDS,
  type FleetInstructionsControl,
  type FleetInstructionsSource,
  type FleetStepId,
} from '../../../../src/features/fleet/fleet-stepper-model.ts';
import { type Mounted, mount } from '../../../support/dom.ts';
import { area, button, card, cardChosen, click, field, pick, type } from './fleet-support.ts';

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
    await mounted.unmount().catch(() => undefined);
  }
});

const DETECTION: FleetHarnessDetection = {
  harness: 'claude',
  detail: 'Detected claude at /usr/local/bin/claude.',
  noneInstalled: false,
};

/** Enough documents that a list stops being one a person reads and becomes one they search. */
const MANY = [
  'instructions/CLAUDE-alpha.md',
  'instructions/CLAUDE-beta.md',
  'instructions/CLAUDE-gamma.md',
  'instructions/CLAUDE-delta.md',
  'instructions/CLAUDE-epsilon.md',
  'instructions/CLAUDE-zeta.md',
  'instructions/CLAUDE-eta.md',
];

/**
 * The stepper on ONE step, with a live draft, so a test can assert what a keystroke produced.
 *
 * The step and the instructions answer are props rather than component state, so a test opens the
 * screen it is about directly instead of pressing Next four times to reach it.
 */
const stepper = async (options: {
  readonly step: FleetStepId;
  readonly draft?: Partial<FleetAccountDraft>;
  readonly source?: FleetInstructionsSource;
  readonly assets?: readonly string[];
  readonly loading?: boolean;
  readonly instructions?: Partial<FleetInstructionsControl>;
  /** What this fleet declares. Only a fleet with a slot no mode derives gets the group control. */
  readonly variants?: readonly string[];
}) => {
  let current: FleetAccountDraft = {
    ...emptyAccountDraft('claude'),
    name: 'atelier',
    modelsText: 'claude-opus-5',
    defaultModel: 'claude-opus-5',
    ...options.draft,
  };
  let chosen: string | null = null;
  const instructions: FleetInstructionsControl = {
    choices: [{ value: 'new-blank', label: 'New — empty', detail: 'A new, empty document.' }],
    value: 'new-blank',
    onChoose: value => {
      chosen = value;
    },
    loading: false,
    ...options.instructions,
  };
  const element = () => (
    <FleetAccountStepper
      draft={current}
      step={options.step}
      onStep={() => {}}
      onChange={next => {
        current = next;
      }}
      onSubmit={() => {}}
      onCancel={() => {}}
      disabled={false}
      loading={options.loading ?? false}
      detection={DETECTION}
      instructions={instructions}
      instructionsSource={options.source ?? 'new'}
      onInstructionsSource={() => {}}
      variants={options.variants ?? ['default']}
      config={null}
      discovery={null}
      published={[]}
      skillsStore={[]}
      storeDocuments={options.assets ?? []}
      assetBlockers={[]}
    />
  );
  const mounted = tracked(await mount(element()));
  return {
    ...mounted,
    rerender: async () => await mounted.render(element()),
    latest: () => current,
    chosen: () => chosen,
  };
};

describe('a long list of documents', () => {
  it('offers a filter instead of a long list, and says how much it is hiding', async () => {
    // "A dropdown of thirty things is a search problem wearing the wrong control." Below the threshold
    // the whole list is shown; above it, the list stays cards and gains a way to narrow them.
    const few = await stepper({ step: 'instructions', source: 'existing', assets: MANY.slice(0, 3) });
    expect(few.container.querySelector('[data-fleet-choice-filter="instructions"]')).toBeNull();
    await few.unmount();

    const many = await stepper({ step: 'instructions', source: 'existing', assets: MANY });
    const filter = pick(many.container, '[data-fleet-choice-filter="instructions"]') as HTMLInputElement;
    expect(filter).toBeDefined();
    expect(
      many.container.querySelectorAll('[data-fleet-choice-group="instructions"] [data-fleet-choice]'),
    ).toHaveLength(MANY.length);

    // Act
    await type(filter, 'beta');

    // Assert — narrowed, and the count says what is off screen rather than leaving a short list to be
    // read as the whole store.
    expect(
      many.container.querySelectorAll('[data-fleet-choice-group="instructions"] [data-fleet-choice]'),
    ).toHaveLength(1);
    expect(pick(many.container, '[data-fleet-choice-filtered="instructions"]').textContent).toContain('Showing 1 of 7');
    await many.unmount();
  });

  it('never filters out what is currently chosen', async () => {
    // A control that hid what it holds would render a group with nothing selected, which is a different
    // and false statement about the draft.
    const many = await stepper({
      step: 'instructions',
      source: 'existing',
      assets: MANY,
      draft: { layer: { ...emptyAccountDraft('claude').layer, instructions: { path: MANY[0] ?? '', text: '' } } },
    });
    await type(pick(many.container, '[data-fleet-choice-filter="instructions"]') as HTMLInputElement, 'zzzz');
    expect(
      pick(many.container, `[data-fleet-choice="${MANY[0] ?? ''}"]`).getAttribute('data-fleet-choice-selected'),
    ).toBe('true');
    expect(pick(many.container, '[data-fleet-choice-filtered="instructions"]').textContent).toContain('Showing 1 of 7');
    await many.unmount();
  });
});

describe('the instructions step', () => {
  it('edits the document text in place, because that is the point of offering it', async () => {
    const surface = await stepper({ step: 'instructions' });
    await type(area(surface.container, '-text'), '# my own rules\n');
    expect(surface.latest().layer.instructions.text).toBe('# my own rules\n');
    await surface.unmount();
  });

  it('says it is reading a chosen document rather than showing a stale explanation', async () => {
    const surface = await stepper({ step: 'instructions', instructions: { loading: true } });
    expect(pick(surface.container, '[data-fleet-instructions-reading]').textContent).toContain(
      'Reading that document’s current text',
    );
    await surface.unmount();
  });

  it('disables the store answer when the store is empty, and says why on the card', async () => {
    const surface = await stepper({ step: 'instructions', assets: [] });
    const existing = pick(surface.container, '[data-fleet-choice="existing"]');
    expect(existing.textContent).toContain('Nothing in the store yet');
    expect(existing.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('disables the import answer when this host has no document of its own', async () => {
    // Never invent one. A harness with nothing to copy says so rather than offering an empty import.
    const surface = await stepper({ step: 'instructions' });
    const importCard = pick(surface.container, '[data-fleet-choice="import"]');
    expect(importCard.textContent).toContain('no instructions document for this harness to copy');
    expect(importCard.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('points at a document when one is picked out of the store', async () => {
    const surface = await stepper({ step: 'instructions', source: 'existing', assets: MANY.slice(0, 2) });
    await click(pick(surface.container, `[data-fleet-choice="${MANY[1] ?? ''}"] input`));
    expect(surface.chosen()).toBe(`asset:${MANY[1] ?? ''}`);
    await surface.unmount();
  });
});

describe('the models step', () => {
  it('picks the default from cards rather than the last dropdown in the sequence', async () => {
    // RED: "Default model" was a native `<select>` sitting directly under the two tick-cards its two
    // entries came from — the owner's "the model list is pretty bad", surviving in the one control on
    // the step that still hid its options behind a tap.
    const surface = await stepper({
      step: 'models',
      draft: { modelsText: 'claude-opus-5\nclaude-sonnet-5', defaultModel: 'claude-opus-5' },
    });

    expect(surface.container.querySelector('[data-fleet-choice-group="default-model"] select')).toBeNull();
    expect(cardChosen(surface.container, 'default-model', 'claude-opus-5')).toBe(true);
    // The cards are the TICKED models and nothing else, so this control cannot name a model the
    // account does not serve.
    expect(
      surface.container.querySelectorAll('[data-fleet-choice-group="default-model"] [data-fleet-choice]'),
    ).toHaveLength(2);

    // Act
    await click(card(surface.container, 'default-model', 'claude-sonnet-5'));

    // Assert
    expect(surface.latest().defaultModel).toBe('claude-sonnet-5');
    await surface.unmount();
  });

  it('offers no default to choose from when nothing is ticked, and says what to do first', async () => {
    const surface = await stepper({ step: 'models', draft: { modelsText: '', defaultModel: '' } });
    expect(surface.container.querySelector('[data-fleet-choice-group="default-model"]')).toBeNull();
    expect(pick(surface.container, '[data-fleet-default-model-empty]').textContent).toContain('Tick a model above');
    await surface.unmount();
  });
});

describe('the identity step', () => {
  it('picks a fleet-declared group from cards, each naming the wrapper it would produce', async () => {
    // The last two `<select>`s in the sequence. They only appear for a fleet that declares a slot no
    // mode derives — which did not make them exempt from the complaint about dropdowns, and this is
    // also the only place a person meets the fleet's own slot names, so a bare identifier list would
    // have been the worst of both.
    const surface = await stepper({
      step: 'identity',
      variants: ['default', 'auto', 'review'],
      draft: { lanes: [{ mode: 'interactive', variant: 'default' }] },
    });

    expect(surface.container.querySelector('[data-fleet-other-lanes] select')).toBeNull();
    const group = pick(surface.container, '[data-fleet-choice-group="group-interactive"]');
    expect(group.textContent).toContain('Picked from how this account runs.');
    expect(group.textContent).toContain('Declared by this fleet.');
    expect(group.textContent).toContain('claude-review-atelier');

    // Act
    await click(card(surface.container, 'group-interactive', 'review'));

    // Assert
    expect(surface.latest().lanes).toEqual([{ mode: 'interactive', variant: 'review' }]);
    await surface.unmount();
  });

  it('offers no group control at all when every slot follows from how the account runs', async () => {
    const surface = await stepper({ step: 'identity', variants: ['default', 'auto'] });
    expect(surface.container.querySelector('[data-fleet-other-lanes]')).toBeNull();
    await surface.unmount();
  });
});

describe('the settings step', () => {
  it('adds an environment variable and edits both halves of it', async () => {
    // Environment is not settings and does not go through the two-answer control: it is a table, folded
    // away because almost nobody sets one while CREATING an account.
    const surface = await stepper({ step: 'settings' });
    expect(pick(surface.container, '[data-fleet-env-fold]').textContent).toContain('0 set');

    await click(button(surface.container, 'Add variable'));
    await surface.rerender();
    expect(surface.latest().layer.env).toHaveLength(1);

    await type(field(surface.container, '-env-name-0'), 'FY_EXAMPLE');
    await surface.rerender();
    await type(field(surface.container, '-env-value-0'), 'yes');
    expect(surface.latest().layer.env[0]).toMatchObject({ name: 'FY_EXAMPLE', value: 'yes' });
    await surface.unmount();
  });

  it('keeps two rows independent, so a second row does not edit the first', async () => {
    const surface = await stepper({
      step: 'settings',
      draft: {
        layer: {
          ...emptyAccountDraft('claude').layer,
          env: [
            { id: 'a', name: 'FIRST', value: '1' },
            { id: 'b', name: 'SECOND', value: '2' },
          ],
        },
      },
    });
    await type(field(surface.container, '-env-value-1'), 'changed');
    expect(surface.latest().layer.env).toEqual([
      { id: 'a', name: 'FIRST', value: '1' },
      { id: 'b', name: 'SECOND', value: 'changed' },
    ]);
    await surface.unmount();
  });
});

describe('the whole sequence', () => {
  it('says why it is inert while the asset listing is in flight', async () => {
    // A new account writes asset text, so the sequence cannot judge a path until the daemon has said
    // what is already there. Saying so is the difference between loading and broken.
    const waiting = await stepper({ step: 'harness', loading: true });
    expect(pick(waiting.container, '[data-fleet-account-loading]').textContent).toContain(
      'Reading what is already in the asset tree',
    );
    expect(pick(waiting.container, '[data-fleet-account-stepper]').getAttribute('aria-busy')).toBe('true');
    await waiting.unmount();
  });

  it('cannot go back from the first step, and asks for a preview only at the last', async () => {
    const first = await stepper({ step: 'harness' });
    expect(pick(first.container, '[data-fleet-step-back]').hasAttribute('disabled')).toBe(true);
    expect(button(first.container, 'Next')).toBeDefined();
    await first.unmount();

    const last = await stepper({ step: 'review' });
    expect(pick(last.container, '[data-fleet-step-back]').hasAttribute('disabled')).toBe(false);
    expect(button(last.container, 'Preview this change')).toBeDefined();
    await last.unmount();
  });

  it('names its position in the sequence for a screen reader, not only in colour', async () => {
    const surface = await stepper({ step: 'models' });
    expect(pick(surface.container, '[data-fleet-step-marker="models"]').getAttribute('aria-current')).toBe('step');
    // Earlier steps are buttons, because going back is always safe; later ones are not, because skipping
    // a question is what the sequence exists to prevent.
    expect(surface.container.querySelector('[data-fleet-step-jump="harness"]')).toBeDefined();
    expect(surface.container.querySelector('[data-fleet-step-jump="skills"]')).toBeNull();
    await surface.unmount();
  });

  it('does not shout the steps already behind you', async () => {
    // A completed step used to be `kt-btn`, and that class carries the theme's `--label-transform` —
    // so the strip read `✓ 1. HARNESS ✓ 2. ACCOUNT ✓ 3. MODELS 4. Instructions`, with the loudest
    // text on a progress indicator being what you had already finished.
    //
    // Asserted on the CLASS rather than on rendered casing, because the casing is applied by CSS this
    // renderer does not run and by a custom property whose value differs per theme — a text assertion
    // would pass in every theme that resolves it to `none`. The fix stays local for the same reason:
    // that one property drives buttons, badges, tabs and section labels, so the strip stops borrowing
    // the button role rather than switching the property off for all of them.
    const surface = await stepper({ step: 'models' });
    const jumped = pick(surface.container, '[data-fleet-step-jump="harness"]');
    const here = pick(surface.container, '[data-fleet-step-marker="models"]');
    expect(jumped.className).not.toContain('kt-btn');
    // Both markers paint from one class list, so the only difference a person sees is where they are.
    for (const shared of ['rounded-control', 'px-2', 'text-meta']) {
      expect(jumped.className).toContain(shared);
      expect(here.className).toContain(shared);
    }
    // The tap floor a `kt-btn--sm` used to supply is kept as the same pointer-derived token rather
    // than a hardcoded 44px, which would have cleared the floor by deleting the desktop density.
    expect(jumped.className).toContain('min-h-[var(--control-h-sm)]');
    await surface.unmount();
  });

  it('never says "lane" or "layer" on any step a person walks', async () => {
    // The two words the owner asked about, on the seven screens they would meet them. They are the
    // configuration schema's names for composition slots; the sequence asks "how does this account
    // run?" and derives both, so nothing on screen may reintroduce them — including the sentence
    // under the two cards that replaced the word, which used to end "this picks the lane and the
    // wrapper name for each".
    for (const step of FLEET_STEP_IDS) {
      const surface = await stepper({ step, variants: ['default', 'auto', 'review'] });
      const text = surface.container.textContent ?? '';
      expect(text.toLowerCase(), step).not.toContain('lane');
      expect(text.toLowerCase(), step).not.toContain('layer');
      await surface.unmount();
    }
  });

  it('recaps an account that has answered nothing without inventing values for it', async () => {
    const surface = await stepper({
      step: 'review',
      draft: { name: '', displayName: '', modelsText: '', defaultModel: '' },
    });
    const recap = pick(surface.container, '[data-fleet-recap]').textContent ?? '';
    expect(recap).toContain('—');
    expect(recap).toContain('none');
    await surface.unmount();
  });

  it('shows a display name a person gave rather than falling back to the account name', async () => {
    const surface = await stepper({ step: 'review', draft: { displayName: 'Atelier Claude' } });
    expect(pick(surface.container, '[data-fleet-recap]').textContent).toContain('Atelier Claude');
    await surface.unmount();
  });

  it('recaps an account that runs unattended in words rather than in an enum', async () => {
    const auto = await stepper({ step: 'review', draft: { lanes: [{ mode: 'auto', variant: 'auto' }] } });
    expect(pick(auto.container, '[data-fleet-recap]').textContent).toContain('Account (unattended)');
    await auto.unmount();

    const driven = await stepper({
      step: 'review',
      draft: { lanes: [{ mode: 'interactive', variant: 'default' }] },
    });
    expect(pick(driven.container, '[data-fleet-recap]').textContent).toContain('driven by a person');
    await driven.unmount();
  });

  it('recaps BOTH accounts by name when both modes are ticked, and names no lane', async () => {
    // A recap that said "2 accounts" would be the last place a person could still be surprised by
    // the second one, so both wrapper names are still here.
    //
    // What is GONE is "· lane default · home claude-atelier". The home IS the wrapper name — the row
    // printed the same string twice — and between the two copies sat a word the sequence spends
    // seven steps never teaching. On this fleet the variant is derived from the mode the label
    // already gives in words, so it added nothing but the vocabulary. The case where it is NOT
    // derived is the test below.
    const surface = await stepper({
      step: 'review',
      draft: {
        lanes: [
          { mode: 'interactive', variant: 'default' },
          { mode: 'auto', variant: 'auto' },
        ],
      },
    });

    const recap = pick(surface.container, '[data-fleet-recap]').textContent ?? '';
    expect(recap).toContain('claude-atelier');
    expect(recap).toContain('claude-auto-atelier');
    expect(recap).not.toContain('lane');
    expect(recap).not.toContain('group');
    await surface.unmount();
  });

  it('recaps the group when the fleet declares one no mode would derive', async () => {
    // The escape hatch is a CHOICE a person made two steps back, so dropping it from the recap would
    // be recapping a different change from the one that would be applied.
    const surface = await stepper({
      step: 'review',
      variants: ['default', 'auto', 'review'],
      draft: { lanes: [{ mode: 'interactive', variant: 'review' }] },
    });

    expect(pick(surface.container, '[data-fleet-recap]').textContent).toContain('group review');
    await surface.unmount();
  });

  it('says nothing would be created when no mode is ticked', async () => {
    const surface = await stepper({ step: 'review', draft: { lanes: [] } });
    expect(pick(surface.container, '[data-fleet-recap]').textContent).toContain('no mode chosen');
    await surface.unmount();
  });

  it('names both wrappers on the step that asks, and warns that they share one instructions document', async () => {
    // The step must say what it will do BEFORE somebody leaves it, and the one thing two accounts from
    // one pass cannot each have is their own instructions text — so that limit is said out loud.
    const both = {
      lanes: [
        { mode: 'interactive' as const, variant: 'default' },
        { mode: 'auto' as const, variant: 'auto' },
      ],
    };
    const identity = await stepper({ step: 'identity', draft: both });
    const wrappers = [...identity.container.querySelectorAll('[data-fleet-derived-wrapper]')].map(
      node => node.textContent,
    );
    expect(wrappers).toEqual(['claude-atelier', 'claude-auto-atelier']);
    await identity.unmount();

    const instructions = await stepper({ step: 'instructions', draft: both });
    expect(pick(instructions.container, '[data-fleet-shared-instructions]').textContent).toContain(
      'Both accounts read this one document',
    );
    await instructions.unmount();

    // One mode is one account, so neither the plural line nor the warning appears.
    const one = await stepper({ step: 'instructions', draft: { lanes: [{ mode: 'auto', variant: 'auto' }] } });
    expect(one.container.querySelector('[data-fleet-shared-instructions]')).toBeNull();
    await one.unmount();
  });
});
