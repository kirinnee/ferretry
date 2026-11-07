/**
 * Type-level tests (§4.7, §7.1): compiled by `tsc --noEmit`, never run. Each `@ts-expect-error` must stay an error;
 * if a case starts compiling, tsc fails on the unused directive.
 */
import type { Ack, Content, OpaqueId, OP_EFFECTS, PolicyRef, ResultOf } from '../../contract/index.ts';
import { policyRef } from '../../contract/index.ts';

declare const page: { readonly url: string };
declare const someContent: Content;

// @ts-expect-error a write-only Op cannot return page content
export const a: ResultOf<'navigate'> = someContent;

// @ts-expect-error an Ack cannot carry a URL
export const b: Ack = { status: 'done', url: 'https://example.test/' };

// @ts-expect-error a target-derived string is not an OpaqueId
export const c: Ack = { status: 'done', ids: [page.url] };

// @ts-expect-error widening the effects table is refused
export const d: (typeof OP_EFFECTS)['keys'] = ['writes', 'reads'];

// A reading Op does return content.
export const e: ResultOf<'read'> = someContent;
// `script` writes AND reads, so it returns content.
export const f: ResultOf<'script'> = someContent;
// Every write-only Op is an Ack.
export const g: ResultOf<'keys'> = { status: 'refused', code: 'held' };

declare const capability: PolicyRef<'capability'>;
declare const minted: OpaqueId;

// @ts-expect-error a capability is not a step-up act
export const h: PolicyRef<'step-up-act'> = capability;

// @ts-expect-error a bare string is not a policy ref
export const i: PolicyRef<'audit'> = 'card-moved';

// @ts-expect-error a policy ref of one kind is not another kind
export const j: PolicyRef<'remedy'> = policyRef('audit', 'card-moved');

export const k: PolicyRef<'capability'> = policyRef('capability', 'board');
export const l: Ack = { status: 'done', ids: [minted] };
