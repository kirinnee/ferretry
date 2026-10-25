import { afterEach, describe, expect, it } from 'bun:test';
import {
  DAEMON_FEATURES,
  LEGACY_MAX_IDEA_CHARS,
  MAX_IDEA_CHARS,
  MAX_ROUTING_PROMPT_CHARS,
  type PackCleanUpRequest,
  type PackRoutingAcceptRequest,
} from '@ferretry/protocol';
import { RoutingPromptCard, type RoutingPromptCardProps } from '../../../../src/features/pack/routing-prompt-card.tsx';
import { ideaLimitFor } from '../../../../src/lib/pack/routing-prompt.ts';
import { healthOf } from '../../../support/health.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';
import { byText, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import {
  IDLE_ROUTING_API,
  NUDGE_VIEW,
  OWNER_PROMPT,
  OWNER_VIEW,
  PACK_VIEW,
  RUNNING_JOB,
  SUGGESTION,
  WRITING_JOB,
  WRITTEN_SUGGESTION,
} from '../../../support/pack.ts';
import { alpha } from '../config-files/config-files-support.ts';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

type State = RoutingPromptCardProps['state'];

const card = async (
  view: RoutingPromptCardProps['view'] = OWNER_VIEW,
  overrides: Partial<State> = {},
  props: Partial<Omit<RoutingPromptCardProps, 'view' | 'state' | 'connection'>> = {},
) => {
  const state: State = { ...IDLE_ROUTING_API, ...overrides };
  shown = await mount(<RoutingPromptCard connection={alpha} view={view} state={state} pollMs={5} {...props} />);
  return shown.container;
};

const field = (root: HTMLElement) => must(root.querySelector<HTMLTextAreaElement>('textarea'), 'the prompt');
const action = (root: HTMLElement, name: string) =>
  must(root.querySelector<HTMLButtonElement>(`[data-routing-action="${name}"]`), name);
const byHand = async (root: HTMLElement) => await click(action(root, 'by-hand'));
const sourceOf = (root: HTMLElement) => must(root.querySelector('[data-routing-source]'), 'source');

describe('the routing prompt card', () => {
  it('shows the prompt, where it came from, and who reads it', async () => {
    let root = await card(PACK_VIEW);
    await byHand(root);
    expect(textOf(root)).toContain('Routing prompt');
    expect(textOf(root)).toContain('Ferrets use this to pick which model runs each sub-task');
    expect(textOf(root)).toContain('Jev reads it when Jev decides');
    expect(field(root).value).toBe(PACK_VIEW.routing.text);
    expect(textOf(sourceOf(root))).toBe('Default — built from the model catalogs');
    await shown?.unmount();

    root = await card(OWNER_VIEW);
    expect(field(root).value).toBe(OWNER_PROMPT);
    expect(textOf(sourceOf(root))).toBe('Your words');
    await shown?.unmount();

    root = await card({
      ...OWNER_VIEW,
      routing: {
        text: SUGGESTION.after,
        source: 'file',
        suggested: { ...SUGGESTION.suggested, acceptedAt: '2026-10-22T14:31:00.000Z' },
      },
    });
    expect(sourceOf(root).getAttribute('data-routing-source')).toBe('cleaned-up');
    expect(textOf(sourceOf(root))).toMatch(/^Cleaned up by gpt-6-astra via codex-main, accepted 2026-10-2\d /u);
  });

  it('marks a known, an absent and an unknown model as they are written', async () => {
    const root = await card(OWNER_VIEW);
    const marks = [...root.querySelectorAll('[data-model-mark]')].map(mark => [
      mark.getAttribute('data-model-mark'),
      mark.textContent,
    ]);
    expect(marks).toEqual([
      ['known', 'claude-opus-5-5'],
      ['absent', 'glm-5.3'],
      ['unknown', 'gpt-6-astra-mini'],
    ]);
  });

  it('saves the owner’s words only once they change, trimmed', async () => {
    const saved: (string | null)[] = [];
    const root = await card(OWNER_VIEW, {
      savePrompt: async prompt => {
        saved.push(prompt);
        return { kind: 'applied' };
      },
    });
    expect(action(root, 'save').disabled).toBe(true);
    await typeInto(field(root), '  Opus for hard work; Haiku for chores.  ');
    expect(action(root, 'save').disabled).toBe(false);
    await click(action(root, 'save'));
    await waitFor(() => saved.length === 1, 'the save');
    expect(saved).toEqual(['Opus for hard work; Haiku for chores.']);
    await waitForText(root, 'These are your words now.');
  });

  it('removes the prompt on an empty Save so the default applies, and says so', async () => {
    const saved: (string | null)[] = [];
    const root = await card(OWNER_VIEW, {
      savePrompt: async prompt => {
        saved.push(prompt);
        return { kind: 'applied' };
      },
    });
    await typeInto(field(root), '   ');
    expect(textOf(root)).toContain('Saving it empty removes your prompt, and the default applies.');
    await click(action(root, 'save'));
    await waitFor(() => saved.length === 1, 'the save');
    expect(saved).toEqual([null]);
    await waitForText(root, 'the default, built from the model catalogs, applies now');
  });

  it('has nothing to save when the box is emptied over the default', async () => {
    const root = await card(PACK_VIEW);
    await byHand(root);
    await typeInto(field(root), '');
    expect(action(root, 'save').disabled).toBe(true);
  });

  it('lets an over-long prompt be typed but not saved, and says why', async () => {
    const root = await card(OWNER_VIEW);
    await typeInto(field(root), 'x'.repeat(MAX_ROUTING_PROMPT_CHARS + 30));
    expect(action(root, 'save').disabled).toBe(true);
    expect(root.querySelector('[data-routing-counter]')?.getAttribute('data-routing-counter')).toBe('over');
    expect(textOf(root)).toContain('Too long to save: 1,230 characters');
    expect(field(root).getAttribute('aria-invalid')).toBe('true');
    expect(field(root).getAttribute('aria-describedby')).toContain('-count');
    expect(action(root, 'clean-up').disabled).toBe(false);
  });

  it('shows the save refused or held in the daemon’s words', async () => {
    const root = await card(OWNER_VIEW, {
      savePrompt: async () => ({ kind: 'refused', message: 'models-guide.yaml has a problem.' }),
    });
    await typeInto(field(root), 'Opus.');
    await click(action(root, 'save'));
    await waitForText(root, 'models-guide.yaml has a problem.');
    expect(root.querySelector('[data-routing-outcome]')?.getAttribute('data-routing-outcome')).toBe('err');
  });

  it('disables Clean up and Write it for me with the daemon’s reason when they cannot run here', async () => {
    const root = await card(PACK_VIEW);
    expect(action(root, 'write').disabled).toBe(true);
    expect(textOf(must(root.querySelector('[data-routing-write-blocked]'), 'reason'))).toBe(
      'No agent runtime here is ready to run a clean-up.',
    );
    await byHand(root);
    expect(action(root, 'write').disabled).toBe(true);
    expect(action(root, 'clean-up').disabled).toBe(true);
    expect(textOf(must(root.querySelector('[data-routing-clean-up-blocked]'), 'reason'))).toBe(
      'No agent runtime here is ready to run a clean-up.',
    );
  });

  it('cleans up the text in the box now, shows the run, and polls it into a review', async () => {
    const asked: PackCleanUpRequest[] = [];
    let reads = 0;
    const startedAt = Date.parse(RUNNING_JOB.startedAt);
    const root = await card(
      OWNER_VIEW,
      {
        cleanUp: async request => {
          asked.push(request);
          return { kind: 'started', job: RUNNING_JOB };
        },
        readJob: async () => {
          reads += 1;
          return reads < 2
            ? { kind: 'read', result: { job: RUNNING_JOB } }
            : { kind: 'read', result: { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION } };
        },
      },
      { clock: () => startedAt + 65_000 },
    );
    await typeInto(field(root), SUGGESTION.before);
    await click(action(root, 'clean-up'));
    await waitFor(() => asked.length === 1, 'the clean-up');
    expect(asked).toEqual([{ prompt: SUGGESTION.before }]);
    await waitFor(() => root.querySelector('[data-clean-up-job]') !== null, 'the run');
    const job = must(root.querySelector('[data-clean-up-job]'), 'job');
    expect(textOf(job)).toContain('Routing Clean Up');
    expect(textOf(job)).toContain('codex-main');
    expect(textOf(job)).toContain('running for 1m 5s');
    expect(must(job.querySelector('a[data-clean-up-session]'), 'link').getAttribute('href')).toContain(
      RUNNING_JOB.session,
    );
    expect(action(root, 'clean-up').disabled).toBe(true);
    await waitFor(() => root.querySelector('[data-clean-up-review]') !== null, 'the review');
    expect(reads).toBe(2);
  });

  it('says why a clean-up did not start', async () => {
    const root = await card(OWNER_VIEW, {
      cleanUp: async () => ({ kind: 'refused', message: 'codex-main cannot start now.' }),
    });
    await click(action(root, 'clean-up'));
    await waitForText(root, 'codex-main cannot start now.');
    expect(root.querySelector('[data-clean-up-job]') === null).toBe(true);
  });

  it('keeps the daemon’s own text behind Details when it said a refusal in plain words', async () => {
    const raw = 'the request body is invalid — idea: Too big: expected string to have <=500 characters';
    const root = await card(OWNER_VIEW, {
      cleanUp: async () => ({
        kind: 'refused',
        message: 'Your idea can hold at most 500 characters on this machine.',
        details: raw,
      }),
    });
    await click(action(root, 'clean-up'));
    await waitForText(root, 'Your idea can hold at most 500 characters on this machine.');
    const details = must(root.querySelector('[data-routing-outcome-details]'), 'the details');
    expect(textOf(details)).toContain(raw);
  });

  it('picks up a run already going when the page opens', async () => {
    const root = await card(
      { ...OWNER_VIEW, cleanUp: { ...OWNER_VIEW.cleanUp, job: RUNNING_JOB } },
      { readJob: () => new Promise(() => undefined) },
    );
    await waitFor(() => root.querySelector('[data-clean-up-job="running"]') !== null, 'the adopted run');
  });

  it('shows a failed run with why', async () => {
    const root = await card(
      OWNER_VIEW,
      {},
      { initial: { job: { ...RUNNING_JOB, status: 'failed', message: 'It ran out of time.' } } },
    );
    expect(textOf(must(root.querySelector('[data-clean-up-message]'), 'why'))).toBe('It ran out of time.');
  });
});

describe('Write it for me', () => {
  it('is the first-run nudge until something is saved: not written yet, a big button, no empty box', async () => {
    const root = await card(NUDGE_VIEW);
    const nudge = must(root.querySelector('[data-routing-nudge]'), 'the nudge');
    expect(textOf(nudge)).toContain('Not written yet');
    expect(textOf(byText(nudge, 'button', 'Write it for me'))).toBe('Write it for me');
    expect(textOf(nudge)).toContain('Your idea (optional)');
    expect(root.querySelector('textarea:not([data-routing-idea])') === null).toBe(true);
    expect(action(root, 'write').disabled).toBe(false);
  });

  it('is not the nudge once a prompt is saved, but a panel next to Clean up', async () => {
    const root = await card(OWNER_VIEW);
    expect(root.querySelector('[data-routing-nudge]') === null).toBe(true);
    expect(root.querySelector('[data-routing-write]') === null).toBe(false);
    expect(action(root, 'write').disabled).toBe(false);
    expect(action(root, 'clean-up').disabled).toBe(false);
  });

  it('opens the box on Or write it by hand', async () => {
    const root = await card(NUDGE_VIEW);
    await byHand(root);
    expect(root.querySelector('[data-routing-nudge]') === null).toBe(true);
    expect(field(root).value).toBe(NUDGE_VIEW.routing.text);
  });

  it('starts the writer with the idea, and with no prompt when only the default is in the box', async () => {
    const asked: PackCleanUpRequest[] = [];
    const root = await card(NUDGE_VIEW, {
      cleanUp: async request => {
        asked.push(request);
        return { kind: 'started', job: WRITING_JOB };
      },
      readJob: () => new Promise(() => undefined),
    });
    await typeInto(
      must(root.querySelector<HTMLTextAreaElement>('[data-routing-idea]'), 'the idea'),
      '  cheap models for chores, Opus for planning  ',
    );
    await click(action(root, 'write'));
    await waitFor(() => asked.length === 1, 'the write');
    expect(asked).toEqual([{ mode: 'generate', idea: 'cheap models for chores, Opus for planning' }]);
    await waitFor(() => root.querySelector('[data-clean-up-job]') !== null, 'the run');
    const job = must(root.querySelector('[data-clean-up-job]'), 'job');
    expect(textOf(job)).toContain('Routing Prompt Writer');
    expect(textOf(job)).toContain('Open the writer’s session');
    expect(action(root, 'write').disabled).toBe(true);
  });

  it('takes a multi-line idea in a text area with a live counter that warns near the limit', async () => {
    const root = await card(NUDGE_VIEW);
    const idea = must(root.querySelector<HTMLTextAreaElement>('textarea[data-routing-idea]'), 'the idea');
    const counter = () => must(root.querySelector('[data-idea-counter]'), 'the counter');
    expect(Number(idea.getAttribute('rows'))).toBeGreaterThanOrEqual(4);
    expect(idea.getAttribute('maxlength')).toBe(String(MAX_IDEA_CHARS));
    expect(idea.getAttribute('aria-describedby')).toBe(counter().id);
    expect(textOf(counter())).toBe('0 / 4,000 characters');
    expect(counter().getAttribute('data-idea-counter')).toBe('ok');
    await typeInto(idea, 'one\ntwo\n\nthree');
    expect(idea.value).toBe('one\ntwo\n\nthree');
    expect(textOf(counter())).toBe('14 / 4,000 characters');
    await typeInto(idea, 'x'.repeat(3_599));
    expect(counter().getAttribute('data-idea-counter')).toBe('ok');
    await typeInto(idea, 'x'.repeat(3_600));
    expect(counter().getAttribute('data-idea-counter')).toBe('near');
    expect(counter().className).toContain('text-warn');
    await typeInto(idea, 'x'.repeat(MAX_IDEA_CHARS));
    expect(counter().getAttribute('data-idea-counter')).toBe('full');
    expect(counter().className).toContain('text-err');
    expect(textOf(counter())).toBe('4,000 / 4,000 characters');
  });

  it('keeps an older machine to 500 characters and says it needs an update', async () => {
    const root = await card(NUDGE_VIEW, {}, { ideaLimit: ideaLimitFor({ kind: 'read', health: healthOf('4.84.0') }) });
    const idea = must(root.querySelector<HTMLTextAreaElement>('textarea[data-routing-idea]'), 'the idea');
    const counter = () => must(root.querySelector('[data-idea-counter]'), 'the counter');
    const note = must(root.querySelector('[data-idea-update-note]'), 'the update note');
    expect(idea.getAttribute('maxlength')).toBe(String(LEGACY_MAX_IDEA_CHARS));
    expect(textOf(counter())).toBe('0 / 500 characters');
    expect(textOf(note)).toBe(
      'This machine needs an update for ideas longer than 500 characters — run “fy daemon update” (Settings › Machine › About & updates).',
    );
    expect(idea.getAttribute('aria-describedby')).toContain(note.id);
    await typeInto(idea, 'x'.repeat(450));
    expect(counter().getAttribute('data-idea-counter')).toBe('near');
    await typeInto(idea, 'x'.repeat(LEGACY_MAX_IDEA_CHARS));
    expect(counter().getAttribute('data-idea-counter')).toBe('full');
  });

  it('says nothing about an update when the machine offers the longer idea, or has not answered', async () => {
    for (const machine of [
      { kind: 'read', health: healthOf('4.90.0', [DAEMON_FEATURES.packIdea4000]) },
      { kind: 'loading' },
    ] as const) {
      const root = await card(NUDGE_VIEW, {}, { ideaLimit: ideaLimitFor(machine) });
      expect(root.querySelector('[data-idea-update-note]') === null).toBe(true);
      await shown?.unmount();
    }
  });

  it('sends the idea with its line breaks on Cmd+Enter and on Ctrl+Enter, and not on a plain Enter', async () => {
    const asked: PackCleanUpRequest[] = [];
    const root = await card(NUDGE_VIEW, {
      cleanUp: async request => {
        asked.push(request);
        return { kind: 'started', job: WRITING_JOB };
      },
      readJob: () => new Promise(() => undefined),
    });
    const idea = must(root.querySelector<HTMLTextAreaElement>('[data-routing-idea]'), 'the idea');
    await typeInto(idea, ' Chores cheap.\n\nOpus plans. ');
    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await interact(() => idea.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
    expect(asked).toEqual([]);
    const withMeta = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    await interact(() => idea.dispatchEvent(withMeta));
    expect(withMeta.defaultPrevented).toBe(true);
    await waitFor(() => asked.length === 1, 'the write on Cmd+Enter');
    expect(asked).toEqual([{ mode: 'generate', idea: 'Chores cheap.\n\nOpus plans.' }]);
    await waitFor(() => root.querySelector('[data-clean-up-job]') !== null, 'the run');
    expect(idea.disabled).toBe(true);
    await interact(() => pressKey(idea, 'Enter', { ctrlKey: true }));
    expect(asked.length).toBe(1);
    await shown?.unmount();

    const again: PackCleanUpRequest[] = [];
    const next = await card(NUDGE_VIEW, {
      cleanUp: async request => {
        again.push(request);
        return { kind: 'refused', message: 'codex-main cannot start now.' };
      },
    });
    const field2 = must(next.querySelector<HTMLTextAreaElement>('[data-routing-idea]'), 'the idea');
    await typeInto(field2, 'cheap');
    await interact(() => pressKey(field2, 'Enter', { ctrlKey: true }));
    await waitFor(() => again.length === 1, 'the write on Ctrl+Enter');
    expect(again).toEqual([{ mode: 'generate', idea: 'cheap' }]);
  });

  it('does nothing on Cmd+Enter while the writer cannot start', async () => {
    const asked: PackCleanUpRequest[] = [];
    const root = await card(
      { ...NUDGE_VIEW, cleanUp: { available: false, runtimes: [], reason: 'No agent runtime here is ready.' } },
      {
        cleanUp: async request => {
          asked.push(request);
          return { kind: 'started', job: WRITING_JOB };
        },
      },
    );
    const idea = must(root.querySelector<HTMLTextAreaElement>('[data-routing-idea]'), 'the idea');
    await typeInto(idea, 'cheap');
    await interact(() => pressKey(idea, 'Enter', { metaKey: true }));
    expect(action(root, 'write').disabled).toBe(true);
    expect(asked).toEqual([]);
  });

  it('starts the writer from nothing: no idea, no prompt', async () => {
    const asked: PackCleanUpRequest[] = [];
    const root = await card(NUDGE_VIEW, {
      cleanUp: async request => {
        asked.push(request);
        return { kind: 'refused', message: 'codex-main cannot start now.' };
      },
    });
    await click(action(root, 'write'));
    await waitForText(root, 'codex-main cannot start now.');
    expect(asked).toEqual([{ mode: 'generate' }]);
  });

  it('builds on the saved prompt when one exists', async () => {
    const asked: PackCleanUpRequest[] = [];
    const root = await card(OWNER_VIEW, {
      cleanUp: async request => {
        asked.push(request);
        return { kind: 'started', job: WRITING_JOB };
      },
      readJob: () => new Promise(() => undefined),
    });
    await click(action(root, 'write'));
    await waitFor(() => asked.length === 1, 'the write');
    expect(asked).toEqual([{ mode: 'generate', prompt: OWNER_PROMPT }]);
  });

  it('shows only the new prompt, no diff, when there was nothing before, then accepts it as written', async () => {
    const accepted: PackRoutingAcceptRequest[] = [];
    const root = await card(
      NUDGE_VIEW,
      {
        accept: async request => {
          accepted.push(request);
          return { kind: 'applied', message: 'The routing prompt is the one gpt-6-astra wrote.' };
        },
      },
      { initial: { job: { ...WRITING_JOB, status: 'suggested' }, suggestion: WRITTEN_SUGGESTION } },
    );
    const review = must(root.querySelector('[data-clean-up-review]'), 'review');
    expect(textOf(review)).toContain('Review the new prompt');
    expect(textOf(must(root.querySelector('[data-clean-up-job]'), 'the job'))).toContain('Prompt written');
    expect(textOf(must(review.querySelector('[data-clean-up-fresh]'), 'the new prompt'))).toBe(
      WRITTEN_SUGGESTION.after,
    );
    expect(review.querySelector('[data-clean-up-diff]') === null).toBe(true);
    expect(review.querySelector('del, ins') === null).toBe(true);
    expect(
      [...review.querySelectorAll('[data-clean-up-note]')].map(note => note.getAttribute('data-clean-up-note')),
    ).toEqual(['unknown_model', 'suggestion']);
    await click(byText(review, 'button', 'Accept'));
    await waitFor(() => accepted.length === 1, 'the accept');
    expect(accepted[0]).toEqual({ prompt: WRITTEN_SUGGESTION.after, suggested: WRITTEN_SUGGESTION.suggested });
    await waitForText(root, 'gpt-6-astra wrote');
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(true);
  });

  it('puts the written prompt in the box on Edit first, even from the nudge', async () => {
    const root = await card(
      NUDGE_VIEW,
      {},
      { initial: { job: { ...WRITING_JOB, status: 'suggested' }, suggestion: WRITTEN_SUGGESTION } },
    );
    await click(must(root.querySelector('[data-review="edit"]'), 'edit'));
    expect(field(root).value).toBe(WRITTEN_SUGGESTION.after);
    expect(action(root, 'save').disabled).toBe(false);
  });

  it('discards the written prompt and goes back to the nudge, writing nothing', async () => {
    const root = await card(
      NUDGE_VIEW,
      {},
      { initial: { job: { ...WRITING_JOB, status: 'suggested' }, suggestion: WRITTEN_SUGGESTION } },
    );
    await click(must(root.querySelector('[data-review="discard"]'), 'discard'));
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(true);
    expect(root.querySelector('[data-routing-nudge]') === null).toBe(false);
  });

  it('shows a before and an after when a prompt was there to build on', async () => {
    const root = await card(
      OWNER_VIEW,
      {},
      {
        initial: {
          job: { ...WRITING_JOB, status: 'suggested' },
          suggestion: { ...WRITTEN_SUGGESTION, before: OWNER_PROMPT },
        },
      },
    );
    expect(root.querySelector('[data-clean-up-diff]') === null).toBe(false);
    expect(root.querySelector('[data-clean-up-fresh]') === null).toBe(true);
  });

  it('says a prompt was written by, not cleaned up by, once accepted', async () => {
    const root = await card({
      ...OWNER_VIEW,
      routing: {
        text: WRITTEN_SUGGESTION.after,
        source: 'file',
        suggested: { ...WRITTEN_SUGGESTION.suggested, acceptedAt: '2026-10-22T14:31:00.000Z' },
      },
    });
    expect(textOf(sourceOf(root))).toMatch(/^Written by gpt-6-astra via codex-main, accepted /u);
  });
});

describe('the clean-up review', () => {
  const reviewing = (overrides: Partial<State> = {}, view: RoutingPromptCardProps['view'] = OWNER_VIEW) =>
    card(view, overrides, { initial: { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION } });

  it('shows a word diff that is not colour alone, then every note', async () => {
    const root = await reviewing();
    const diff = must(root.querySelector('[data-clean-up-diff]'), 'diff');
    const removed = [...diff.querySelectorAll('del[data-diff="removed"]')];
    const added = [...diff.querySelectorAll('ins[data-diff="added"]')];
    expect(removed.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThan(0);
    expect(textOf(must(removed[0], 'removed'))).toContain('[removed: ');
    expect(textOf(must(added[0], 'added'))).toContain('[added: ');
    const kinds = [...root.querySelectorAll('[data-clean-up-note]')].map(note =>
      note.getAttribute('data-clean-up-note'),
    );
    expect(kinds).toEqual(['unknown_model', 'absent_model', 'cut', 'suggestion']);
    expect(textOf(root)).toContain('No catalog lists glm-9');
    expect(textOf(root)).toContain('Nothing is saved until you accept it.');
  });

  it('accepts the rewrite with who made it, then closes the review', async () => {
    const accepted: PackRoutingAcceptRequest[] = [];
    const root = await reviewing({
      accept: async request => {
        accepted.push(request);
        return { kind: 'applied', message: 'Routing prompt saved. Undo puts the old one back.' };
      },
    });
    await click(byText(root, 'button', 'Accept'));
    await waitFor(() => accepted.length === 1, 'the accept');
    expect(accepted[0]).toEqual({ prompt: SUGGESTION.after, suggested: SUGGESTION.suggested });
    await waitForText(root, 'Undo puts the old one back.');
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(true);
    expect(field(root).value).toBe(SUGGESTION.after);
  });

  it('keeps the review open and says why when an accept is refused', async () => {
    const root = await reviewing({ accept: async () => ({ kind: 'refused', message: 'The file moved.' }) });
    await click(byText(root, 'button', 'Accept'));
    await waitForText(root, 'The file moved.');
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(false);
  });

  it('discards the rewrite without writing anything', async () => {
    let writes = 0;
    const root = await reviewing({
      accept: async () => {
        writes += 1;
        return { kind: 'applied', message: 'no' };
      },
    });
    await click(must(root.querySelector('[data-review="discard"]'), 'discard'));
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(true);
    expect(root.querySelector('[data-clean-up-job]') === null).toBe(true);
    expect(field(root).value).toBe(OWNER_PROMPT);
    expect(writes).toBe(0);
  });

  it('loads the rewrite into the box on Edit first, without saving it', async () => {
    let saves = 0;
    const root = await reviewing({
      savePrompt: async () => {
        saves += 1;
        return { kind: 'applied' };
      },
    });
    await click(must(root.querySelector('[data-review="edit"]'), 'edit'));
    expect(field(root).value).toBe(SUGGESTION.after);
    expect(root.querySelector('[data-clean-up-review]') === null).toBe(true);
    expect(action(root, 'save').disabled).toBe(false);
    expect(saves).toBe(0);
  });
});

describe('undo', () => {
  it('is offered only while an accepted clean-up can be undone', async () => {
    let root = await card(OWNER_VIEW);
    expect(root.querySelector('[data-routing-action="undo"]') === null).toBe(true);
    await shown?.unmount();

    let undone = 0;
    root = await card(
      { ...OWNER_VIEW, undo: { savedAt: '2026-10-22T14:35:00.000Z', source: 'file' } },
      {
        undo: async () => {
          undone += 1;
          return { kind: 'applied', message: 'Put the old routing prompt back.' };
        },
      },
    );
    await click(action(root, 'undo'));
    await waitForText(root, 'Put the old routing prompt back.');
    expect(undone).toBe(1);
  });

  it('shows a new prompt under an untouched box, and keeps a draft being written', async () => {
    const root = await card(OWNER_VIEW);
    await must(shown, 'mounted').render(
      <RoutingPromptCard
        connection={alpha}
        view={{ ...OWNER_VIEW, routing: { text: 'Opus for everything.', source: 'file' } }}
        state={IDLE_ROUTING_API}
      />,
    );
    expect(field(root).value).toBe('Opus for everything.');

    await typeInto(field(root), 'My own draft.');
    await must(shown, 'mounted').render(
      <RoutingPromptCard
        connection={alpha}
        view={{ ...OWNER_VIEW, routing: { text: 'Somebody else saved this.', source: 'file' } }}
        state={IDLE_ROUTING_API}
      />,
    );
    expect(field(root).value).toBe('My own draft.');
  });
});

describe('available now', () => {
  it('lists every model usable here in the daemon’s order, with where the prompt names it', async () => {
    const root = await card(OWNER_VIEW);
    const rows = [...root.querySelectorAll<HTMLElement>('[data-available-model]')];
    expect(rows.map(row => row.getAttribute('data-available-model'))).toEqual([
      'claude-opus-5-5',
      'gpt-6-astra',
      'claude-haiku-4-5',
    ]);
    const opus = must(rows[0], 'opus');
    const astra = must(rows[1], 'astra');
    const haiku = must(rows[2], 'haiku');
    expect(textOf(opus)).toContain('Claude Opus 5.5');
    expect(textOf(opus)).toContain('claude-main');
    expect(textOf(opus)).toContain('Named 1st');
    expect(textOf(opus)).toContain('Effort max');
    expect(textOf(opus)).toContain('Plenty of quota');
    expect(textOf(astra)).toContain('Named 2nd');
    expect(textOf(astra)).toContain('Low quota');
    expect(textOf(astra)).not.toContain('Effort');
    expect(haiku.getAttribute('data-available-ready')).toBe('no');
    expect(textOf(haiku)).toContain('Not ready');
    expect(textOf(must(haiku.querySelector('[data-available-refusal]'), 'refusal'))).toBe(
      'claude-spare is out of quota until 18:00Z. Wait for the reset, or add a login.',
    );
    expect(textOf(haiku)).not.toContain('Named');
  });

  it('says when nothing here can start', async () => {
    const root = await card({ ...OWNER_VIEW, available: [] });
    expect(textOf(root)).toContain('No runtime on this machine offers a model right now.');
  });
});
