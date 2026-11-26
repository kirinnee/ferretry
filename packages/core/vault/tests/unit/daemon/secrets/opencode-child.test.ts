import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { ChildEnvironmentPort, VaultPort } from '../../../../contract/index.ts';
import vault from '../../../../daemon/index.ts';

test('the sealed child path refuses Anthropic OAuth material in every OpenCode variable, never returning it', async () => {
  const host = await testHost({ plugins: [vault], fakes: { asks: new FakeAsks(), gate: new FakeGate() } });
  try {
    const api = host.provided(VaultPort);
    // Synthetic shapes only; these are deliberately not live credentials.
    await api.put('OAUTH', 'sk-ant-oat01-SYNTHETIC-NOT-A-CREDENTIAL');
    await api.put('REFRESH', 'sk-ant-ort01-SYNTHETIC-NOT-A-CREDENTIAL');
    await api.put('KEY', 'sk-ant-api03-SYNTHETIC-NOT-A-CREDENTIAL');
    for (const name of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'PROFILE_SETTING', 'ENDPOINT_AUTH']) {
      for (const value of ['${secret:OAUTH}', 'Bearer ${secret:REFRESH}', '${secret:KEY}:${secret:OAUTH}']) {
        const refused = await api.childEnvironment('test-ferret' as never, { [name]: value }, 'opencode');
        expect(refused).toEqual({ ok: false, error: { unknown: [], code: 'subscription_login' } });
        expect(JSON.stringify(refused)).not.toContain('sk-ant-');
      }
    }
    const accepted = await api.childEnvironment(
      'test-ferret' as never,
      { ANTHROPIC_API_KEY: '${secret:KEY}' },
      'opencode',
    );
    expect(accepted.ok).toBe(true);
    expect(JSON.stringify(accepted)).not.toContain('sk-ant-');
    if (!accepted.ok) throw new Error('API key should pass');
    expect(host.provided(ChildEnvironmentPort).open(accepted.value)).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-api03-SYNTHETIC-NOT-A-CREDENTIAL',
    });
    for (const harness of ['claude-code', 'codex']) {
      expect((await api.childEnvironment('test-ferret' as never, { TOKEN: '${secret:OAUTH}' }, harness)).ok).toBe(true);
    }
  } finally {
    await host.stop();
  }
});
