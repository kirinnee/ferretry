/**
 * Masks one credential out of a stranger's reply, in a stream (a reply that echoes the credential is a leak whatever
 * carries it). The text is decoded as it arrives, the longest tail that could still be the start of the value is held
 * back until the next chunk settles it, and every whole occurrence becomes `mask`. A value that is empty is never
 * searched for (an empty needle would match everywhere).
 */
export function maskEchoStream(
  body: ReadableStream<Uint8Array>,
  value: string,
  mask: string,
): ReadableStream<Uint8Array> {
  if (value.length === 0) return body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const keep = value.length - 1;
  let held = '';
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    if (text.length > 0) controller.enqueue(encoder.encode(text));
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        held = (held + decoder.decode(chunk, { stream: true })).split(value).join(mask);
        // Whatever still ends in a prefix of the value waits; the rest is final.
        let cut = held.length;
        for (let tail = Math.min(keep, held.length); tail > 0; tail -= 1)
          if (value.startsWith(held.slice(held.length - tail))) {
            cut = held.length - tail;
            break;
          }
        emit(controller, held.slice(0, cut));
        held = held.slice(cut);
      },
      flush(controller) {
        emit(controller, (held + decoder.decode()).split(value).join(mask));
      },
    }),
  );
}

/** A copy of `headers` with the credential masked out of every value. */
export function maskEchoHeaders(headers: Headers, value: string, mask: string): Headers {
  const masked = new Headers();
  headers.forEach((text, name) => {
    masked.append(name, value.length === 0 ? text : text.split(value).join(mask));
  });
  return masked;
}
