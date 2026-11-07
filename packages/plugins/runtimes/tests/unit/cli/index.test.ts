import { describe, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import should from 'should';
import cli from '../../../cli/index.ts';
import { VERB_BODIES } from '../../../cli/lib/verbs.ts';
import manifest from '../../../manifest.ts';
import { ROUTES } from '../../../cli/lib/fleet/account-gateway.ts';
import { changeView, machine } from './fleet/account-fakes.ts';

const declaredVerbs = manifest.actions.cli.map(declared => declared.verb);

function context(answers: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const client: PluginClient = {
    call: async <Answer>(route: string): Promise<Answer> => {
      calls.push(route);
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route] as Answer;
    },
    subscribe: () => () => undefined,
  };
  const ctx: CliContext<typeof manifest> = { manifest, client, io };
  return { ctx, out, err, calls };
}

describe('the runtimes cli half', () => {
  it('should have a handler for every verb the manifest declares, under its exact verb string', () => {
    const { ctx } = context();
    const half = cli.build?.(ctx);
    should(Object.keys(half?.verbs ?? {}).sort()).eql([...declaredVerbs].sort());
    for (const verbLine of declaredVerbs) {
      should(typeof (half?.verbs as Record<string, unknown>)[verbLine]).equal('function');
    }
  });

  it('should have a body for every declared verb and no verb the manifest does not declare', () => {
    should(Object.keys(VERB_BODIES).sort()).eql([...declaredVerbs].sort());
  });

  it('should not be the skeleton', () => {
    should((cli as { skeleton?: true }).skeleton).be.undefined();
  });

  it('should print a runtime list through the terminal and exit 0', async () => {
    // Arrange
    const { ctx, out, calls } = context({ [ROUTES.runtimes]: { format: 'present', runtimes: [] } });
    const half = cli.build?.(ctx);

    // Act
    const code = await half?.verbs['runtime ls']({ args: [], options: {} });

    // Assert
    should(code).equal(0);
    should(calls).eql(['GET /v1/runtimes']);
    should(out.join('')).match(/No runtimes yet\. Set this machine up with `fy onboard`/);
  });

  it('should answer a plain-words refusal on stderr and exit 1', async () => {
    const { ctx, out, err } = context({ [ROUTES.runtimes]: { format: 'present', runtimes: [] } });
    const half = cli.build?.(ctx);
    const code = await half?.verbs['runtime show']({ args: ['nope'], options: {} });
    should(code).equal(1);
    should(out).be.empty();
    should(err.join('')).match(/There is no runtime called "nope"\. See them all with `fy runtime ls`\./);
  });

  it('should stop a destructive change without --yes and exit 1, since a command line cannot be asked', async () => {
    const { ctx, err, calls } = context({
      [ROUTES.machine]: machine(),
      [ROUTES.propose]: changeView({ kind: 'runtime.remove', name: 'old' }),
    });
    const half = cli.build?.(ctx);
    const code = await half?.verbs['runtime rm']({ args: ['old'], options: {} });
    should(code).equal(1);
    should(calls[0]).equal(ROUTES.machine);
    should(calls).not.containEql(ROUTES.apply);
    should(err.join('')).match(/Re-run with --yes/);
  });
});
