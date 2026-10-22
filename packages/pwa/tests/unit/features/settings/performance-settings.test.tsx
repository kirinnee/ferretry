import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import type { PerformanceProfileView, PerformanceReport } from '@ferretry/protocol';
import { fullReport, minimalReport } from '../../../../../protocol/tests/performance-report-fixtures.ts';
import type { PerformanceClient } from '../../../../src/features/settings/performance-api.ts';
import {
  PROFILE_LOST_SENTENCE,
  PROFILE_REFUSED_INTRO,
  PROFILE_REFUSED_REMEDY,
  PROFILE_TOO_SLOW_SENTENCE,
  PWA_REPORT_UNAVAILABLE,
} from '../../../../src/features/settings/performance-model.ts';
import {
  downloadText,
  type PerformanceClientFactory,
  PerformanceSettings,
  type PerformanceTimer,
  performanceSettingsTab,
} from '../../../../src/features/settings/performance-settings.tsx';
import { SETTINGS_LINKS, settingsPaletteEntries } from '../../../../src/features/settings/settings-catalog.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { PerformanceRecorder } from '../../../../src/lib/performance/recorder.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_beta000000000000000000',
});

class HttpRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const RUNNING: PerformanceProfileView = {
  state: 'running',
  id: 'profile-1',
  startedAt: '2026-10-21T10:00:00.000Z',
  endsAt: '2026-10-21T10:00:30.000Z',
};
const finished = (report: PerformanceReport = fullReport()): PerformanceProfileView => ({
  state: 'finished',
  id: 'profile-1',
  report,
});

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** A daemon whose start and reads answer from the given lists, in turn; every call is kept. */
const daemon = (
  start: () => Promise<PerformanceProfileView>,
  reads: (() => Promise<PerformanceProfileView>)[] = [],
) => {
  const calls: Call[] = [];
  const createClient: PerformanceClientFactory = async () =>
    ({
      request: (async (path: string, _schema: unknown, init?: RequestInit) => {
        calls.push({
          path,
          method: init?.method ?? 'GET',
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        if (init?.method === 'POST') return await start();
        const next = reads.shift();
        if (next === undefined) throw new Error('no read scripted');
        return await next();
      }) as PerformanceClient['request'],
    }) satisfies PerformanceClient;
  return { calls, createClient };
};

/** A clock and timers the test moves by hand. */
const handTime = () => {
  let time = 0;
  const pending: { at: number; run: () => void }[] = [];
  const timer: PerformanceTimer = (run, milliseconds) => {
    const entry = { at: time + milliseconds, run };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    now: () => time,
    timer,
    pending: () => pending.length,
    advance: async (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = pending.filter(entry => entry.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        pending.splice(pending.indexOf(due), 1);
        time = due.at;
        await runAsync(async () => {
          due.run();
          for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        });
      }
      time = until;
    },
  };
};

const settled = async (container: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => container.querySelector(selector) !== null, selector, runAsync);
};

const press = async (container: HTMLElement, selector: string): Promise<void> => {
  const button = must(container.querySelector<HTMLButtonElement>(selector), selector);
  await interact(() => button.click());
};

describe('PerformanceSettings', () => {
  it('records both halves over one window, shows the broken budget first, and copies and downloads them', async () => {
    // Arrange — the machine finishes its report on the second read after the window.
    const time = handTime();
    const machine = daemon(async () => RUNNING, [async () => RUNNING, async () => finished()]);
    const recorder = new PerformanceRecorder({ now: time.now });
    const copied: string[] = [];
    const saved: { name: string; text: string }[] = [];
    const shown = await mount(
      <PerformanceSettings
        connection={alpha}
        createClient={machine.createClient}
        recorder={recorder}
        now={time.now}
        timer={time.timer}
        write={async text => void copied.push(text)}
        save={(name, text) => void saved.push({ name, text })}
      />,
    );
    expect(shown.container.textContent).toContain('Record 30 s');

    // Act — start, and watch the countdown move.
    await press(shown.container, '[data-performance-record]');
    await settled(shown.container, '[data-performance-progress]');
    recorder.recordRequest({
      route: 'GET /v1/sessions',
      at: 1,
      durationMs: 40,
      outcome: 200,
      bytesIn: 2_048,
      bytesOut: 0,
    });
    await time.advance(10_000);
    const midway = shown.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow');
    const countdown = shown.container.textContent;
    await time.advance(21_000);
    await settled(shown.container, '[data-performance-report]');

    // Assert — the window, the budget, both reports.
    expect(machine.calls[0]).toEqual({ path: '/v1/diagnostics/profile', method: 'POST', body: { seconds: 30 } });
    expect(machine.calls.slice(1).map(call => call.path)).toEqual([
      '/v1/diagnostics/profile/profile-1',
      '/v1/diagnostics/profile/profile-1',
    ]);
    expect(midway).toBe('33');
    expect(countdown).toContain('20 s left');
    const budgets = must(shown.container.querySelector('[data-performance-budgets]'), 'budgets');
    expect(budgets.getAttribute('data-performance-budgets')).toBe('1');
    expect(budgets.textContent).toContain('1 of 2 budgets over');
    expect(budgets.querySelector('li')?.textContent).toContain('stall');
    expect(shown.container.querySelector('[data-performance-daemon]')?.textContent).toContain('Daemon profile — 30 s');
    expect(shown.container.querySelector('[data-performance-pwa]')?.textContent).toContain('GET /v1/sessions');

    // Act — copy, then download.
    await press(shown.container, '[data-performance-copy]');
    await settled(shown.container, '[data-performance-copied="copied"]');
    await press(shown.container, '[data-performance-download]');

    // Assert
    expect(copied[0]).toContain('Daemon profile — 30 s');
    expect(copied[0]).toContain('This browser — last');
    expect(saved[0]?.name).toBe('ferretry-performance-2026-10-21T10-00-30Z.json');
    const document = JSON.parse(saved[0]?.text ?? '{}') as { daemon: PerformanceReport; pwa: { requests: unknown } };
    expect(document.daemon.budgets).toHaveLength(2);
    expect(document.pwa.requests).toMatchObject({ count: 1 });
    expect(shown.container.textContent).toContain('Record again');
    await shown.unmount();
  });

  it('says every budget held, and that this page recorded nothing of its own without a recorder', async () => {
    // Arrange — a machine that answers finished at once.
    const machine = daemon(async () => finished(minimalReport()));

    // Act
    const shown = await mount(
      <PerformanceSettings connection={alpha} createClient={machine.createClient} recorder={undefined} />,
    );
    await press(shown.container, '[data-performance-record]');
    await settled(shown.container, '[data-performance-report]');

    // Assert
    expect(shown.container.querySelector('[data-performance-budgets]')?.textContent).toContain('Every budget held (0)');
    expect(shown.container.querySelector('[data-performance-pwa]')?.textContent).toBe(PWA_REPORT_UNAVAILABLE);
    await shown.unmount();
  });

  it('says a refusal in words, with the place a profile always works', async () => {
    // Arrange
    const machine = daemon(async () => {
      throw new HttpRefusal('operator access is required', 403);
    });

    // Act
    const shown = await mount(
      <PerformanceSettings connection={alpha} createClient={machine.createClient} recorder={undefined} />,
    );
    await press(shown.container, '[data-performance-record]');
    await settled(shown.container, '[data-performance-refused]');

    // Assert
    const text = shown.container.querySelector('[data-performance-refused]')?.textContent ?? '';
    expect(text).toContain(PROFILE_REFUSED_INTRO);
    expect(text).toContain('operator access is required');
    expect(text).toContain(PROFILE_REFUSED_REMEDY);
    await shown.unmount();
  });

  it('says a recording the machine lost, and a report it never finished', async () => {
    // Arrange — one machine forgets the profile; another never finishes it.
    const lostTime = handTime();
    const lost = daemon(
      async () => RUNNING,
      [
        async () => {
          throw new HttpRefusal('no such profile on this daemon', 404);
        },
      ],
    );
    const slowTime = handTime();
    const slow = daemon(
      async () => RUNNING,
      Array.from({ length: 40 }, () => async () => RUNNING),
    );

    // Act
    const forgot = await mount(
      <PerformanceSettings
        connection={alpha}
        createClient={lost.createClient}
        recorder={undefined}
        now={lostTime.now}
        timer={lostTime.timer}
      />,
    );
    await press(forgot.container, '[data-performance-record]');
    await settled(forgot.container, '[data-performance-progress]');
    await lostTime.advance(31_000);
    await settled(forgot.container, '[data-performance-failed]');
    const tooSlow = await mount(
      <PerformanceSettings
        connection={alpha}
        createClient={slow.createClient}
        recorder={undefined}
        now={slowTime.now}
        timer={slowTime.timer}
      />,
    );
    await press(tooSlow.container, '[data-performance-record]');
    await settled(tooSlow.container, '[data-performance-progress]');
    await slowTime.advance(70_000);
    await settled(tooSlow.container, '[data-performance-failed]');

    // Assert
    expect(forgot.container.querySelector('[data-performance-failed]')?.textContent).toContain(PROFILE_LOST_SENTENCE);
    expect(tooSlow.container.querySelector('[data-performance-failed]')?.textContent).toContain(
      PROFILE_TOO_SLOW_SENTENCE,
    );
    expect(slowTime.pending()).toBe(0);
    await forgot.unmount();
    await tooSlow.unmount();
  });

  it('says a failure with no words of its own, and a blocked copy', async () => {
    // Arrange
    const failing = daemon(async () => {
      throw new Error('  ');
    });
    const working = daemon(async () => finished());

    // Act
    const failed = await mount(
      <PerformanceSettings connection={alpha} createClient={failing.createClient} recorder={undefined} />,
    );
    await press(failed.container, '[data-performance-record]');
    await settled(failed.container, '[data-performance-failed]');
    const blocked = await mount(
      <PerformanceSettings
        connection={alpha}
        createClient={working.createClient}
        recorder={undefined}
        write={async () => {
          throw new Error('denied');
        }}
      />,
    );
    await press(blocked.container, '[data-performance-record]');
    await settled(blocked.container, '[data-performance-report]');
    await press(blocked.container, '[data-performance-copy]');
    await settled(blocked.container, '[data-performance-copied="failed"]');

    // Assert
    expect(failed.container.querySelector('[data-performance-failed]')?.textContent).toContain(
      'The machine did not say why.',
    );
    expect(blocked.container.textContent).toContain('Copy was blocked');
    await failed.unmount();
    await blocked.unmount();
  });

  it('drops a recording started on another machine once the panel moves to this one', async () => {
    // Arrange — alpha's start is held until after the move.
    let answer: (view: PerformanceProfileView) => void = () => undefined;
    const held = daemon(
      async () =>
        await new Promise<PerformanceProfileView>(resolve => {
          answer = resolve;
        }),
    );
    const time = handTime();
    const shown = await mount(
      <PerformanceSettings
        connection={alpha}
        createClient={held.createClient}
        recorder={undefined}
        now={time.now}
        timer={time.timer}
      />,
    );
    await press(shown.container, '[data-performance-record]');

    // Act
    await shown.render(
      <PerformanceSettings
        connection={beta}
        createClient={held.createClient}
        recorder={undefined}
        now={time.now}
        timer={time.timer}
      />,
    );
    await runAsync(async () => answer(RUNNING));

    // Assert — nothing of alpha's window appeared, and no timer was left behind.
    expect(shown.container.querySelector('[data-performance-progress]')).toBeNull();
    expect(time.pending()).toBe(0);
    expect(shown.container.textContent).toContain('Record 30 s');
    await shown.unmount();
  });

  it('runs on the browser’s own clock and timers when none are injected', async () => {
    // Arrange — a window of twenty milliseconds, so the real timer is quick about it.
    const machine = daemon(async () => ({ ...RUNNING, endsAt: '2026-10-21T10:00:00.020Z' }), [async () => finished()]);

    // Act
    const shown = await mount(
      <PerformanceSettings connection={alpha} createClient={machine.createClient} recorder={undefined} />,
    );
    await press(shown.container, '[data-performance-record]');
    await settled(shown.container, '[data-performance-report]');

    // Assert
    expect(machine.calls.map(call => call.method)).toEqual(['POST', 'GET']);
    await shown.unmount();
  });

  it('is offered as a Machine panel and in the palette', async () => {
    // Arrange
    const machine = daemon(async () => finished());
    const tab = performanceSettingsTab(machine.createClient, undefined);

    // Act
    const shown = await mount(<tab.Surface connection={alpha} />);
    const link = must(
      SETTINGS_LINKS.find(entry => entry.id === 'performance'),
      'the performance palette link',
    );

    // Assert
    expect(tab.id).toBe('performance');
    expect(tab.label).toBe('Performance');
    expect(shown.container.querySelector('[data-performance-record]')).not.toBeNull();
    for (const query of ['slow', 'lag', 'performance'])
      expect(
        settingsPaletteEntries(alpha.daemonId, query).find(item => item.id === 'setting-link-performance')?.href,
      ).toBe(link.href(alpha.daemonId));
    await shown.unmount();
  });
});

describe('downloadText', () => {
  it('hands the browser a JSON file by name and lets the link go', () => {
    // Arrange — the object-URL pair and the link click, observed.
    const urls: string[] = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      urls.push(`created ${blob.type}`);
      return 'blob:performance';
    };
    URL.revokeObjectURL = (url: string) => void urls.push(`revoked ${url}`);
    const realClick = HTMLAnchorElement.prototype.click;
    const clicked: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.href}`);
    };

    try {
      // Act
      downloadText('report.json', '{}');
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
      HTMLAnchorElement.prototype.click = realClick;
    }

    // Assert
    expect(urls).toEqual(['created application/json', 'revoked blob:performance']);
    expect(clicked).toEqual(['report.json blob:performance']);
  });
});
