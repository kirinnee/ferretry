import { PinAgentController } from '../lib/session/pin-agent.ts';
import { RevokeCredentialController } from '../lib/session/revoke-credential.ts';
import { BINARY, defineVerbs, type VerbContext } from './context.ts';

const SESSION_USAGE = [
  "act on a ferret's own standing with this daemon:",
  `  ${BINARY} session revoke-credential <ferret>`,
  `  ${BINARY} session pin <ferret>`,
  `  ${BINARY} session unpin <ferret>`,
];

const pin = (how: 'pin' | 'unpin', { api, verb, json }: VerbContext) =>
  verb(async (invocation, presenter) => {
    await new PinAgentController(api, presenter)[how](invocation.args[0] ?? '', json(invocation));
  });

export default defineVerbs(c => ({
  session: c.usage(SESSION_USAGE),
  'session revoke-credential <session>': c.verb(async (invocation, presenter) => {
    await new RevokeCredentialController(c.api, presenter, BINARY).execute(
      invocation.args[0] ?? '',
      c.json(invocation),
    );
  }),
  'session pin <session>': pin('pin', c),
  'session unpin <session>': pin('unpin', c),
}));
