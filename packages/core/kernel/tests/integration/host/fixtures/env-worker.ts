// A worker that answers each message with what its environment holds for the names it was asked about.
declare const self: Worker;
self.onmessage = (event: MessageEvent<readonly string[]>) => {
  const seen: Record<string, string | null> = {};
  for (const name of event.data) seen[name] = process.env[name] ?? null;
  self.postMessage(seen);
};
