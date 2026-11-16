/**
 * `fy history claim` as the wrapper runs it, end to end through the built half: the words the wrapper sends, the kernel's
 * real state port on a temp home, real files and a real lock. No daemon is built or asked (the client throws if the verb
 * so much as looks at it), which is the point: a resumed harness is claimed with nothing running.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import cli from '../../../../cli/index.ts';
import manifest from '../../../../manifest.ts';

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function shell(options: { readonly noState?: boolean; readonly env?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fy-history-verb-'));
  folders.push(root);
  const port = state.createStatePort({
    home: root,
    pluginId: 'ferrets',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  const out: string[] = [];
  const err: string[] = [];
  const environment = options.env ?? {};
  const half = cli.build?.({
    manifest,
    client: {
      call: async () => {
        throw new Error('the daemon must not be asked to claim a conversation');
      },
      subscribe: () => () => undefined,
    },
    io: { out: text => out.push(text), err: text => err.push(text), isTty: false },
    ...(options.noState === true ? {} : { ownState: port }),
    env: environment,
    readEnvironment: names =>
      Object.fromEntries(names.filter(name => name in environment).map(name => [name, environment[name]])),
  });
  if (half === undefined) throw new Error('the cli half is real');
  const verbs = half.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const claim = async (args: readonly string[], options: VerbInvocation['options']): Promise<number> =>
    await (verbs['history claim [words...]'] as (invocation: VerbInvocation) => Promise<number>)({ args, options });
  const pool = join(root, 'state', 'ferrets', 'conversation-leases', 'claude');
  return { claim, verbs, out, err, pool };
}

/** What a wrapper sends: `fy history claim --harness claude --pid $$ --from-arguments -- "$@"`. */
const wrapper = (pid: number) => ({ harness: 'claude', pid: String(pid), 'from-arguments': true });

describe('fy history claim', () => {
  it('should claim a resumed conversation silently with no daemon, so the wrapper prints no warning', async () => {
    // Arrange
    const { claim, out, err, pool } = await shell();

    // Act
    const status = await claim(['--resume', CONVERSATION], wrapper(process.pid));

    // Assert
    should(status).equal(0);
    should(out).be.empty();
    should(err).be.empty();
    should(await readdir(pool)).containEql(`${CONVERSATION}.lease`);
  });

  it('should record the session and the runtime a daemon-launched wrapper carries, and nothing else of its environment', async () => {
    // Arrange
    const { claim, pool } = await shell({
      env: { FY_SESSION_ID: 'ms8-abcd1234', FY_RUNTIME: 'claude-review', FY_SECRET_TOKEN: 'never-recorded' },
    });

    // Act
    await claim(['--session-id', CONVERSATION], wrapper(process.pid));

    // Assert
    const lease = JSON.parse(await readFile(join(pool, `${CONVERSATION}.lease`), 'utf8')) as {
      holder: { session: string; runtime: string; pid: number };
    };
    should(lease.holder).containEql({ session: 'ms8-abcd1234', runtime: 'claude-review', pid: process.pid });
    should(JSON.stringify(lease)).not.containEql('never-recorded');
  });

  it('should answer the held status and name the holder when another live writer has the conversation', async () => {
    // Arrange
    const { claim, err } = await shell();
    await claim(['--resume', CONVERSATION], wrapper(process.pid));

    // Act
    const status = await claim(['--resume', CONVERSATION], wrapper(process.ppid));

    // Assert
    should(status).equal(75);
    should(err.join('')).equal(
      `conversation ${CONVERSATION} is being written by another claude running as process ${process.pid} since ${err.join('').match(/since (\S+ \S+ UTC)/u)?.[1]}: close that one first; only one writer may hold a conversation at a time\n`,
    );
  });

  it('should claim nothing for arguments that name no conversation', async () => {
    // Arrange
    const { claim, pool } = await shell();

    // Act
    const status = await claim(['--continue'], wrapper(process.pid));

    // Assert
    should(status).equal(0);
    should(await readdir(pool).catch(() => [])).be.empty();
  });

  it('should claim a conversation a person names, for the harness they name', async () => {
    // Arrange
    const { claim, pool } = await shell();

    // Act
    const status = await claim([CONVERSATION], { harness: 'claude', pid: String(process.pid) });

    // Assert
    should(status).equal(0);
    should(await readdir(pool)).containEql(`${CONVERSATION}.lease`);
  });

  it('should answer a caller mistake with a failure that is never the held status, so a wrapper launches anyway', async () => {
    // Arrange
    const { claim, err } = await shell();

    // Act
    const noPid = await claim([], { harness: 'claude' });
    const badId = await claim(['../escape'], { harness: 'claude', pid: String(process.pid) });

    // Assert
    // Unreadable words are 2; a conversation id that could be a path is the controller's own refusal, 1.
    should([noPid, badId]).eql([2, 1]);
    should(err.join('')).containEql('--pid is required');
    should(err.join('')).containEql('not a conversation id');
  });

  it('should answer 1, never the held status, when the shell gives no state home to keep leases in', async () => {
    // Arrange
    const { claim, err } = await shell({ noState: true });

    // Act
    const status = await claim(['--resume', CONVERSATION], wrapper(process.pid));

    // Assert
    should(status).equal(1);
    should(err.join('')).containEql('no state home');
  });

  it('should print what the group offers and fail when typed bare', async () => {
    // Arrange
    const { verbs, out } = await shell();

    // Act
    const status = await (verbs.history as (invocation: VerbInvocation) => Promise<number>)({ args: [], options: {} });

    // Assert
    should(status).equal(2);
    should(out.join('')).containEql('fy history claim --harness');
    should(out.join('')).containEql('exit 75');
  });
});
