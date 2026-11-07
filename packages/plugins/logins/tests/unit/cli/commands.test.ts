import { describe, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import should from 'should';
import {
  loginCheck,
  loginLs,
  loginModelsList,
  loginModelsRefresh,
  loginPresets,
  loginTest,
} from '../../../cli/lib/commands.ts';
import { LoginsCommandError } from '../../../cli/lib/ports.ts';
import { renderModelCatalogs, renderModelRefresh, renderPresetList } from '../../../cli/lib/render.ts';
import { runSignIn } from '../../../cli/lib/sign-in.ts';
import type { LoginId, ModelCatalogsView, ProviderPresetCatalog } from '../../../contract/index.ts';
import { fakeWorld, flow, login, loginList } from './fakes.ts';

const VIEW: ModelCatalogsView = {
  published: {
    origin: 'https://ferretry.pages.dev',
    enabled: true,
    version: 4,
    checkedAt: '2026-10-19T00:00:00.000Z' as Instant,
  },
  catalogs: [
    {
      id: 'zai',
      label: 'GLM / Z.ai',
      origin: 'published',
      verified: '2026-10-18',
      customIds: false,
      claude: [
        { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', context: 1_000_000, efforts: ['low', 'high'], default: true },
        { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', context: 256_000, efforts: [], default: false },
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      origin: 'built-in',
      verified: '2026-10-18',
      customIds: true,
      codex: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: [], default: true }],
    },
  ],
};

const PRESETS = {
  presets: [
    {
      id: 'zai-glm',
      label: 'Z.ai GLM',
      harness: 'claude-code',
      halves: [
        { harness: 'claude-code', offered: { available: true }, models: [] },
        { harness: 'codex', offered: { available: true }, models: [] },
      ],
      test: { available: true, spends: 'nothing', note: 'lists models' },
      quota: { source: 'none', note: 'n/a' },
      offered: { available: true },
    },
    {
      id: 'hidden',
      label: 'Hidden',
      harness: 'codex',
      halves: [{ harness: 'codex', offered: { available: false, reason: 'no' }, models: [] }],
      test: { available: false, reason: 'nope' },
      quota: { source: 'none', note: 'n/a' },
      offered: { available: false, reason: 'needs a cloud profile' },
    },
  ],
} as unknown as ProviderPresetCatalog;

describe('fy login ls / check / test / presets', () => {
  it('should list the logins with status, usage and who uses each, and say what needs sign-in', async () => {
    // Arrange
    const needs = login({
      id: 'codex-you',
      harness: 'codex',
      status: {
        word: 'needs_sign_in',
        label: 'Needs sign-in',
        reason: 'access_current',
        explanation: 'Sign in again.',
        lastCheckInconclusive: false,
      },
      usedBy: [],
    });
    const world = fakeWorld({ gateway: { logins: () => loginList(login(), needs) } });

    // Act
    await loginLs(world.deps, { args: [], options: {} });

    // Assert
    const text = world.out.text('report');
    should(text).containEql('Logins on box:');
    should(text).containEql('claude-you  Claude Code  you@example.com  — Ready');
    should(text).containEql('Usage: 5-hour 12% used · weekly not measured yet');
    should(text).containEql('Used by: main');
    should(text).containEql('Used by: no runtime yet');
    should(text).containEql('Needs sign-in:\n  fz login signin codex-you');
  });

  it('should say how to add the first login when there are none, and print JSON when asked', async () => {
    const world = fakeWorld({ gateway: { logins: () => loginList() } });
    await loginLs(world.deps, { args: [], options: {} });
    should(world.out.text('report')).equal('No logins on box yet. Add one with `fz login add claude` (or codex).');
    await loginLs(world.deps, { args: [], options: { json: true } });
    should(JSON.parse(world.out.lines[1]?.text as string)).match({ format: 1, machine: 'box' });
  });

  it('should show one login after a check, and exit 1 naming the sign-in when it needs one', async () => {
    const world = fakeWorld({
      gateway: {
        check: () =>
          login({
            status: {
              word: 'needs_sign_in',
              label: 'Needs sign-in',
              reason: 'access_current',
              explanation: 'Gone.',
              lastCheckInconclusive: false,
            },
          }),
      },
    });
    await loginCheck(world.deps, { args: ['claude-you'], options: {} });
    should(world.gateway.called('check')[0]?.args).eql(['claude-you']);
    should(world.out.text('error')).equal('claude-you needs sign-in: fz login signin claude-you');
    should(world.out.exitCode).equal(1);
    await should(loginCheck(world.deps, { args: [], options: {} })).be.rejectedWith(LoginsCommandError);
  });

  it('should print a test result, ask for consent when the provider needs one token, and exit 1 on failure', async () => {
    const world = fakeWorld({
      gateway: {
        test: () => ({
          loginId: 'glm' as LoginId,
          ok: false,
          code: 'consent_required',
          message: 'This provider has no free check.',
          spent: 'nothing',
          at: '2026-11-01T10:00:00.000Z' as Instant,
        }),
      },
    });
    await loginTest(world.deps, { args: ['glm'], options: {} });
    should(world.out.text('report')).equal('glm: This provider has no free check.');
    should(world.out.text('error')).equal('To send it: fz login test glm --allow-inference');
    should(world.out.exitCode).equal(1);
    await loginTest(world.deps, { args: ['glm'], options: { 'allow-inference': true } });
    should(world.gateway.called('test').map(call => call.args)).eql([
      ['glm', false],
      ['glm', true],
    ]);
  });

  it('should list the presets by tool with their scope, and why a hidden one is not offered', async () => {
    const world = fakeWorld({ gateway: { presets: () => PRESETS } });
    await loginPresets(world.deps, { args: [], options: {} });
    const text = world.out.text('report');
    should(text).containEql('Claude Code:\n  zai-glm  Z.ai GLM  (Claude + Codex)  — test: free, quota: none');
    should(text).containEql('Codex:\n  hidden  Hidden  (not offered)');
    should(text).containEql('Not offered: needs a cloud profile');
    should(renderPresetList(PRESETS, 'fz')).containEql('Add one: fz login add claude --preset <id>');
  });
});

describe('fy login models', () => {
  it('should list every catalog, where it came from, and its models by CLI with the default starred', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { models: () => VIEW } });

    // Act
    await loginModelsList(world.deps, { args: [], options: {} });

    // Assert
    const text = world.out.text('report');
    should(text).containEql(
      'Published catalog from https://ferretry.pages.dev: version 4, checked 2026-10-19T00:00:00.000Z',
    );
    should(text).containEql('zai — GLM / Z.ai (published, verified 2026-10-18)');
    should(text).containEql('* glm-5.3  GLM-5.3 (most capable · 1M context · effort low/high)');
    should(text).containEql('  glm-5.3-flash  GLM-5.3-Flash (fast · 256K context)');
    should(text).containEql('openai — OpenAI (built-in, verified 2026-10-18, takes any id)');
    should(text).containEql('Codex:');
  });

  it('should check for a newer published catalog and say what came of it', async () => {
    const world = fakeWorld({
      gateway: {
        refreshModels: () => ({ outcome: 'refused', version: 4, reason: 'the signature does not verify' }),
      },
    });
    await loginModelsRefresh(world.deps, { args: [], options: {} });
    await loginModelsRefresh(world.deps, { args: [], options: { json: true } });
    should(world.out.lines[0]?.text).equal(
      'The published model catalog did not check; the one held stays in effect (version 4): the signature does not verify.',
    );
    should(JSON.parse(world.out.lines[1]?.text as string)).match({ outcome: 'refused' });
  });

  it('should word every outcome, and a daemon that follows no published catalog', () => {
    should(renderModelRefresh({ outcome: 'updated', version: 5 })).equal(
      'A newer model catalog was published; it is in effect now (version 5).',
    );
    should(renderModelRefresh({ outcome: 'disabled' })).containEql('FY_MODEL_CATALOG=off');
    should(renderModelCatalogs({ published: { origin: 'https://x', enabled: false }, catalogs: [] })).equal(
      'Published catalog: not followed (FY_MODEL_CATALOG=off)',
    );
    should(renderModelCatalogs({ published: { origin: 'https://x', enabled: true }, catalogs: [] })).equal(
      'Published catalog from https://x: none taken yet, never checked',
    );
  });
});

describe('harness sign-in secrecy (docs/design/harness-login.md)', () => {
  it('should never print or keep the code a person pastes, and show the page address once', async () => {
    // Arrange
    const pasted = 'PASTED-CODE-123#state';
    const awaiting = flow({ state: 'awaiting-code', verificationUrl: 'https://claude.ai/oauth/authorize?x=1' });
    const world = fakeWorld({
      answers: [pasted],
      gateway: {
        startSignIn: () => awaiting,
        submitSignInCode: () => ({ outcome: 'accepted', flow: flow({ state: 'complete' }) }),
      },
    });

    // Act
    await runSignIn(world.deps, 'claude-you');

    // Assert
    should(world.out.lines.some(line => line.text.includes(pasted))).be.false();
    should(world.out.lines.filter(line => line.text.includes('claude.ai/oauth'))).have.length(1);
    should(world.gateway.called('submitSignInCode')[0]?.args).eql(['flow-1', pasted]);
  });
});
