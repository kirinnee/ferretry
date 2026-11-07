/**
 * The Lessons-owned S rows of docs/design/rebuild-parity.tsv, one test per row (or row group), each named by its ids.
 * Every test drives the real surface — the half the shell builds, the Lessons screen, the Settings tab — over a scripted
 * daemon, and asserts what a person sees. Today's "Learning" is "Lessons" (design §1.4).
 */
import { describe, expect, it } from 'bun:test';
import type { ComponentType } from 'react';
import app from '../../../app/index.ts';
import { LessonsPage } from '../../../app/src/lessons-page.tsx';
import { LessonsSettingsSurface } from '../../../app/src/lessons-settings.tsx';
import { LESSON_TABS } from '../../../app/src/model.ts';
import { LESSONS_PATH, lessonsHref } from '../../../app/src/surfaces.tsx';
import { LESSONS_MINER_GAP, LESSONS_MINER_GAP_CODE } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { byText, click, textOf, waitForText } from '../../support/app/dom-helpers.ts';
import { mount, must } from '../../support/app/dom.ts';
import { fakeLessonsDaemon, lesson } from '../../support/app/lessons.ts';

const FERRETS = [{ ferretId: 'ferret-hadi', name: 'hadi', folder: '/work/ferretry' }];

const halfOver = (daemon: ReturnType<typeof fakeLessonsDaemon>) =>
  must(app.build, 'the app half builder')({ manifest, client: daemon.connection.client as never }) as unknown as {
    readonly screens: Record<string, ComponentType>;
    readonly panels: Record<string, ComponentType<{ subject?: string }>>;
    readonly settings: Record<string, ComponentType>;
  };

describe('the Lessons app half', () => {
  it('S-0311 feature learning is the lessons half: a screen, a ferret toolbar panel and a Settings tab', () => {
    const half = halfOver(fakeLessonsDaemon());
    expect(Object.keys(half.screens)).toEqual(['lessons']);
    expect(Object.keys(half.panels)).toEqual(['ferret-lessons']);
    expect(Object.keys(half.settings)).toEqual(['lessons']);
  });

  it('S-0396 S-0372 S-0131 screen learning at /d/:daemonId/learning is the lessons screen at lessons, per daemon', async () => {
    const [screen] = manifest.ui.screens;
    expect(screen).toMatchObject({ id: 'lessons', path: 'lessons' });
    expect(LESSONS_PATH).toBe('lessons');
    expect(lessonsHref({ daemon: 'studio' })).toBe('/d/studio/lessons');
    const daemon = fakeLessonsDaemon([lesson({ ruleText: 'Run the gate before pushing.' })]);
    const Screen = must(halfOver(daemon).screens.lessons, 'screen');
    const view = await mount(<Screen />);
    await waitForText(view.container, 'Run the gate before pushing.');
    await view.unmount();
  });

  it('S-0346 PAGE_SLOTS Learning is the Lessons nav entry', () => {
    expect(manifest.ui.screens[0]?.nav).toMatchObject({ label: 'Lessons', icon: 'graduation-cap', order: 70 });
  });

  it('S-0130 S-0135 LearningPage with LessonTabs: the board in To review, Accepted, Applied and Rejected', async () => {
    expect(LESSON_TABS.map(tab => tab.label)).toEqual(['To review', 'Accepted', 'Applied', 'Rejected']);
    const daemon = fakeLessonsDaemon([lesson({ ruleText: 'Run the gate before pushing.' })]);
    const view = await mount(<LessonsPage connection={daemon.connection} ferrets={FERRETS} timeZone="UTC" />);
    await waitForText(view.container, 'Run the gate before pushing.');
    const tabs = [...view.container.querySelectorAll('[role="tab"]')].map(tab => textOf(tab));
    for (const label of ['To review', 'Accepted', 'Applied', 'Rejected'])
      expect(tabs.some(text => text.includes(label))).toBe(true);
    await view.unmount();
  });

  it('S-0211 ScanDialog estimates first, and shows the daemon’s refusal when a scan cannot start', async () => {
    const daemon = fakeLessonsDaemon([lesson({ ruleText: 'Run the gate before pushing.' })]);
    daemon.once('POST /v1/lessons/scan', {
      refuse: { status: 503, code: LESSONS_MINER_GAP_CODE, message: LESSONS_MINER_GAP },
    });
    const view = await mount(
      <LessonsPage
        connection={daemon.connection}
        ferrets={FERRETS}
        timeZone="UTC"
        estimateDelayMs={0}
        scanPollMs={5}
      />,
    );
    await waitForText(view.container, 'Run the gate before pushing.');
    await click(byText(view.container, 'button', 'Scan for lessons…'));
    await waitForText(view.container, 'Nothing runs until you press Start.');
    expect(daemon.calls.some(call => call.route === 'POST /v1/lessons/scan')).toBe(false);
    await click(byText(view.container, 'button', 'Start scan'));
    await waitForText(view.container, LESSONS_MINER_GAP);
    await view.unmount();
  });

  it('S-0420 S-0500 S-0133 settings panel learning is the Lessons tab', async () => {
    expect(manifest.ui.settings).toEqual([expect.objectContaining({ id: 'lessons', label: 'Lessons', order: 70 })]);
    const Tab = must(halfOver(fakeLessonsDaemon()).settings.lessons, 'tab');
    const view = await mount(<Tab />);
    await waitForText(view.container, 'Passive lessons for new ferrets');
    await view.unmount();
  });

  it('S-0132 S-0501 LearningSettingsSurface and its “Learning defaults”: the machine default and each ferret', async () => {
    const daemon = fakeLessonsDaemon();
    const view = await mount(<LessonsSettingsSurface connection={daemon.connection} ferrets={FERRETS} />);
    await waitForText(view.container, 'Passive lessons for new ferrets');
    await waitForText(view.container, 'Ferrets right now');
    expect(view.container.querySelector('[data-global-lessons]')).not.toBeNull();
    await view.unmount();
  });
});
