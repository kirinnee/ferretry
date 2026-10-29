/** Info › Runtime: the CLI, the login, requested vs observed model, effort, and what it can reach. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  type InfoListRead,
  InfoRuntime,
  type InfoRuntimeProps,
} from '../../../../src/features/session-info/info-runtime.tsx';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const show = async (overrides: Partial<InfoRuntimeProps> = {}) => {
  mounted = await mount(
    <InfoRuntime
      instructions={{ kind: 'loading' }}
      mcp={{ kind: 'loading' }}
      skills={null}
      view={sessionView('session-a', { config: { agent: 'claude-default', model: 'opus', mode: 'auto' } })}
      {...overrides}
    />,
  );
  return mounted.container;
};

describe('InfoRuntime — CLI, login and effort', () => {
  it('names the CLI, the login and its scope chip, and the mode', async () => {
    const root = await show({
      view: sessionView('session-a', { config: { harness: 'codex', agent: 'codex-default', mode: 'interactive' } }),
    });
    expect(root.textContent).toContain('Codex');
    expect(root.textContent).toContain('codex-default');
    expect(root.textContent).toContain('Codex-only');
    expect(root.textContent).toContain('interactive');
  });

  it('reads effort from the CLI, else the launch level, else default', async () => {
    const observed = await show({
      view: sessionView('session-a', { state: { observedReasoningEffort: 'high' } }),
    });
    expect(must(observed.querySelector('[data-info-row="Effort"]'), 'effort').textContent).toContain('high');

    await mounted?.unmount();
    mounted = undefined;
    const defaulted = await show({ view: sessionView('session-a') });
    expect(must(defaulted.querySelector('[data-info-row="Effort"]'), 'effort').textContent).toContain('default');
  });

  it('always shows Ferretry tools as On', async () => {
    const root = await show();
    expect(must(root.querySelector('[data-info-row="Ferretry tools"]'), 'ferretry tools').textContent).toContain('On');
  });
});

describe('InfoRuntime — model', () => {
  it('shows requested and observed as em dashes before either is known, with no mismatch chip', async () => {
    const root = await show({ view: sessionView('session-a', { config: { model: undefined, modelHint: undefined } }) });
    expect(root.querySelector('[data-info-model-requested]')?.textContent).toBe('—');
    expect(root.querySelector('[data-info-model-observed]')?.textContent).toBe('not reported yet');
    expect(root.textContent).not.toContain('Mismatch');
  });

  it('flags a genuine mismatch between requested and observed', async () => {
    const root = await show({
      view: sessionView('session-a', { config: { model: 'opus' }, state: { observedModel: 'claude-haiku-5' } }),
    });
    expect(root.textContent).toContain('Mismatch');
  });

  it('is not a mismatch when the observed model carries the requested alias', async () => {
    const root = await show({
      view: sessionView('session-a', {
        config: { model: 'opus' },
        state: { observedModel: 'claude-opus-4-5-20251101' },
      }),
    });
    expect(root.textContent).not.toContain('Mismatch');
  });
});

describe('InfoRuntime — controls slot', () => {
  it('draws nothing in the Change row without a host, and the host’s controls when given one', async () => {
    const without = await show();
    expect(without.querySelector('[data-info-row="Change"]')).toBeNull();

    await mounted?.unmount();
    mounted = undefined;
    const root = await show({ controls: <button type="button">Switch model</button> });
    expect(must(root.querySelector('[data-info-row="Change"]'), 'change row').textContent).toContain('Switch model');
  });
});

describe('InfoRuntime — Other MCP and Instructions', () => {
  const list = (value: InfoListRead) => value;

  it('says it is reading, and reports a failure', async () => {
    const reading = await show({ mcp: list({ kind: 'loading' }) });
    expect(must(reading.querySelector('[data-info-row="Other MCP"]'), 'mcp row').textContent).toContain('Reading…');

    await mounted?.unmount();
    mounted = undefined;
    const failed = await show({ mcp: list({ kind: 'failed', reason: 'offline' }) });
    expect(must(failed.querySelector('[data-info-row="Other MCP"]'), 'mcp row').textContent).toContain(
      'Couldn’t read: offline',
    );
  });

  it('says None for an empty list, and lists what it found otherwise', async () => {
    const empty = await show({ mcp: list({ kind: 'ready', items: [] }) });
    expect(must(empty.querySelector('[data-info-row="Other MCP"]'), 'mcp row').textContent).toContain('None');

    await mounted?.unmount();
    mounted = undefined;
    const ready = await show({ mcp: list({ kind: 'ready', items: ['linear', 'notion'] }) });
    expect(must(ready.querySelector('[data-info-row="Other MCP"]'), 'mcp row').textContent).toContain('linear, notion');
  });

  it('lists instruction files, with its own empty copy', async () => {
    const empty = await show({ instructions: list({ kind: 'ready', items: [] }) });
    expect(must(empty.querySelector('[data-info-row="Instruction files"]'), 'row').textContent).toContain(
      'None at the folder’s root',
    );

    await mounted?.unmount();
    mounted = undefined;
    const ready = await show({ instructions: list({ kind: 'ready', items: ['CLAUDE.md', 'AGENTS.md'] }) });
    expect(must(ready.querySelector('[data-info-row="Instruction files"]'), 'row').textContent).toContain(
      'CLAUDE.md, AGENTS.md',
    );
  });
});

describe('InfoRuntime — skills', () => {
  it('says it is reading while unread, and how many are available once read', async () => {
    const reading = await show({ skills: null });
    expect(must(reading.querySelector('[data-info-row="Skills"]'), 'skills').textContent).toContain('Reading…');

    await mounted?.unmount();
    mounted = undefined;
    const root = await show({ skills: 5 });
    expect(must(root.querySelector('[data-info-row="Skills"]'), 'skills').textContent).toBe('Skills5 available');
  });
});

describe('InfoRuntime — learning', () => {
  const row = (root: HTMLElement) => must(root.querySelector('[data-info-row="Learning"]'), 'learning row');

  it('draws no row when the host has no passive-learning read', async () => {
    const root = await show();
    expect(root.querySelector('[data-info-row="Learning"]')).toBeNull();
  });

  it('says the ferret is instructed to file lessons when passive learning is on', async () => {
    const root = await show({ learning: true });
    expect(row(root).textContent).toContain('On · instructed to file lessons');
    expect(root.querySelector('[data-info-learning="on"]')).not.toBeNull();
  });

  it('says it is not instructed when passive learning is off', async () => {
    const root = await show({ learning: false });
    expect(row(root).textContent).toContain('Off · not instructed');
    expect(root.querySelector('[data-info-learning="off"]')).not.toBeNull();
  });

  it('says it has not heard yet rather than guessing off', async () => {
    const root = await show({ learning: null });
    expect(row(root).textContent).toContain('Not reported yet');
    expect(root.querySelector('[data-info-learning]')).toBeNull();
  });
});

describe('InfoRuntime — agenda mode', () => {
  it('says notify rule only while the session has no switch', async () => {
    const root = await show();
    expect(root.querySelector('[data-info-agenda="off"]')?.textContent).toBe('Off · notify rule only');
  });

  it('says it keeps an agenda when the owner switched it on', async () => {
    const root = await show({ view: sessionView('session-a', { config: { agenda: true } }) });
    expect(must(root.querySelector('[data-info-row="Agenda mode"]'), 'agenda row').textContent).toContain(
      'On · keeps an agenda of open items',
    );
    expect(root.querySelector('[data-info-agenda="on"]')).not.toBeNull();
  });
});

describe('InfoRuntime — hypermedia', () => {
  it('reads the switch off the session itself, absent as the mode default', async () => {
    const root = await show({ view: sessionView('session-a', { config: { mode: 'interactive' } }) });
    expect(must(root.querySelector('[data-info-row="Hypermedia"]'), 'hypermedia row').textContent).toContain(
      'On · may explain with diagrams and media',
    );
    expect(root.querySelector('[data-info-hypermedia="on"]')).not.toBeNull();
  });

  it('says plain text for an auto ferret that has no switch', async () => {
    const root = await show();
    expect(root.querySelector('[data-info-hypermedia="off"]')?.textContent).toBe('Off · plain text');
  });

  it('says plain text when the owner switched it off', async () => {
    const root = await show({ view: sessionView('session-a', { config: { hypermedia: false } }) });
    expect(root.querySelector('[data-info-hypermedia="off"]')?.textContent).toBe('Off · plain text');
  });
});

describe('InfoRuntime — Pack mode', () => {
  it('reads the switch off the session itself, absent as on, and says when a change lands', async () => {
    const root = await show();
    const row = must(root.querySelector('[data-info-row="Pack mode"]'), 'pack row');
    expect(row.textContent).toContain('On · may delegate to sub-ferrets');
    expect(row.textContent).toContain('takes effect at the next launch');
  });

  it('says it works alone when the owner switched it off', async () => {
    const root = await show({ view: sessionView('session-a', { config: { pack: false } }) });
    expect(root.querySelector('[data-info-pack="off"]')?.textContent).toBe('Off · works alone');
  });
});

describe('InfoRuntime — Remote control', () => {
  it('says off for a session that did not ask for it', async () => {
    const root = await show();
    must(root.querySelector('[data-info-row="Remote control"]'), 'remote control row');
    expect(root.querySelector('[data-info-remote-control="off"]')?.textContent).toBe('Off');
  });

  it('says on only when the session explicitly asked for it', async () => {
    const root = await show({ view: sessionView('session-a', { config: { remoteControl: true } }) });
    expect(root.querySelector('[data-info-remote-control="on"]')?.textContent).toBe(
      'On · another device can drive this session',
    );
  });

  it('says it is not available on Codex', async () => {
    const root = await show({ view: sessionView('session-a', { config: { harness: 'codex' } }) });
    expect(root.querySelector('[data-info-remote-control="off"]')?.textContent).toBe('Not available on Codex');
  });
});

describe('InfoRuntime — Instructions', () => {
  it('lists each launch section with its size, the mode and whether it may ask questions', async () => {
    const root = await show({
      view: sessionView('session-a', {
        state: {
          launchInstructions: {
            sections: [
              { id: 'tools', chars: 640 },
              { id: 'settings', chars: 470 },
              { id: 'pack', chars: 1010 },
            ],
            mode: 'interactive',
            questions: true,
          },
        },
      }),
    });
    const row = must(root.querySelector('[data-info-row="Instructions"]'), 'instructions row');
    expect([...row.querySelectorAll('[data-info-launch-section]')].map(chip => chip.textContent)).toEqual([
      'Ferretry tools · 640 chars',
      'Settings rules · 470 chars',
      'Pack mode · 1k chars',
    ]);
    expect(row.querySelector('[data-info-launch-mode]')?.textContent).toBe('ModeInteractive');
    expect(row.querySelector('[data-info-launch-questions]')?.textContent).toBe('Can ask questionsYes');
    expect(row.querySelector('[data-info-launch-unrecorded]')).toBeNull();
  });

  it('says it is recorded from the next launch for a ferret launched before the record existed', async () => {
    const root = await show();
    const row = must(root.querySelector('[data-info-row="Instructions"]'), 'instructions row');
    expect(row.querySelector('[data-info-launch-unrecorded]')?.textContent).toBe('Recorded from the next launch');
    expect(row.querySelector('[data-info-launch-sections]')).toBeNull();
  });
});
