import { afterEach, describe, expect, it } from 'bun:test';
import type { PackGuideBuilder, PackGuideJob } from '@ferretry/protocol';
import { GuideSuggestPanel } from '../../../../src/features/pack/guide-suggest-panel.tsx';
import type {
  GuideJobRead,
  GuideStart,
  GuideWrite,
  MachinePack,
  PackSave,
} from '../../../../src/features/pack/use-machine-pack.ts';
import { daemonSessionPath } from '../../../../src/lib/pages/routes.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, choose, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
import { alpha } from '../config-files/config-files-support.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

const READY: PackGuideBuilder = { available: true, runtimes: ['codex-main', 'claude-main'] };
const SUGGESTED: PackGuideJob = { ...RUNNING_JOB, status: 'suggested' };

interface Fakes {
  start?: GuideStart;
  reads?: GuideJobRead[];
  save?: PackSave;
  accept?: GuideWrite;
  undo?: GuideWrite;
}

const panel = async (
  fakes: Fakes = {},
  builder: PackGuideBuilder | 'none' = READY,
  extra: Partial<React.ComponentProps<typeof GuideSuggestPanel>> = {},
) => {
  const calls = {
    suggest: [] as Parameters<MachinePack['suggest']>[0][],
    reads: [] as string[],
    saves: [] as Parameters<MachinePack['saveConfig']>[0][],
    accepts: [] as Parameters<MachinePack['acceptGuide']>[0][],
    undos: 0,
    edits: [] as unknown[],
  };
  const reads = [...(fakes.reads ?? [])];
  const state: Pick<MachinePack, 'suggest' | 'readJob' | 'acceptGuide' | 'undoGuide' | 'saveConfig'> = {
    suggest: async request => {
      calls.suggest.push(request);
      return fakes.start ?? { kind: 'started', job: RUNNING_JOB };
    },
    readJob: async id => {
      calls.reads.push(id);
      return reads.shift() ?? reads[0] ?? { kind: 'read', result: { job: RUNNING_JOB } };
    },
    saveConfig: async patch => {
      calls.saves.push(patch);
      return fakes.save ?? { kind: 'applied' };
    },
    acceptGuide: async request => {
      calls.accepts.push(request);
      return fakes.accept ?? { kind: 'applied', message: 'Guide saved.' };
    },
    undoGuide: async () => {
      calls.undos += 1;
      return fakes.undo ?? { kind: 'applied', message: 'Put the old guide back.' };
    },
  };
  shown = await mount(
    <GuideSuggestPanel
      connection={alpha}
      state={state}
      builder={builder === 'none' ? undefined : builder}
      preferences=""
      pollMs={5}
      onEdit={guide => calls.edits.push(guide)}
      {...extra}
    />,
  );
  return { root: shown.container, calls };
};

const idle = async (ms: number): Promise<void> => {
  await interact(async () => await new Promise(resolve => setTimeout(resolve, ms)));
};
const startButton = (root: HTMLElement) => must(root.querySelector<HTMLButtonElement>('[data-guide-start]'), 'start');
const prefs = (root: HTMLElement) =>
  must(root.querySelector<HTMLTextAreaElement>('[data-guide-preferences]'), 'preferences');
const remember = (root: HTMLElement) => must(root.querySelector<HTMLInputElement>('[data-guide-remember]'), 'remember');
const jobState = (root: HTMLElement) => root.querySelector('[data-guide-job]')?.getAttribute('data-guide-job');

describe('GuideSuggestPanel', () => {
  it('says it spends one model run, only on a press', async () => {
    const { root } = await panel();
    expect(textOf(root)).toContain('one model run');
    expect(textOf(root)).toContain('only now');
    expect(startButton(root).disabled).toBe(false);
  });

  it('is disabled with the reason when the builder is unavailable, and with a default reason without one', async () => {
    let { root, calls } = await panel({}, { available: false, runtimes: [], reason: 'No runtime is signed in.' });
    expect(startButton(root).disabled).toBe(true);
    expect(must(root.querySelector('[data-guide-unavailable]'), 'reason').textContent).toBe('No runtime is signed in.');
    expect(calls.suggest).toHaveLength(0);
    await shown?.unmount();
    ({ root } = await panel({}, 'none'));
    expect(textOf(root)).toContain('daemon is too old');
    expect(startButton(root).disabled).toBe(true);
  });

  it('offers the best ready runtime, then each one, and starts with the choice and the preferences', async () => {
    const { root, calls } = await panel();
    const select = must(root.querySelector<HTMLSelectElement>('select'), 'runtime');
    expect([...select.options].map(o => o.textContent)).toEqual([
      'Best ready (codex-main)',
      'codex-main',
      'claude-main',
    ]);
    await click(startButton(root));
    await waitFor(() => calls.suggest.length === 1, 'first start');
    expect(calls.suggest[0]).toEqual({ preferences: '' });
    await waitForText(root, 'Guide Builder');
    await shown?.unmount();

    const second = await panel();
    await choose(must(second.root.querySelector<HTMLSelectElement>('select'), 'runtime'), 'claude-main');
    await typeInto(prefs(second.root), '  Cheap first.  ');
    await click(startButton(second.root));
    await waitFor(() => second.calls.suggest.length === 1, 'second start');
    expect(second.calls.suggest[0]).toEqual({ runtime: 'claude-main', preferences: 'Cheap first.' });
    expect(second.calls.saves).toHaveLength(0);
  });

  it('prefills the preferences from pack.yaml, and shows a changed value under an untouched box', async () => {
    const { root } = await panel({}, READY, { preferences: 'Prefer Opus.' });
    expect(prefs(root).value).toBe('Prefer Opus.');
    const props = { connection: alpha, builder: READY, pollMs: 5, onEdit: () => undefined };
    const state = {} as MachinePack;
    await must(shown, 'shown').render(<GuideSuggestPanel {...props} state={state} preferences="Prefer Sonnet." />);
    expect(prefs(root).value).toBe('Prefer Sonnet.');
    await typeInto(prefs(root), 'My own words');
    await must(shown, 'shown').render(<GuideSuggestPanel {...props} state={state} preferences="Prefer Haiku." />);
    expect(prefs(root).value).toBe('My own words');
  });

  it('remembers the preferences first, and starts a run only once they are saved', async () => {
    const { root, calls } = await panel();
    await typeInto(prefs(root), 'Never use glm.');
    await click(remember(root));
    await click(startButton(root));
    await waitFor(() => calls.suggest.length === 1, 'start');
    expect(calls.saves).toEqual([{ routingPreferences: 'Never use glm.' }]);
  });

  it('starts nothing when the preferences cannot be saved, and says so', async () => {
    const { root, calls } = await panel({ save: { kind: 'refused', message: 'pack.yaml has a problem.' } });
    await typeInto(prefs(root), 'Never use glm.');
    await click(remember(root));
    await click(startButton(root));
    await waitForText(root, 'no run was started');
    expect(textOf(must(root.querySelector('[data-guide-problem]'), 'problem'))).toContain('pack.yaml has a problem.');
    expect(calls.suggest).toHaveLength(0);
    expect(startButton(root).disabled).toBe(false);
  });

  it('says why the daemon would not start a run', async () => {
    const { root } = await panel({ start: { kind: 'refused', message: 'A builder is already running.' } });
    await click(startButton(root));
    await waitForText(root, 'A builder is already running.');
    expect(root.querySelector('[data-guide-job]') === null).toBe(true);
  });

  it('shows the run: name, runtime, model, a link to its session and the time it has been going', async () => {
    const started = Date.parse(RUNNING_JOB.startedAt);
    const { root } = await panel({}, READY, { clock: () => started + 65_000 });
    await click(startButton(root));
    await waitForText(root, 'Guide Builder');
    expect(jobState(root)).toBe('running');
    expect(textOf(root)).toContain('codex-main');
    expect(textOf(root)).toContain('gpt-6-astra');
    expect(textOf(root)).toContain('running for 1m');
    const link = must(root.querySelector<HTMLAnchorElement>('[data-guide-job-session]'), 'link');
    expect(link.getAttribute('href')).toBe(daemonSessionPath(alpha.daemonId, RUNNING_JOB.session));
    expect(startButton(root).disabled).toBe(true);
  });

  it('adopts a run already going when the page opens, and polls it until the review arrives', async () => {
    const { root, calls } = await panel(
      {
        reads: [
          { kind: 'read', result: { job: RUNNING_JOB } },
          { kind: 'read', result: { job: SUGGESTED, suggestion: SUGGESTION } },
        ],
      },
      { ...READY, job: RUNNING_JOB },
    );
    expect(jobState(root)).toBe('running');
    await waitFor(() => root.querySelector('[data-guide-review]') !== null, 'the review');
    expect(jobState(root)).toBe('suggested');
    expect(calls.reads.length).toBeGreaterThanOrEqual(2);
    const settled = calls.reads.length;
    await idle(40);
    expect(calls.reads).toHaveLength(settled);
  });

  it('does not adopt a run that is not running', async () => {
    const { root, calls } = await panel({}, { ...READY, job: SUGGESTED });
    expect(root.querySelector('[data-guide-job]') === null).toBe(true);
    expect(calls.reads).toHaveLength(0);
  });

  it('shows why a run failed, and stops reading it', async () => {
    const failed: PackGuideJob = { ...RUNNING_JOB, status: 'failed', message: 'The builder wrote no draft.' };
    const { root, calls } = await panel(
      { reads: [{ kind: 'read', result: { job: failed } }] },
      { ...READY, job: RUNNING_JOB },
    );
    await waitForText(root, 'The builder wrote no draft.');
    expect(jobState(root)).toBe('failed');
    const settled = calls.reads.length;
    await idle(30);
    expect(calls.reads).toHaveLength(settled);
    expect(startButton(root).disabled).toBe(false);
  });

  it('gives a default sentence for a failure with no message', async () => {
    const failed: PackGuideJob = { ...RUNNING_JOB, status: 'failed' };
    const { root } = await panel(
      { reads: [{ kind: 'read', result: { job: failed } }] },
      { ...READY, job: RUNNING_JOB },
    );
    await waitForText(root, 'stopped without a draft');
  });

  it('keeps trying when a read fails, and says so', async () => {
    const { root, calls } = await panel(
      {
        reads: [
          { kind: 'failed', message: 'offline' },
          { kind: 'read', result: { job: SUGGESTED, suggestion: SUGGESTION } },
        ],
      },
      { ...READY, job: RUNNING_JOB },
    );
    await waitFor(() => calls.reads.length >= 1, 'a read');
    await waitFor(() => root.querySelector('[data-guide-review]') !== null, 'the review');
    expect(textOf(root)).not.toContain('Could not read');
  });

  it('shows a read error while it lasts', async () => {
    const { root } = await panel({ reads: [{ kind: 'failed', message: 'offline' }] }, { ...READY, job: RUNNING_JOB });
    await waitForText(root, 'Could not read the builder just now (offline)');
  });

  it('stops reading when it is unmounted', async () => {
    const { calls } = await panel({}, { ...READY, job: RUNNING_JOB });
    await waitFor(() => calls.reads.length >= 1, 'a read');
    await shown?.unmount();
    shown = undefined;
    const settled = calls.reads.length;
    await idle(40);
    expect(calls.reads.length).toBeLessThanOrEqual(settled + 1);
  });

  it('starts from a run and its suggestion it is given', async () => {
    const { root } = await panel({}, READY, { initial: { job: SUGGESTED, suggestion: SUGGESTION } });
    expect(root.querySelector('[data-guide-review]')).not.toBeNull();
    expect(jobState(root)).toBe('suggested');
    expect(textOf(root)).toContain('started');
  });

  it('accepts the review, says it is done, and offers to undo', async () => {
    const { root, calls } = await panel({}, READY, { initial: { job: SUGGESTED, suggestion: SUGGESTION } });
    await click(must(root.querySelector('[data-review-action="accept-all"]'), 'accept all'));
    await waitFor(() => root.querySelector('[data-guide-done]') !== null, 'done');
    expect(calls.accepts).toHaveLength(1);
    expect(root.querySelector('[data-guide-review]') === null).toBe(true);
    expect(root.querySelector('[data-guide-job]') === null).toBe(true);
    expect(textOf(root)).toContain('Guide saved.');
    await click(must(root.querySelector('[data-guide-undo]'), 'undo'));
    await waitForText(root, 'Put the old guide back.');
    expect(calls.undos).toBe(1);
    expect(root.querySelector('[data-guide-undo]') === null).toBe(true);
  });

  it('offers no undo when the accept changed nothing', async () => {
    const { root } = await panel({ accept: { kind: 'nothing', message: 'Nothing to change.' } }, READY, {
      initial: { job: SUGGESTED, suggestion: SUGGESTION },
    });
    await click(must(root.querySelector('[data-review-action="accept-all"]'), 'accept all'));
    await waitForText(root, 'Nothing to change.');
    expect(root.querySelector('[data-guide-undo]') === null).toBe(true);
  });

  it('keeps the review and says why when the accept is refused', async () => {
    const { root } = await panel({ accept: { kind: 'refused', message: 'The guide changed meanwhile.' } }, READY, {
      initial: { job: SUGGESTED, suggestion: SUGGESTION },
    });
    await click(must(root.querySelector('[data-review-action="accept-all"]'), 'accept all'));
    await waitForText(root, 'The guide changed meanwhile.');
    expect(root.querySelector('[data-guide-review]')).not.toBeNull();
  });

  it('says when an undo is refused', async () => {
    const { root } = await panel({ undo: { kind: 'refused', message: 'Nothing to undo.' } }, READY, {
      initial: { job: SUGGESTED, suggestion: SUGGESTION },
    });
    await click(must(root.querySelector('[data-review-action="accept-all"]'), 'accept all'));
    await waitFor(() => root.querySelector('[data-guide-undo]') !== null, 'undo');
    await click(must(root.querySelector('[data-guide-undo]'), 'undo'));
    await waitForText(root, 'Nothing to undo.');
    expect(root.querySelector('[data-guide-done]') === null).toBe(true);
  });

  it('hands the ticked result to the editor on Edit and closes the review; Discard closes it too', async () => {
    const { root, calls } = await panel({}, READY, { initial: { job: SUGGESTED, suggestion: SUGGESTION } });
    await click(byText(root, 'button', 'Edit'));
    expect(calls.edits).toHaveLength(1);
    expect(root.querySelector('[data-guide-review]') === null).toBe(true);
    await shown?.unmount();
    const again = await panel({}, READY, { initial: { job: SUGGESTED, suggestion: SUGGESTION } });
    await click(byText(again.root, 'button', 'Discard'));
    expect(again.root.querySelector('[data-guide-review]') === null).toBe(true);
    expect(again.calls.accepts).toHaveLength(0);
  });
});
