import { describe, expect, it } from 'bun:test';
import type { FleetCredentialTestAct } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CredentialEnvironment } from '../../../../../src/features/fleet/credentials/credential-environment.tsx';
import { secretRef } from '../../../../../src/features/fleet/credentials/environment-model.ts';
import { LoginScopeChip } from '../../../../../src/features/fleet/credentials/login-scope-chip.tsx';
import { LoginTest } from '../../../../../src/features/fleet/credentials/login-test.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { type Call, STUDIO, scripted } from '../account-support.ts';
import { ENVIRONMENT } from './environment-support.ts';

const TEST = 'POST /v1/fleet/credentials/zai-glm/test';

const passed = (spent: 'nothing' | 'one-token' = 'nothing') => ({
  credentialId: 'zai-glm',
  ok: true,
  code: 'ok',
  message: 'The provider accepted this login.',
  spent,
  at: '2026-10-16T08:00:00.000Z',
});

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const openTest = async (act: FleetCredentialTestAct, answer: unknown) => {
  const calls: Call[] = [];
  const client = scripted({ [TEST]: answer }, calls);
  const createClient = async (): Promise<FleetClient> => client;
  const view = await mount(
    <LoginTest credentialId="zai-glm" act={act} connection={STUDIO} createClient={createClient} />,
  );
  return { view, calls };
};

describe('LoginTest', () => {
  it('says why there is no Test when the login cannot be tested', async () => {
    const { view } = await openTest({ available: false, reason: 'Bedrock needs signing.' }, passed());
    expect(view.container.textContent).toBe('No Test: Bedrock needs signing.');
    await view.unmount();
  });

  it('sends a free Test at once and shows that it passed', async () => {
    const { view, calls } = await openTest({ available: true, spends: 'nothing', note: 'Free read.' }, passed());
    expect(view.container.textContent).toContain('Free read.');
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await until(() => view.container.querySelector('[data-login-test-result]') !== null, 'the result');
    expect(view.container.querySelector('[data-login-test-result]')?.textContent).toBe('Test passed — nothing spent.');
    expect(calls.map(call => call.body)).toEqual([{}]);
    await view.unmount();
  });

  it('asks before a one-token Test, sends nothing on Cancel, and consents on Send', async () => {
    const { view, calls } = await openTest(
      { available: true, spends: 'one-token', note: 'One token.' },
      { ...passed('one-token'), ok: false, code: 'rejected', message: 'The provider refused this key.' },
    );
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    expect(view.container.querySelector('[data-login-test-consent]')?.textContent).toContain('one token');
    await click(view.container.querySelector('[data-login-test-cancel]'), 'Cancel');
    expect(view.container.querySelector('[data-login-test-consent]')).toBeNull();
    expect(calls).toHaveLength(0);
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await click(view.container.querySelector('[data-login-test-send]'), 'Send');
    await until(() => view.container.querySelector('[data-login-test-result]') !== null, 'the result');
    expect(view.container.querySelector('[data-login-test-result="rejected"]')?.textContent).toBe(
      'The provider refused this key.',
    );
    expect(calls.map(call => call.body)).toEqual([{ allowInference: true }]);
    await view.unmount();
  });

  it('says the daemon’s refusal when the Test could not run', async () => {
    const { view } = await openTest(
      { available: true, spends: 'nothing', note: 'Free read.' },
      new FyHttpError('Only a login made from environment variables has a Test.', 409, 'fleet_credential_unavailable'),
    );
    await click(view.container.querySelector('[data-login-test-run]'), 'Test');
    await until(() => view.container.querySelector('[data-login-test-failure]') !== null, 'the failure');
    expect(view.container.querySelector('[data-login-test-failure]')?.textContent).toBe(
      'Only a login made from environment variables has a Test.',
    );
    await view.unmount();
  });
});

describe('LoginScopeChip', () => {
  it('names the one CLI a login drives', async () => {
    const view = await mount(
      <p>
        <LoginScopeChip harness="claude" />
        <LoginScopeChip harness="codex" />
      </p>,
    );
    expect(view.container.textContent).toBe('Claude onlyCodex only');
    await view.unmount();
  });
});

describe('CredentialEnvironment', () => {
  it('shows plain values, secret names with set ✓ or needs, the reference, the provider and what is missing', async () => {
    const createClient = async (): Promise<FleetClient> => scripted({});
    const view = await mount(
      <CredentialEnvironment
        credentialId="zai-glm"
        environment={{
          ...ENVIRONMENT,
          missingPreset: 'gone',
          cloudCredential: {
            reference: 'aws-profile:work',
            kind: 'aws-profile',
            sentence: 'Uses your AWS profile work on this machine. It is named here, never copied.',
            variable: 'AWS_PROFILE',
          },
          codexProvider: { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1' },
        }}
        connection={STUDIO}
        createClient={createClient}
        online
      />,
    );
    const c = view.container;
    const row = (name: string) => c.querySelector(`[data-credential-variable="${name}"]`)?.textContent;
    expect(row('ANTHROPIC_AUTH_TOKEN')).toBe(`ANTHROPIC_AUTH_TOKEN ${secretRef('ZAI_API_KEY')} set ✓`);
    expect(row('ANTHROPIC_BASE_URL')).toBe('ANTHROPIC_BASE_URLhttps://api.z.ai/api/anthropic');
    expect(row('ANTHROPIC_API_KEY')).toBe('ANTHROPIC_API_KEY""');
    expect(row('GATEWAY')).toBe('GATEWAYneeds GW_KEY');
    expect(row('ODD_TOKEN')).toBe('ODD_TOKENhidden');
    expect(c.textContent).toContain('Made from GLM / Z.ai');
    expect(c.querySelector('[data-credential-missing-preset]')?.textContent).toContain('Preset gone');
    expect(c.querySelector('[data-credential-cloud]')?.textContent).toContain('aws-profile:work');
    expect(c.querySelector('[data-credential-codex-provider]')?.textContent).toBe(
      'Codex model provider: Kimi · https://api.moonshot.ai/v1',
    );
    expect(c.querySelector('[data-credential-needs]')?.textContent).toContain('needs: GW_KEY — add it');
    expect(c.querySelector('[data-login-test-run]')).not.toBeNull();
    await view.unmount();
  });

  it('leaves out what a login without a preset, reference or provider does not have', async () => {
    const createClient = async (): Promise<FleetClient> => scripted({});
    const view = await mount(
      <CredentialEnvironment
        credentialId="hand"
        environment={{
          variables: [],
          quotaSource: 'transcript-pricing',
          missingSecrets: ['A_KEY', 'B_KEY'],
          codexProvider: { id: 'ollama', name: 'ollama' },
          test: { available: false, reason: 'No preset.' },
        }}
        connection={STUDIO}
        createClient={createClient}
        online={false}
      />,
    );
    const c = view.container;
    expect(c.textContent).not.toContain('Made from');
    expect(c.querySelector('[data-credential-cloud]')).toBeNull();
    expect(c.querySelector('[data-credential-codex-provider]')?.textContent).toBe('Codex model provider: ollama');
    expect(c.querySelector('[data-credential-needs]')?.textContent).toContain('add them');
    expect(c.textContent).toContain('No Test: No preset.');
    await view.unmount();
  });
});
