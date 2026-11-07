import { describe, expect, it } from 'bun:test';
import { LessonsSettingsSurface } from '../../../app/src/lessons-settings.tsx';
import { byText, click, textOf, waitForText } from '../../support/app/dom-helpers.ts';
import { mount, must } from '../../support/app/dom.ts';
import { AT, fakeLessonsDaemon } from '../../support/app/lessons.ts';

const FERRETS = [{ ferretId: 'ferret-hadi', name: 'hadi', folder: '/work/ferretry' }];

describe('Settings › Lessons', () => {
  it('switches the machine default and each ferret, showing the daemon’s note', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.ferrets = [
      { ferretId: 'ferret-hadi', passive: true, since: AT, setBy: 'default' },
      { ferretId: 'ferret-kofi-long-id', passive: false, since: AT, setBy: 'owner' },
    ];
    const view = await mount(<LessonsSettingsSurface connection={daemon.connection} ferrets={FERRETS} />);
    await waitForText(view.container, 'On');
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch');
    await waitForText(view.container, 'Hadi');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(textOf(view.container)).toContain('Passive lessons for new ferrets');
    expect(textOf(view.container)).toContain('ferretry');
    expect(textOf(view.container)).toContain('ferret-k…');

    await click(toggle);
    await waitForText(toggle, 'Off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(daemon.calls.find(call => call.route === 'PATCH /v1/lessons/config')?.body).toEqual({
      passiveDefault: false,
    });

    const kofi = must(view.container.querySelector('[data-lessons-ferret="ferret-kofi-long-id"]'), 'kofi row');
    await click(byText(kofi, 'button', 'Turn on'));
    await waitForText(view.container, 'Re-instructed; it costs one turn.');
    expect(daemon.calls.at(-1)).toMatchObject({
      route: 'PATCH /v1/ferrets/:ferretId/lessons',
      body: { passive: true },
    });
    await waitForText(
      must(view.container.querySelector('[data-lessons-ferret="ferret-kofi-long-id"]'), 'row'),
      'Turn off',
    );

    daemon.once('PATCH /v1/ferrets/:ferretId/lessons', {
      refuse: { status: 403, code: 'grant_refused', message: 'fleet.use is closed' },
    });
    await click(byText(view.container, '[data-lessons-ferret="ferret-hadi"] button', 'Turn off'));
    await waitForText(view.container, 'fleet.use is closed');
    await view.unmount();
  });

  it('says why the default could not be read or written, and when there are no ferrets', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('GET /v1/lessons/config', {
      refuse: { status: 500, code: 'internal', message: 'lessons.yaml is invalid' },
    });
    const broken = await mount(<LessonsSettingsSurface connection={daemon.connection} />);
    await waitForText(broken.container, 'lessons.yaml is invalid');
    expect(must(broken.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch').disabled).toBe(true);
    await waitForText(broken.container, 'No ferrets on this machine yet.');
    await broken.unmount();

    const refusing = fakeLessonsDaemon();
    refusing.once('PATCH /v1/lessons/config', {
      refuse: { status: 403, code: 'grant_refused', message: 'fleet.configure is closed' },
    });
    let release: () => void = () => undefined;
    refusing.once(
      'GET /v1/lessons/ferrets',
      () =>
        new Promise(resolve => {
          release = () => resolve({ body: [] });
        }),
    );
    const view = await mount(<LessonsSettingsSurface connection={refusing.connection} />);
    expect(textOf(view.container)).toContain('Reading which ferrets learn…');
    release();
    await waitForText(view.container, 'On');
    await click(must(view.container.querySelector('[role="switch"]'), 'switch'));
    await waitForText(view.container, 'fleet.configure is closed');
    await view.unmount();
  });
});
