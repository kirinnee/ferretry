import type { KernelPorts } from '@ferretry/kernel/contract';
import {
  LaunchRefusal,
  type Harness,
  type LaunchSpec,
  type Runner,
  type RunSpec,
} from '@ferretry/core-ferrets/contract';
import { err, ok, seconds } from '@ferretry/std';
import { HarnessConfigSchema, type HarnessConfig } from '../contract/index.ts';
import { isolatedCommand, isolatedEnvironment } from './lib/environment.ts';
import { OPENCODE_FACTS, opencodeHomes } from './lib/home.ts';
import { sessionStore } from './adapters/session-store.ts';
import { opencodeScreen } from './lib/screen.ts';

export function opencodeHarness(kernel: KernelPorts, config: () => HarnessConfig): Harness {
  const homes = opencodeHomes(kernel);
  const probe = async () => {
    const configured = HarnessConfigSchema.parse(config());
    let binary = configured.binary;
    if (binary === undefined) {
      const found = await kernel.spawn.run('which', ['opencode'], { sealed: true, timeout: seconds(5) });
      if (found.exitCode !== 0 || !found.stdout.trim().startsWith('/')) return undefined;
      binary = found.stdout.trim();
    }
    const root = kernel.roots.root('agent-homes');
    const at = root.resolve('probe');
    if (!at.ok) return undefined;
    await root.ensurePrivateDirectory(at.value);
    const version = await kernel.spawn.run(binary, ['--version'], {
      env: isolatedEnvironment(at.value),
      cwd: at.value,
      sealed: true,
      timeout: seconds(5),
    });
    const match = /^(?:opencode\s+)?v?(2\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\s*$/u.exec(version.stdout.trim());
    return version.exitCode === 0 && match?.[1] !== undefined ? { binary, version: match[1] } : undefined;
  };
  let discovered: Awaited<ReturnType<typeof probe>>;
  const locate = async () => {
    discovered ??= await probe();
    return discovered?.binary;
  };
  const sessions = sessionStore(kernel, homes.homeFor, locate);
  const launch = async (spec: LaunchSpec, runner: Runner, env: RunSpec['env'], resume?: string) => {
    if (spec.harness !== 'opencode') throw new LaunchRefusal('This launch is not for OpenCode');
    if (spec.credential !== undefined)
      throw new LaunchRefusal('OpenCode refuses subscription sign-ins; use an API key or endpoint');
    const installed = await probe();
    if (installed === undefined) return err('unavailable' as const);
    discovered = installed;
    await homes.prepareHome(spec);
    if (resume !== undefined) {
      // Root --session creates a missing ID: only an export proves a resume is real.
      try {
        await sessions.snapshot(spec.ferret, resume);
      } catch {
        throw new LaunchRefusal('The OpenCode session to resume is not present in this ferret’s private home');
      }
    }
    const session = resume ?? `ses_${kernel.ids.mint('opencode')}`;
    if (!/^ses_[A-Za-z0-9_-]{1,160}$/u.test(session))
      throw new LaunchRefusal('OpenCode could not name a private session');
    const args = ['--session', session, ...(config().permissionMode === 'skip' ? ['--auto'] : [])];
    const run: RunSpec = {
      ferret: spec.ferret,
      command: isolatedCommand(spec.home, installed.binary, args),
      cwd: spec.folder,
      env,
      harness: 'opencode',
      screenReader: opencodeScreen,
      execChain: ['env', 'opencode'],
    };
    await sessions.bind(spec.ferret, session);
    const running = resume === undefined ? await runner.start(run) : await runner.resume(run, session);
    return running.ok ? ok({ running: running.value, harnessConversation: session }) : running;
  };
  return {
    key: 'opencode',
    screenReader: opencodeScreen,
    facts: OPENCODE_FACTS,
    accepts: ['api-key', 'proxy', 'endpoint'],
    async discover() {
      discovered = await probe();
      return discovered === undefined
        ? { found: false, reason: 'Install OpenCode V2 (@opencode/cli); V1 is not supported' }
        : { found: true, ...discovered };
    },
    homeFor: homes.homeFor,
    prepareHome: homes.prepareHome,
    start: (spec, runner, env) => launch(spec, runner, env),
    resume: (spec, runner, env, session) => launch(spec, runner, env, session),
    async hasConversation(spec, session) {
      try {
        await sessions.snapshot(spec.ferret, session);
        return true;
      } catch {
        return undefined;
      }
    },
    async stop(ferret, handle, runner, how) {
      try {
        await runner.stop(handle, how, ferret);
      } finally {
        sessions.forget(ferret);
      }
    },
    async deliver(_ferret, _handle, message) {
      return {
        status: 'refused',
        id: message.id,
        reason: 'OpenCode messages are sent through Conversation, which owns the send path',
      };
    },
    transcript: sessions.transcript,
    usage: sessions.usage,
    conversations: sessions.conversations,
  };
}
