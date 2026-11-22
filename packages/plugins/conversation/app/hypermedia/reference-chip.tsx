import {
  REFERENCE_CLOSED_ATTRIBUTE,
  type ReferenceResolvers,
  type ResolvedReference,
  referenceIdentity,
  referenceTitle,
  remarkReferences,
  resolveReference,
  revalidateReference,
  surfaceReferenceClosed,
} from '@ferretry/app';
import type { ReferenceData } from './with-references.ts';
import { referenceClick, useReferenceProof } from './reference-proof.tsx';

/**
 * ONE PROVED REFERENCE IN PROSE: a link when this surface can prove it AND open it, a tombstone when its owner proved it
 * gone, and the text it was written as in every other case (docs/reference-standard.md §6, "proof before link").
 *
 * Durian draws this through its inline-reference component slot; the parser never saw the token, so nothing an agent
 * writes can make one (a hand-written `[x](#fy-reference?…)` is dropped by the URL policy and is never a chip).
 *
 *  - PROVED AT PAINT: `resolveReference` asks the live resolver; no answer, no link.
 *  - RE-PROVED AT PAINT AND AT CLICK: the chip asks again with the trusted resolvers (an `@file` only for the path the
 *    folder listing returned), and a click whose proof has gone does nothing.
 *  - A CLOSED SURFACE is an inert `<del>` with its own sentence, never a link and never plain prose.
 */
export function ReferenceChip({ text, data }: { readonly text: string; readonly data: unknown }) {
  const proof = useReferenceProof();
  const reference = (data as ReferenceData | undefined)?.reference;
  if (proof === null || reference === undefined) return <>{text}</>;
  const resolved = resolveReference(reference, proof.resolvers);
  if (resolved === null) {
    if (reference.kind !== 'surface' || !surfaceReferenceClosed(reference, proof.resolvers)) return <>{text}</>;
    return (
      <del
        {...{ [REFERENCE_CLOSED_ATTRIBUTE]: `${reference.surface}:${reference.key}` }}
        title={tombstoneTitle(text, proof.resolvers)}
      >
        {text}
      </del>
    );
  }
  const target = revalidateReference(resolved, proof.trusted);
  if (target === null || !proof.hasOpener(target)) return <>{text}</>;
  const stillProved = (t: ResolvedReference): boolean => revalidateReference(t, proof.trusted) !== null;
  return (
    <a
      data-fy-reference={referenceIdentity(target)}
      href={proof.destination(target)}
      onClick={referenceClick(proof, target, stillProved)}
      title={referenceTitle(target)}
    >
      {text}
    </a>
  );
}

/**
 * The tombstone's sentence is the grammar's own (`closedSurfaceTitle` is private to it): ask the same transform that made
 * the Markdown reader's tombstone, on the one token, rather than restate the sentence here.
 */
function tombstoneTitle(raw: string, resolvers: ReferenceResolvers): string | undefined {
  const paragraph = { type: 'paragraph', children: [{ type: 'text', value: raw }] };
  remarkReferences({ resolvers })({ type: 'root', children: [paragraph] } as never);
  const node = (paragraph.children as { data?: { hProperties?: Record<string, string> } }[])[0];
  return node?.data?.hProperties?.title;
}
