import { describe, expect, it } from 'bun:test';
import {
  LEARNING_SETTINGS_TAB,
  LearningSettingsSurface,
} from '../../../../src/features/learning/learning-settings.tsx';
import { mount, must } from '../../../support/dom.ts';
import { configChangeHarness } from '../../config-change-support.tsx';
import { AT, fakeLearningDaemon, learningDaemon } from '../../../support/learning.ts';
import { byText, click, textOf, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const SESSIONS = [sessionView('session-hadi', { config: { teammate: 'hadi', cwd: '/work/ferretry' } })];

describe('Settings › Learning', () => {
  it('switches the machine default and each ferret, showing the daemon’s note', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.sessions = [
      { sessionId: 'session-hadi', passive: true, since: AT, setBy: 'default' },
      { sessionId: 'session-kofi-long-id', passive: false, since: AT, setBy: 'owner' },
    ];
    const view = await mount(
      <LearningSettingsSurface connection={learningDaemon} sessions={SESSIONS} fetcher={daemon.fetch} />,
    );
    await waitForText(view.container, 'On');
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch');
    await waitForText(view.container, 'Hadi');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(textOf(view.container)).toContain('Passive learning for new ferrets');
    expect(textOf(view.container)).toContain('Change a running ferret from its Actions › Passive learning');
    expect(textOf(view.container)).toContain('ferretry');
    expect(textOf(view.container)).toContain('session-…');

    await click(toggle);
    await waitForText(toggle, 'Off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(daemon.calls.find(call => call.method === 'PATCH')?.body).toEqual({ passiveDefault: false });

    const kofi = must(view.container.querySelector('[data-learning-ferret="session-kofi-long-id"]'), 'kofi row');
    await click(byText(kofi, 'button', 'Turn on'));
    await waitForText(view.container, 'Re-instructed; it costs one turn.');
    expect(daemon.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { passive: true } });
    await waitForText(
      must(view.container.querySelector('[data-learning-ferret="session-kofi-long-id"]'), 'row'),
      'Turn off',
    );

    daemon.once('PATCH /v1/sessions/session-hadi/learning', { status: 403, body: { error: 'fleet.use is closed' } });
    await click(byText(view.container, '[data-learning-ferret="session-hadi"] button', 'Turn off'));
    await waitForText(view.container, 'fleet.use is closed');
    expect(LEARNING_SETTINGS_TAB.id).toBe('learning');
    await view.unmount();
  });

  it('says why the default could not be read or written, and when there are no ferrets', async () => {
    const daemon = fakeLearningDaemon();
    daemon.once('GET /v1/learning/config', { status: 500, body: { error: 'learning.yaml is invalid' } });
    const broken = await mount(<LearningSettingsSurface connection={learningDaemon} fetcher={daemon.fetch} />);
    await waitForText(broken.container, 'learning.yaml is invalid');
    expect(must(broken.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch').disabled).toBe(true);
    await waitForText(broken.container, 'No ferrets on this machine yet.');
    await broken.unmount();

    const refusing = fakeLearningDaemon();
    refusing.once('PATCH /v1/learning/config', { status: 403, body: { error: 'fleet.configure is closed' } });
    let release: () => void = () => undefined;
    refusing.once(
      'GET /v1/learning/sessions',
      () =>
        new Promise(resolve => {
          release = () => resolve({ body: [] });
        }),
    );
    const view = await mount(<LearningSettingsSurface connection={learningDaemon} fetcher={refusing.fetch} />);
    expect(textOf(view.container)).toContain('Reading which ferrets learn…');
    release();
    await waitForText(view.container, 'On');
    await click(must(view.container.querySelector('[role="switch"]'), 'switch'));
    await waitForText(view.container, 'fleet.configure is closed');
    await view.unmount();
  });

  it('shows the new default when learning.yaml changes elsewhere, without a reload', async () => {
    // Arrange: the screen reads the default as On.
    const daemon = fakeLearningDaemon();
    const harness = configChangeHarness(learningDaemon.daemonId);
    const view = await mount(
      harness.wrap(<LearningSettingsSurface connection={learningDaemon} fetcher={daemon.fetch} />),
    );
    const toggle = must(view.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch');
    await waitForText(toggle, 'On');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const reads = () => daemon.calls.filter(call => call.method === 'GET' && call.path === '/v1/learning/config');
    expect(reads()).toHaveLength(1);

    // Act: another device (or a hand edit) turns passive learning off, and the machine says learning moved.
    daemon.state.config = { ...daemon.state.config, passiveDefault: false };
    await harness.move(['learning']);

    // Assert: the default was read again and the switch shows it.
    await waitForText(toggle, 'Off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(reads()).toHaveLength(2);

    // A change to some other kind of configuration does not re-read it.
    await harness.move(['runtimes']);
    expect(reads()).toHaveLength(2);
    await view.unmount();
  });
});
