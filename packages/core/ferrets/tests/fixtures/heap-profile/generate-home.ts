/**
 * Generates a credential-free FY_HOME for the idle-daemon memory profile (see README.md in this folder).
 *
 *   bun generate-home.ts <home> <ferrets> <eventsEach> [giantEvents]
 *
 * It writes `<ferrets>` sessions (`g0` … `gN`: config, state, and a journal of `<eventsEach>` events) through the
 * real `DaemonStorage` over the kernel's real state port on a real disk, so every file is in the shape the daemon
 * itself writes. `giantEvents` replaces `g0`'s journal with that many events, written straight to the file: appending
 * one event at a time reads the whole journal each time, which is far too slow to make a journal of the owner's size
 * (one journal on the owner's host held 236,562 events). The status of every session comes from `GEN_STATUS`
 * (default `completed`): a `running` session with no tmux behind it makes the daemon try to supervise it.
 */
import { nodeFs, openHome, state as hostState } from '@ferretry/kernel/host';
import { writeFileSync } from 'node:fs';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { SESSION_STORE_FILES, sessionConfig, sessionState } from '../../support/daemon/storage.ts';

const AT = '2026-11-09T10:00:00.000Z';
const TEXT = 'x'.repeat(600);

const [home, ferretsArg, eventsArg, giantArg] = process.argv.slice(2);
if (home === undefined || ferretsArg === undefined || eventsArg === undefined)
  throw new Error('usage: bun generate-home.ts <home> <ferrets> <eventsEach> [giantEvents]');
const ferrets = Number(ferretsArg);
const events = Number(eventsArg);
const giant = Number(giantArg ?? 0);
const status = process.env.GEN_STATUS ?? 'completed';

await openHome(
  nodeFs(() => 'r'),
  home,
  'fyd 5.0.0',
  AT as never,
);
const port = hostState.createStatePort({
  home,
  pluginId: 'ferrets',
  files: SESSION_STORE_FILES,
  fs: hostState.createNodeHostFs(),
});
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const storage = new DaemonStorage(port, { now: () => AT }, quiet as never);
await storage.loadArchive();
for (let i = 0; i < ferrets; i += 1) {
  const id = parseSessionId(`g${i}`);
  await storage.writeConfig(id, sessionConfig(`g${i}`, { name: `ferret${i}`, harness: i % 2 ? 'codex' : 'claude' }));
  await storage.writeState(id, sessionState(`g${i}`, { status }));
  for (let n = 0; n < events; n += 1)
    await storage.append(id, 'turn.message', { n, role: n % 2 ? 'assistant' : 'user', text: TEXT });
}
await storage.close();

if (giant > 0) {
  const lines: string[] = [];
  for (let n = 1; n <= giant; n += 1)
    lines.push(
      `${JSON.stringify({ format: 1, schemaVersion: 1, sequence: n, sessionId: 'g0', time: AT, type: 'turn.message', data: { n, role: n % 2 ? 'user' : 'assistant', text: TEXT } })}\n`,
    );
  writeFileSync(`${home}/state/ferrets/g0/history.jsonl`, lines.join(''), { mode: 0o600 });
}
console.log(`generated ${ferrets} sessions x ${events} events${giant > 0 ? `, g0 with ${giant}` : ''} under ${home}`);
