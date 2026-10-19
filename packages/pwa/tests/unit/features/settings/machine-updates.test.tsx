import { afterEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { DAEMON_UPDATE_PATH, useMachineUpdates } from '../../../../src/features/settings/machine-updates.ts';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
import { type DaemonConnection, type DaemonId, daemonId } from '../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount } from '../../../support/dom.ts';
import { pairing } from '../fleet/shell/machine-support.ts';
import { updateView } from './about-machine-support.ts';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const seen: { current: ReadonlySet<DaemonId> } = { current: new Set() };

function Probe(props: Parameters<typeof useMachineUpdates>[0]) {
  seen.current = useMachineUpdates(props);
  return null;
}

const answers: Record<string, () => unknown> = {
  'daemon-new': () => updateView(),
  'daemon-current': () => updateView({ available: false }),
  'daemon-old': () => {
    throw Object.assign(new Error('unknown route'), { status: 404 });
  },
  'daemon-locked': () => updateView(),
};

const asked: string[] = [];
const createClient = async (connection: DaemonConnection) => ({
  request: async <T,>(path: string, schema: z.ZodType<T>): Promise<T> => {
    asked.push(`${String(connection.daemonId)} ${path}`);
    return schema.parse(answers[String(connection.daemonId)]?.());
  },
});

const connections: readonly DaemonConnectionRecord[] = Object.keys(answers).map(id => pairing(id));

describe('useMachineUpdates', () => {
  it('marks only the machines that said a newer release exists, and skips locked ones', async () => {
    mounted = await mount(
      <Probe connections={connections} createClient={createClient} locked={[daemonId('daemon-locked')]} />,
    );
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    expect([...seen.current]).toEqual([daemonId('daemon-new')]);
    expect(asked.sort()).toEqual(
      ['daemon-current', 'daemon-new', 'daemon-old'].map(id => `${id} ${DAEMON_UPDATE_PATH}`),
    );
  });

  it('asks nothing without a client', async () => {
    mounted = await mount(<Probe connections={connections} />);
    expect([...seen.current]).toEqual([]);
  });
});
