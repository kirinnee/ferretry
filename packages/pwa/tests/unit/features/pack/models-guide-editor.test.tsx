import { afterEach, describe, expect, it } from 'bun:test';
import type { GuideUseCase, ModelsGuide } from '@ferretry/protocol';
import { ModelsGuideEditor } from '../../../../src/features/pack/models-guide-editor.tsx';
import type { PackSave } from '../../../../src/features/pack/use-machine-pack.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';
import { byText, choose, click, textOf, typeInto, waitForText } from '../../../support/learning-dom.ts';
import { FLEET_MODELS, PACK_VIEW } from '../../../support/pack.ts';

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
