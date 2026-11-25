/**
 * The ferret acts: `send_to_ferret`, `restart_ferret`, `stop_ferret` and `spawn_ferret`. Each goes through the daemon's own
 * route as the connector's principal (U2), so a grant the operator narrowed refuses it exactly as it would a phone.
 */
import { z } from 'zod';
import { clip, oneLine } from '../format.ts';
import { ToolFailure } from '../gateway.ts';
import { matchName } from '../names.ts';
import { callsignOf, ferretArg, isLive, resolveFerret } from './ferrets.ts';
import { type ConnectorToolSpec, DESTRUCTIVE, WRITE } from './spec.ts';

const MESSAGE_MAX_CHARS = 8000;

const sendToFerret: ConnectorToolSpec<{ ferret: typeof ferretArg; message: z.ZodString }> = {
  name: 'send_to_ferret',
  title: 'Send a message to a ferret',
  description:
    'Send a message to one ferret, as if the owner typed it in the Ferretry app. Use for instructions or replies in the conversation. To answer an open question or approval, use answer_attention instead.',
  scope: 'fleet:write',
  annotations: WRITE,
  input: { ferret: ferretArg, message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).describe('The message text.') },
  run: async ({ ferret, message }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const result = await env.gateway.send(view.id, message);
    const who = callsignOf(view);
    const said: Record<string, string> = {
      delivered: `Sent to ${who}.`,
      sent: `Sent to ${who}; it is busy, so it will read it shortly.`,
      queued: `Queued for ${who}; it will read it when it is next free.`,
      revived: `${who} was stopped. I woke it up and sent your message.`,
      'queued-for-revive': `${who} was stopped. Your message is queued and it will wake up for it.`,
    };
    return { text: said[result.disposition] ?? `Sent to ${who}.`, sessionId: view.id };
  },
};

const restartFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'restart_ferret',
  title: 'Restart a ferret',
  description:
    'Restart one ferret on its current conversation, as the Restart button does. If it is busy mid-turn the restart waits until it is idle. Interrupts work in progress. Only a running ferret restarts; a stopped one is woken by send_to_ferret.',
  scope: 'fleet:write',
  annotations: DESTRUCTIVE,
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const result = await env.gateway.restart(view.id);
    const who = callsignOf(view);
    if (result.restarted.length > 0) return { text: `Restarted ${who}.`, sessionId: view.id };
    if (result.queued.length > 0)
      return { text: `${who} is busy, so I queued the restart for when it is idle.`, sessionId: view.id };
    const failure = result.failed[0];
    if (failure !== undefined)
      throw new ToolFailure(`I could not restart ${who}: ${clip(oneLine(failure.reason), 200)}`);
    const skipped = result.skipped[0];
    // The daemon restarts only a RUNNING ferret. Say that plainly, and the one thing that does bring it back here:
    // a message to it wakes it (`send_to_ferret`, disposition `revived`).
    if (skipped?.reason === 'not-running')
      return {
        text: `${who} is stopped, so there is nothing to restart. To bring it back, send it a message with send_to_ferret and it will wake up for it.`,
        sessionId: view.id,
      };
    return {
      text: `I left ${who} alone${skipped === undefined ? '' : ` (${skipped.reason.replace(/-/gu, ' ')})`}.`,
      sessionId: view.id,
    };
  },
};

const stopFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'stop_ferret',
  title: 'Stop a ferret',
  description:
    'Stop one ferret. It ends its session; it can be resumed later from the app. Use only when the user clearly asks to stop it.',
  scope: 'fleet:write',
  annotations: { ...DESTRUCTIVE, idempotentHint: true },
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const who = callsignOf(view);
    if (!isLive(view)) return { text: `${who} is already ${view.state}.`, sessionId: view.id };
    await env.gateway.stop(view.id);
    return { text: `Stopped ${who}.`, sessionId: view.id };
  },
};

const spawnFerret: ConnectorToolSpec<{
  task: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  project: z.ZodOptional<z.ZodString>;
}> = {
  name: 'spawn_ferret',
  title: 'Start a new ferret',
  description:
    'Start a new ferret on a task, as the New ferret button does. Give the task in plain words, optionally a short name, and the project (one of the registered projects; list_ferrets does not show them, so if unsure leave it out and the error lists them).',
  scope: 'fleet:write',
  annotations: WRITE,
  input: {
    task: z.string().trim().min(1).max(4000).describe('What the new ferret should do.'),
    name: z.string().trim().min(1).max(100).optional().describe('A short task name.'),
    project: z.string().trim().min(1).max(200).optional().describe('A registered project name.'),
  },
  run: async ({ task, name, project }, env) => {
    const projects = await env.gateway.projects();
    const label = (entry: (typeof projects)[number]): string => entry.name;
    let chosen = projects.length === 1 ? projects[0] : undefined;
    if (project !== undefined) {
      const result = matchName(project, projects, entry => ({ exact: [entry.id], names: [entry.name] }));
      if (result.kind === 'one') chosen = result.item;
      else if (result.kind === 'many')
        throw new ToolFailure(
          `More than one project matches "${oneLine(project)}": ${result.items.map(label).join(', ')}. Which one?`,
        );
      else {
        const hint = result.suggestions.length > 0 ? result.suggestions : projects.slice(0, 8);
        throw new ToolFailure(
          `No project called "${oneLine(project)}". Projects: ${hint.map(label).join(', ') || 'none registered'}.`,
        );
      }
    }
    if (chosen === undefined) {
      if (projects.length === 0)
        throw new ToolFailure('No projects are registered on this machine, so I cannot start a ferret.');
      throw new ToolFailure(`Which project? Choose one of: ${projects.slice(0, 12).map(label).join(', ')}.`);
    }
    const view = await env.gateway.start(task, name, chosen);
    return {
      text: `Started ${callsignOf(view)} on "${clip(oneLine(task), 80)}" in ${chosen.name}.`,
      sessionId: view.id,
    };
  },
};

export const ACTION_TOOLS = [sendToFerret, restartFerret, stopFerret, spawnFerret] as const;
