import { describe, expect, it } from 'bun:test';
import type { PasskeysView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { PasskeyNudge } from '../../../../src/features/settings/passkey-nudge.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { NudgeStorage } from '../../../../src/lib/passkey-panel.ts';
import type { StepUpClient } from '../../../../src/lib/step-up-client.ts';
import { mount, must } from '../../../support/dom.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});
const view = (over: Partial<PasskeysView> = {}): PasskeysView => ({
  passkeys: [],
  registration: 'first-window',
  ...over,
});

const answering = (answer: unknown, calls: string[] = []): (() => Promise<StepUpClient>) => {
  const client = {
    request: async (path: string) => {
      calls.push(path);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as StepUpClient;
  return async () => client;
};

const memory = (seed: Record<string, string> = {}): NudgeStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const throwing: NudgeStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

const mountNudge = async (
  create: () => Promise<StepUpClient>,
  storage: NudgeStorage | undefined,
  opened: string[] = [],
): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await runAsync(async () => {
    renderer = render(
      <PasskeyNudge
        connection={connection}
        createClient={create}
        storage={() => storage}
        onOpenSecurity={() => opened.push('security')}
      />,
    );
  });
  return must(renderer, 'the rendered nudge');
};

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);

describe('PasskeyNudge', () => {
  it('shows one line when this device has no passkey and one can be added, and reads once', async () => {
    // Arrange
    const calls: string[] = [];

    // Act
    const nudge = await mountNudge(answering(view(), calls), memory());

    // Assert
    should(marked(nudge, 'data-passkey-nudge')).have.length(1);
    should(calls).eql(['/v1/passkeys']);
    run(() => nudge.unmount());
  });

  it('points at Settings → Security and opens it', async () => {
    // Arrange
    const opened: string[] = [];
    const nudge = await mountNudge(answering(view()), memory(), opened);

    // Act
    await runAsync(async () => marked(nudge, 'data-passkey-nudge-open')[0]?.props.onClick());

    // Assert
    should(opened).eql(['security']);
    should(JSON.stringify(nudge.toJSON())).containEql('Settings → Daemons → Security → Add a passkey');
    run(() => nudge.unmount());
  });

  it('stays quiet when a passkey already exists', async () => {
    // Arrange / Act
    const nudge = await mountNudge(
      answering(
        view({ passkeys: [{ id: 'QUJD', origin: 'https://a.example.test', createdAt: '2025-12-20T18:22:00.000Z' }] }),
      ),
      memory(),
    );

    // Assert
    should(marked(nudge, 'data-passkey-nudge')).be.empty();
    run(() => nudge.unmount());
  });

  it('stays quiet when adding one would be refused', async () => {
    // Arrange / Act
    const nudge = await mountNudge(answering(view({ registration: 'closed' })), memory());

    // Assert
    should(marked(nudge, 'data-passkey-nudge')).be.empty();
    run(() => nudge.unmount());
  });

  it('stays quiet when the machine cannot answer or answers something else', async () => {
    // Arrange / Act
    const failed = await mountNudge(answering(new Error('offline')), memory());
    const garbled = await mountNudge(answering('nonsense'), memory());
    const noClient = await mountNudge(async () => {
      throw new Error('no carrier');
    }, memory());

    // Assert
    for (const nudge of [failed, garbled, noClient]) {
      should(marked(nudge, 'data-passkey-nudge')).be.empty();
      run(() => nudge.unmount());
    }
  });

  it('stays dismissed for a machine that was dismissed, without asking the machine', async () => {
    // Arrange
    const calls: string[] = [];

    // Act
    const nudge = await mountNudge(
      answering(view(), calls),
      memory({ 'fy-passkey-nudge-dismissed-v1:daemon-alpha': '1' }),
    );

    // Assert
    should(marked(nudge, 'data-passkey-nudge')).be.empty();
    should(calls).be.empty();
    run(() => nudge.unmount());
  });

  it('remembers a dismissal for this machine only', async () => {
    // Arrange
    const storage = memory();
    const nudge = await mountNudge(answering(view()), storage);

    // Act
    await runAsync(async () => marked(nudge, 'data-passkey-nudge-dismiss')[0]?.props.onClick());

    // Assert
    should(marked(nudge, 'data-passkey-nudge')).be.empty();
    should([...storage.values.keys()]).eql(['fy-passkey-nudge-dismissed-v1:daemon-alpha']);
    run(() => nudge.unmount());
  });

  it('renders and dismisses for this load when storage throws, or does not exist', async () => {
    // Arrange / Act
    const refusing = await mountNudge(answering(view()), throwing);
    const absent = await mountNudge(answering(view()), undefined);

    // Assert
    should(marked(refusing, 'data-passkey-nudge')).have.length(1);
    should(marked(absent, 'data-passkey-nudge')).have.length(1);
    await runAsync(async () => marked(refusing, 'data-passkey-nudge-dismiss')[0]?.props.onClick());
    should(marked(refusing, 'data-passkey-nudge')).be.empty();
    run(() => refusing.unmount());
    run(() => absent.unmount());
  });

  it('ignores an answer that lands after unmount', async () => {
    // Arrange
    let release: (client: StepUpClient) => void = () => undefined;
    const nudge = await mountNudge(() => new Promise(resolve => (release = resolve)), memory());

    // Act
    run(() => nudge.unmount());
    await runAsync(async () => release(await answering(view())()));

    // Assert
    should(nudge.toJSON()).be.null();
  });

  it('uses the browser storage and the app’s client pool by default, and stays quiet without a pool', async () => {
    // Arrange / Act — outside a provider the pool refuses.
    const mounted = await mount(<PasskeyNudge connection={connection} onOpenSecurity={() => undefined} />);

    // Assert
    expect(mounted.container.querySelector('[data-passkey-nudge]')).toBeNull();
    await mounted.unmount();
  });
});
