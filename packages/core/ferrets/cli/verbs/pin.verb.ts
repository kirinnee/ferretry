import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { PinController, type PinOptions } from '../lib/pins/controller.ts';
import { ClientPinGateway } from '../lib/pins/gateway.ts';
import { text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

// `fy pin [add] <text...>|ls|edit|rm` (V-0341…): a ferret's pin board, the ferret this runs inside unless `-s` names one.
export default defineVerbs(({ client, env, verb, json, first }) => {
  const pinBoard = (
    work: (controller: PinController, invocation: VerbInvocation, options: PinOptions) => Promise<void>,
  ) =>
    verb(async (invocation, _presenter, io) => {
      const session = text(invocation, 'session', 's');
      const options: PinOptions = { ...(session === undefined ? {} : { session }), ...json(invocation) };
      await work(new PinController(new ClientPinGateway(client), io, env?.FY_SESSION_ID), invocation, options);
    });
  return {
    'pin add <text...>': pinBoard(async (pins, invocation, options) => {
      await pins.add(invocation.args, options);
    }),
    'pin ls': pinBoard(async (pins, _invocation, options) => {
      await pins.list(options);
    }),
    'pin edit <id> <text...>': pinBoard(async (pins, invocation, options) => {
      await pins.edit(first(invocation, 'pin id'), invocation.args.slice(1), options);
    }),
    'pin rm <id>': pinBoard(async (pins, invocation, options) => {
      await pins.remove(first(invocation, 'pin id'), options);
    }),
  };
});
