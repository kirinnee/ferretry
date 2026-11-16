/**
 * The record layer: what a keyed session does with every byte after the handshake.
 *
 * Two properties are load-bearing and neither is optional.
 *
 * **A carrier cannot read.** Each direction has its own AES-256-GCM key derived from the
 * handshake transcript. Separate keys per direction mean a frame cannot be reflected back at its
 * sender and accepted.
 *
 * **A carrier cannot inject, drop or reorder.** The frame header is the AEAD associated data, so
 * the session identifier, the kind and the sequence number are all authenticated even though they
 * travel in the clear for routing. The receiver accepts exactly the next sequence number and
 * nothing else: a gap is not tolerated and not repaired, it ends the session. That is deliberate.
 * A relay that quietly loses frames would otherwise produce a session that looks healthy and is
 * missing data, and this repository has shipped "absent evidence read as a benign result" often
 * enough to know how that ends.
 *
 * The AEAD nonce is the sequence number, so a sequence number is never reused under one key. The
 * session ends at {@link MAX_FRAME_SEQUENCE} rather than wrapping.
 */

import { writeUint64 } from './binary.ts';
import {
  AEAD_NONCE_BYTES,
  MAX_FRAME_SEQUENCE,
  MAX_PLAINTEXT_BYTES,
  RELAY_CLOSE_CODES,
  type RelayCloseCode,
} from './constants.ts';
import type { RelayCrypto } from './crypto.ts';
import { encodeFrameHeader, FRAME_KINDS, type RelayFrame, type SessionId } from './frames.ts';
import type { SessionKeys } from './handshake.ts';

/** The first record sequence number. Zero belongs to the handshake frame in each direction. */
const FIRST_RECORD_SEQUENCE = 1;

export interface ChannelState {
  readonly sessionId: SessionId;
  readonly sendKey: Uint8Array;
  readonly receiveKey: Uint8Array;
  readonly sendSequence: number;
  readonly receiveSequence: number;
}

/** Key a channel from a completed handshake. The role decides which key goes in which direction. */
export function openChannel(sessionId: SessionId, keys: SessionKeys, role: 'client' | 'daemon'): ChannelState {
  const asClient = role === 'client';
  return {
    sessionId,
    sendKey: asClient ? keys.clientToDaemon : keys.daemonToClient,
    receiveKey: asClient ? keys.daemonToClient : keys.clientToDaemon,
    sendSequence: FIRST_RECORD_SEQUENCE,
    receiveSequence: FIRST_RECORD_SEQUENCE,
  };
}

function recordNonce(sequence: number): Uint8Array {
  const nonce = new Uint8Array(AEAD_NONCE_BYTES);
  writeUint64(nonce, AEAD_NONCE_BYTES - 8, sequence);
  return nonce;
}

export type ChannelFailure = { readonly ok: false; readonly code: RelayCloseCode; readonly reason: string };

export type SealResult =
  | { readonly ok: true; readonly state: ChannelState; readonly frame: RelayFrame }
  | ChannelFailure;

export async function sealRecord(crypto: RelayCrypto, state: ChannelState, plaintext: Uint8Array): Promise<SealResult> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    return { ok: false, code: RELAY_CLOSE_CODES.frameTooLarge, reason: 'payload exceeds one record' };
  }
  if (state.sendSequence > MAX_FRAME_SEQUENCE) {
    return { ok: false, code: RELAY_CLOSE_CODES.sequenceBroken, reason: 'send sequence is exhausted' };
  }
  const header = encodeFrameHeader(FRAME_KINDS.data, state.sessionId, state.sendSequence);
  const ciphertext = await crypto.seal(state.sendKey, recordNonce(state.sendSequence), header, plaintext);
  return {
    ok: true,
    state: { ...state, sendSequence: state.sendSequence + 1 },
    frame: {
      kind: FRAME_KINDS.data,
      sessionId: state.sessionId,
      sequence: state.sendSequence,
      payload: ciphertext,
    },
  };
}

export type OpenResult =
  | { readonly ok: true; readonly state: ChannelState; readonly plaintext: Uint8Array }
  | ChannelFailure;

export async function openRecord(crypto: RelayCrypto, state: ChannelState, frame: RelayFrame): Promise<OpenResult> {
  if (frame.kind !== FRAME_KINDS.data) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'frame is not a record' };
  }
  if (frame.sessionId.text !== state.sessionId.text) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'record belongs to another session' };
  }
  if (frame.sequence !== state.receiveSequence) {
    return { ok: false, code: RELAY_CLOSE_CODES.sequenceBroken, reason: 'record sequence is not the next one' };
  }
  const header = encodeFrameHeader(frame.kind, frame.sessionId, frame.sequence);
  const plaintext = await crypto.open(state.receiveKey, recordNonce(frame.sequence), header, frame.payload);
  if (plaintext === null) {
    return { ok: false, code: RELAY_CLOSE_CODES.frameForged, reason: 'record failed authentication' };
  }
  return { ok: true, state: { ...state, receiveSequence: state.receiveSequence + 1 }, plaintext };
}
