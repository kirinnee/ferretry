/**
 * THE PICTURE OF THE PAGE, with a box on each field the values go into (docs/input-requests.md, "The agenda card").
 *
 * The daemon took the picture before anything was typed and holds it in memory for the owner's card; this reads it once
 * for this request while the card is on screen. The picture and the boxes are the BROWSER's, never the ferret's: the
 * owner sees where the value lands. A picture that cannot be read (or is not valid) is not drawn, and the facts above
 * still say what is there.
 *
 * THE BYTES LIVE IN THIS COMPONENT'S STATE ONLY: no cache, storage, URL, log or slot prop, and they are dropped when the
 * card goes away or moves to another request.
 */
import { useEffect, useState } from 'react';
import type { InputRequest, InputShot } from '../../../contract/index.ts';
import { readInputShot } from '../../lib/input-api.ts';
import { shotBoxes } from '../../lib/field-shot.ts';
import type { InputCardField } from '../../lib/input-card.ts';
import type { VaultClient } from '../../shell.tsx';

export function FieldShot({
  client,
  request,
  fields,
}: {
  readonly client: VaultClient;
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
}) {
  const [shot, setShot] = useState<InputShot | null>(null);
  const { id, sessionId, observedDigest } = request;
  // One read per request id AND observed digest: a refresh with the same facts does not read again, but a rebind (same
  // id, new picture, new facts, new digest) clears the old picture and reads the new one, so the boxes never sit on a
  // stale picture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `observedDigest` is the re-read trigger; the effect does not read it
  useEffect(() => {
    let live = true;
    setShot(null);
    readInputShot(client, { id, sessionId })
      .then(found => {
        if (live) setShot(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      setShot(null);
    };
  }, [client, id, sessionId, observedDigest]);
  if (shot === null) return null;
  return (
    <figure className="relative m-0 min-w-0 overflow-hidden rounded-control border border-border" data-input-shot="">
      <img
        alt="The page where the values go, before anything was typed"
        className="block h-auto w-full"
        src={`data:image/png;base64,${shot.pngBase64}`}
      />
      {shotBoxes(request, fields, shot).map(box => (
        <span
          aria-hidden="true"
          className="absolute rounded-control outline outline-2 outline-accent"
          data-input-shot-box={box.key}
          key={box.key}
          style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
        />
      ))}
    </figure>
  );
}
