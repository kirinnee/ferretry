import { describe, it } from 'bun:test';
import should from 'should';
import { codexSettings } from '../../app/codex-settings.ts';
import { installWords, jobWords, latestWords, startRefusal, unverifiedQuestion, updateChoices, verificationBadge } from '../../app/lib/model.ts';
import { renderStatus } from '../../cli/lib/render.ts';
import { ABSENT_VIEW } from '../../contract/testing/index.ts';
import type { HarnessCliView } from '../../contract/index.ts';

const view = (extra: Partial<HarnessCliView>): HarnessCliView => ({
  ...ABSENT_VIEW,
  location: { state: 'located', path: '/opt/bin/codex', rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '0.140.0' },
  method: { kind: 'npm-global', tool: 'npm', package: '@openai/codex', prefix: '/p' },
  plan: { kind: 'self', steps: [{ command: 'npm install -g --prefix /p @openai/codex@latest' }], rollback: 'automatic', pinsVersion: true },
  check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z' as never, latest: { version: '0.163.0', url: 'https://example.test' } },
  verification: 'older',
  available: true,
  ...extra,
});

describe('the Codex settings words', () => {
  it('offers the verified version first and the newest after it, flagging the one past what Ferretry verified', () => {
    const choices = updateChoices(view({}));
    should(choices.map(choice => [choice.target, choice.unverified, choice.primary])).eql([
      ['0.145.0', false, true],
      ['0.163.0', true, false],
    ]);
  });

  it('offers a single Update for a method that takes what it has', () => {
    const plan = { kind: 'self' as const, steps: [{ command: 'brew upgrade --cask codex' }], rollback: 'none' as const, pinsVersion: false };
    should(updateChoices(view({ plan })).map(choice => choice.key)).eql(['newest']);
    should(updateChoices(view({ plan, available: false }))).eql([]);
  });

  it('says the badge, the install, the check and the job in plain words', () => {
    should(verificationBadge('unverified').tone).equal('warn');
    should(installWords({ kind: 'homebrew', type: 'cask', package: 'codex' })).equal('Homebrew cask codex');
    should(latestWords({ state: 'never' }, 0)).equal('Not checked yet.');
    should(jobWords({ state: 'running', command: 'brew update' } as never).text).equal('Updating — running brew update');
    should(unverifiedQuestion(view({}), '0.163.0')).match(/has not been verified by Ferretry yet/u);
  });

  it('turns a refused update into the question it needs, or the daemon’s own sentence', () => {
    should(
      startRefusal({ code: 'harness_update_unverified', body: { error: 'x', code: 'harness_update_unverified', verified: '0.145.0', target: '0.163.0' } }),
    ).eql({ kind: 'unverified', verified: '0.145.0', target: '0.163.0' });
    should(startRefusal(new Error('nope'))).eql({ kind: 'message', text: 'nope' });
  });

  it('reads the view and starts an update through the generated client, handing a refusal back as data', async () => {
    const calls: string[] = [];
    const client = {
      call: async (route: string) => {
        calls.push(route);
        if (route.startsWith('POST')) throw Object.assign(new Error('busy'), { code: 'harness_update_in_progress' });
        return ABSENT_VIEW;
      },
    };
    const settings = codexSettings(client as never);
    should(await settings.load()).eql(ABSENT_VIEW);
    should(await settings.update({})).eql({ started: false, refusal: { kind: 'message', text: 'busy' } });
    should(calls).eql(['GET /v1/codex/update', 'POST /v1/codex/update']);
  });
});

describe('fy harness codex status', () => {
  it('says plainly when Codex is not on the machine', () => {
    should(renderStatus(ABSENT_VIEW, 'fy')).equal('Codex: not found on this machine\n  Searched PATH.');
  });

  it('says what runs, how to update it, and that running ferrets keep their version', () => {
    const text = renderStatus(view({}), 'fy');
    should(text).match(/Codex 0\.140\.0 - update available: 0\.163\.0/u);
    should(text).match(/Update:     fy harness codex update - runs npm install/u);
    should(text).match(/Running ferrets keep the version they started with/u);
  });
});
