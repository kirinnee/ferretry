/** r12 H2 — an assistant row in the transcript draws a terminal fence as a Durian part (red until `AssistantProse` reads Hypermedia). */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import { TranscriptRow } from '../../../../app/chat/transcript-row.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);

describe('an assistant row', () => {
  it('draws a terminal fence as `.dh-doc .term`', async () => {
    const f = fixture();
    const mounted = await mount(
      inShell(
        <ReferenceSurfaceProvider surface={f.surface}>
          <TranscriptRow
            entry={{
              id: 'a1',
              kind: 'assistant',
              text: `Run it:\n\n${FENCE}terminal\n$ bun test\nok\n${FENCE}\n\nthen &F12`,
              at: Date.UTC(2026, 10, 21, 12, 0, 0),
            }}
          />
        </ReferenceSurfaceProvider>,
      ) as never,
    );
    await interact(() => Promise.resolve());
    expect(mounted.container.querySelectorAll('.dh-doc .term').length).toBe(1);
    expect(mounted.container.querySelector('a[data-fy-reference]')?.textContent).toBe('&F12');
    await mounted.unmount();
  });
});
