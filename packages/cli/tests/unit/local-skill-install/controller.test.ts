import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  LocalSkillInstallController,
  type LocalSkillInstallOptions,
} from '../../../src/lib/local-skill-install/controller.ts';
import { FakeGateway, FakeOutput, FakePrompt, INSTALL_ID, installOf, PREVIEW_ID, previewOf } from './support.ts';

const PROJECT: LocalSkillInstallOptions = {
  from: '/home/a/.claude/skills/pdf-tools',
  to: 'project',
  project: 'repo',
  harness: 'claude',
  yes: true,
};

function build(options: { interactive?: boolean; answers?: string[] } = {}) {
  const gateway = new FakeGateway();
  const out = new FakeOutput();
  const prompt = new FakePrompt(options.answers);
  const controller = new LocalSkillInstallController({
    gateway,
    out,
    prompt,
    interactive: options.interactive ?? false,
    cwd: '/work',
    binaryName: 'fy',
  });
  return { controller, gateway, out, prompt };
}

describe('fy skill install', () => {
  it('should preview a project copy, print the review and apply exactly that preview with --yes', async () => {
    const { controller, gateway, out } = build();

    await controller.install(PROJECT);

    should(gateway.previews[0]?.scope).equal('project');
    should(gateway.previews[0]?.request).eql({
      source: { path: '/home/a/.claude/skills/pdf-tools/SKILL.md' },
      target: { scope: 'project', projectRoot: '/work/repo', harness: 'claude' },
    });
    should(out.reports[0]).containEql('pdf-tools copied from');
    should(gateway.applies).eql([{ scope: 'project', request: { previewId: PREVIEW_ID } }]);
    should(out.successes[0]).equal(
      `Copied pdf-tools (${INSTALL_ID}) to /work/repo/.claude/skills/pdf-tools/ (1 file).`,
    );
  });

  it('should take a SKILL.md path as it is, copy to a runtime and print the notes', async () => {
    const { controller, gateway, out } = build();
    gateway.notes = ['starts next time'];

    await controller.install({
      from: '/home/a/.claude/skills/pdf-tools/SKILL.md',
      to: 'runtime',
      runtime: 'claude-work',
      profile: 'work',
      yes: true,
    });

    should(gateway.previews[0]?.request.source.path).equal('/home/a/.claude/skills/pdf-tools/SKILL.md');
    should(gateway.previews[0]?.request.target).eql({ scope: 'runtime', runtime: 'claude-work', profile: 'work' });
    should(out.reports).containEql('starts next time');
  });

  it('should send the review to stderr and the payload to stdout with --json --yes', async () => {
    const { controller, out } = build();

    await controller.install({ ...PROJECT, json: true });

    should(JSON.parse(out.diagnostics[0] ?? '{}').phase).equal('preview');
    should(out.reports).eql([]);
    should(JSON.parse(out.successes[0] ?? '{}').install.installId).equal(INSTALL_ID);
  });

  it('should refuse --json without --yes before asking the daemon anything', async () => {
    const { controller, gateway, out } = build();

    await controller.install({ ...PROJECT, yes: undefined, json: true });

    should(gateway.previews).have.length(0);
    should(out.errors[0]).containEql('--json is for scripts');
    should(out.exitCode).equal(1);
  });

  it('should ask first when it replaces a copy, and apply on a yes', async () => {
    const { controller, gateway, prompt } = build({ interactive: true, answers: ['y'] });
    gateway.preview = previewOf({ replaces: { installId: INSTALL_ID } });

    await controller.install({ ...PROJECT, yes: undefined });

    should(prompt.asked).eql(['Replace your copy? [y/N]']);
    should(gateway.applies).have.length(1);
  });

  it('should ask "Copy this?" for a fresh copy and write nothing on a no', async () => {
    const { controller, gateway, out, prompt } = build({ interactive: true, answers: ['n'] });

    await controller.install({ ...PROJECT, yes: undefined });

    should(prompt.asked).eql(['Copy this? [y/N]']);
    should(gateway.applies).have.length(0);
    should(out.warnings).eql(['Nothing was changed.']);
    should(out.exitCode).equal(1);
  });

  it('should not guess a yes when there is no terminal', async () => {
    const { controller, gateway, out } = build();

    await controller.install({ ...PROJECT, yes: undefined });

    should(gateway.applies).have.length(0);
    should(out.errors[0]).containEql('needs a yes');
    should(out.exitCode).equal(1);
  });

  for (const [name, options, words] of [
    ['no source', { ...PROJECT, from: undefined }, 'Name the skill to copy'],
    ['an empty source', { ...PROJECT, from: '' }, 'Name the skill to copy'],
    ['no scope', { ...PROJECT, to: undefined }, 'Say where it goes'],
    ['an unknown scope', { ...PROJECT, to: 'cloud' }, 'Say where it goes'],
    ['a project without a root', { ...PROJECT, project: undefined }, 'needs --project'],
    ['a project without a harness', { ...PROJECT, harness: undefined }, 'needs --harness'],
    ['a runtime without a name', { from: PROJECT.from, to: 'runtime', profile: 'p', yes: true }, '--runtime <name>'],
    ['a runtime without a profile', { from: PROJECT.from, to: 'runtime', runtime: 'r', yes: true }, '--profile <name>'],
  ] as const) {
    it(`should explain ${name} and change nothing`, async () => {
      const { controller, gateway, out } = build();

      await controller.install(options as LocalSkillInstallOptions);

      should(gateway.previews).have.length(0);
      should(out.errors[0]).containEql(words);
      should(out.exitCode).equal(1);
    });
  }

  it('should say a passkey is wanted, and that nothing changed', async () => {
    const { controller, gateway, out } = build();
    gateway.failure = new FyHttpError('step up', 403, STEP_UP_REQUIRED_CODE);

    await controller.install(PROJECT);

    should(out.errors[0]).containEql('passkey');
    should(out.exitCode).equal(1);
  });

  it("should print the daemon's own refusal as nothing changed", async () => {
    const { controller, gateway, out } = build();
    gateway.failure = new FyHttpError('a file was edited here', 409, 'local_skill_conflict');

    await controller.install(PROJECT);

    should(out.errors[0]).equal('Nothing was changed. a file was edited here');
  });

  it('should not swallow an error it does not know', async () => {
    const { controller, gateway } = build();
    gateway.failure = new Error('boom');

    await controller.install(PROJECT).then(
      () => should.fail('expected a rejection', 'resolved'),
      error => should((error as Error).message).equal('boom'),
    );
  });
});

describe('fy skill installs', () => {
  it('should list copies, or the protocol payload with --json', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf()];

    await controller.installs();
    await controller.installs({ json: true });

    should(out.reports[0]).containEql(INSTALL_ID);
    should(JSON.parse(out.successes[0] ?? '{}').installs).have.length(1);
  });
});

describe('fy skill uninstall', () => {
  it('should remove a copy by id after a yes, with its scope', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf('runtime')];

    await controller.uninstall(INSTALL_ID, { yes: true });

    should(gateway.removes).eql([{ scope: 'runtime', installId: INSTALL_ID }]);
    should(out.successes[0]).equal('Removed pdf-tools from gone.');
  });

  it('should print the payload with --json --yes', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf()];

    await controller.uninstall(INSTALL_ID, { yes: true, json: true });

    should(JSON.parse(out.successes[0] ?? '{}').installId).equal(INSTALL_ID);
  });

  it('should need --yes with --json, and name an unknown id', async () => {
    const { controller, gateway, out } = build();

    await controller.uninstall(INSTALL_ID, { json: true });
    await controller.uninstall(INSTALL_ID, { yes: true });

    should(out.errors[0]).containEql('--json is for scripts');
    should(out.errors[1]).containEql(`No copy ${INSTALL_ID}`);
    should(gateway.removes).have.length(0);
  });

  it('should leave the copy alone on a no', async () => {
    const { controller, gateway, out } = build({ interactive: true, answers: ['no'] });
    gateway.installs = [installOf()];

    await controller.uninstall(INSTALL_ID, {});

    should(gateway.removes).have.length(0);
    should(out.exitCode).equal(1);
  });
});
