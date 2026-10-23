import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { PackSessionsProvider } from '../../src/components/pack-call.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { PackCall, PackStartCall, PackStartOutcome } from '../../src/lib/pack-calls.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const row = (pack: PackCall): TranscriptEntry => ({
  id: 'pack:k1',
  kind: 'tool',
  text: 'started a sub-ferret',
  at: Date.UTC(2026, 9, 20, 2, 0, 0),
  tools: [{ key: 'k1', use: { name: 'Bash', input: { command: 'fy new --auto "Review it"' } }, result: { text: '' } }],
  pack,
});

const started = (overrides: Partial<Extract<PackStartOutcome, { outcome: 'started' }>> = {}): PackStartOutcome => ({
  outcome: 'started',
  id: 'mvnadia-1',
  teammate: 'nadia',
  runtime: 'claude-auto-work',
  model: 'claude-opus-5-5',
  decidedBy: 'you',
  attempts: [{ runtime: 'claude-auto-work', model: 'claude-opus-5-5', outcome: 'started', probe: 812 }],
  ...overrides,
});

const start = (overrides: Partial<PackStartCall> = {}): PackStartCall => ({
  kind: 'new',
  runtime: 'claude-auto-work',
  model: 'claude-opus-5-5',
  effort: 'high',
  auto: false,
  brief: 'Review the pack service for races.\n\nReport **findings**.',
  progress: { state: 'done', value: started() },
  ...overrides,
});

const child = sessionView('mvnadia-1', {
  config: { teammate: 'nadia', parent: 'lead' },
  state: { status: 'running', turnState: 'needs-input', turnPrompt: 'Trust this folder?' },
});

const show = async (pack: PackCall, sessions?: readonly SessionView[]) => {
  view = await mount(
    <ReferenceSurfaceProvider
      surface={{
        agentReferenceResolver: createAgentReferenceResolver('d1' as DaemonId, sessions ?? [child]),
        onNavigate: () => undefined,
      }}
    >
      <PackSessionsProvider sessions={sessions}>
        <TranscriptRow entry={row(pack)} previous={{ id: 'a', kind: 'assistant', text: 'ok' }} />
      </PackSessionsProvider>
    </ReferenceSurfaceProvider>,
  );
  return must(view.container.querySelector<HTMLElement>('.fy-message-pack'), 'the card');
};

const lines = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.fy-pack-line')].map(line => line.textContent ?? '');

describe('a sub-ferret start in the parent’s chat', () => {
  test('is a "Started sub-ferret" card: the proved name, what it runs on, the probe, its live state and brief', async () => {
    const card = await show(start(), [child]);
    expect(card.dataset['packKind']).toBe('start');
    expect(card.dataset['packState']).toBe('started');
    expect(card.dataset['transcriptDensity']).toBe('message');
    expect(card.querySelector('header')?.textContent).toContain('Started sub-ferret');
    expect(must(card.querySelector('header a'), 'the link').getAttribute('href')).toBe('/d/d1/session/mvnadia-1');
    expect(lines(card)).toEqual([
      'claude-auto-work · claude-opus-5-5 · effort high',
      'decided by you · answered the probe in 812 ms',
      'Needs you — Trust this folder?',
    ]);
    // The brief is folded to its first line and opens to the whole, as Markdown.
    const brief = must(card.querySelector<HTMLDetailsElement>('.fy-pack-fold'), 'the brief');
    expect(brief.open).toBe(false);
    expect(brief.querySelector('.fy-pack-fold-preview')?.textContent).toBe('Review the pack service for races.');
    expect(brief.querySelector('.fy-pack-fold-body strong')?.textContent).toBe('findings');
    // No result yet, and the command is one tap away.
    expect(card.querySelector('[data-pack-collected]')).toBeNull();
    const toggle = must(card.querySelector<HTMLButtonElement>('.fy-sent-command-toggle'), 'the toggle');
    await interact(() => toggle.click());
    expect(toggle.textContent).toBe('Hide command');
    expect(card.textContent).toContain('Bash');
  });

  test('lists every candidate tried, a Jev note and a cached probe; says nothing live it cannot see', async () => {
    const card = await show(
      start({
        effort: undefined,
        progress: {
          state: 'done',
          value: started({
            decidedBy: 'jev',
            note: 'Jev could not answer, so the routing prompt decided.',
            model: undefined,
            effort: 'max',
            attempts: [
              {
                runtime: 'codex-w',
                model: 'gpt-6-astra',
                outcome: 'refused',
                probe: 0,
                code: 'out_of_quota',
                message: 'used up',
              },
              { runtime: 'claude-w', outcome: 'refused', code: 'cli_missing', message: '' },
              { runtime: 'claude-auto-work', outcome: 'started', probe: 'cached' },
            ],
          }),
        },
      }),
      [],
    );
    expect(lines(card)).toEqual([
      'claude-auto-work · claude-opus-5-5 · effort max',
      'decided by jev · probe cached',
      'Jev could not answer, so the routing prompt decided.',
    ]);
    const tried = must(card.querySelectorAll<HTMLDetailsElement>('.fy-pack-fold')[0], 'the attempts');
    expect(tried.querySelector('.fy-pack-fold-label')?.textContent).toBe('Tried 3 candidates');
    expect([...tried.querySelectorAll('li')].map(item => item.textContent)).toEqual([
      'refused codex-w · gpt-6-astra (probe 0 ms) — out_of_quota: used up',
      'refused claude-w — cli_missing',
      'started claude-auto-work (probe cached)',
    ]);
    // Not in the session list read: no live line, and the name is plain text.
    expect(card.querySelector('[data-pack-live]')).toBeNull();
    expect(card.querySelector('header .fy-peer-name')?.textContent).toBe('Nadia');
  });

  test('renders who decided in the words it was given, a multi-word decider included', async () => {
    const card = await show(
      start({ progress: { state: 'done', value: started({ decidedBy: 'the routing prompt', attempts: [] }) } }),
    );
    expect(lines(card)).toContain('decided by the routing prompt');
  });

  test('a start with no probe on record says only who decided', async () => {
    const card = await show(start({ progress: { state: 'done', value: started({ attempts: [] }) } }));
    expect(lines(card)).toContain('decided by you');
  });

  test('folds a collected result INTO the card, in every state a wait can be in', async () => {
    const cases: Array<[PackStartCall['collected'], string, string[]]> = [
      [{ state: 'running' }, 'Waiting for its result…', []],
      [
        { state: 'done', value: { status: 'completed', summary: 'Found **two** races.', stopped: true, note: 'n' } },
        'Result collected',
        ['Ended completed · stopped once its result was collected', 'n'],
      ],
      [
        { state: 'done', value: { status: 'awaiting_user', stopped: false } },
        'Result collected',
        ['Ended awaiting user', 'It reported no result.'],
      ],
      [{ state: 'failed', reason: 'the daemon went away' }, 'Could not collect its result', ['the daemon went away']],
      [{ state: 'unread' }, 'Result collected — not recognised; see the command', []],
    ];
    for (const [collected, title, said] of cases) {
      const card = await show(start({ collected }));
      const result = must(card.querySelector<HTMLElement>('[data-pack-collected]'), 'the result');
      expect(result.querySelector('.fy-pack-section-title')?.textContent).toBe(title);
      expect([...result.querySelectorAll('.fy-pack-line')].map(line => line.textContent)).toEqual(said);
      if (collected?.state === 'done' && collected.value.summary !== undefined)
        expect(result.querySelector('.fy-pack-result-body strong')?.textContent).toBe('two');
      await view?.unmount();
      view = null;
    }
  });

  test('says starting, failed and not recognised without claiming a ferret', async () => {
    let card = await show(start({ progress: { state: 'running' } }));
    expect(card.querySelector('header')?.textContent).toBe('Starting a sub-ferret…');
    expect(lines(card)).toEqual(['claude-auto-work · claude-opus-5-5 · effort high']);
    await view?.unmount();

    card = await show(
      start({
        auto: true,
        runtime: undefined,
        model: undefined,
        effort: undefined,
        progress: { state: 'failed', reason: 'the daemon is not running' },
      }),
    );
    expect(card.dataset['packState']).toBe('failed');
    expect(card.querySelector('header')?.textContent).toBe('Could not start a sub-ferret');
    expect(must(card.querySelector('[role="alert"]'), 'the alert').textContent).toBe('the daemon is not running');
    expect(lines(card)[0]).toBe('chosen by Ferretry');
    await view?.unmount();

    card = await show(
      start({ runtime: undefined, model: undefined, effort: undefined, progress: { state: 'unread' } }),
    );
    expect(card.querySelector('header')?.textContent).toBe('Sub-ferret start');
    expect(lines(card)).toEqual(['Its answer was not recognised — see the command.']);
  });

  test('a brief it could not see says where it came from; an empty one says nothing', async () => {
    let card = await show(start({ brief: null, briefFile: '/tmp/brief.md' }));
    expect(lines(card)).toContain('The brief was read from /tmp/brief.md.');
    await view?.unmount();
    card = await show(start({ brief: null }));
    expect(lines(card)).toContain('The brief was composed by a shell command.');
    await view?.unmount();
    card = await show(start({ brief: '' }));
    expect(card.querySelector('.fy-pack-fold')).toBeNull();
  });
});

describe('a refused start', () => {
  test('names the code and message out loud, the remedy, every attempt, and that it tried again', async () => {
    const card = await show(
      start({
        retried: true,
        progress: {
          state: 'done',
          value: {
            outcome: 'refused',
            code: 'probe_failed',
            message: 'codex-auto-work did not answer a "reply OK" check.',
            remedy: 'Try the next candidate.',
            attempts: [
              {
                runtime: 'codex-auto-work',
                model: 'gpt-6-astra',
                outcome: 'refused',
                probe: 45000,
                code: 'probe_failed',
                message: 'timed out',
              },
            ],
          },
        },
      }),
    );
    expect(card.dataset['packState']).toBe('refused');
    expect(card.querySelector('header')?.textContent).toBe('Sub-ferret not startedprobe_failed');
    expect(must(card.querySelector('[role="alert"]'), 'the alert').textContent).toBe(
      'codex-auto-work did not answer a "reply OK" check.',
    );
    expect(lines(card)).toEqual([
      'claude-auto-work · claude-opus-5-5 · effort high',
      'codex-auto-work did not answer a "reply OK" check.',
      'Try the next candidate.',
      'Tried again — the next start is below.',
    ]);
    expect(card.querySelector('[data-pack-attempts] li')?.textContent).toBe(
      'refused codex-auto-work · gpt-6-astra (probe 45000 ms) — probe_failed: timed out',
    );
  });

  test('with nothing tried, no remedy and nothing asked, says only the refusal', async () => {
    const card = await show(
      start({
        auto: false,
        runtime: undefined,
        model: undefined,
        effort: undefined,
        progress: {
          state: 'done',
          value: { outcome: 'refused', code: 'pack_off', message: 'Pack mode is off.', attempts: [] },
        },
      }),
    );
    expect(lines(card)).toEqual(['Pack mode is off.']);
    expect(card.querySelector('[data-pack-attempts]')).toBeNull();
    expect(card.querySelector('[data-pack-retried]')).toBeNull();
  });
});

describe('a wait no card started, and a recommendation', () => {
  test('a standalone wait names the ferret, how it is doing, and the result', async () => {
    const card = await show(
      {
        kind: 'wait',
        id: 'mvnadia-1',
        progress: { state: 'done', value: { status: 'completed', summary: 'ok', stopped: false } },
      },
      [child],
    );
    expect(card.dataset['packKind']).toBe('wait');
    expect(card.dataset['packState']).toBe('done');
    expect(card.querySelector('header')?.textContent).toContain('Waited for');
    expect(card.querySelector('[data-pack-live]')?.textContent).toBe('Needs you — Trust this folder?');
    expect(card.querySelector('.fy-pack-section-title')?.textContent).toBe('Result collected');
  });

  test('a recommendation folds the routing prompt and the models usable now under the task, ready or not', async () => {
    const card = await show({
      kind: 'recommend',
      task: 'review the auth change',
      progress: {
        state: 'done',
        value: {
          routing: 'Planning and review → **claude-opus-5-5** at max.\n\nChores → claude-haiku-5-5.',
          source: 'your routing prompt',
          options: [
            {
              ready: true,
              model: 'Claude Opus 5.5',
              id: 'claude-opus-5-5',
              runtime: 'claude-auto-work',
              effort: 'max',
              named: 1,
              quota: '5h 2% · week 46%',
            },
            {
              ready: false,
              model: 'GPT 6 Astra',
              id: 'gpt-6-astra',
              runtime: 'codex-work',
              refusal: 'cli_missing: codex is not installed',
            },
          ],
          next: 'fy new …',
        },
      },
    });
    expect(card.dataset['packKind']).toBe('recommend');
    expect(card.querySelector('header')?.textContent).toBe('Asked which model suits');
    expect(card.querySelector('.fy-pack-task')?.textContent).toBe('review the auth change');
    const [routing, models] = [...card.querySelectorAll<HTMLDetailsElement>('.fy-pack-fold')];
    // The prompt is folded to its first line, says where it came from, and opens to the whole as Markdown.
    expect(must(routing, 'the routing prompt').open).toBe(false);
    expect(routing?.querySelector('.fy-pack-fold-label')?.textContent).toBe('Routing prompt');
    expect(routing?.querySelector('.fy-pack-fold-preview')?.textContent).toBe(
      'Planning and review → **claude-opus-5-5** at max.',
    );
    expect(routing?.querySelector('.fy-pack-line')?.textContent).toBe('your routing prompt');
    expect(routing?.querySelector('.fy-pack-fold-body strong')?.textContent).toBe('claude-opus-5-5');
    expect(routing?.textContent).toContain('Chores → claude-haiku-5-5.');
    const fold = must(models, 'the list');
    expect(fold.querySelector('.fy-pack-fold-label')?.textContent).toBe('2 models, 1 ready');
    expect(fold.querySelector('.fy-pack-fold-preview')?.textContent).toBe('Claude Opus 5.5');
    expect([...fold.querySelectorAll('[data-pack-options] li')].map(item => item.textContent)).toEqual([
      'Claude Opus 5.5ready claude-auto-work · claude-opus-5-5 · effort maxnamed 1st in the prompt · quota 5h 2% · week 46%',
      'GPT 6 Astracannot run codex-work · gpt-6-astracli_missing: codex is not installed',
    ]);
    expect(fold.textContent).not.toContain('Nothing can run it here now.');
  });

  test('a recommendation that is asking, failed, unread, or has nothing ready says so', async () => {
    const said = async (progress: Extract<PackCall, { kind: 'recommend' }>['progress'], task: string | null = null) => {
      const card = await show({ kind: 'recommend', task, progress });
      const text = card.textContent ?? '';
      await view?.unmount();
      view = null;
      return text;
    };
    expect(await said({ state: 'running' })).toContain('Asking…');
    expect(await said({ state: 'failed', reason: 'no route' }, '')).toContain('no route');
    expect(await said({ state: 'unread' })).toContain('not recognised');
    expect(await said({ state: 'done', value: { routing: 'Chores → haiku.', options: [] } })).toContain(
      'Nothing can run it here now.',
    );
  });
});
