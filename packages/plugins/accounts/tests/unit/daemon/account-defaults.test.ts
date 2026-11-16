/**
 * THE OWNER'S DEFAULT LINES (`account-defaults.ts`): a line is refused when it could never be used, a rename or merge moves
 * the lines in the same act, a file that does not check is not written over, and every line the daemon cannot use is said
 * in a warning that names the fix.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { AccountDefaultsFile } from '../../../contract/routes/index.ts';
import {
  AccountDefaultNotUsable,
  AccountDefaults,
  AccountDefaultsFileBroken,
  type AccountDefaultsWriter,
  DEFAULTS_PATH,
} from '../../../daemon/lib/account-defaults.ts';
import type { ProjectInfo } from '../../../daemon/lib/sign-in-context.ts';
import { list } from '../../support/app/accounts-fixtures.ts';

const PROJECT_A = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e01' as ProjectInfo['id'];
const PROJECT_B = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e02' as ProjectInfo['id'];
const PROJECT_C = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e03' as ProjectInfo['id'];

/** The kernel's config write, as a held file: `amend` applies the edit and remembers how it was asked to. */
function world(options: { file?: AccountDefaultsFile; broken?: boolean; projects?: readonly ProjectInfo[] } = {}) {
  const state = { file: options.file ?? ({} as AccountDefaultsFile), asked: [] as string[], reads: 0 };
  const writer: AccountDefaultsWriter = {
    amend: async (edit, broken) => {
      state.asked.push(broken);
      if (options.broken === true && broken === 'refuse')
        throw new AccountDefaultsFileBroken([{ path: DEFAULTS_PATH, severity: 'error', message: 'not a map' }]);
      if (options.broken === true) throw new Error('the file does not check');
      state.file = edit(state.file);
    },
  };
  const defaults = new AccountDefaults({
    inEffect: () => {
      state.reads += 1;
      return state.file;
    },
    writer,
    listing: async () => list(),
    ...(options.projects === undefined ? {} : { projects: async () => options.projects as readonly ProjectInfo[] }),
  });
  return { defaults, state };
}

describe('setting a default line', () => {
  it('writes a line for an account that signs in on that key, and answers the lines now in effect', async () => {
    const { defaults, state } = world();

    const written = await defaults.set({ scope: 'sites', key: 'github.com' }, 'GITHUB');

    should(written).eql({ sites: { 'github.com': 'GITHUB' } });
    should(state.asked).eql(['refuse']);
  });

  it('refuses an account with no sign-in on the key, an account that does not exist, and writes nothing', async () => {
    const { defaults, state } = world();

    const noSignIn = await defaults
      .set({ scope: 'sites', key: 'vercel.com' }, 'GITHUB')
      .catch((error: unknown) => error);
    const missing = await defaults.set({ scope: 'sites', key: 'github.com' }, 'GONE').catch((error: unknown) => error);

    should(noSignIn).be.instanceOf(AccountDefaultNotUsable);
    should((noSignIn as Error).message).equal(
      'GITHUB has no sign-in on vercel.com, so it cannot be its default; add that sign-in first',
    );
    should(missing).be.instanceOf(AccountDefaultNotUsable);
    should(state.asked).eql([]);
  });

  it('accepts a host a site is only FOR (its match list), and removes a line without asking whether it is usable', async () => {
    const { defaults } = world({ file: { sites: { 'github.com': 'GITHUB' } } });

    should(await defaults.set({ scope: 'sites', key: 'app.vercel.com' }, 'VERCEL')).eql({
      sites: { 'github.com': 'GITHUB', 'app.vercel.com': 'VERCEL' },
    });
    should(await defaults.set({ scope: 'sites', key: 'github.com' }, null)).eql({
      sites: { 'app.vercel.com': 'VERCEL' },
    });
  });

  it('is refused, naming the file, when the file does not check', async () => {
    const { defaults } = world({ broken: true });

    const refused = await defaults
      .set({ scope: 'sites', key: 'github.com' }, 'GITHUB')
      .catch((error: unknown) => error);

    should(refused).be.instanceOf(AccountDefaultsFileBroken);
    should((refused as Error).message).equal('accounts.yaml does not check, so it was not changed; fix it first');
    should((refused as AccountDefaultsFileBroken).issues).have.length(1);
  });
});

describe('the lines in effect', () => {
  it('are what the owner confirmed', async () => {
    const { defaults } = world({ file: { sites: { 'github.com': 'GITHUB' } } });

    should(await defaults.current()).eql({ sites: { 'github.com': 'GITHUB' } });
  });

  it('are none when the file has nothing in effect, or cannot be read, so a card is never lost to it', async () => {
    const empty = new AccountDefaults({
      inEffect: () => undefined,
      writer: { amend: async () => undefined },
      listing: async () => list(),
    });
    const unreadable = new AccountDefaults({
      inEffect: () => {
        throw new Error('the config port is down');
      },
      writer: { amend: async () => undefined },
      listing: async () => list(),
    });

    should(await empty.current()).eql({});
    should(await unreadable.current()).eql({});
  });
});

describe('following an account act', () => {
  const file: AccountDefaultsFile = { sites: { 'github.com': 'GITHUB' } };

  it('moves the lines in the same act, and corrects only what is in effect when the file does not check', async () => {
    const { defaults, state } = world({ file });

    await defaults.repoint([{ kind: 'rename', from: 'GITHUB', to: 'GH' }]);

    should(state.file).eql({ sites: { 'github.com': 'GH' } });
    should(state.asked).eql(['record']);
  });

  it('throws the failure on to the account act, and says it in the warnings until a later change follows', async () => {
    const { defaults, state } = world({ file, broken: true });

    await should(defaults.repoint([{ kind: 'remove', handle: 'GITHUB' }])).be.rejectedWith('the file does not check');
    const warned = await defaults.warnings(list());

    should(warned.map(issue => issue.message)).eql([
      'the last account change could not be followed in accounts.yaml (the file does not check); a line may name an account that is gone or was replaced',
    ]);
    should(warned[0]).match({ path: 'accounts.yaml', severity: 'warning' });
    should(state.asked).eql(['record']);

    const healed = world({ file });
    await healed.defaults.repoint([]);
    should(await healed.defaults.warnings(list())).eql([]);
  });

  it('says a failure that is not an Error by its text', async () => {
    const defaults = new AccountDefaults({
      inEffect: () => file,
      writer: { amend: async () => Promise.reject('disk full') },
      listing: async () => list(),
    });

    await defaults.repoint([]).catch(() => undefined);

    should((await defaults.warnings(list()))[0]?.message).containEql('(disk full)');
  });
});

describe('the warnings for a line the daemon cannot use', () => {
  const projects: readonly ProjectInfo[] = [
    { id: PROJECT_A, name: 'ferretry' },
    { id: PROJECT_B, name: 'twin' },
    { id: PROJECT_C, name: 'twin' },
  ];

  it('says nothing for lines that all work, or for a file with no lines', async () => {
    const good = world({
      file: {
        sites: { 'github.com': 'GITHUB', 'app.vercel.com': 'VERCEL' },
        projects: { [PROJECT_A]: { 'github.com': 'GITHUB' }, ferretry: { 'github.com': 'GITHUB_WORK' } },
      },
      projects,
    });

    should(await good.defaults.warnings(list())).eql([]);
    should(await world().defaults.warnings(list())).eql([]);
    should(
      await new AccountDefaults({
        inEffect: () => undefined,
        writer: { amend: async () => undefined },
        listing: async () => list(),
      }).warnings(list()),
    ).eql([]);
  });

  it('says a line names an account that is not one, and how to fix it', async () => {
    const { defaults } = world({ file: { sites: { 'github.com': 'GONE' } } });

    const [issue] = await defaults.warnings(list());

    should(issue).eql({
      path: 'accounts.yaml',
      severity: 'warning',
      message: 'github.com in every session on this machine: GONE is not an account; this line is ignored',
      fix: 'name an account that exists (`fy account ls`), or remove the line',
    });
  });

  it('says a line names an account with no sign-in on its key', async () => {
    const { defaults } = world({ file: { sites: { 'vercel.com': 'GITHUB' } } });

    const [issue] = await defaults.warnings(list());

    should(issue?.message).equal(
      'vercel.com in every session on this machine: GITHUB has no sign-in on vercel.com; this line is ignored',
    );
    should(issue?.fix).equal('add that sign-in to GITHUB, or point the line at an account that signs in there');
  });

  it('says a project line names no project, or more than one, but takes one named by its id or its only name', async () => {
    const { defaults } = world({
      file: {
        projects: {
          nowhere: { 'github.com': 'GITHUB' },
          twin: { 'github.com': 'GITHUB' },
          [PROJECT_C]: { 'github.com': 'GITHUB' },
          ferretry: { 'github.com': 'GITHUB' },
        },
      },
      projects,
    });

    const warned = await defaults.warnings(list());

    should(warned.map(issue => issue.message)).eql([
      'github.com in project nowhere: no project is named nowhere; this line is ignored',
      'github.com in project twin: more than one project is named twin; this line is ignored',
    ]);
    should(warned.map(issue => issue.fix)).eql([
      'name a project by its id or its exact name',
      'name the project by its id instead',
    ]);
  });

  it('judges no project when the registry of projects is not offered', async () => {
    const { defaults } = world({ file: { projects: { nowhere: { 'github.com': 'GITHUB' } } } });

    should(await defaults.warnings(list())).eql([]);
  });

  it('puts the unfollowed-change warning before the line warnings', async () => {
    const { defaults } = world({ file: { sites: { 'github.com': 'GONE' } }, broken: true });
    await defaults.repoint([]).catch(() => undefined);

    const warned = await defaults.warnings(list());

    should(warned).have.length(2);
    should(warned[0]?.message).startWith('the last account change could not be followed');
    should(warned[1]?.message).containEql('GONE is not an account');
  });
});
