import { describe, expect, test } from 'bun:test';
import { FERRET_READABLE_FOLDERS, FERRET_SESSIONS_FOLDER } from '@ferretry/core-ferrets/contract';
import { launchCommand, readAllowArguments } from '../../../daemon/lib/harness/launch.ts';

/**
 * LAUNCH-ARGV PARITY: the read allowance a Claude start carries, against today's.
 *
 * Today (rebuild-ref, read-only), every Claude launch argv carried one `--allowedTools=Read(//<folder>/**)` per hand-off
 * folder, so the agent could read its first turn without asking:
 * - `packages/daemon/src/lib/session/send/handoff.ts:40-47` `handoffFolders(sessionDirectory, attachmentRoot)`:
 *   `<session>/turns`, `<session>/channel`, `<session>/attachments`, then the attachment root;
 * - `packages/daemon/src/lib/session/send/handoff.ts:63-65` `handoffReadArguments`: Claude only, `Read(/${folder}/**)`;
 * - `packages/daemon/bin/fyd.ts:10841` `readableHandoffs: id => handoffFolders(createSessionPaths(paths, id).directory,
 *   attachmentOriginals(id))`, with the session directory `FY_HOME/state/sessions/<id>` (`lib/paths.ts:175`) and the
 *   attachment root `FY_HOME/state/attachments/<daemonId>/<id>` (`lib/attachments/session-attachments.ts:59-62`);
 * - `packages/daemon/src/lib/session/launch/argv.ts:171` `buildLaunchArgv`: those arguments in every launch argv.
 *
 * 5.0: the session directory is `FY_HOME/state/ferrets/sessions/<id>` (Ferrets' `FERRET_SESSIONS_FOLDER`), Ferrets
 * hands the folders as `LaunchSpec.readable` (`FERRET_READABLE_FOLDERS`), and Claude spells them in `readAllowArguments`.
 * The fourth (the attachment root, where today wrote a send's delivered copies) has no 5.0 folder: 5.0 keeps the
 * originals in Conversation's state and writes no delivered copy to disk yet (GAP(deliver) in ports-pending.json).
 */
const HOME = '/fy';
const ID = 'mw7t92ds-aec7833f';
const DAEMON = 'daemon-1';

/** Today's argv fragment for that session, exactly as rebuild-ref built it (the citations above). */
const TODAY_CLAUDE = [
  `--allowedTools=Read(/${HOME}/state/sessions/${ID}/turns/**)`,
  `--allowedTools=Read(/${HOME}/state/sessions/${ID}/channel/**)`,
  `--allowedTools=Read(/${HOME}/state/sessions/${ID}/attachments/**)`,
  `--allowedTools=Read(/${HOME}/state/attachments/${DAEMON}/${ID}/**)`,
] as const;
/** The one today allowed that 5.0 has no folder for (declared, see above). */
const TODAY_WITHOUT_A_FOLDER = `--allowedTools=Read(/${HOME}/state/attachments/${DAEMON}/${ID}/**)`;

/** Today's session folder, moved to 5.0's: the only layout change between the two. */
const moved = (argument: string) =>
  argument.replace(`${HOME}/state/sessions/${ID}/`, `${HOME}/${FERRET_SESSIONS_FOLDER}/${ID}/`);

/** The 5.0 folders Ferrets hands a start for that session (`LaunchSpec.readable`). */
const readable5 = FERRET_READABLE_FOLDERS.map(folder => `${HOME}/${FERRET_SESSIONS_FOLDER}/${ID}/${folder}`);

/** Whether one `Read(//<folder>/**)` rule lets Claude read `path` without asking (prefix under the folder). */
const covers = (rules: readonly string[], path: string): boolean =>
  rules.some(rule => {
    const match = /^--allowedTools=Read\(\/(\/.+)\/\*\*\)$/.exec(rule);
    return match !== null && path.startsWith(`${match[1]}/`);
  });

const ARGV = {
  binary: '/opt/bin/claude',
  home: '/fy/state/claude-code/agent-homes/f1',
  permissionMode: 'auto' as const,
  hasMcp: false,
  conversation: { kind: 'new' as const, id: 'c-1' },
};

describe('launch-argv parity: the read allowance of a Claude start', () => {
  test('a Claude start carries today’s hand-off read allowances, moved to 5.0’s session folder', () => {
    // Act
    const argv = launchCommand({ ...ARGV, readable: readable5 });
    const allowances = argv.filter(argument => argument.startsWith('--allowedTools='));

    // Assert: today's, less the one 5.0 has no folder for, with the session folder moved and nothing else changed.
    expect(allowances).toEqual(TODAY_CLAUDE.filter(argument => argument !== TODAY_WITHOUT_A_FOLDER).map(moved));
    expect(TODAY_CLAUDE.filter(argument => !allowances.includes(moved(argument)))).toEqual([TODAY_WITHOUT_A_FOLDER]);
  });

  test('the allowance comes after the conversation id and before the model, so the model stays last', () => {
    const argv = launchCommand({ ...ARGV, readable: readable5, model: 'claude-opus-5-5' });
    const first = argv.findIndex(argument => argument.startsWith('--allowedTools='));
    expect(argv[first - 1]).toBe('c-1');
    expect(argv.slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
  });

  test('F-0324 the allowance covers the ferret’s own first turn, and not its environment, its folder or another ferret', () => {
    // Arrange
    const rules = readAllowArguments(readable5);
    const own = `${HOME}/${FERRET_SESSIONS_FOLDER}/${ID}`;
    const other = `${HOME}/${FERRET_SESSIONS_FOLDER}/mw7t92ds-00000000`;

    // Assert: exactly the own turns, channel and attachments folders.
    expect(covers(rules, `${own}/turns/turn-001.md`)).toBe(true);
    expect(covers(rules, `${own}/channel/queue.jsonl`)).toBe(true);
    expect(covers(rules, `${own}/attachments/a1/photo.png`)).toBe(true);
    expect(covers(rules, `${own}/environment.json`)).toBe(false);
    expect(covers(rules, `${own}/config.json`)).toBe(false);
    expect(covers(rules, `${own}/turns`)).toBe(false);
    expect(covers(rules, `${own}-x/turns/turn-001.md`)).toBe(false);
    expect(covers(rules, `${other}/turns/turn-001.md`)).toBe(false);
    expect(rules.some(rule => rule.includes('*') && !rule.endsWith('/**)'))).toBe(false);
  });

  test('no allowance without folders, and a folder that is not absolute is never allowed', () => {
    expect(launchCommand(ARGV).some(argument => argument.startsWith('--allowedTools='))).toBe(false);
    expect(readAllowArguments(['relative/turns', '', `${HOME}/x`])).toEqual([`--allowedTools=Read(/${HOME}/x/**)`]);
  });
});
