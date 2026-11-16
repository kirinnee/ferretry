import { describe, it } from 'bun:test';
import should from 'should';
import { SignInController } from '../../../cli/lib/sign-in-controller.ts';
import { FyHttpError } from '../../../cli/shell.ts';
import { DAMAGED, LIST, RP, SI, accountPorts, rejection, signIn, type RigOptions } from './accounts-rig.ts';

function rig(options: RigOptions = {}) {
  const made = accountPorts(options);
  return { ...made, controller: new SignInController(made.ports) };
}

const withRecipe = { ...LIST, signIns: [signIn({ recipe: 'Click Sign in.' })] };

describe('SignInController list', () => {
  it('should list every sign-in, each with the id the other verbs take', async () => {
    const { controller, said } = rig();
    await controller.list(undefined, {});
    should(said).eql([`GITHUB_WORK  ${SI(1)}  Password, site signs in on github.com`]);
  });

  it("should list one account's sign-ins, or say it has none", async () => {
    const some = rig();
    await some.controller.list('GITHUB_WORK', {});
    should(some.said[0]).startWith(`GITHUB_WORK  ${SI(1)}`);
    const none = rig();
    await none.controller.list('GITHUB_HOME', {});
    should(none.said).eql(['GITHUB_HOME has no sign-ins yet (add one with `account site add`).']);
  });

  it('should print JSON, and refuse an account that does not exist or a store it cannot read', async () => {
    const json = rig();
    await json.controller.list(undefined, { json: true });
    should(JSON.parse(json.said[0] ?? '')).eql(JSON.parse(JSON.stringify(LIST.signIns)));
    should(await rejection(() => rig().controller.list('NOPE', {}))).equal('no account NOPE (see `account ls`)');
    should(await rejection(() => rig({ list: DAMAGED }).controller.list(undefined, {}))).containEql('NOT gone');
  });
});

describe('SignInController add', () => {
  it('should add a sign-in at the place the flags name and print it', async () => {
    const { controller, gateway, said } = rig();
    await controller.add('GITHUB_HOME', { domain: ['accounts.google.com'], for: ['vercel.com'] });
    should(gateway.calls.at(-1)).eql([
      'addSignIn',
      'GITHUB_HOME',
      { place: { kind: 'site', domains: ['accounts.google.com'], match: ['vercel.com'] } },
    ]);
    should(said[0]).startWith('Added to GITHUB_HOME: si_').and.containEql('accounts.google.com, for vercel.com');
  });

  it('should send the method and the auto-apply switch when they are named', async () => {
    const { controller, gateway } = rig();
    await controller.add('GITHUB_HOME', {
      tool: 'ssh',
      host: 'laptop',
      dest: 'build.example.com',
      method: 'sso',
      ssoName: 'Okta',
      autoApplyRecipe: 'on',
    });
    should(gateway.calls.at(-1)?.[2]).eql({
      place: { kind: 'terminal', tool: 'ssh', host: 'laptop', dest: 'build.example.com' },
      method: { kind: 'sso', name: 'Okta' },
      autoApplyRecipe: true,
    });
    const off = rig();
    await off.controller.add('GITHUB_HOME', { domain: ['github.com'], autoApplyRecipe: 'off' });
    should(off.gateway.calls.at(-1)?.[2]).eql({
      place: { kind: 'site', domains: ['github.com'], match: [] },
      autoApplyRecipe: false,
    });
  });

  it('should refuse an unknown account, a missing place, a bad switch and a damaged store before writing', async () => {
    const missing = rig();
    should(await rejection(() => missing.controller.add('NOPE', { domain: ['github.com'] }))).containEql(
      'no account NOPE',
    );
    const noPlace = rig();
    should(await rejection(() => noPlace.controller.add('GITHUB_HOME', {}))).containEql('say where it signs in');
    const badSwitch = rig();
    should(
      await rejection(() => badSwitch.controller.add('GITHUB_HOME', { domain: ['github.com'], autoApplyRecipe: 'x' })),
    ).equal('--auto-apply-recipe is on or off');
    const damaged = rig({ list: DAMAGED });
    should(await rejection(() => damaged.controller.add('GITHUB_HOME', { domain: ['github.com'] }))).containEql(
      'NOT gone',
    );
    for (const made of [missing, noPlace, badSwitch, damaged])
      should(made.gateway.calls.map(call => call[0])).not.containEql('addSignIn');
  });
});

describe('SignInController edit', () => {
  it('should refuse when no part is named, and a sign-in that does not exist', async () => {
    const none = rig();
    should(await rejection(() => none.controller.edit(SI(1), {}))).containEql('nothing to change');
    should(none.gateway.calls).eql([]);
    should(await rejection(() => rig().controller.edit(SI(9), { method: 'google' }))).equal(
      `no sign-in ${SI(9)} (see \`account site ls\`)`,
    );
    should(await rejection(() => rig().controller.edit('si_nope', { method: 'google' }))).containEql(
      'not a sign-in id',
    );
  });

  it('should change the place over the current one: a list is replaced and the other list is kept', async () => {
    const list = {
      ...LIST,
      signIns: [signIn({ place: { kind: 'site', domains: ['github.com'], match: ['npmjs.com'] } })],
    };
    const { controller, gateway, said } = rig({ list });
    await controller.edit(SI(1), { domain: ['gist.github.com'] });
    should(gateway.calls.at(-1)).eql([
      'putSignIn',
      SI(1),
      { place: { kind: 'site', domains: ['gist.github.com'], match: ['npmjs.com'] } },
    ]);
    should(said[0]).startWith(`Updated ${SI(1)}`);
  });

  it('should change the method over the current one, and the auto-apply switch', async () => {
    const list = {
      ...LIST,
      signIns: [signIn({ method: { kind: 'google', via: 'GITHUB_HOME' } })],
    };
    const method = rig({ list });
    await method.controller.edit(SI(1), { method: 'github' });
    should(method.gateway.calls.at(-1)).eql(['putSignIn', SI(1), { method: { kind: 'github', via: 'GITHUB_HOME' } }]);
    const noVia = rig({ list });
    await noVia.controller.edit(SI(1), { via: false });
    should(noVia.gateway.calls.at(-1)).eql(['putSignIn', SI(1), { method: { kind: 'google' } }]);
    const apply = rig();
    await apply.controller.edit(SI(1), { autoApplyRecipe: 'off' });
    should(apply.gateway.calls.at(-1)).eql(['putSignIn', SI(1), { autoApplyRecipe: false }]);
  });

  it('should not turn a site into a terminal by an edit', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.edit(SI(1), { tool: 'sudo', host: 'box' }))).containEql(
      'that sign-in is on a site',
    );
    should(gateway.calls.map(call => call[0])).not.containEql('putSignIn');
  });
});

describe('SignInController remove', () => {
  it('should remove at once with --yes', async () => {
    const { controller, gateway, said, asked } = rig();
    await controller.remove(SI(1), { yes: true });
    should(asked).eql([]);
    should(gateway.calls.at(-1)).eql(['removeSignIn', SI(1)]);
    should(said).eql([`Removed ${SI(1)} from GITHUB_WORK.`]);
  });

  it('should ask first, showing the sign-in, and remove on yes', async () => {
    const { controller, gateway, asked } = rig({ typed: ['Yes'] });
    await controller.remove(SI(1), {});
    should(asked[0]).equal(`Remove ${SI(1)}  Password, site signs in on github.com from GITHUB_WORK? Type yes: `);
    should(gateway.calls.at(-1)).eql(['removeSignIn', SI(1)]);
  });

  it('should keep it on any other answer', async () => {
    const { controller, gateway, said } = rig({ typed: ['no'] });
    await controller.remove(SI(1), {});
    should(said).eql([`Kept ${SI(1)}.`]);
    should(gateway.calls.map(call => call[0])).not.containEql('removeSignIn');
  });

  it('should refuse to ask away from a terminal', async () => {
    const { controller } = rig({ interactive: false });
    should(await rejection(() => controller.remove(SI(1), {}))).containEql('pass --yes to skip');
  });
});

describe('SignInController recipe show', () => {
  it("should show the recipe page for a sign-in with its account's label, or JSON", async () => {
    const text = rig({ list: withRecipe });
    await text.controller.recipeShow(SI(1), {});
    should(text.said[0]?.split('\n')[0]).equal(`work github  [GITHUB_WORK]  ${SI(1)}  on github.com`);
    should(text.said[0]).containEql('Click Sign in.');
    const json = rig({ list: withRecipe });
    await json.controller.recipeShow(SI(1), { json: true });
    should(JSON.parse(json.said[0] ?? '').recipe).equal('Click Sign in.');
  });

  it('should refuse a sign-in that does not exist', async () => {
    should(await rejection(() => rig().controller.recipeShow(SI(9), {}))).containEql(`no sign-in ${SI(9)}`);
  });
});

describe('SignInController recipe set', () => {
  it('should read the Markdown from the file named and replace the whole recipe with it', async () => {
    const { controller, gateway, reads, said } = rig({
      recipeFiles: { 'steps.md': ' Click Sign in.\r\nThen Continue. ' },
    });
    await controller.recipeSet(SI(1), { file: 'steps.md' });
    should(reads).eql(['steps.md']);
    should(gateway.calls.at(-1)).eql(['putSignIn', SI(1), { recipe: 'Click Sign in.\nThen Continue.' }]);
    should(said[0]).startWith(`Saved the recipe of ${SI(1)}`);
  });

  it('should ask for a file when none is named, and read nothing', async () => {
    const { controller, reads } = rig();
    should(await rejection(() => controller.recipeSet(SI(1), {}))).containEql('name the Markdown: --file <path>');
    should(reads).eql([]);
  });

  it('should refuse text that is not a recipe, and a sign-in that does not exist, before writing', async () => {
    const empty = rig({ recipeFiles: { 'empty.md': '   ' } });
    should(await rejection(() => empty.controller.recipeSet(SI(1), { file: 'empty.md' }))).containEql(
      'that is not a usable recipe',
    );
    const hidden = rig({ recipeFiles: { 'bad.md': 'click​here' } });
    should(await rejection(() => hidden.controller.recipeSet(SI(1), { file: 'bad.md' }))).containEql(
      'not a usable recipe',
    );
    const missing = rig({ recipeFiles: { 'steps.md': 'Click.' } });
    should(await rejection(() => missing.controller.recipeSet(SI(9), { file: 'steps.md' }))).containEql('no sign-in');
    for (const made of [empty, hidden, missing])
      should(made.gateway.calls.map(call => call[0])).not.containEql('putSignIn');
  });

  it("should say a recipe that holds a value was refused, in the owner's words", async () => {
    const { controller } = rig({
      recipeFiles: { 'steps.md': 'Type [[GITHUB_WORK]] password.' },
      fail: { putSignIn: new FyHttpError('refused', 400, 'recipe_holds_value') },
    });
    should(await rejection(() => controller.recipeSet(SI(1), { file: 'steps.md' }))).containEql('a recipe never may');
  });
});

describe('SignInController recipe clear', () => {
  it('should clear a recipe that is set', async () => {
    const { controller, gateway, said } = rig({ list: withRecipe });
    await controller.recipeClear(SI(1));
    should(gateway.calls.at(-1)).eql(['putSignIn', SI(1), { recipe: null }]);
    should(said).eql([`Cleared the recipe of ${SI(1)}.`]);
  });

  it('should say there is nothing to clear, and write nothing', async () => {
    const { controller, gateway, said } = rig();
    await controller.recipeClear(SI(1));
    should(said).eql([`${SI(1)} has no recipe to clear.`]);
    should(gateway.calls.map(call => call[0])).not.containEql('putSignIn');
  });
});

describe('SignInController recipe decide', () => {
  it('should approve a proposal and say what the recipe is now', async () => {
    const { controller, gateway, said } = rig();
    await controller.recipeDecide(SI(1), RP(7), 'approve');
    should(gateway.calls.at(-1)).eql(['decideRecipe', SI(1), RP(7), 'approve']);
    should(said[0]).startWith(`Approved ${RP(7)}: that is now the recipe of ${SI(1)}`);
  });

  it('should decline a proposal and say the recipe is as it was', async () => {
    const { controller, gateway, said } = rig();
    await controller.recipeDecide(SI(1), RP(7), 'decline');
    should(gateway.calls.at(-1)).eql(['decideRecipe', SI(1), RP(7), 'decline']);
    should(said).eql([`Declined ${RP(7)}: the recipe of ${SI(1)} is as it was.`]);
  });

  it("should refuse ids that are not ids, and put a daemon refusal in the owner's words", async () => {
    should(await rejection(() => rig().controller.recipeDecide(SI(1), 'rp_x', 'approve'))).containEql(
      'is not a proposal id',
    );
    const stale = rig({ fail: { decideRecipe: new FyHttpError('x', 409, 'stale_proposal') } });
    should(await rejection(() => stale.controller.recipeDecide(SI(1), RP(7), 'approve'))).containEql(
      'the recipe changed after the ferret proposed this one',
    );
    const gone = rig({ fail: { decideRecipe: new FyHttpError('x', 404, 'unknown_proposal') } });
    should(await rejection(() => gone.controller.recipeDecide(SI(1), RP(7), 'decline'))).containEql('no such proposal');
  });
});
