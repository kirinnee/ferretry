import { describe, expect, it } from 'bun:test';
import { runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import type { Redaction, RedactionScope } from '@ferretry/kernel/contract';
import { subject } from './runner-world.ts';

const keys = (world: ReturnType<typeof subject>) =>
  world.server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1));
const identity: Redaction = {
  read: async fn =>
    await fn({ lines: (lines: readonly string[]) => lines, text: (text: string) => text } as unknown as RedactionScope),
};
const redacting = (secret: string): Redaction => ({
  read: async fn =>
    await fn({
      lines: (lines: readonly string[]) => lines.map(line => line.split(secret).join('*'.repeat(secret.length))),
      text: (text: string) => text.split(secret).join('*'.repeat(secret.length)),
    } as unknown as RedactionScope),
});
const failureOf = async (promise: Promise<unknown>) =>
  runnerDeliveryFailure(
    await promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );

describe('structured questions: the runner’s form seam', () => {
  it('formCapture reads the visible screen and the scrollback inside ONE read act, writing nothing', async () => {
    const world = subject({ redaction: identity });
    world.server.transcript = 'Which database?';
    const seen = await world.runner.formCapture(world.handle);
    expect(seen).toMatchObject({ alive: true, dead: false, activeWork: false });
    expect(seen?.visible).toContain('Which database?');
    expect(world.acts.map(act => act.op)).toEqual(['read']);
    expect(keys(world)).toEqual([]);
  });

  it('formCapture masks a value the Vault holds in both the screen and the scrollback', async () => {
    const world = subject({ redaction: redacting('hunter2') });
    world.server.transcript = 'the password is hunter2';
    const seen = await world.runner.formCapture(world.handle);
    expect(seen?.visible).not.toContain('hunter2');
    expect(seen?.history).not.toContain('hunter2');
  });

  it('formCapture reads a working pane as activeWork', async () => {
    const world = subject({ redaction: identity });
    world.server.working = true;
    expect((await world.runner.formCapture(world.handle))?.activeWork).toBe(true);
  });

  it('formCapture is total: a pane that is gone, replaced, held or unreadable reads undefined; with no redaction bound it reads nothing', async () => {
    const gone = subject({ redaction: identity });
    gone.server.alive = false;
    expect(await gone.runner.formCapture(gone.handle)).toBeUndefined();
    const replaced = subject({ redaction: identity });
    replaced.replace({ session: 'fy-webterm-person' });
    expect(await replaced.runner.formCapture(replaced.handle)).toBeUndefined();
    const broken = subject({ redaction: identity });
    broken.throwOn('capture-pane');
    expect(await broken.runner.formCapture(broken.handle)).toBeUndefined();
    expect(await subject().runner.formCapture(subject().handle)).toBeUndefined();
  });

  it('formKey types ONE closed key, acted on the exact pane as a keys write', async () => {
    const world = subject();
    await world.runner.formKey(world.handle, 'Down');
    expect(keys(world)).toEqual(['Down']);
    expect(world.acts.map(act => act.op)).toEqual(['keys']);
  });

  it('formKey refuses a key outside the closed set before anything is typed', async () => {
    const world = subject();
    await expect(world.runner.formKey(world.handle, 'C-c' as never)).rejects.toThrow();
    await expect(world.runner.formKey(world.handle, 'y' as never)).rejects.toThrow();
    expect(keys(world)).toEqual([]);
    expect(world.acts).toEqual([]);
  });

  it('formKey under a Vault hold types NOTHING and rejects held with the hold’s code', async () => {
    const world = subject();
    world.hold();
    expect(await failureOf(world.runner.formKey(world.handle, 'Enter'))).toEqual({
      kind: 'held',
      code: 'input_pending',
    });
    expect(keys(world)).toEqual([]);
  });

  it('formKey and formPaste reject not_ready/exited for a pane that is gone, with nothing typed', async () => {
    const world = subject();
    world.server.alive = false;
    expect(await failureOf(world.runner.formKey(world.handle, 'Enter'))).toMatchObject({
      kind: 'not_ready',
      why: 'exited',
    });
    expect(await failureOf(world.runner.formPaste(world.handle, 'text'))).toMatchObject({
      kind: 'not_ready',
      why: 'exited',
    });
    expect(keys(world)).toEqual([]);
  });

  it('formPaste pastes through the guard (load, paste), and under a hold types nothing', async () => {
    const world = subject();
    await world.runner.formPaste(world.handle, 'free text');
    expect(world.server.calls.some(call => call[0] === 'paste-buffer')).toBe(true);
    const held = subject();
    held.hold();
    expect(await failureOf(held.runner.formPaste(held.handle, 'free text'))).toEqual({
      kind: 'held',
      code: 'input_pending',
    });
    expect(held.server.calls.some(call => call[0] === 'paste-buffer')).toBe(false);
  });
});
