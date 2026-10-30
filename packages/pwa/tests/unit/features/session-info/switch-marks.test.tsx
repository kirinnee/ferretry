import { afterEach, describe, expect, it } from 'bun:test';
import { InfoAbout } from '../../../../src/features/session-info/info-about.tsx';
import { useAgendaSessionActions } from '../../../../src/features/agenda/agenda-session-actions.tsx';
import { useHypermediaSessionActions } from '../../../../src/features/hypermedia/hypermedia-session-actions.tsx';
import { usePackSessionActions } from '../../../../src/features/pack/pack-session-actions.tsx';
import {
  AGENDA_MARK_LABEL,
  HYPERMEDIA_MARK_LABEL,
  PACK_MARK_LABEL,
  SwitchMarks,
  type SwitchSection,
  switchTapper,
} from '../../../../src/features/session-info/switch-marks.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { click, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const DAEMON = daemonConnection({ daemonId: 'daemon/a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const marks = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-switch-marks] > *')].map(node =>
    node.hasAttribute('data-learning-passive') ? 'learning' : (node.getAttribute('data-switch-mark') ?? '?'),
  );

describe('a ferret’s switch marks', () => {
  it('draws nothing while every section is off', async () => {
    mounted = await mount(<SwitchMarks agenda={false} hypermedia={false} learning={false} pack={false} />);
    expect(mounted.container.querySelector('[data-switch-marks]')).toBeNull();
  });

  it('draws one mark per section that is on, in the prompt’s order, each named in words and not a control', async () => {
    mounted = await mount(<SwitchMarks agenda hypermedia learning pack />);
    const root = mounted.container;
    expect(marks(root)).toEqual(['learning', 'hypermedia', 'pack', 'agenda']);
    const hypermedia = must(root.querySelector('[data-switch-mark="hypermedia"]'), 'hypermedia mark');
    expect(hypermedia.getAttribute('role')).toBe('img');
    expect(hypermedia.getAttribute('aria-label')).toBe(HYPERMEDIA_MARK_LABEL);
    expect(hypermedia.getAttribute('title')).toBe(HYPERMEDIA_MARK_LABEL);
    expect(root.querySelector('[data-switch-mark="pack"]')?.getAttribute('aria-label')).toBe(PACK_MARK_LABEL);
    expect(root.querySelector('[data-switch-mark="agenda"]')?.getAttribute('aria-label')).toBe(AGENDA_MARK_LABEL);
    expect(root.querySelector('button')).toBeNull();
  });

  it('turns a section off from Info, saying when that takes effect', async () => {
    const taps: Array<[SwitchSection, boolean]> = [];
    mounted = await mount(
      <InfoAbout
        subFerrets={[]}
        switches={{
          learning: false,
          hypermedia: false,
          pack: true,
          onToggle: (section, next) => taps.push([section, next]),
        }}
        view={sessionView('s1', { config: { teammate: 'hadi', mode: 'interactive' } })}
      />,
    );
    const root = mounted.container;
    expect(marks(root)).toEqual(['pack']);
    const pack = must(root.querySelector<HTMLButtonElement>('button[data-switch-mark="pack"]'), 'pack button');
    expect(pack.getAttribute('aria-label')).toBe(
      `${PACK_MARK_LABEL}. Turn it off — takes effect when this ferret restarts`,
    );
    await click(pack);
    expect(taps).toEqual([['pack', false]]);
  });

  it('reads the marks from the session’s own record when the host hands none', async () => {
    mounted = await mount(
      <InfoAbout
        subFerrets={[]}
        view={sessionView('s1', { config: { teammate: 'hadi', mode: 'auto', pack: false } })}
      />,
    );
    // An auto ferret is not told about hypermedia, and this one's Pack mode is switched off.
    expect(mounted.container.querySelector('[data-switch-marks]')).toBeNull();
    expect(mounted.container.textContent).toContain('None on');
  });
});

it('draws the Agenda mark from the session’s record when the host hands none', async () => {
  mounted = await mount(
    <InfoAbout
      subFerrets={[]}
      view={sessionView('s1', { config: { teammate: 'hadi', mode: 'auto', pack: false, agenda: true } })}
    />,
  );
  expect(marks(mounted.container)).toEqual(['agenda']);
});

describe('switchTapper', () => {
  it('sends an Info tap to that section’s own switch, for this ferret', async () => {
    const sent: string[] = [];
    const tap = (section: string) => async (sessionId: string, next: boolean) => {
      sent.push(`${section} ${sessionId} ${String(next)}`);
    };
    const onToggle = switchTapper(
      { hypermedia: { tap: tap('hypermedia') }, pack: { tap: tap('pack') }, agenda: { tap: tap('agenda') } },
      's1',
    );
    onToggle('pack', false);
    onToggle('hypermedia', true);
    onToggle('agenda', false);
    expect(sent).toEqual(['pack s1 false', 'hypermedia s1 true', 'agenda s1 false']);
  });
});

/** A host for one switch's Info tap, as App wires it, and the status line it reports in. */
function TapHost({ fetcher, section }: { readonly fetcher: DaemonFetch; readonly section: SwitchSection }) {
  const hypermedia = useHypermediaSessionActions({ connection: DAEMON, fetcher });
  const pack = usePackSessionActions({ connection: DAEMON, fetcher });
  const agenda = useAgendaSessionActions({ connection: DAEMON, fetcher });
  const actions = { hypermedia, pack, agenda }[section];
  return (
    <>
      <button data-tap="" onClick={() => void actions.tap('session-hadi', false)} type="button">
        tap
      </button>
      {actions.host}
    </>
  );
}

describe('an Info tap that the daemon refuses', () => {
  const refusing: DaemonFetch = async () =>
    Response.json({ error: 'operator access is closed', code: 'forbidden' }, { status: 403 });

  it.each([
    ['hypermedia', 'Hypermedia could not be switched: operator access is closed'],
    ['pack', 'Pack mode could not be switched: operator access is closed'],
    ['agenda', 'Agenda mode could not be switched: operator access is closed'],
  ] as const)('says why %s could not be switched in its own status line', async (section, sentence) => {
    mounted = await mount(<TapHost fetcher={refusing} section={section} />);
    await click(must(mounted.container.querySelector<HTMLElement>('[data-tap]'), 'tap'));
    await waitForText(mounted.container, sentence);
  });
});
