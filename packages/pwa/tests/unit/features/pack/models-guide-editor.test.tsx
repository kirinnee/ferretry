import { afterEach, describe, expect, it } from 'bun:test';
import type { GuideUseCase, ModelsGuide } from '@ferretry/protocol';
import { ModelsGuideEditor } from '../../../../src/features/pack/models-guide-editor.tsx';
import type { PackSave } from '../../../../src/features/pack/use-machine-pack.ts';
import type { RoutingEdit } from '../../../../src/lib/pack/pack-files.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';
import { byText, choose, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { FLEET_MODELS, PACK_VIEW, SUGGESTION } from '../../../support/pack.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

const editor = async (
  guide: ModelsGuide = PACK_VIEW.guide,
  answer: PackSave = { kind: 'applied' },
  initiallyOpen: readonly number[] = [],
) => {
  const saves: (readonly GuideUseCase[] | null)[] = [];
  shown = await mount(
    <ModelsGuideEditor
      guide={guide}
      models={FLEET_MODELS}
      initiallyOpen={initiallyOpen}
      onSave={async useCases => {
        saves.push(useCases);
        return answer;
      }}
    />,
  );
  return { root: shown.container, saves };
};

const button = (root: HTMLElement, label: string) =>
  must(root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`), label);
const useCaseIds = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-guide-use-case]')].map(item => item.getAttribute('data-guide-use-case'));
const saveButton = (root: HTMLElement) => byText<HTMLButtonElement>(root, 'button', 'Save guide');

describe('ModelsGuideEditor', () => {
  it('lists the derived guide closed, says where it comes from, and opens a use case', async () => {
    const { root } = await editor();
    expect(useCaseIds(root)).toEqual(['hard', 'bulk']);
    expect(root.querySelector('[data-guide-source]')?.getAttribute('data-guide-source')).toBe('derived');
    expect(textOf(root)).toContain('Claude Opus 5.5 +1');
    expect(textOf(root)).toContain('stops following the catalogs');
    expect(saveButton(root).disabled).toBe(true);
    expect(root.querySelector('[data-guide-candidate]') === null).toBe(true);
    const toggle = must(root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]'), 'toggle');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelectorAll('[data-guide-candidate]')).toHaveLength(2);
    expect(textOf(root)).toContain('Runs here');
    await click(toggle);
    expect(root.querySelector('[data-guide-candidate]') === null).toBe(true);
  });

  it('reorders use cases and candidates with buttons, and saves every use case', async () => {
    const { root, saves } = await editor(PACK_VIEW.guide, { kind: 'applied' }, [0]);
    expect(button(root, 'Move candidate 1 up').disabled).toBe(true);
    await click(button(root, 'Move candidate 1 down'));
    const models = () => [...root.querySelectorAll<HTMLInputElement>('[data-guide-candidate] input[role="combobox"]')];
    expect(models().map(input => input.value)).toEqual(['gpt-6-astra', 'claude-opus-5-5']);
    await click(button(root, 'Move candidate 1 up'.replace('1', '2')));
    expect(models().map(input => input.value)).toEqual(['claude-opus-5-5', 'gpt-6-astra']);

    await click(button(root, 'Move use case Hard planning / review / critical code down'));
    expect(useCaseIds(root)).toEqual(['bulk', 'hard']);
    // The open use case moved with its place.
    expect(root.querySelectorAll('[data-guide-candidate]')).toHaveLength(2);
    await click(button(root, 'Move use case Hard planning / review / critical code up'));
    expect(useCaseIds(root)).toEqual(['hard', 'bulk']);
    await click(button(root, 'Move use case Mechanical bulk edits down'.replace(' down', ' up')));
    expect(useCaseIds(root)).toEqual(['bulk', 'hard']);

    await click(saveButton(root));
    await waitForText(root, 'Save guide');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.map(useCase => useCase.id)).toEqual(['bulk', 'hard']);
    expect(root.querySelector('[role="status"]') === null).toBe(true);
  });

  it('edits a use case and a candidate, picks a model that fills the provider, and lists what is wrong', async () => {
    const { root, saves } = await editor(PACK_VIEW.guide, { kind: 'pending', message: 'Held for you.' }, [0]);
    await typeInto(must(root.querySelector<HTMLInputElement>('input[id$="-title"]'), 'title'), 'Hard work');
    await typeInto(must(root.querySelector<HTMLInputElement>('input[id$="-id"]'), 'id'), 'hard-work');
    const keywords = must(root.querySelector<HTMLInputElement>('input[id$="-keywords"]'), 'keywords');
    expect(keywords.value).toBe('plan, review');
    await typeInto(keywords, 'plan, review, ');
    expect(keywords.value).toBe('plan, review, ');
    const description = must(root.querySelector<HTMLTextAreaElement>('textarea[id$="-description"]'), 'description');
    await typeInto(description, 'Plans; prefer glm-5.3 or zzz-9.');
    expect(textOf(root)).toContain('GLM-5.3 (not on this machine)');

    const model = must(root.querySelector<HTMLInputElement>('input[id$="-c1-model"]'), 'model');
    const provider = must(root.querySelector<HTMLInputElement>('input[id$="-c1-provider"]'), 'provider');
    await typeInto(model, 'claude-hai');
    await interact(() => pressKey(model, 'Enter'));
    expect(model.value).toBe('claude-haiku-4-5');
    expect(provider.value).toBe('anthropic');
    await typeInto(model, 'glm-5.3');
    expect(provider.value).toBe('zai');
    expect(root.querySelector('[data-candidate-model-status="absent"]') === null).toBe(false);
    await typeInto(model, 'gpt-6 astra');
    expect(provider.value).toBe('zai');
    await typeInto(model, 'mystery');
    expect(root.querySelector('[data-candidate-model-status="unknown"]') === null).toBe(false);
    await typeInto(provider, 'openai');

    // The first candidate's model has efforts, so its effort is a choice; Default removes it.
    const effort = must(root.querySelector<HTMLSelectElement>('select[id$="-c0-effort"]'), 'effort');
    expect(effort.value).toBe('high');
    await choose(effort, '');
    expect(effort.value).toBe('');
    await choose(effort, 'max');
    const freeEffort = must(root.querySelector<HTMLInputElement>('input[id$="-c1-effort"]'), 'free effort');
    await typeInto(freeEffort, 'xhigh');
    await typeInto(must(root.querySelector<HTMLTextAreaElement>('textarea[id$="-c1-why"]'), 'why'), '');
    expect(textOf(must(root.querySelector('[data-guide-issues]'), 'issues'))).toContain(
      'Use case 1 › candidate 2 › why',
    );
    expect(saveButton(root).disabled).toBe(true);
    await typeInto(must(root.querySelector<HTMLTextAreaElement>('textarea[id$="-c1-why"]'), 'why'), 'Because.');
    await click(saveButton(root));
    await waitForText(root, 'Held for you.');
    expect(saves[0]?.[0]).toMatchObject({
      id: 'hard-work',
      title: 'Hard work',
      keywords: ['plan', 'review'],
      candidates: [
        { model: 'claude-opus-5-5', effort: 'max' },
        { provider: 'openai', model: 'mystery', effort: 'xhigh', why: 'Because.' },
      ],
    });
  });

  it('adds and removes use cases and candidates, and discards the draft', async () => {
    const { root } = await editor();
    await click(byText(root, 'button', 'Add use case'));
    expect(useCaseIds(root)).toEqual(['hard', 'bulk', 'use-case-3']);
    expect(textOf(root)).toContain('No candidates yet — add');
    await click(byText(root, 'button', 'Add candidate'));
    expect(root.querySelectorAll('[data-guide-candidate]')).toHaveLength(1);
    await click(button(root, 'Remove candidate 1'));
    expect(root.querySelectorAll('[data-guide-candidate]')).toHaveLength(0);
    await click(button(root, 'Remove use case Hard planning / review / critical code'));
    expect(useCaseIds(root)).toEqual(['bulk', 'use-case-3']);
    // The new use case stayed open after the one above it went.
    expect(textOf(root)).toContain('No candidates yet — add');
    await click(button(root, 'Remove use case Mechanical bulk edits'));
    await typeInto(must(root.querySelector<HTMLInputElement>('input[id$="-title"]'), 'title'), '');
    expect(textOf(root)).toContain('Untitled use case');
    await click(button(root, 'Remove use case 1'));
    expect(textOf(root)).toContain('No use cases.');
    await click(byText(root, 'button', 'Discard changes'));
    expect(useCaseIds(root)).toEqual(['hard', 'bulk']);
  });

  it('resets the owner’s guide to the built-in one and says when that was refused', async () => {
    const guide: ModelsGuide = { ...PACK_VIEW.guide, source: 'file' };
    const { root, saves } = await editor(guide, { kind: 'refused', message: 'No.' });
    expect(textOf(root)).toContain('Your guide · models-guide.yaml');
    expect(textOf(root)).not.toContain('stops following the catalogs');
    await click(byText(root, 'button', 'Reset to the built-in guide'));
    await waitForText(root, 'No.');
    expect(saves).toEqual([null]);
  });

  it('follows a guide that moved under an untouched editor, and keeps a draft under a touched one', async () => {
    const { root } = await editor();
    const moved: ModelsGuide = { source: 'file', useCases: PACK_VIEW.guide.useCases.slice(1) };
    const rerender = (guide: ModelsGuide) =>
      shown?.render(
        <ModelsGuideEditor guide={guide} models={FLEET_MODELS} onSave={async () => ({ kind: 'applied' })} />,
      );
    await rerender(moved);
    expect(useCaseIds(root)).toEqual(['bulk']);
    await click(byText(root, 'button', 'Add use case'));
    await rerender(PACK_VIEW.guide);
    expect(useCaseIds(root)).toEqual(['bulk', 'use-case-2']);
  });
});

describe('ModelsGuideEditor › routing guidance and the generator', () => {
  const withRouting: ModelsGuide = {
    ...PACK_VIEW.guide,
    source: 'file',
    routing: { source: 'file', prompt: 'Opus for hard work.', short: 'Opus for hard work' },
  };

  const routed = async (
    guide: ModelsGuide = withRouting,
    extra: Partial<React.ComponentProps<typeof ModelsGuideEditor>> = {},
  ) => {
    const saves: { useCases: readonly GuideUseCase[] | null; routing: RoutingEdit }[] = [];
    shown = await mount(
      <ModelsGuideEditor
        guide={guide}
        models={FLEET_MODELS}
        onSave={async (useCases, routing) => {
          saves.push({ useCases, routing });
          return { kind: 'applied' };
        }}
        {...extra}
      />,
    );
    return { root: shown.container, saves };
  };
  const prompt = (root: HTMLElement) =>
    must(root.querySelector<HTMLTextAreaElement>('[data-routing-prompt]'), 'routing prompt');
  const summary = (root: HTMLElement) =>
    must(root.querySelector<HTMLInputElement>('[data-guide-routing] input[type="text"]'), 'routing summary');

  it('shows the routing in effect, and leaves it alone on a save that did not touch it', async () => {
    const { root, saves } = await routed();
    expect(prompt(root).value).toBe('Opus for hard work.');
    expect(summary(root).value).toBe('Opus for hard work');
    expect(saveButton(root).disabled).toBe(true);
    await click(button(root, 'Move use case Hard planning / review / critical code down'));
    await click(saveButton(root));
    await waitFor(() => saves.length === 1, 'save');
    expect(saves[0]?.routing).toBeUndefined();
  });

  it('saves an edited routing with the guide', async () => {
    const { root, saves } = await routed();
    await typeInto(prompt(root), 'Sonnet first.');
    await typeInto(summary(root), 'Sonnet first');
    expect(saveButton(root).disabled).toBe(false);
    await click(saveButton(root));
    await waitFor(() => saves.length === 1, 'save');
    expect(saves[0]?.routing).toEqual({ prompt: 'Sonnet first.', short: 'Sonnet first' });
  });

  it('removes the routing when both fields are cleared', async () => {
    const { root, saves } = await routed();
    await typeInto(prompt(root), '');
    await typeInto(summary(root), '');
    await click(saveButton(root));
    await waitFor(() => saves.length === 1, 'save');
    expect(saves[0]?.routing).toBeNull();
  });

  it('lists what is wrong with the routing and will not save it', async () => {
    const { root } = await routed();
    await typeInto(summary(root), 'He said "no"');
    expect(textOf(must(root.querySelector('[data-guide-issues]'), 'issues')).toLowerCase()).toContain('summary');
    expect(saveButton(root).disabled).toBe(true);
    await typeInto(summary(root), '');
    expect(textOf(must(root.querySelector('[data-guide-issues]'), 'issues')).toLowerCase()).toContain('summary');
  });

  it('says when the routing shown is rendered from the use cases', async () => {
    const { root } = await routed({
      ...PACK_VIEW.guide,
      routing: { source: 'derived', prompt: 'Derived.', short: 'D' },
    });
    expect(textOf(must(root.querySelector('[data-guide-routing]'), 'routing'))).toContain(
      'rendered from the use cases',
    );
  });

  it('discards a routing edit with the rest of the draft', async () => {
    const { root } = await routed();
    await typeInto(prompt(root), 'Changed.');
    await click(byText(root, 'button', 'Discard changes'));
    expect(prompt(root).value).toBe('Opus for hard work.');
  });

  it('follows routing that moved under an untouched editor, and keeps an edit under a touched one', async () => {
    const { root } = await routed();
    const render = (routing: ModelsGuide['routing']) =>
      shown?.render(
        <ModelsGuideEditor
          guide={{ ...withRouting, routing }}
          models={FLEET_MODELS}
          onSave={async () => ({ kind: 'applied' })}
        />,
      );
    await render({ source: 'file', prompt: 'Moved.', short: 'Moved' });
    expect(prompt(root).value).toBe('Moved.');
    await typeInto(prompt(root), 'Mine.');
    await render({ source: 'file', prompt: 'Moved again.', short: 'Moved again' });
    expect(prompt(root).value).toBe('Mine.');
  });

  it('loads a suggestion sent to be edited into the draft, once per key, and saves nothing', async () => {
    const { root, saves } = await routed(withRouting, {
      incoming: { key: 1, useCases: SUGGESTION.useCases, routing: SUGGESTION.routing },
    });
    expect(useCaseIds(root)).toEqual(['hard', 'bulk', 'docs']);
    expect(prompt(root).value).toContain('Use Opus for planning');
    expect(saves).toHaveLength(0);
    expect(saveButton(root).disabled).toBe(false);
    await click(byText(root, 'button', 'Discard changes'));
    expect(useCaseIds(root)).toEqual(['hard', 'bulk']);
    await shown?.render(
      <ModelsGuideEditor
        guide={withRouting}
        models={FLEET_MODELS}
        onSave={async () => ({ kind: 'applied' })}
        incoming={{ key: 1, useCases: SUGGESTION.useCases }}
      />,
    );
    expect(useCaseIds(root)).toEqual(['hard', 'bulk']);
    await shown?.render(
      <ModelsGuideEditor
        guide={withRouting}
        models={FLEET_MODELS}
        onSave={async () => ({ kind: 'applied' })}
        incoming={{ key: 2, useCases: SUGGESTION.useCases }}
      />,
    );
    expect(useCaseIds(root)).toEqual(['hard', 'bulk', 'docs']);
    expect(prompt(root).value).toBe('Opus for hard work.');
  });

  it('offers to undo the last accepted suggestion, and says what came of it', async () => {
    const undos: number[] = [];
    const { root } = await routed(withRouting, {
      undo: { savedAt: '2026-10-22T14:35:00.000Z', source: 'file' },
      onUndo: async () => {
        undos.push(1);
        return { kind: 'applied', message: 'Put the old guide back.' };
      },
    });
    const undo = byText<HTMLButtonElement>(root, 'button', 'Undo last accepted suggestion (saved ');
    expect(undo.textContent).toContain('2026');
    await click(undo);
    await waitForText(root, 'Put the old guide back.');
    expect(undos).toHaveLength(1);
  });

  it('shows an undo that was refused in the error colour, and no undo button without one', async () => {
    const { root } = await routed(withRouting, {
      undo: { savedAt: '2026-10-22T14:35:00.000Z', source: 'derived' },
      onUndo: async () => ({ kind: 'refused', message: 'Nothing to undo.' }),
    });
    await click(byText(root, 'button', 'Undo last accepted suggestion'));
    await waitForText(root, 'Nothing to undo.');
    expect(byText(root, 'p', 'Nothing to undo.').className).toContain('text-err');
    await shown?.unmount();
    const plain = await routed();
    expect(plain.root.querySelector('[data-guide-undo-last]') === null).toBe(true);
  });
});
