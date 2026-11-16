import { describe, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type {
  InputRaise,
  InputRequestId,
  SecureCopyCommand,
  SecureCopyCommandOutcome,
} from '@ferretry/core-vault/contract';
import type { BrowsersApi, BrowserCopyAnswer } from '@ferretry/plugin-browsers/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import accounts from '../../../../daemon/index.ts';

/** A value no real credential looks like: it must reach the masking registry and the paste, and NOTHING an agent reads. */
const SENTINEL = 'FAKE-SC-7f3a91';

/**
 * THE VAULT, as the composition root sees it: the real Vault runs the command and masks the value; this one records what it
 * was asked, so a test can say exactly where the sentinel went. It is the only place the sentinel may be.
 */
class SimVault extends FakeVault {
  readonly commands: SecureCopyCommand[] = [];
  readonly held: { ferret: string; value: string; marker: string; until: number }[] = [];
  readonly raises: { ferret: string; raise: InputRaise }[] = [];
  raiseRefusal: string | undefined;
  stdout = `${SENTINEL}\n`;
  stderr = '';
  exitCode = 0;
  // The members the Vault hands Accounts alone: optional on the port, present here.
  // A field, not a method: the host lends a fake's own members, and a prototype method would not travel.
  readonly captureCommand = async (spec: SecureCopyCommand): Promise<SecureCopyCommandOutcome> => {
    this.commands.push(spec);
    return { outcome: 'exited', exitCode: this.exitCode, stdout: this.stdout, stderr: this.stderr, truncated: false };
  };
  readonly maskCopy = {
    hold: (ferret: FerretId, value: string, marker: string, until: number) => {
      this.held.push({ ferret, value, marker, until });
    },
    retime: () => undefined,
    holdScrollback: (ferret: FerretId, value: string, marker: string) => {
      this.scrollback.push({ ferret, value, marker });
    },
  };
  readonly scrollback: { ferret: FerretId; value: string; marker: string }[] = [];
  override async raiseInput(ferret: FerretId, raise: InputRaise): Promise<Result<InputRequestId, string>> {
    this.raises.push({ ferret, raise });
    return this.raiseRefusal === undefined ? await super.raiseInput(ferret, raise) : err(this.raiseRefusal);
  }
}

class Browsers {
  takenOver = false;
  readonly reads: string[] = [];
  value = SENTINEL;
  readonly api: BrowsersApi = {
    state: async () => ({ state: 'stopped' }) as never,
    pagesOf: async () => [],
    closeLeftoverBrowsers: async () => ({ closed: 0, leftAlone: [] }),
    copy: {
      copyRead: async (_ferret, key, _target, _part, _attribute, queue): Promise<BrowserCopyAnswer> => {
        this.reads.push(key);
        if (this.takenOver)
          return {
            ok: false,
            reason: 'refused',
            code: 'taken_over',
            message: `A person has taken over %browser:${key}.`,
          };
        await queue.guard?.({ document: async () => 'loader-1' });
        const found = {
          ok: true as const,
          value: this.value,
          pageId: 'page-1',
          origin: 'https://example.test',
          frameOrigin: 'https://example.test',
          navigationId: 'loader-1',
        };
        queue.seal(found);
        return found;
      },
      pasteTarget: async (_ferret, key) =>
        this.takenOver
          ? { ok: false, code: 'taken_over', message: `A person has taken over %browser:${key}.` }
          : { ok: true, key },
      clipboardRead: async (_ferret, key, queue): Promise<BrowserCopyAnswer> => {
        this.reads.push(`clipboard:${key}`);
        if (this.takenOver)
          return {
            ok: false,
            reason: 'refused',
            code: 'taken_over',
            message: `A person has taken over %browser:${key}.`,
          };
        const found = {
          ok: true as const,
          value: this.value,
          pageId: 'page-1',
          origin: 'https://example.test',
          frameOrigin: 'https://example.test',
          navigationId: 'loader-1',
        };
        queue.seal(found);
        return found;
      },
      sealed: {
        hold: (ferret, copy, origins, until) => void this.sealed.push({ ferret, copy, origins, until }),
        pastedOn: (ferret, copy, origins, until) => void this.sealed.push({ ferret, copy, origins, until }),
        drop: () => undefined,
      },
      takenOver: async () => this.takenOver,
    },
  };
  readonly sealed: { ferret: string; copy: string; origins: readonly string[]; until: () => number | undefined }[] = [];
}

async function world(allows = true) {
  const vault = new SimVault();
  const browsers = new Browsers();
  const gateFake = new FakeGate();
  const audits = gateFake.audits;
  const h = await testHost({
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged
        ? ferretStanding('F1' as FerretId)
        : ownerStanding(),
    ),
    plugins: [accounts],
    uses: {
      browsers: browsers.api,
      agentControl: { allows: async () => allows },
      ferrets: { workFolder: async () => ({ folder: '/work/f1' }) },
    },
    fakes: {
      gate: gateFake,
      vault,
      asks: new FakeAsks(),
      sealed: new FakeSealedDocuments(),
    },
  });
  /** Everything an agent, a route, a log, an audit record or an event can say, as text. */
  const everything = (): string =>
    JSON.stringify([audits, h.logs, h.published, [...h.state('accounts').files.entries()]]);
  return { h, vault, browsers, audits, everything };
}

const COMMAND = { name: 'token', source: { kind: 'command', argv: ['gh', 'auth', 'token'] } };
const PAGE = { name: 'shown', source: { kind: 'browser', key: 'app', ref: 'e3' } };

describe('secure copy, as the composition root wires it', () => {
  it('should seal a command’s stdout: the agent hears a handle and a length, the Vault masks the value, nothing else holds it', async () => {
    const { h, vault, everything } = await world();

    const sealed = await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('sealed:token').and.containEql(`${SENTINEL.length} characters`);
    should(JSON.stringify(sealed)).not.containEql(SENTINEL);
    // The command ran through the Vault's runner: no shell, the session's own folder, the byte cap one over.
    should(vault.commands).have.length(1);
    should(vault.commands[0]).match({ command: ['gh', 'auth', 'token'], cwd: '/work/f1' });
    // The masking registry holds it from that moment, as `[sealed:token]`, in the ferret's own session.
    should(vault.held.length).be.above(0);
    should(vault.held.every(hold => hold.ferret === 'F1' && hold.marker === '[sealed:token]')).equal(true);
    should(vault.held.some(hold => hold.value === SENTINEL)).equal(true);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should list and discard by handle, and the owner’s copies route answers the same facts, never the value', async () => {
    const { h, everything } = await world();
    await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    const listed = await h.tool('secure_list', {}, { as: ferret('F1') });
    const route = await h.request('GET', '/v1/ferrets/F1/copies');
    const discarded = await h.tool('secure_discard', { handle: 'sealed:token' }, { as: ferret('F1') });
    const after = await h.tool('secure_list', {}, { as: ferret('F1') });

    should(listed.text).containEql('1 live copy');
    should(route.status).equal(200);
    should(route.json<{ copies: { handle: string; length: number }[] }>().copies).match([
      { handle: 'sealed:token', length: SENTINEL.length },
    ]);
    should(discarded.text).containEql('sealed:token is discarded');
    should(JSON.stringify(after)).containEql('discarded');
    for (const said of [JSON.stringify(listed), route.body, JSON.stringify(discarded), JSON.stringify(after)])
      should(said).not.containEql(SENTINEL);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should refuse a command copy when the owner turned Terminals off, and say which switch', async () => {
    const { h, vault } = await world(false);

    const refused = await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    should(refused.isError).equal(true);
    should(refused.text).containEql('Terminals');
    should(vault.commands).have.length(0);
  });

  it('should hold a failing command’s stderr back when it holds a piece of the value, and never quote the value', async () => {
    const { h, vault, everything } = await world();
    vault.exitCode = 1;
    // The program printed the value AND failed: stderr holding a piece of it is withheld whole.
    vault.stderr = `denied for ${SENTINEL.slice(0, 9)}`;

    const failed = await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    should(failed.isError).equal(true);
    should(failed.text).containEql('[withheld: it held part of sealed:token]');
    should(JSON.stringify(failed)).not.containEql(SENTINEL);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should copy a page element through Browsers’ reach, mark it for the page’s origin, and keep the value out of every answer', async () => {
    const { h, vault, browsers, everything } = await world();

    const sealed = await h.tool('secure_copy', PAGE, { as: ferret('F1') });
    const route = await h.request('GET', '/v1/ferrets/F1/copies');

    should(sealed.isError).not.equal(true);
    should(browsers.reads).eql(['app']);
    should(route.json<{ copies: { from: { kind: string; origin: string } }[] }>().copies[0]?.from).match({
      kind: 'browser',
      origin: 'https://example.test',
    });
    // Sealed inside the page's queue, then once more by the service: the registry holds it.
    should(vault.held.some(hold => hold.value === SENTINEL)).equal(true);
    should(JSON.stringify([sealed, route.body])).not.containEql(SENTINEL);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should refuse a copy from a page a person has taken over, with the browser’s own sentence and nothing held', async () => {
    const { h, vault, browsers } = await world();
    browsers.takenOver = true;

    const refused = await h.tool('secure_copy', PAGE, { as: ferret('F1') });

    should(refused.isError).equal(true);
    should(refused.text).containEql('taken over');
    should(vault.held).have.length(0);
    should(JSON.stringify(refused)).not.containEql(SENTINEL);
  });

  it('should raise a paste to a terminal, a page field and the secret store as a sealed source naming no value', async () => {
    const { h, vault, everything } = await world();
    await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    const terminal = await h.tool(
      'secure_paste',
      { handle: 'sealed:token', to: { kind: 'terminal', name: 'dev' }, prompt: 'log in' },
      { as: ferret('F1') },
    );
    const field = await h.tool(
      'secure_paste',
      { handle: 'sealed:token', to: { kind: 'browser', name: 'app', ref: 'e9' }, prompt: 'token field' },
      { as: ferret('F1') },
    );
    const store = await h.tool(
      'secure_paste',
      { handle: 'sealed:token', to: { kind: 'secret', name: 'VERCEL_TOKEN' }, prompt: 'keep it' },
      { as: ferret('F1') },
    );

    for (const answer of [terminal, field, store]) {
      should(answer.isError).not.equal(true);
      should(answer.text).containEql('Asked the owner').and.containEql('Wait with input_wait');
      should(JSON.stringify(answer)).not.containEql(SENTINEL);
    }
    should(vault.raises.map(each => each.raise.target)).match([
      { kind: 'terminal', key: 'dev' },
      { kind: 'page', key: 'app' },
      { kind: 'secret', key: 'VERCEL_TOKEN' },
    ]);
    // Every raise names the copy, always as a secret, and carries no value anywhere.
    for (const { raise } of vault.raises) should(raise).match({ source: { kind: 'sealed', name: 'token' } });
    should(JSON.stringify(vault.raises)).not.containEql(SENTINEL);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should refuse a paste into a page a person has taken over before anything is raised', async () => {
    const { h, vault, browsers } = await world();
    await h.tool('secure_copy', COMMAND, { as: ferret('F1') });
    browsers.takenOver = true;

    const refused = await h.tool(
      'secure_paste',
      { handle: 'sealed:token', to: { kind: 'browser', name: 'app', ref: 'e9' }, prompt: 'token field' },
      { as: ferret('F1') },
    );

    should(refused.isError).equal(true);
    should(refused.text).containEql('taken over');
    should(vault.raises).have.length(0);
  });

  it('should tell the agent a paste the Vault refused in the Vault’s words, never an error with a value', async () => {
    const { h, vault } = await world();
    await h.tool('secure_copy', COMMAND, { as: ferret('F1') });
    vault.raiseRefusal = 'there is no live copy named sealed:gone in this session';

    const refused = await h.tool(
      'secure_paste',
      { handle: 'sealed:token', to: { kind: 'terminal', name: 'dev' }, prompt: 'log in' },
      { as: ferret('F1') },
    );

    should(refused.isError).equal(true);
    should(refused.text).containEql('no live copy');
    should(JSON.stringify(refused)).not.containEql(SENTINEL);
  });

  it('should refuse every secure tool for a caller that is not a ferret', async () => {
    const { h } = await world();
    for (const [name, input] of [
      ['secure_copy', COMMAND],
      ['secure_list', {}],
      ['secure_discard', { handle: 'sealed:token' }],
      ['secure_paste', { handle: 'sealed:token', to: { kind: 'terminal', name: 'dev' }, prompt: 'x' }],
    ] as const) {
      const said = await h.tool(name, input, { as: owner() }).then(
        result => result,
        (error: unknown) => ({ isError: true, text: String(error) }),
      );
      should(said.isError).equal(true);
    }
  });

  it('should answer a malformed call with the first problem, and call nothing', async () => {
    const { h, vault } = await world();

    const bad = await h.tool(
      'secure_copy',
      { name: 'Token!', source: { kind: 'command', argv: [] } },
      { as: ferret('F1') },
    );

    should(bad.isError).equal(true);
    should(vault.commands).have.length(0);
  });
});

const CLIPBOARD = { name: 'pasted', source: { kind: 'clipboard', key: 'app' } };

describe('secure copy of a page’s clipboard, as the composition root wires it', () => {
  it('should seal the clipboard through Browsers’ reach: a handle and a length, the page’s pages closed, the Vault masking it', async () => {
    const { h, vault, browsers, everything } = await world();

    const sealed = await h.tool('secure_copy', CLIPBOARD, { as: ferret('F1') });

    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('sealed:pasted').and.containEql(`${SENTINEL.length} characters`);
    should(sealed.text).containEql(
      'https://example.test are closed to your read, eval, console, network and screenshot',
    );
    should(JSON.stringify(sealed)).not.containEql(SENTINEL);
    should(browsers.reads).eql(['clipboard:app']);
    should(vault.held.every(hold => hold.ferret === 'F1' && hold.marker === '[sealed:pasted]')).equal(true);
    // Browsers was told which origins the copy sits on, and answers when it ends.
    should(browsers.sealed).have.length(1);
    should(browsers.sealed[0]).match({
      ferret: 'F1',
      copy: 'pasted',
      origins: ['https://example.test', 'https://example.test'],
    });
    should(browsers.sealed[0]?.until()).be.a.Number();
    should(everything()).not.containEql(SENTINEL);
  });

  it('should lift the pages the moment the agent discards the copy', async () => {
    const { h, browsers } = await world();
    await h.tool('secure_copy', CLIPBOARD, { as: ferret('F1') });

    await h.tool('secure_discard', { handle: 'sealed:pasted' }, { as: ferret('F1') });

    should(browsers.sealed[0]?.until()).equal(undefined);
  });

  it('should refuse a clipboard capture while a person holds the page, saying so, and keep nothing', async () => {
    const { h, browsers, vault, everything } = await world();
    browsers.takenOver = true;

    const refused = await h.tool('secure_copy', CLIPBOARD, { as: ferret('F1') });

    should(refused.isError).equal(true);
    should(refused.text).containEql('taken over');
    should(vault.held).have.length(0);
    should(browsers.sealed).have.length(0);
    should(everything()).not.containEql(SENTINEL);
  });

  it('should register a COMMAND copy with Browsers too, with no page, so a picture of any page that shows it is checked', async () => {
    const { h, browsers } = await world();

    await h.tool('secure_copy', COMMAND, { as: ferret('F1') });

    should(browsers.sealed).have.length(1);
    should(browsers.sealed[0]).match({ ferret: 'F1', copy: 'token', origins: [] });
  });
});
