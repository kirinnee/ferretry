import { describe, it } from 'bun:test';
import type { InputRaise, InputRequestId, VaultApi } from '@ferretry/core-vault/contract';
import { agentControlRefusal } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import { err, ok } from '@ferretry/std';
import should from 'should';
import type { SecretChildRunner } from '../../../../daemon/lib/local-ports.ts';
import { SecureCopyService } from '../../../../daemon/lib/secure-copy/service.ts';
import { secureCopyTools } from '../../../../daemon/lib/secure-copy/tools.ts';
import { EphemeralValues } from '../support/masking.ts';

const SENTINEL = 'FAKE-SC-4d2e19';
const FERRET = { credential: { tokenClass: 'ferret', ferret: 'F1' } } as never;

class Clock {
  ms = Date.parse('2026-11-14T09:00:00.000Z');
  now(): number {
    return this.ms;
  }
}

const runner: SecretChildRunner = {
  run: async () => ({ outcome: 'exited', exitCode: 0, stdout: `${SENTINEL}\n`, stderr: '', truncated: false }),
};

interface Options {
  readonly transcript?: 'found' | 'clean' | 'unknown';
  readonly mayControl?: boolean;
  readonly browsers?: BrowsersApi | undefined;
  readonly state?: 'delivered' | 'pending';
}

/** The four tools over a real copy service, a recording Vault reach and a switch the case sets. */
function world(options: Options = {}) {
  const clock = new Clock();
  const raises: InputRaise[] = [];
  const vault: Pick<VaultApi, 'raiseInput' | 'inputState'> = {
    raiseInput: async (_ferret, raise) => {
      raises.push(raise);
      return ok('req-1' as InputRequestId);
    },
    inputState: async () => (options.state ?? 'pending') as never,
  };
  const copies = new SecureCopyService({
    clock,
    runner,
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => options.transcript ?? 'clean' },
    masking: new EphemeralValues(clock),
    redact: async text => text,
  });
  const tools = secureCopyTools({
    copies,
    vault: () => vault,
    browsers: () => options.browsers,
    mayControl: async () => options.mayControl ?? true,
    redact: async text => text,
    audit: { record: async () => undefined },
  });
  const run = async (tool: ToolHandler, input: unknown) => await tool(FERRET, input as never);
  return { tools, raises, run };
}

const PASTE = (to: unknown) => ({ handle: 'sealed:token', to, prompt: 'log in' });

describe('what the secure-copy tools tell an agent', () => {
  it('should warn the agent, in words, that a value already in its transcript is NOT protected, and never quote it', async () => {
    const { tools, run } = world({ transcript: 'found' });

    const sealed = await run(tools.secure_copy, {
      name: 'token',
      source: { kind: 'command', argv: ['gh', 'auth', 'token'] },
    });

    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('WARNING').and.containEql('NOT protected').and.containEql('rotated');
    should(JSON.stringify(sealed)).not.containEql(SENTINEL);
  });

  it('should refuse a paste into the secret store or a terminal when the owner turned Terminals off, raising nothing', async () => {
    const { tools, raises, run } = world({ mayControl: false });

    const store = await run(tools.secure_paste, PASTE({ kind: 'secret', name: 'VERCEL_TOKEN' }));
    const terminal = await run(tools.secure_paste, PASTE({ kind: 'terminal', name: 'dev' }));

    for (const refused of [store, terminal]) {
      should(refused.isError).equal(true);
      should(refused.text).equal(agentControlRefusal('terminal'));
    }
    should(raises).eql([]);
  });

  it('should say a page paste is not available on a daemon that has no Browsers, raising nothing', async () => {
    const { tools, raises, run } = world({ browsers: undefined });

    const refused = await run(tools.secure_paste, PASTE({ kind: 'browser', name: 'app', ref: 'e9' }));

    should(refused.isError).equal(true);
    should(refused.text).equal('Pasting into a page is not available on this daemon.');
    should(raises).eql([]);
  });

  it('should raise a page paste into a field named by selector, naming the cleared page and no value', async () => {
    const browsers = {
      copy: { pasteTarget: async (_ferret: string, key: string) => ({ ok: true, key }) },
    } as unknown as BrowsersApi;
    const { tools, raises, run } = world({ browsers });

    const asked = await run(tools.secure_paste, PASTE({ kind: 'browser', name: 'app', selector: '#token' }));

    should(asked.isError).not.equal(true);
    should(asked.text).containEql('a field on %browser:app');
    should(raises).have.length(1);
    should(raises[0]).match({
      target: { kind: 'page', key: 'app' },
      fields: [{ id: 'value', sensitivity: 'secret', element: { kind: 'selector', selector: '#token' } }],
      source: { kind: 'sealed', name: 'token' },
    });
    should(JSON.stringify([asked, raises])).not.containEql(SENTINEL);
  });

  it('should say a paste was made already when a rule the owner approved in advance delivered it', async () => {
    const { tools, run } = world({ state: 'delivered' });

    const pasted = await run(tools.secure_paste, PASTE({ kind: 'terminal', name: 'dev' }));

    should(pasted.isError).not.equal(true);
    should(pasted.text).equal(
      'Pasted sealed:token into %terminal:dev under a rule the owner approved in advance (req-1).',
    );
    should(pasted.data).eql({ request: 'req-1', delivered: true });
  });

  it('should tell the agent a refused raise in the Vault’s words', async () => {
    const clock = new Clock();
    const tools = secureCopyTools({
      copies: new SecureCopyService({
        clock,
        runner,
        folders: { folderOf: async () => '/work' },
        exposure: { transcriptHolds: async () => 'clean' },
        masking: new EphemeralValues(clock),
        redact: async text => text,
      }),
      vault: () => ({
        raiseInput: async () => err('a person has taken over %terminal:dev'),
        inputState: async () => undefined as never,
      }),
      browsers: () => undefined,
      mayControl: async () => true,
      redact: async text => text,
      audit: { record: async () => undefined },
    });

    const refused = await tools.secure_paste(FERRET, PASTE({ kind: 'terminal', name: 'dev' }) as never);

    should(refused.isError).equal(true);
    should(refused.text).containEql('taken over');
  });
});
