import { describe, expect, it } from 'bun:test';
import { LearningPage, type LearningPageProps } from '../../../../src/features/learning/learning-page.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must, pressKey } from '../../../support/dom.ts';
import {
  evidence,
  type FakeLearningDaemon,
  fakeLearningDaemon,
  learningDaemon,
  lesson,
  preview,
  progress,
} from '../../../support/learning.ts';
import { byText, click, maybeByText, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const SESSIONS = [
  sessionView('session-hadi', { config: { teammate: 'hadi', cwd: '/work/ferretry' } }),
  sessionView('session-kofi', { config: { teammate: 'kofi', cwd: '/work/home-manager' } }),
];

const LESSONS = [
  lesson({ id: 'gate', ruleText: 'Run the gate before pushing.', count: 9 }),
  lesson({
    id: 'biome',
    ruleText: 'Never biome a whole directory.',
    category: 'global',
    source: 'scan',
    target: { kind: 'global-instructions', path: '/fy/global.md' },
    evidence: [evidence({ observationId: 'o-9', sessionId: 'session-kofi', turn: undefined })],
  }),
  lesson({ id: 'tf', ruleText: 'Check the apply job first.', state: 'accepted' }),
  lesson({
    id: 'bun',
    ruleText: 'Prefer bun.',
    state: 'applied',
    applied: { at: lesson().lastSeen, path: '/fy/g.md' },
  }),
  lesson({ id: 'bare', ruleText: 'Bare applied.', state: 'applied' }),
  lesson({ id: 'tabs', ruleText: 'Indent with tabs.', state: 'rejected' }),
];

const hub = async (daemon: FakeLearningDaemon, props: Partial<LearningPageProps> = {}) => {
  const view = await mount(
    <LearningPage
      connection={learningDaemon}
      fetcher={daemon.fetch}
      sessions={SESSIONS}
      timeZone="UTC"
      estimateDelayMs={0}
      scanPollMs={5}
      {...props}
    />,
  );
  await waitForText(view.container, 'Run the gate before pushing.');
  return view;
};

const tab = (root: ParentNode, label: string): HTMLElement => byText(root, '[role="tab"]', label);
const row = (root: ParentNode, id: string): HTMLElement => must(root.querySelector(`[data-lesson="${id}"]`), id);
const open = async (root: ParentNode, id: string) => click(must(row(root, id).querySelector('button'), 'row header'));

describe('the Learning hub', () => {
  it('lists To review with strength, type and source chips, and counts every tab', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    const view = await hub(daemon);
    const text = textOf(view.container);
    expect(text).toContain('Learning hub');
    expect(text).toContain('fy lesson suggest');
    expect(tab(view.container, 'To review').textContent).toBe('To review2');
    expect(tab(view.container, 'Applied').textContent).toBe('Applied2');
    expect(tab(view.container, 'To review').getAttribute('aria-selected')).toBe('true');
    const chips = [...row(view.container, 'gate').querySelectorAll('[data-lesson-chip]')].map(chip => chip.textContent);
    expect(chips).toEqual(['9×', 'Repo · ferretry', 'passive · Hadi']);
    const scanChips = [...row(view.container, 'biome').querySelectorAll('[data-lesson-chip]')].map(c => c.textContent);
    expect(scanChips).toEqual(['1×', 'Global', 'scan']);
    expect(view.container.querySelector('[data-lesson="tf"]')).toBeNull();
    await view.unmount();
  });

  it('narrows by source and says so when a tab is empty', async () => {
    const view = await hub(fakeLearningDaemon(LESSONS));
    await click(must(view.container.querySelector('input[value="scan"]'), 'Scan filter'));
    expect(view.container.querySelector('[data-lesson="gate"]')).toBeNull();
    expect(tab(view.container, 'To review').textContent).toBe('To review1');
    await click(tab(view.container, 'Accepted'));
    expect(textOf(view.container)).toContain('No accepted lessons from scan.');
    await click(must(view.container.querySelector('input[value="all"]'), 'All filter'));
    expect(view.container.querySelector('[data-lesson="tf"]')).not.toBeNull();
    await view.unmount();
  });

  it('moves between tabs with the arrow, Home and End keys', async () => {
    const view = await hub(fakeLearningDaemon(LESSONS));
    const selected = () => must(view.container.querySelector('[role="tab"][aria-selected="true"]'), 'tab').id;
    await interact(() => pressKey(tab(view.container, 'To review'), 'ArrowLeft'));
    expect(selected()).toBe('learning-tab-rejected');
    await interact(() => pressKey(tab(view.container, 'Rejected'), 'ArrowRight'));
    expect(selected()).toBe('learning-tab-pending');
    await interact(() => pressKey(tab(view.container, 'To review'), 'ArrowRight'));
    expect(selected()).toBe('learning-tab-accepted');
    await interact(() => pressKey(tab(view.container, 'Accepted'), 'ArrowLeft'));
    expect(selected()).toBe('learning-tab-pending');
    await interact(() => pressKey(tab(view.container, 'To review'), 'End'));
    expect(selected()).toBe('learning-tab-rejected');
    await interact(() => pressKey(tab(view.container, 'Rejected'), 'Home'));
    expect(selected()).toBe('learning-tab-pending');
    await interact(() => pressKey(tab(view.container, 'To review'), 'Enter'));
    expect(selected()).toBe('learning-tab-pending');
    expect(document.activeElement?.id).toBe('learning-tab-pending');
    await view.unmount();
  });

  it('opens a lesson to its rule, type and evidence linked to the session', async () => {
    const navigated: string[] = [];
    const view = await hub(fakeLearningDaemon(LESSONS), { onNavigate: to => navigated.push(to) });
    await open(view.container, 'gate');
    const body = row(view.container, 'gate');
    expect(must(body.querySelector('button'), 'header').getAttribute('aria-expanded')).toBe('true');
    expect(textOf(body)).toContain('The ferret picked Repo; you can change it.');
    expect(textOf(body)).toContain('Writes to /work/ferretry/AGENTS.md');
    expect(textOf(body)).toContain('Evidence (1) — attached by the daemon');
    expect(textOf(body)).toContain('· turn 41');
    expect(textOf(body)).toContain('· 2026-10-16 09:40');
    const link = byText<HTMLAnchorElement>(body, 'a', 'Hadi');
    expect(link.getAttribute('href')).toBe('/d/daemon%2Fa/session/session-hadi');
    await click(link);
    expect(navigated).toEqual(['/d/daemon%2Fa/session/session-hadi']);
    // A second click closes it.
    await open(view.container, 'gate');
    expect(row(view.container, 'gate').querySelector('textarea')).toBeNull();
    // Evidence without a turn says nothing about one.
    await open(view.container, 'biome');
    expect(textOf(row(view.container, 'biome'))).not.toContain('turn');
    await view.unmount();
  });

  it('accepts, rejects, edits and re-types a lesson, saying what happened', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    const view = await hub(daemon);
    await open(view.container, 'gate');
    await click(must(row(view.container, 'gate').querySelector('input[value="global"]'), 'Global radio'));
    await waitForText(row(view.container, 'gate'), 'Global');
    expect(daemon.calls.at(-1)?.body).toEqual({ action: 'categorize', category: 'global' });
    // Choosing the type it already has sends nothing.
    const before = daemon.calls.length;
    await click(must(row(view.container, 'gate').querySelector('input[value="global"]'), 'Global radio'));
    expect(daemon.calls.length).toBe(before);

    await click(byText(row(view.container, 'gate'), 'button', 'Edit'));
    const field = must(row(view.container, 'gate').querySelector('textarea'), 'rule field');
    expect(field.readOnly).toBe(false);
    await typeInto(field, '   ');
    expect(byText<HTMLButtonElement>(row(view.container, 'gate'), 'button', 'Save edit').disabled).toBe(true);
    await click(byText(row(view.container, 'gate'), 'button', 'Cancel'));
    expect(must(row(view.container, 'gate').querySelector('textarea'), 'rule').readOnly).toBe(true);
    await click(byText(row(view.container, 'gate'), 'button', 'Edit'));
    await typeInto(must(row(view.container, 'gate').querySelector('textarea'), 'rule'), ' Gate first. ');
    await click(byText(row(view.container, 'gate'), 'button', 'Save edit'));
    await waitForText(view.container, 'Rule updated.');
    expect(daemon.calls.at(-1)?.body).toEqual({ action: 'edit', ruleText: 'Gate first.' });

    await click(byText(row(view.container, 'gate'), 'button', 'Accept'));
    await waitForText(view.container, 'Accepted — apply it from the Accepted tab.');
    expect(view.container.querySelector('[data-lesson="gate"]')).toBeNull();

    await open(view.container, 'biome');
    await click(byText(row(view.container, 'biome'), 'button', 'Reject'));
    await waitForText(view.container, 'Rejected.');
    await click(must(view.container.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(view.container.querySelector('[role="status"]')).toBeNull();

    await click(tab(view.container, 'Rejected'));
    await open(view.container, 'biome');
    expect(textOf(row(view.container, 'biome'))).toContain('Ferretry keeps it so the same lesson is not filed again.');
    expect(row(view.container, 'biome').querySelector('input[type="radio"]')).toBeNull();
    await view.unmount();
  });

  it('shows a refused verdict on the lesson itself', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    daemon.once('POST /v1/learning/proposals/gate', { status: 403, body: { error: 'fleet.configure is closed' } });
    daemon.once('POST /v1/learning/proposals/gate', { status: 500, body: {} });
    const view = await hub(daemon);
    await open(view.container, 'gate');
    await click(byText(row(view.container, 'gate'), 'button', 'Accept'));
    await waitForText(row(view.container, 'gate'), 'fleet.configure is closed');
    await click(byText(row(view.container, 'gate'), 'button', 'Edit'));
    await click(byText(row(view.container, 'gate'), 'button', 'Save edit'));
    await waitForText(row(view.container, 'gate'), 'HTTP 500');
    expect(byText(row(view.container, 'gate'), 'button', 'Save edit')).toBeTruthy();
    await view.unmount();
  });

  it('applies an accepted lesson only after showing the diff, and lands it in Applied', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    daemon.once('GET /v1/learning/proposals/tf/apply-preview', {
      body: preview({ proposalId: 'tf', exists: false, notes: ['No profile includes this component yet.'] }),
    });
    const view = await hub(daemon);
    await click(tab(view.container, 'Accepted'));
    await open(view.container, 'tf');
    await click(byText(row(view.container, 'tf'), 'button', 'Apply…'));
    await waitForText(row(view.container, 'tf'), 'Preview: what Ferretry will write');
    const body = row(view.container, 'tf');
    expect(textOf(body)).toContain('Creates /work/ferretry/AGENTS.md');
    expect(textOf(body)).toContain('No profile includes this component yet.');
    expect([...body.querySelectorAll('[data-diff-line]')].map(line => line.getAttribute('data-diff-line'))).toEqual([
      'meta',
      'meta',
      'hunk',
      'context',
      'remove',
      'add',
      'context',
    ]);
    expect(textOf(must(body.querySelector('figcaption'), 'diff caption'))).toContain('+1 −1');
    // Cancelling writes nothing.
    await click(byText(body, 'button', 'Cancel'));
    expect(row(view.container, 'tf').querySelector('[data-learning-diff]')).toBeNull();
    expect(daemon.calls.some(call => call.path.endsWith('/apply'))).toBe(false);

    await click(byText(row(view.container, 'tf'), 'button', 'Apply…'));
    await waitForText(row(view.container, 'tf'), 'Write to AGENTS.md');
    expect(textOf(row(view.container, 'tf'))).toContain('Changes /work/ferretry/AGENTS.md');
    await click(byText(row(view.container, 'tf'), 'button', 'Write to AGENTS.md'));
    await waitForText(view.container, 'Wrote the lesson to /work/ferretry/AGENTS.md.');
    expect(daemon.calls.at(-1)).toMatchObject({ method: 'POST', body: { etag: 'etag-1' } });
    await click(tab(view.container, 'Applied'));
    await open(view.container, 'tf');
    expect(textOf(row(view.container, 'tf'))).toContain('Applied to /work/ferretry/AGENTS.md · 2026-10-16 09:40');
    await open(view.container, 'bare');
    expect(textOf(row(view.container, 'bare'))).toContain('Applied.');
    await view.unmount();
  });

  it('refuses to write over a file that moved, and offers the new diff', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    daemon.once('POST /v1/learning/proposals/tf/apply', {
      status: 409,
      body: { error: 'moved', code: 'apply_conflict' },
    });
    daemon.once('POST /v1/learning/proposals/tf/apply', { status: 403, body: { error: 'passkey declined' } });
    daemon.once('GET /v1/learning/proposals/tf/apply-preview', { status: 404, body: { error: 'gone' } });
    const view = await hub(daemon);
    await click(tab(view.container, 'Accepted'));
    await open(view.container, 'tf');
    await click(byText(row(view.container, 'tf'), 'button', 'Apply…'));
    await waitForText(row(view.container, 'tf'), 'gone');
    await click(byText(row(view.container, 'tf'), 'button', 'Apply…'));
    await waitForText(row(view.container, 'tf'), 'Write to AGENTS.md');
    await click(byText(row(view.container, 'tf'), 'button', 'Write to AGENTS.md'));
    await waitForText(row(view.container, 'tf'), 'AGENTS.md changed since this preview, so nothing was written.');
    await click(byText(row(view.container, 'tf'), 'button', 'Show the new diff'));
    await waitForText(row(view.container, 'tf'), 'Write to AGENTS.md');
    await click(byText(row(view.container, 'tf'), 'button', 'Write to AGENTS.md'));
    await waitForText(row(view.container, 'tf'), 'passkey declined');
    // The preview stays, so the reader can try again.
    expect(maybeByText(row(view.container, 'tf'), 'button', 'Write to AGENTS.md')).toBeDefined();

    await click(byText(row(view.container, 'tf'), 'button', 'Cancel'));
    await click(byText(row(view.container, 'tf'), 'button', 'Back to review'));
    await waitForText(view.container, 'Back in To review.');
    await view.unmount();
  });

  it('says it is reading, then says why it could not', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    let release: () => void = () => undefined;
    daemon.once(
      'GET /v1/learning/proposals',
      () =>
        new Promise(resolve => {
          release = () => resolve({ status: 503, body: { error: 'learning is off' } });
        }),
    );
    daemon.once('GET /v1/learning/config', { status: 500, body: {} });
    const view = await mount(<LearningPage connection={learningDaemon} fetcher={daemon.fetch} />);
    expect(textOf(view.container)).toContain('Reading lessons…');
    await interact(() => release());
    await waitForText(view.container, 'learning is off');
    expect(textOf(view.container)).toContain('No to review lessons.');
    await view.unmount();
  });

  it('starts from nothing when the machine changes', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    const view = await hub(daemon);
    const other = fakeLearningDaemon([lesson({ id: 'other', ruleText: 'Another machine.' })]);
    const b = daemonConnection({ daemonId: 'daemon/b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
    await view.render(<LearningPage connection={b} fetcher={other.fetch} />);
    await waitForText(view.container, 'Another machine.');
    expect(textOf(view.container)).not.toContain('Run the gate');
    await view.unmount();
  });

  it('shows a running scan inline, reads its result when it ends, and cancels it', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    daemon.state.scan = progress({ total: 4, done: 1 });
    const view = await hub(daemon);
    await waitForText(view.container, 'Reading ferret 2 of 4…');
    const bar = must(view.container.querySelector('[data-learning-scan-inline] [role="progressbar"]'), 'bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    // It finishes: the hub reads the lessons it added.
    const reads = () => daemon.calls.filter(call => call.path === '/v1/learning/proposals').length;
    const before = reads();
    daemon.state.lessons = [...daemon.state.lessons, lesson({ id: 'found', ruleText: 'Found by the scan.' })];
    daemon.state.scan = progress({ state: 'finished', done: 4, added: 1 });
    await waitForText(view.container, 'Found by the scan.');
    expect(reads()).toBe(before + 1);
    expect(view.container.querySelector('[data-learning-scan-inline]')).toBeNull();

    await view.unmount();
    daemon.state.scan = progress({ runId: 'run-2' });
    const again = await hub(daemon);
    await waitFor(() => again.container.querySelector('[data-learning-scan-inline]') !== null, 'the inline scan');
    daemon.once('POST /v1/learning/scan/cancel', { status: 500, body: { error: 'cannot cancel' } });
    await click(
      byText(must(again.container.querySelector('[data-learning-scan-inline]'), 'inline'), 'button', 'Cancel'),
    );
    await waitForText(again.container, 'cannot cancel');
    await click(
      byText(must(again.container.querySelector('[data-learning-scan-inline]'), 'inline'), 'button', 'Cancel'),
    );
    await waitForText(again.container, 'Scan cancelled.');
    await again.unmount();
  });

  it('opens the scan dialog from the header and from a running scan’s Details', async () => {
    const daemon = fakeLearningDaemon(LESSONS);
    const view = await hub(daemon);
    await click(byText(view.container, 'button', 'Scan for lessons…'));
    await waitForText(view.container, 'Nothing runs until you press Start.');
    await click(byText(view.container, 'button', 'Start scan'));
    await waitForText(view.container, 'You can close this; the scan keeps going');
    await click(byText(view.container, 'button', 'Hide'));
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await click(byText(view.container, 'button', 'Details'));
    expect(
      must(view.container.querySelector('[role="dialog"]'), 'dialog').getAttribute('data-learning-scan-dialog'),
    ).toBe('progress');
    daemon.state.lessons = [...daemon.state.lessons, lesson({ id: 'scanned', source: 'scan', ruleText: 'Scanned.' })];
    daemon.state.scan = progress({ state: 'finished', done: 4, added: 1 });
    await waitForText(view.container, 'Added 1 lesson to To review.');
    await click(tab(view.container, 'Applied'));
    await click(byText(view.container, 'button', 'View in Learning'));
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(tab(view.container, 'To review').getAttribute('aria-selected')).toBe('true');
    expect(must(view.container.querySelector<HTMLInputElement>('input[value="scan"]'), 'scan filter').checked).toBe(
      true,
    );
    expect(view.container.querySelector('[data-lesson="scanned"]')).not.toBeNull();
    await view.unmount();
  });
});
