import { afterEach, describe, expect, it } from 'bun:test';
import type { PackFleetModel } from '@ferretry/protocol';
import { ModelsPanel } from '../../../../src/features/pack/models-panel.tsx';
import type { GuideWrite } from '../../../../src/features/pack/use-machine-pack.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, click, textOf, typeInto, waitForText } from '../../../support/learning-dom.ts';
import { ASTRA, FLEET_MODELS, GLM, OPUS, SONNET } from '../../../support/pack.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

interface Request {
  readonly provider: string;
  readonly model: string;
  readonly description: string | null;
}

const panel = async (
  models: readonly PackFleetModel[],
  answer: GuideWrite = { kind: 'applied', message: 'Saved.' },
  initiallyOpen = true,
) => {
  const requests: Request[] = [];
  shown = await mount(
    <ModelsPanel
      models={models}
      initiallyOpen={initiallyOpen}
      onDescribe={async request => {
        requests.push(request);
        return answer;
      }}
    />,
  );
  return { root: shown.container, requests };
};

const row = (root: HTMLElement, id: string) => must(root.querySelector<HTMLElement>(`[data-model-row="${id}"]`), id);
const box = (root: HTMLElement, id: string) => must(row(root, id).querySelector('textarea'), 'textarea');

const described: readonly PackFleetModel[] = [
  { ...OPUS, description: 'Deep reasoning.', describedBy: 'catalog' },
  { ...SONNET, description: 'My everyday model.', describedBy: 'owner' },
  GLM,
  ASTRA,
];

describe('ModelsPanel', () => {
  it('is closed by default and counts the models', async () => {
    const { root } = await panel(FLEET_MODELS, undefined, false);
    expect(textOf(root)).toContain('8 models');
    expect(root.querySelector('[data-model-row]') === null).toBe(true);
    await click(must(root.querySelector('button[aria-expanded="false"]'), 'toggle'));
    expect(root.querySelectorAll('[data-model-group]').length).toBeGreaterThan(1);
    await click(must(root.querySelector('button[aria-expanded="true"]'), 'toggle'));
    expect(root.querySelector('[data-model-row]') === null).toBe(true);
  });

  it('groups by provider, badges who described each model, and says where it runs', async () => {
    const { root } = await panel(described);
    expect([...root.querySelectorAll('[data-model-group]')].map(g => g.getAttribute('data-model-group'))).toEqual([
      'anthropic',
      'zai',
      'openai',
    ]);
    expect(row(root, OPUS.id).querySelector('[data-model-described-by]')?.textContent).toBe('From the catalog');
    expect(row(root, SONNET.id).querySelector('[data-model-described-by]')?.textContent).toBe('Your words');
    expect(row(root, GLM.id).querySelector('[data-model-described-by]') === null).toBe(true);
    expect(row(root, GLM.id).querySelector('[data-model-runs]')?.textContent).toBe('Not on this machine');
    expect(row(root, OPUS.id).querySelector('[data-model-runs]')?.textContent).toBe('Runs here');
    expect(textOf(root)).toContain('1 described in your words');
    expect(box(root, SONNET.id).value).toBe('My everyday model.');
  });

  it('counts a single model in the singular', async () => {
    const { root } = await panel([OPUS], undefined, false);
    expect(textOf(root)).toContain('1 model.');
  });

  it('filters by a word from the name, the id or the description, and says when nothing matches', async () => {
    const { root } = await panel(described);
    const filter = must(root.querySelector<HTMLInputElement>('[data-models-filter]'), 'filter');
    await typeInto(filter, 'everyday');
    expect([...root.querySelectorAll('[data-model-row]')].map(r => r.getAttribute('data-model-row'))).toEqual([
      SONNET.id,
    ]);
    await typeInto(filter, 'astra');
    expect(root.querySelectorAll('[data-model-row]')).toHaveLength(1);
    await typeInto(filter, 'zzz');
    expect(textOf(root)).toContain('No model matches “zzz”.');
    await typeInto(filter, '');
    expect(root.querySelectorAll('[data-model-row]')).toHaveLength(4);
  });

  it('saves a description only once it has changed and is not empty', async () => {
    const { root, requests } = await panel(described);
    const save = byText<HTMLButtonElement>(row(root, GLM.id), 'button', 'Save description');
    expect(save.disabled).toBe(true);
    await typeInto(box(root, GLM.id), '   ');
    expect(save.disabled).toBe(true);
    await typeInto(box(root, GLM.id), '  Cheap, long context.  ');
    expect(save.disabled).toBe(false);
    await click(save);
    await waitForText(row(root, GLM.id), 'Saved.');
    expect(requests).toEqual([{ provider: 'zai', model: 'glm-5.3', description: 'Cheap, long context.' }]);
  });

  it('gives the catalog’s words back with a null description, only on an owner-described model', async () => {
    const { root, requests } = await panel(described);
    expect(row(root, OPUS.id).querySelector('[data-model-reset]') === null).toBe(true);
    await click(must(row(root, SONNET.id).querySelector('[data-model-reset]'), 'reset'));
    await waitForText(row(root, SONNET.id), 'Saved.');
    expect(requests).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-5', description: null }]);
  });

  it('shows the daemon’s refusal in words', async () => {
    const { root } = await panel(described, { kind: 'refused', message: 'models-guide.yaml has a problem.' });
    await typeInto(box(root, ASTRA.id), 'A second opinion.');
    await click(byText(row(root, ASTRA.id), 'button', 'Save description'));
    await waitForText(row(root, ASTRA.id), 'models-guide.yaml has a problem.');
    expect(row(root, ASTRA.id).querySelector('[role="status"]')?.className).toContain('text-err');
  });

  it('shows new words that arrive under an untouched box, but not over a person’s typing', async () => {
    const onDescribe = async (): Promise<GuideWrite> => ({ kind: 'applied', message: 'Saved.' });
    shown = await mount(<ModelsPanel models={described} initiallyOpen onDescribe={onDescribe} />);
    const root = shown.container;
    const next = described.map(m =>
      m.id === GLM.id ? { ...m, description: 'Arrived.', describedBy: 'catalog' as const } : m,
    );
    await shown.render(<ModelsPanel models={next} initiallyOpen onDescribe={onDescribe} />);
    expect(box(root, GLM.id).value).toBe('Arrived.');
    await typeInto(box(root, GLM.id), 'Mine, half typed');
    const later = next.map(m => (m.id === GLM.id ? { ...m, description: 'Arrived again.' } : m));
    await shown.render(<ModelsPanel models={later} initiallyOpen onDescribe={onDescribe} />);
    expect(box(root, GLM.id).value).toBe('Mine, half typed');
  });
});
