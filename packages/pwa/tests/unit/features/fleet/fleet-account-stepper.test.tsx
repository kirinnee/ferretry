import { afterEach, describe, expect, it } from 'bun:test';

import { FleetAccountStepper } from '../../../../src/features/fleet/fleet-account-stepper.tsx';
import type { FleetConfigView, FleetProfileCatalog } from '../../../../src/features/fleet/fleet-api.ts';
import {
  detectedAccountDraft,
  emptyAccountDraft,
  type FleetAccountDraft,
  type FleetHarnessDetection,
  reconcileAccountDraft,
} from '../../../../src/features/fleet/fleet-change-model.ts';
import {
  FLEET_STEP_IDS,
  type FleetInstructionsControl,
  type FleetPickOrAddSource,
  type FleetSkillsStoreItem,
  type FleetStepId,
  SKILL_DOCUMENT,
  SKILLS_PREFIX,
} from '../../../../src/features/fleet/fleet-stepper-model.ts';
import { type Mounted, mount } from '../../../support/dom.ts';
import {
  area,
  button,
  card,
  cardChosen,
  click,
  config,
  discovery,
  field,
  pick,
  profileCatalog,
  type,
} from './fleet-support.ts';

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

/**
 * One row of a profile being written, with the credential answer already given.
 *
 * `id` is a DOM identity rather than fleet data — two empty rows keyed by their contents would be one
 * row — so it is fixed here and asserted to survive every edit.
 */
const WRITTEN_ROW = { id: 'row-one', from: 'secret' as const, variable: 'ANTHROPIC_API_KEY', detail: 'WORK_KEY' };

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
  readonly source?: FleetPickOrAddSource;
  readonly assets?: readonly string[];
  readonly loading?: boolean;
  readonly instructions?: Partial<FleetInstructionsControl>;
  /** What this fleet declares. Only a fleet with a slot no mode derives gets the group control. */
  readonly variants?: readonly string[];
  /**
   * The declared configuration, which is where the accounts a new member could sign in as come from.
   *
   * `null` by default, so a suite that is about some other step gets the first-account shape: no picker
   * at all, one name box, exactly as a fleet with nothing in it renders.
   */
  readonly config?: FleetConfigView | null;
  /** What the fleet's skills store already holds. Empty by default, which is the first-account shape. */
  readonly skillsStore?: readonly FleetSkillsStoreItem[];
  /** Which answer the account step is on. Held by the surface in production, a prop here. */
  readonly accountSource?: FleetPickOrAddSource;
  /**
   * The profiles this fleet declares. `null` by default, which is the state before the read lands —
   * and the state most of these cases want, because the sign-in step is not what they are about.
   */
  readonly profiles?: FleetProfileCatalog | null;
  readonly onNavigate?: (to: string) => void;
}) => {
  let current: FleetAccountDraft = {
    ...emptyAccountDraft('claude'),
    name: 'atelier',
    modelsText: 'claude-opus-5',
    defaultModel: 'claude-opus-5',
    ...options.draft,
  };
  let chosen: string | null = null;
  let accountSource: FleetPickOrAddSource = options.accountSource ?? 'existing';
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
      accountSource={accountSource}
      onAccountSource={next => {
        accountSource = next;
        if (next === 'new') current = { ...current, name: '' };
      }}
      accountsHref="/d/9f1c/accounts"
      {...(options.onNavigate === undefined ? {} : { onNavigate: options.onNavigate })}
      variants={options.variants ?? ['default']}
      config={options.config ?? null}
      discovery={null}
      published={[]}
      skillsStore={options.skillsStore ?? []}
      storeDocuments={options.assets ?? []}
      assetBlockers={[]}
      profiles={options.profiles ?? null}
    />
  );
  const mounted = tracked(await mount(element()));
  return {
    ...mounted,
    rerender: async () => await mounted.render(element()),
    latest: () => current,
    chosen: () => chosen,
    source: () => accountSource,
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

  it('says on the mode card which wrapper the picked login already has in that slot', async () => {
    // RED: this used to be a refusal at the END — walk four screens, then read that the daemon will not
    // take it. The collision is knowable the moment a login is picked, so the card that would cause it
    // says so on itself.
    //
    // `config()` declares `studio` with a `default` route held by `claude-studio`, and the draft opens
    // ticked on `auto` in that same `default` slot.
    const surface = await stepper({
      step: 'identity',
      draft: { name: 'studio' },
      config: config(),
      accountSource: 'existing',
    });

    const auto = pick(surface.container, '[data-fleet-check-group="mode"] [data-fleet-check="auto"]');
    const interactive = pick(surface.container, '[data-fleet-check-group="mode"] [data-fleet-check="interactive"]');
    // The occupant is NAMED, on both cards — the ticked one reads its own lane's slot, the unticked one
    // reads the slot its mode would derive. Two different reads of `slotFor`, one sentence each.
    expect(auto.textContent).toContain('already added');
    expect(auto.textContent).toContain('This account already has one: claude-studio.');
    expect(interactive.textContent).toContain('This account already has one: claude-studio.');

    // NOT DISABLED WHILE TICKED. Disabling the ticked card would leave somebody unable to untick their
    // way out of a blocker they can read — the unticked one is the only one held shut.
    expect(auto.querySelector('input')?.hasAttribute('disabled')).toBe(false);
    expect(interactive.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('badges no mode when the picked login holds no slot this account would land in', async () => {
    // The other side of the same read: a fleet whose only login is a different one says nothing, so the
    // badge cannot become decoration that is always there.
    const surface = await stepper({
      step: 'identity',
      draft: { name: 'atelier' },
      config: config(),
      accountSource: 'existing',
    });
    expect(pick(surface.container, '[data-fleet-check-group="mode"]').textContent).not.toContain('already added');
    expect(card(surface.container, 'mode', 'interactive').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });
});

describe('the skills step', () => {
  const stored = (path: string): FleetSkillsStoreItem => ({ path, accounts: [] });

  it('writes a skill here rather than sending somebody to the asset tree to make one first', async () => {
    // RED: the step used to offer ONLY what the store already held, so the first account in a fresh
    // fleet met an empty list and a dead end. A skill is named here, seeded with its own SKILL.md, and
    // written into the store by the same reviewed apply — which is what makes it tickable next time.
    const surface = await stepper({ step: 'skills' });
    expect(pick(surface.container, '[data-fleet-check-empty="skills"]').textContent).toContain(
      'Write the first one below',
    );

    // The prefix is RENDERED, not typed: what is read is the whole path, what is edited is the part
    // that is theirs.
    expect(pick(surface.container, '[data-fleet-skill-prefix]').textContent).toBe(SKILLS_PREFIX);
    await type(pick(surface.container, '[data-fleet-new-skill]') as HTMLInputElement, 'review');
    expect(pick(surface.container, '[data-fleet-new-skill-note]').textContent).toContain(
      `${SKILLS_PREFIX}review/${SKILL_DOCUMENT} will be added to the store.`,
    );

    // Act
    await click(pick(surface.container, '[data-fleet-add-skill]'));

    // Assert — the draft carries the directory AND the first document in it, path derived.
    expect(surface.latest().layer.skillsDirectory).toBe(`${SKILLS_PREFIX}review`);
    expect(surface.latest().layer.skills).toMatchObject([
      { path: `${SKILLS_PREFIX}review/${SKILL_DOCUMENT}`, text: '' },
    ]);

    await surface.rerender();
    // It is offered as a CARD, ticked, badged as new — one list rather than a list plus a hidden extra,
    // and unticking it is the way back to an account with no skills at all.
    const written = pick(surface.container, `[data-fleet-check="${SKILLS_PREFIX}review"]`);
    expect(written.textContent).toContain('new');
    expect(cardChosen(surface.container, 'skills', `${SKILLS_PREFIX}review`)).toBe(true);
    // The box empties, so the control is ready for the next answer rather than holding a stale one.
    expect((pick(surface.container, '[data-fleet-new-skill]') as HTMLInputElement).value).toBe('');

    // And the contents are edited here, against the path that was derived.
    const contents = pick(surface.container, `[data-fleet-authored-skill="${SKILLS_PREFIX}review/${SKILL_DOCUMENT}"]`);
    expect(contents.textContent).toContain('on the next apply');
    await type(area(surface.container, '-skill-text'), '# review\n');
    expect(surface.latest().layer.skills[0]?.text).toBe('# review\n');
    await surface.unmount();
  });

  it('shows no contents box until there is a document to put contents in', async () => {
    const surface = await stepper({ step: 'skills', skillsStore: [stored('skills/studio')] });
    expect(surface.container.querySelector('[data-fleet-authored-skill]')).toBeNull();
    // A picked skill is a REFERENCE — the store already holds its documents and this change writes none
    // of them — so ticking one must not open an editor over somebody else's file.
    await click(card(surface.container, 'skills', 'skills/studio'));
    await surface.rerender();
    expect(surface.container.querySelector('[data-fleet-authored-skill]')).toBeNull();
    await surface.unmount();
  });

  it('holds Add shut on a name the store already has, and says which control links it instead', async () => {
    const surface = await stepper({ step: 'skills', skillsStore: [stored('skills/studio')] });
    await type(pick(surface.container, '[data-fleet-new-skill]') as HTMLInputElement, 'studio');

    expect(pick(surface.container, '[data-fleet-new-skill-note]').textContent).toContain(
      'is already in the store — tick it above to link it',
    );
    expect((pick(surface.container, '[data-fleet-add-skill]') as HTMLButtonElement).hasAttribute('disabled')).toBe(
      true,
    );

    // Nothing reached the draft: the refusal is a REDIRECT to the card above, not a half-written skill.
    expect(surface.latest().layer.skillsDirectory).toBe('');
    expect(surface.latest().layer.skills).toEqual([]);
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
    //
    // THE DRAFT CARRIES ITS PREFILL NOTES, and that is the whole reason this loop is not enough on
    // its own. The first version mounted a bare draft, whose `prefilled` is empty — so every
    // provenance note went unrendered, and `DERIVED_PATH_NOTE` kept saying "from the account and
    // lane above" through a green suite until somebody opened the screen. The notes are built by the
    // production functions the surface itself calls, not written out here, so a note added tomorrow
    // is covered by this walk rather than by a fixture somebody forgot to extend.
    const detected = detectedAccountDraft(DETECTION, discovery());
    const named = reconcileAccountDraft(detected, { ...detected, name: 'atelier' }, discovery());
    expect(Object.keys(named.prefilled).length).toBeGreaterThan(0);

    for (const step of FLEET_STEP_IDS) {
      const surface = await stepper({ step, variants: ['default', 'auto', 'review'], draft: named });
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

/**
 * The credential step, which is where "no login wanted" becomes an answer somebody can give.
 *
 * THE HARD LINE: a profile's VALUE is never on this screen. Everything asserted below is a NAME or a
 * shape, and the note the step itself carries says so out loud. `docs/secrets.md` is the contract.
 */
describe('the credential step', () => {
  /** The step on the profile answer, which is the half none of the cases above reach. */
  const onProfile = async (
    options: {
      readonly draft?: Partial<FleetAccountDraft>;
      readonly profiles?: FleetProfileCatalog | null;
      readonly config?: FleetConfigView | null;
    } = {},
  ) =>
    await stepper({
      step: 'credential',
      profiles: options.profiles === undefined ? profileCatalog() : options.profiles,
      ...(options.config === undefined ? {} : { config: options.config }),
      draft: { credential: 'profile', ...options.draft },
    });

  it('offers the two answers, and says signing in happens once for the whole login', async () => {
    // Arrange
    const screen = await stepper({ step: 'credential', profiles: profileCatalog() });

    // Assert — the login half names where it happens, because it is not on this screen.
    expect(cardChosen(screen.container, 'credential', 'login')).toBe(true);
    expect(pick(screen.container, '[data-fleet-credential-login]').textContent).toContain('Accounts screen');
    await screen.unmount();
  });

  it('tells somebody what a login already uses before they change it, on either answer', async () => {
    // Arrange — profiles belong to a provider LOGIN, so what is ticked here reaches every account on
    // it. `claude-studio` is the wrapper the fixture's `studio` login publishes, and `work` is the
    // profile that login already composes.
    const login = await stepper({
      step: 'credential',
      profiles: profileCatalog(),
      config: config(),
      draft: { name: 'studio' },
    });

    // Assert — on the login answer it is a reason to leave the answer alone.
    expect(pick(login.container, '[data-fleet-credential-login]').textContent).toContain('already uses work');
    await login.unmount();

    // Act — and on the profile answer it is a warning about reach, before any tick.
    const profiled = await onProfile({ draft: { name: 'studio' }, config: config() });

    // Assert
    const bound = pick(profiled.container, '[data-fleet-profiles-bound="1"]');
    expect(bound.textContent).toContain('“studio” already uses work');
    expect(bound.textContent).toContain('Profiles belong to the login rather than to one account');
    await profiled.unmount();
  });

  it('says nothing about reach for a login that does not exist yet', async () => {
    // Arrange
    const screen = await onProfile({ draft: { name: 'brand-new' }, config: config() });

    // Assert
    expect(screen.container.querySelector('[data-fleet-profiles-bound]')).toBeNull();
    await screen.unmount();
  });

  it('says what each profile sets and what else it reaches, and never what it holds', async () => {
    // Arrange
    const screen = await onProfile();

    // Assert — the card names the SECRET, which is what somebody has to see to fix an account reaching
    // for one nobody set. `base` is not offered: it is composed by every account, so a tick box for it
    // could not be unticked and would be a control that lies about what it does.
    const work = pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check="work"]');
    expect(work.textContent).toContain('Sets ANTHROPIC_API_KEY.');
    expect(work.textContent).toContain('Also used by claude-studio — editing it reaches them too.');
    expect(work.textContent).toContain('no login needed');
    const gateway = pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check="gateway"]');
    expect(gateway.textContent).toContain('Nothing uses it yet.');
    // The badge is per HARNESS: `gateway` sets no credential for anybody, so it makes no such promise.
    expect(gateway.textContent).not.toContain('no login needed');
    expect(screen.container.querySelector('[data-fleet-check-group="profiles"] [data-fleet-check="base"]')).toBeNull();
    await screen.unmount();
  });

  it('does not promise "no login needed" for a profile that authenticates the OTHER harness', async () => {
    // Arrange — `work` sets `ANTHROPIC_API_KEY` flatly, which IS a Claude credential variable, and the
    // fixture's catalog says it authenticates Claude and nothing else. A Codex account bound to it
    // still needs its sign-in, and a badge saying otherwise sends somebody to an account that cannot
    // start. The badge therefore reads the HOST's `authenticates` verdict rather than re-deciding it
    // here from the variable names, which is the reading that would have got this wrong.
    const screen = await onProfile({ draft: { harness: 'codex' } });

    // Assert — the variables are still listed, both the flat one and this harness's own overlay.
    const work = pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check="work"]');
    expect(work.textContent).not.toContain('no login needed');
    expect(work.textContent).toContain('Sets ANTHROPIC_API_KEY, HTTPS_PROXY.');
    await screen.unmount();
  });

  it('says a profile sets nothing for this harness rather than showing an empty list', async () => {
    // Arrange
    const screen = await onProfile({
      draft: { harness: 'codex' },
      profiles: profileCatalog({
        profiles: [
          {
            name: 'claude-only',
            appliesToEveryAccount: false,
            variables: [
              { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] }, harness: 'claude' },
            ],
            accounts: [],
            authenticates: ['claude'],
          },
        ],
      }),
    });

    // Assert
    expect(
      pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check="claude-only"]').textContent,
    ).toContain('Sets nothing for this harness.');
    await screen.unmount();
  });

  it('invites the first profile to be written when this fleet declares none', async () => {
    // Arrange — an empty catalog is an ordinary fleet, not a broken one.
    const screen = await onProfile({ profiles: profileCatalog({ profiles: [] }) });

    // Assert
    expect(pick(screen.container, '[data-fleet-check-empty="profiles"]').textContent).toContain(
      'This fleet declares no profiles yet',
    );
    await screen.unmount();
  });

  it('appends a ticked profile to the order, because the order is the precedence', async () => {
    // Arrange
    const screen = await onProfile({ draft: { profiles: ['gateway'] } });

    // Act
    await click(card(screen.container, 'profiles', 'work'));

    // Assert — appended rather than inserted: a newly ticked profile beats the ones already there,
    // which is what somebody ticking it is asking for.
    expect(screen.latest().profiles).toEqual(['gateway', 'work']);
    await screen.unmount();
  });

  it('shows which value wins, in the daemon’s own words, before the round trip', async () => {
    // Arrange — `base` sets the URL and `work` sets it again, so one variable is contested.
    const screen = await onProfile({
      draft: { profiles: ['work'] },
      profiles: profileCatalog({
        profiles: [
          {
            name: 'base',
            appliesToEveryAccount: true,
            variables: [{ variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } }],
            accounts: [],
            authenticates: [],
          },
          {
            name: 'work',
            appliesToEveryAccount: false,
            variables: [
              { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] } },
              { variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } },
            ],
            accounts: [],
            authenticates: ['claude'],
          },
        ],
      }),
    });

    // Assert — the shape is described and the origin named; a contested variable says what it beat.
    expect(pick(screen.container, '[data-fleet-composed-env="2"]')).toBeDefined();
    const key = pick(screen.container, '[data-fleet-composed-variable="ANTHROPIC_API_KEY"]');
    expect(key.textContent).toContain('from this daemon’s secret store — secret WORK_KEY');
    expect(key.textContent).toContain('set by the profile “work”');
    const url = pick(screen.container, '[data-fleet-composed-variable="ANTHROPIC_BASE_URL"]');
    expect(url.textContent).toContain('overriding the base profile');
    await screen.unmount();
  });

  it('says out loud that nothing on this screen can show a value', async () => {
    // Arrange — the note is not decoration. It is the sentence that stops somebody hunting for a
    // control that shows the key, because there is no route in this product that answers one.
    const screen = await onProfile({ draft: { profiles: ['work'] } });

    // Assert
    const note = pick(screen.container, '[data-fleet-composed-note]').textContent ?? '';
    expect(note).toContain('Nothing on this screen can show you a value');
    expect(note).toContain('reaches only the account’s own session');
    await screen.unmount();
  });

  it('shows no order at all when nothing is composed yet', async () => {
    // Arrange
    const screen = await onProfile({ profiles: profileCatalog({ profiles: [] }) });

    // Assert
    expect(screen.container.querySelector('[data-fleet-composed-env]')).toBeNull();
    await screen.unmount();
  });
});

describe('writing a new profile', () => {
  const writing = async (draft: Partial<FleetAccountDraft> = {}) =>
    await stepper({
      step: 'credential',
      profiles: profileCatalog(),
      draft: { credential: 'profile', ...draft },
    });

  it('seeds the first row with the credential variable the HOST named for this harness', async () => {
    // Arrange — `credentialVariables` travelling, rather than a name this browser knows. A browser that
    // hard-coded ANTHROPIC_API_KEY would seed a form whose result the host does not call a credential.
    const screen = await writing();

    // Act
    await click(pick(screen.container, '[data-fleet-add-profile]'));

    // Assert
    expect(screen.latest().newProfile?.variables[0]).toMatchObject({ from: 'secret', variable: 'ANTHROPIC_API_KEY' });
    await screen.unmount();
  });

  it('offers the three spellings the daemon accepts and nothing else', async () => {
    // Arrange — a free text box could carry `${secret:work_key}`, a near miss the grammar does not
    // match: it would stay a literal and authenticate the harness with the reference itself.
    const screen = await writing({ newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Assert
    const group = pick(screen.container, '[data-fleet-choice-group="profile-source-0"]');
    expect(
      [...group.querySelectorAll('[data-fleet-choice]')].map(node => node.getAttribute('data-fleet-choice')),
    ).toEqual(['secret', 'environment', 'value']);
    expect(group.textContent).toContain('Secret in this daemon’s store');
    expect(group.textContent).toContain('The value never reaches this browser or the fleet file');
    // And the plain answer carries its consequence on the control rather than in a document.
    expect(group.textContent).toContain('Written into the fleet configuration as text');
    expect(group.textContent).toContain('Never a credential');
    await screen.unmount();
  });

  it('names the box after the answer, because one field carries three meanings', async () => {
    // Arrange
    const screen = await writing({ newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Act
    await click(card(screen.container, 'profile-source-0', 'value'));

    // Assert — the answer changed and the detail somebody already typed is kept, because switching
    // answers mid-thought should not lose it.
    expect(screen.latest().newProfile?.variables[0]).toMatchObject({ from: 'value', detail: 'WORK_KEY' });
    await screen.unmount();
  });

  it('edits the name and the rows in place, keeping each row’s identity', async () => {
    // Arrange
    const screen = await writing({ newProfile: { name: '', variables: [WRITTEN_ROW] } });

    // Act — re-rendered between keystrokes, because each edit is computed from the draft on screen and
    // three edits against one stale render would only prove the last one.
    await type(field(screen.container, '-profile-name'), 'mine');
    await screen.rerender();
    await type(pick(screen.container, '[data-fleet-profile-variable="0"]') as HTMLInputElement, 'ANTHROPIC_AUTH_TOKEN');
    await screen.rerender();
    await type(pick(screen.container, '[data-fleet-profile-detail="0"]') as HTMLInputElement, 'OTHER_KEY');

    // Assert — the id is a DOM identity rather than fleet data, so it survives every edit.
    expect(screen.latest().newProfile).toEqual({
      name: 'mine',
      variables: [{ id: WRITTEN_ROW.id, from: 'secret', variable: 'ANTHROPIC_AUTH_TOKEN', detail: 'OTHER_KEY' }],
    });
    await screen.unmount();
  });

  it('offers no way to remove the only row, because a profile with none is not a state', async () => {
    // Arrange
    const one = await writing({ newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Assert
    expect(one.container.querySelector('[data-fleet-remove-profile-variable]')).toBeNull();
    await one.unmount();

    // Act — a second row makes both removable.
    const two = await writing({
      newProfile: { name: 'mine', variables: [WRITTEN_ROW, { ...WRITTEN_ROW, id: 'row-two' }] },
    });
    await click(pick(two.container, '[data-fleet-remove-profile-variable="1"]'));

    // Assert
    expect(two.latest().newProfile?.variables.map(row => row.id)).toEqual([WRITTEN_ROW.id]);
    await two.unmount();
  });

  it('adds another row as a plain value, because the credential is the row already there', async () => {
    // Arrange
    const screen = await writing({ newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Act
    await click(pick(screen.container, '[data-fleet-add-profile-variable]'));

    // Assert
    expect(screen.latest().newProfile?.variables[1]).toMatchObject({ from: 'value', variable: '', detail: '' });
    await screen.unmount();
  });

  it('abandons the writing when it is discarded, and leaves the ticks alone', async () => {
    // Arrange
    const screen = await writing({ profiles: ['work'], newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Act
    await click(pick(screen.container, '[data-fleet-discard-profile]'));

    // Assert
    expect(screen.latest().newProfile).toBeUndefined();
    expect(screen.latest().profiles).toEqual(['work']);
    await screen.unmount();
  });

  it('shows the problems inside the form, where they are the only place they can be acted on', async () => {
    // Arrange — somebody scrolled into this form should not have to find them below it. The name is
    // `base`, which this fleet declares and which the tick list deliberately does NOT offer: the
    // collision is read against every DECLARED profile rather than against the ones on offer, so a
    // reader narrowing that list to `profileChoices` would let somebody declare a second `base`.
    const screen = await writing({ newProfile: { name: 'base', variables: [{ ...WRITTEN_ROW, detail: 'work_key' }] } });

    // Assert — and the secret's shape is refused here rather than at the daemon.
    const problems = pick(screen.container, '[data-fleet-new-profile] [data-fleet-problems]').textContent ?? '';
    expect(problems).toContain('already declares a profile named "base"');
    expect(problems).toContain('"work_key" is not a secret name');
    await screen.unmount();
  });

  it('is a card in the same list, so the order somebody reads is the whole order', async () => {
    // Arrange
    const screen = await writing({ newProfile: { name: 'mine', variables: [WRITTEN_ROW] } });

    // Assert — labelled by its own name once it has one, and marked as the one this change declares.
    const authored = pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check="mine"]');
    expect(authored.textContent).toContain('mine');
    expect(authored.textContent).toContain('new');
    expect(authored.textContent).toContain('The next account you add can pick it');
    await screen.unmount();
  });

  it('calls an unnamed profile what it is, rather than rendering a blank card', async () => {
    // Arrange
    const screen = await writing({ newProfile: { name: '', variables: [WRITTEN_ROW] } });

    // Assert
    expect(pick(screen.container, '[data-fleet-check-group="profiles"] [data-fleet-check=""]').textContent).toContain(
      'This new profile',
    );
    await screen.unmount();
  });
});
