/**
 * `TmuxRunner.answerDevChannels` through the guarded binding: the Enter that answers Claude's development-channels confirm
 * is written only if tmux still finds that dialog on screen IN the write. A screen that changes between the frame that
 * recognised the dialog and the write (a same-row redraw: another dialog, or the selection moved) gets no key.
 */
import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { subject } from './runner-world.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/startup-dialogs');
const dialog = async (name: string): Promise<string> => (await readFile(join(FIXTURES, name), 'utf8')).trimEnd();
const enters = (world: ReturnType<typeof subject>): number =>
  world.server.calls.filter(call => call[0] === 'send-keys' && call.at(-1) === 'Enter').length;

describe('answering the development-channels confirm at launch, through the guarded binding', () => {
  it('presses one Enter, and the write itself asks tmux to find the dialog on screen', async () => {
    const world = subject();
    world.server.modalReplacesComposer = true;
    world.server.modal = await dialog('claude-2.1.317-dev-channels.txt');

    expect(await world.runner.answerDevChannels(world.handle)).toBe('answered');

    expect(enters(world)).toBe(1);
    expect(world.guards).toHaveLength(1);
    expect(world.guards[0]?.[4]).toContain('#{C:WARNING: Loading development channels}');
    expect(world.guards[0]?.[4]).toContain('#{C:❯ 1. I am using this for local development}');
  });

  it('sends no key when another dialog replaces it between the frame that recognised it and the write', async () => {
    const world = subject();
    world.server.modalReplacesComposer = true;
    world.server.modal = await dialog('claude-2.1.317-dev-channels.txt');
    const folderTrust = await dialog('claude-2.1.281-folder-trust.txt');
    world.beforeGuard(() => {
      world.server.modal = folderTrust;
    });

    expect(await world.runner.answerDevChannels(world.handle)).toBe('absent');

    expect(enters(world)).toBe(0);
    expect(world.server.modal).toBe(folderTrust);
  });

  it('sends no key when the selection moves to Exit between the frame and the write', async () => {
    const world = subject();
    world.server.modalReplacesComposer = true;
    const confirm = await dialog('claude-2.1.317-dev-channels.txt');
    world.server.modal = confirm;
    world.beforeGuard(() => {
      world.server.modal = confirm.replace('❯ 1. I am', '  1. I am').replace('  2. Exit', '❯ 2. Exit');
    });

    expect(await world.runner.answerDevChannels(world.handle)).toBe('absent');

    expect(enters(world)).toBe(0);
  });
});
