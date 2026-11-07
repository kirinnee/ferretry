import type { InputReason, InputRequest, InputRequestList } from '@ferretry/protocol';

const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** What the daemon could not prove about the program reading a terminal, or nothing when it is proved and known. */
function readerWords(observed: { readonly program?: string; readonly recognisedConsumer: boolean }): string {
  if (observed.program === undefined) return ' (UNVERIFIED: Ferretry could not prove which program this is)';
  return observed.recognisedConsumer ? '' : ' (not a program known to ask for secrets)';
}

/** Untrusted text made visible: a control or format character is spelled out, never sent to the terminal. */
export function showUntrusted(value: string): string {
  return value.replaceAll(UNSEEN, char => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`;
  });
}

const compact = (value: string, width: number): string => {
  const line = value.replaceAll(/\s+/gu, ' ').trim();
  return showUntrusted(line.length > width ? `${line.slice(0, width - 1)}…` : line);
};

/** How a target is cited: the same `%terminal:dev` an owner types and reads everywhere. */
export function inputTargetReference(request: InputRequest): string {
  return request.target.kind === 'secret'
    ? `the secret ${request.target.key}`
    : `%${request.target.kind}:${request.target.key}`;
}

function remaining(request: InputRequest, now: number): string {
  const seconds = Math.round((Date.parse(request.expiresAt) - now) / 1_000);
  if (seconds <= 0) return 'expired';
  return seconds < 90 ? `${seconds}s left` : `${Math.round(seconds / 60)}m left`;
}

/** The account the daemon matched to this target, as a handle and a label; nothing more of it. */
function matchedLogin(request: InputRequest): { readonly id: string; readonly text: string } | undefined {
  const offer = request.saved?.offers.find(candidate => candidate.matched);
  return offer === undefined ? undefined : { id: offer.id, text: `${offer.id} (${compact(offer.label, 80)})` };
}

/** One line per open request. There is no value in a request, so there is none to print. */
export function renderInputList(list: InputRequestList, now: number): string {
  if (list.requests.length === 0) return 'No input requests are waiting.';
  return list.requests
    .map(request => {
      const login = matchedLogin(request);
      return `!${request.agendaItemId}  ${request.state}  ${request.sensitivity}  ${inputTargetReference(request)}  ${remaining(request, now)}\n      the ferret says: ${compact(request.prompt, 120)}${login === undefined ? '' : `\n      use: ${login.text}`}`;
    })
    .join('\n');
}

/** What the daemon saw at the target, drawn before the owner types: the ferret's words stay small. */
export function renderInputFacts(request: InputRequest): string[] {
  const lines = [
    `!${request.agendaItemId} wants a ${request.sensitivity} value typed into ${inputTargetReference(request)}`,
    `the ferret says: ${compact(request.prompt, 200)}`,
  ];
  if (request.risk !== undefined) lines.push(`risk ${request.risk.level}: ${showUntrusted(request.risk.reason)}`);
  const login = matchedLogin(request);
  if (login !== undefined) lines.push(`an account matches: ${login.text} (answer with --account ${login.id})`);
  if (request.source !== undefined) {
    const from =
      request.source.from.origin ?? request.source.from.path ?? request.source.from.program ?? request.source.from.kind;
    lines.push(
      `pastes the secure copy sealed:${request.source.name}, captured from ${showUntrusted(from)}: nothing to type`,
    );
  }
  const observed = request.observed;
  if (observed?.kind === 'secret')
    lines.push(
      observed.exists ? `it REPLACES the value ${observed.name} holds now` : `it adds the new secret ${observed.name}`,
    );
  if (observed?.kind === 'terminal') {
    lines.push(
      `reading the terminal now: ${showUntrusted(observed.program ?? observed.foreground.comm)}${readerWords(observed)}`,
      `echo: ${observed.echo}`,
      ...(observed.promptLine === '' ? [] : [`its prompt line: ${showUntrusted(observed.promptLine)}`]),
    );
  }
  if (observed?.kind === 'browser') {
    lines.push(`the page: ${showUntrusted(observed.origin)}${observed.secure ? '' : ' (not secure: http)'}`);
    if (observed.challenge !== undefined)
      lines.push('the page is showing a captcha: take over the browser and complete it yourself');
  }
  if (request.chain !== undefined) lines.push(`step ${request.step ?? 2}, after !${request.chain}`);
  if (request.fields.length > 1)
    for (const field of request.fields)
      lines.push(
        `field ${field.id} (${compact(field.label, 60)}): ${field.sensitivity}${field.risk === undefined ? '' : `, risk ${field.risk.level}: ${showUntrusted(field.risk.reason)}`}`,
      );
  return lines;
}

const REASONS: Readonly<Record<InputReason, string>> = {
  target_changed: 'the target is no longer the one the card showed',
  target_gone: 'the target is gone',
  insecure_origin: 'the page is not a secure origin',
  interrupted: 'the daemon was interrupted',
  owner_declined: 'declined',
  agent_cancelled: 'the ferret cancelled it',
  check_failures: 'the target kept changing, so nothing was typed; ask the ferret to request again',
  expired: 'it expired',
  copy_gone: 'the secure copy it was to paste is gone',
};

/** The sentence for a closed reason. */
export function describeInputReason(reason: InputReason): string {
  return REASONS[reason];
}
