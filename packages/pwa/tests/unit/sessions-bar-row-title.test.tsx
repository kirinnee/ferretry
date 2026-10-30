import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { SessionsBarRow } from '../../src/shell/sessions-bar-row.tsx';
import { type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const draw = async (view: SessionView, machine?: string): Promise<Element> => {
  mounted = await mount(
    <ul>
      <SessionsBarRow
        active={false}
        daemonId={DAEMON}
        learningPassive={false}
        {...(machine === undefined ? {} : { machine })}
        onNavigate={() => undefined}
        view={view}
      />
    </ul>,
  );
  return must(mounted.container.querySelector(`[data-sbar-session="${view.config.id}"]`), 'the row');
};

const outdated = (view: SessionView): SessionView => ({ ...view, outdated: { sections: ['pack'] } }) as never;

describe('SessionsBarRow title', () => {
  test('a labelled session shows its name, so a rename is seen, and never its batch label', async () => {
    const row = await draw(sessionView('cyan', { config: { name: 'CyanPrint', label: 'diene-cyan' } }));
    expect(row.querySelector('.fy-sbar__name')?.textContent).toBe('CyanPrint');
    expect(row.textContent).not.toContain('diene-cyan');
    await mounted?.unmount();

    const renamed = await draw(sessionView('cyan', { config: { name: 'CyanPrint v2', label: 'diene-cyan' } }));
    expect(renamed.querySelector('.fy-sbar__name')?.textContent).toBe('CyanPrint v2');
  });
});

describe('SessionsBarRow outdated glyph', () => {
  test('is a compact icon in the marks cell, so the name keeps its own cell and is never cut for it', async () => {
    const row = await draw(outdated(sessionView('stale-1', { config: { name: 'Quest for the web address' } })));
    const mark = must(row.querySelector('[data-outdated-mark]'), 'the glyph');
    expect(mark.textContent).toBe('');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.getAttribute('aria-label')).toStartWith('Outdated — restart to load new instructions');
    expect(mark.closest('.fy-sbar__marks')).not.toBeNull();
    expect(row.querySelector('.fy-sbar__title [data-outdated-mark]')).toBeNull();
    expect(row.querySelector('.fy-sbar__name')?.textContent).toBe('Quest for the web address');
  });

  test('sits beside the unread badge and beside the machine chip, and is absent on an up-to-date row', async () => {
    const waiting = outdated(
      sessionView('stale-2', {
        state: { attention: { open: 1, first: 'A1', ask: 'Which web address?', latestAt: '2026-10-16T11:59:00.000Z' } },
      }),
    );
    const row = await draw(waiting, 'kirin-box');
    const marks = must(row.querySelector('.fy-sbar__marks'), 'the marks');
    expect(marks.querySelector('[data-outdated-mark]')).not.toBeNull();
    expect(marks.querySelector('.fy-unread-badge')).not.toBeNull();
    expect(marks.querySelector('[data-machine-chip]')?.textContent).toBe('kirin-box');
    await mounted?.unmount();

    const quiet = await draw(outdated(sessionView('stale-3')), 'kirin-box');
    expect(quiet.querySelector('.fy-sbar__marks [data-outdated-mark]')).not.toBeNull();
    expect(quiet.querySelector('[data-machine-chip]')?.textContent).toBe('kirin-box');
    await mounted?.unmount();

    const fresh = await draw(sessionView('fresh-1'));
    expect(fresh.querySelector('[data-outdated-mark]')).toBeNull();
    expect(fresh.querySelector('.fy-sbar__marks')).toBeNull();
  });
});
