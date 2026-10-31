import { describe, it } from 'bun:test';
import { SHARED_CATALOG_FILE_MAX_BYTES, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { CatalogInstallController, type CatalogInstallOptions } from '../../../src/lib/catalog-install/controller.ts';
import {
  catalogFileText,
  FakeFiles,
  FakeGateway,
  FakeOutput,
  FakePrompt,
  INSTALL_ID,
  installOf,
  mcpItem,
  PREVIEW_ID,
  previewOf,
  skillItem,
} from './support.ts';

const PROJECT: CatalogInstallOptions = { project: 'repo', harness: 'claude', bind: [], unbound: [], yes: true };

function build(
  options: {
    text?: string;
    interactive?: boolean;
    answers?: string[];
    size?: number | Error;
    readFailure?: Error;
  } = {},
) {
  const gateway = new FakeGateway();
  const out = new FakeOutput();
  const prompt = new FakePrompt(options.answers);
  const controller = new CatalogInstallController({
    gateway,
    files: new FakeFiles(options.text ?? catalogFileText([skillItem()]), options.size, options.readFailure),
    out,
    prompt,
    interactive: options.interactive ?? false,
    cwd: '/work',
    binaryName: 'fy',
  });
  return { controller, gateway, out, prompt };
}

describe('fy catalog install', () => {
  it('should preview a project install, print the whole review and apply it with --yes', async () => {
    const { controller, gateway, out } = build();
    gateway.preview = previewOf({ warnings: [{ code: 'first-publisher', text: 'first one' }] });

    await controller.install('cat.json', PROJECT);

    should(gateway.previews).have.length(1);
    should(gateway.previews[0]?.scope).equal('project');
    should(gateway.previews[0]?.request.target).eql({ scope: 'project', projectRoot: '/work/repo', harness: 'claude' });
    should(gateway.previews[0]?.request.allowOlder).be.undefined();
    const review = out.reports[0] ?? '';
    for (const part of [
      'pdf-tools',
      'kirin-box',
      'Warnings:',
      '! first one',
      'Starts: acme-mcp',
      '| line one',
      '| line two',
    ])
      should(review).containEql(part);
    should(gateway.applies[0]?.request).eql({ previewId: PREVIEW_ID, secretBindings: {} });
    should(out.successes[0]).containEql('Installed pdf-tools');
    should(out.exitCode).equal(0);
  });

  it('should send --older as allowOlder and print the applied notes', async () => {
    const { controller, gateway, out } = build();
    gateway.notes = ['give the ferret ACME_TOKEN'];

    await controller.install('cat.json', { ...PROJECT, older: true });

    should(gateway.previews[0]?.request.allowOlder).be.true();
    should(out.reports.at(-1)).equal('give the ferret ACME_TOKEN');
  });

  it('should install into a runtime profile', async () => {
    const { controller, gateway } = build();

    await controller.install('cat.json', { runtime: 'claude-work', profile: 'work', bind: [], unbound: [], yes: true });

    should(gateway.previews[0]?.scope).equal('runtime');
    should(gateway.previews[0]?.request.target).eql({ scope: 'runtime', runtime: 'claude-work', profile: 'work' });
  });

  it('should name where it goes when neither or both targets are given', async () => {
    for (const options of [
      { bind: [], unbound: [] },
      { project: '/a', runtime: 'r', bind: [], unbound: [] },
    ]) {
      const { controller, out, gateway } = build();
      await controller.install('cat.json', options);
      should(out.errors[0]).containEql('Name where it goes');
      should(out.exitCode).equal(1);
      should(gateway.previews).have.length(0);
    }
  });

  it('should need a harness for a project and a profile for a runtime', async () => {
    const project = build();
    await project.controller.install('cat.json', { project: '/a', harness: 'gemini', bind: [], unbound: [] });
    should(project.out.errors[0]).containEql('--harness');
    const runtime = build();
    await runtime.controller.install('cat.json', { runtime: 'r', bind: [], unbound: [] });
    should(runtime.out.errors[0]).containEql('--profile');
  });

  it('should read --bind and --unbound, and refuse malformed or repeated ones', async () => {
    const good = build({ text: catalogFileText([mcpItem()]) });
    good.gateway.preview = previewOf({
      secrets: [
        { placeholder: 'A', held: true },
        { placeholder: 'B', held: false },
      ],
    });
    await good.controller.install('cat.json', { ...PROJECT, bind: ['A=MY_A'], unbound: ['B'] });
    should(good.gateway.applies[0]?.request.secretBindings).eql({ A: 'MY_A', B: null });
    should(good.out.reports[0]).containEql('A (you hold a secret with this name)');

    for (const bind of ['A', '=x', 'A=']) {
      const bad = build();
      await bad.controller.install('cat.json', { ...PROJECT, bind: [bind] });
      should(bad.out.errors[0]).containEql('PLACEHOLDER=MY_SECRET');
    }
    const twice = build();
    await twice.controller.install('cat.json', { ...PROJECT, bind: ['A=X'], unbound: ['A'] });
    should(twice.out.errors[0]).containEql('named twice');
  });

  it('should refuse a placeholder the item does not ask for', async () => {
    const { controller, gateway, out } = build();
    await controller.install('cat.json', { ...PROJECT, bind: ['NOPE=X'] });
    should(out.errors[0]).containEql('does not ask for NOPE');
    should(gateway.applies).have.length(0);
  });

  it('should refuse an unanswered placeholder when it cannot ask', async () => {
    const { controller, gateway, out } = build();
    gateway.preview = previewOf({ secrets: [{ placeholder: 'A', held: false }] });
    await controller.install('cat.json', PROJECT);
    should(out.errors[0]).containEql('--bind A=');
    should(gateway.applies).have.length(0);
  });

  it('should ask for a placeholder when interactive, empty meaning unbound', async () => {
    const { controller, gateway, prompt } = build({ interactive: true, answers: ['MY_A', '', 'y'] });
    gateway.preview = previewOf({
      secrets: [
        { placeholder: 'A', held: false },
        { placeholder: 'B', held: false },
      ],
    });
    await controller.install('cat.json', { project: 'repo', harness: 'claude', bind: [], unbound: [] });
    should(prompt.asked[0]).containEql('fills A');
    should(prompt.asked[2]).equal('Install this? [y/N]');
    should(gateway.applies[0]?.request.secretBindings).eql({ A: 'MY_A', B: null });
  });

  it('should ask to replace when the preview replaces an install, and stop on a no', async () => {
    const { controller, gateway, prompt, out } = build({ interactive: true, answers: ['n'] });
    gateway.preview = previewOf({ replaces: { installId: INSTALL_ID, version: 1 } });
    await controller.install('cat.json', { project: 'repo', harness: 'claude', bind: [], unbound: [] });
    should(out.reports[0]).containEql(`Replaces the version 1 you installed there (${INSTALL_ID})`);
    should(prompt.asked[0]).equal('Replace the installed copy? [y/N]');
    should(out.warnings[0]).equal('Nothing was changed.');
    should(out.exitCode).equal(1);
    should(gateway.applies).have.length(0);
  });

  it('should need --yes when it cannot ask', async () => {
    const { controller, out, gateway } = build();
    await controller.install('cat.json', { ...PROJECT, yes: false });
    should(out.errors[0]).containEql('--yes');
    should(out.exitCode).equal(1);
    should(gateway.applies).have.length(0);
  });

  it('should accept "yes" in any case', async () => {
    const { controller, gateway } = build({ interactive: true, answers: [' YES '] });
    await controller.install('cat.json', { project: 'repo', harness: 'claude', bind: [], unbound: [] });
    should(gateway.applies).have.length(1);
  });

  it('should choose the one item, a named item, or ask for --item', async () => {
    const two = catalogFileText([skillItem(), mcpItem()]);
    const named = build({ text: two });
    await named.controller.install('cat.json', { ...PROJECT, item: 'acme-mcp' });
    should(named.gateway.previews[0]?.request.item.name).equal('acme-mcp');

    const several = build({ text: two });
    await several.controller.install('cat.json', PROJECT);
    should(several.out.errors[0]).containEql('pdf-tools, acme-mcp');
    should(several.out.errors[0]).containEql('--item');

    const unknown = build({ text: two });
    await unknown.controller.install('cat.json', { ...PROJECT, item: 'nope' });
    should(unknown.out.errors[0]).containEql('No item called nope');

    const empty = build({ text: catalogFileText([]) });
    await empty.controller.install('cat.json', PROJECT);
    should(empty.out.errors[0]).equal('This file carries no items.');
  });

  it('should explain a file it cannot read, is too big, or is not a catalog', async () => {
    const missing = build({ size: new Error('ENOENT') });
    await missing.controller.install('cat.json', PROJECT);
    should(missing.out.errors[0]).equal('Cannot read cat.json: ENOENT');

    const big = build({ size: SHARED_CATALOG_FILE_MAX_BYTES + 1 });
    await big.controller.install('cat.json', PROJECT);
    should(big.out.errors[0]).containEql('larger than 32 MiB');

    const unreadable = build({ readFailure: new Error('EIO') });
    await unreadable.controller.install('cat.json', PROJECT);
    should(unreadable.out.errors[0]).equal('Cannot read cat.json: EIO');

    const junk = build({ text: 'not json' });
    await junk.controller.install('cat.json', PROJECT);
    should(junk.out.errors[0]).containEql('not JSON');
    should(junk.out.exitCode).equal(1);
  });

  it('should say a passkey is needed, and that nothing changed', async () => {
    const { controller, gateway, out } = build();
    gateway.failure = new FyHttpError('step up', 403, STEP_UP_REQUIRED_CODE);
    await controller.install('cat.json', PROJECT);
    should(out.errors[0]).containEql('passkey');
    should(out.errors[0]).containEql('Nothing was changed');
    should(out.exitCode).equal(1);
  });

  it('should print the daemon sentence for any other refusal, and rethrow what it does not know', async () => {
    const refused = build();
    refused.gateway.failure = new FyHttpError('Signature is wrong', 422, 'catalog_signature_invalid');
    await refused.controller.install('cat.json', PROJECT);
    should(refused.out.errors[0]).equal('Nothing was changed. Signature is wrong');

    const broken = build();
    broken.gateway.failure = new TypeError('boom');
    await should(broken.controller.install('cat.json', PROJECT)).be.rejectedWith('boom');
  });
});

describe('fy catalog installs / uninstall', () => {
  it('should say when nothing is installed and list installs with their secrets', async () => {
    const { controller, gateway, out } = build();
    await controller.installs();
    should(out.reports[0]).equal('No catalog items are installed.');

    gateway.installs = [installOf('project', { A: 'MY_A', B: null }), installOf('runtime')];
    await controller.installs();
    const text = out.reports[1] ?? '';
    should(text).containEql(INSTALL_ID);
    should(text).containEql('secrets: A -> MY_A, B -> unbound');
    should(text).containEql('in the skill pdf-tools in runtime claude-work');
  });

  it('should refuse an id it does not have', async () => {
    const { controller, out } = build();
    await controller.uninstall(INSTALL_ID, { yes: true });
    should(out.errors[0]).containEql('catalog installs');
    should(out.exitCode).equal(1);
  });

  it('should remove with --yes using the install scope, or ask first', async () => {
    const yes = build();
    yes.gateway.installs = [installOf('runtime')];
    await yes.controller.uninstall(INSTALL_ID, { yes: true });
    should(yes.gateway.removes).eql([{ scope: 'runtime', installId: INSTALL_ID }]);
    should(yes.out.successes[0]).containEql('Removed pdf-tools');

    const no = build({ interactive: true, answers: ['n'] });
    no.gateway.installs = [installOf('project')];
    await no.controller.uninstall(INSTALL_ID, {});
    should(no.prompt.asked[0]).containEql('Remove pdf-tools');
    should(no.gateway.removes).have.length(0);

    const ask = build({ interactive: true, answers: ['y'] });
    ask.gateway.installs = [installOf('project')];
    await ask.controller.uninstall(INSTALL_ID, {});
    should(ask.gateway.removes).have.length(1);
  });

  it('should print a daemon refusal on remove', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf('project')];
    gateway.failure = new FyHttpError('edited locally', 409, 'catalog_install_conflict');
    await controller.uninstall(INSTALL_ID, { yes: true });
    should(out.errors[0]).equal('Nothing was changed. edited locally');
  });
});

describe('fy catalog install, installs and uninstall with --json', () => {
  it('should send the preview to stderr and print only the applied install on stdout', async () => {
    const { controller, gateway, out } = build();
    gateway.preview = previewOf({ warnings: [{ code: 'first-publisher', text: 'first one' }] });

    await controller.install('cat.json', { ...PROJECT, json: true });

    should(out.reports).have.length(0);
    should(JSON.parse(out.diagnostics[0] ?? '{}')).match({ phase: 'preview', preview: { previewId: PREVIEW_ID } });
    should(out.successes).have.length(1);
    const installed = JSON.parse(out.successes[0] ?? '{}');
    should(installed.install.installId).equal(INSTALL_ID);
    should(installed.notes).be.an.Array();
  });

  it('should print the install list as its protocol payload', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf('project', { A: null })];

    await controller.installs({ json: true });

    should(out.reports).have.length(0);
    should(JSON.parse(out.successes[0] ?? '{}').installs[0].installId).equal(INSTALL_ID);
  });

  it('should refuse --json without --yes, before reading or changing anything', async () => {
    const install = build({ interactive: true, answers: ['y'] });
    await install.controller.install('cat.json', { ...PROJECT, yes: false, json: true });
    should(install.gateway.previews).have.length(0);
    should(install.out.errors[0]).containEql('--json is for scripts');
    should(install.out.exitCode).equal(1);

    const remove = build({ interactive: true, answers: ['y'] });
    remove.gateway.installs = [installOf('runtime')];
    await remove.controller.uninstall(INSTALL_ID, { json: true });
    should(remove.gateway.removes).have.length(0);
    should(remove.out.errors[0]).containEql('--json is for scripts');
  });

  it('should print what was removed as its protocol payload', async () => {
    const { controller, gateway, out } = build();
    gateway.installs = [installOf('runtime')];

    await controller.uninstall(INSTALL_ID, { yes: true, json: true });

    should(JSON.parse(out.successes[0] ?? '{}').installId).equal(INSTALL_ID);
  });
});
