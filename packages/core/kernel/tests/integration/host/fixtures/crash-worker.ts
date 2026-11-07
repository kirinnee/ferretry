// A worker that throws on its first message, so its handle sees the exit.
declare const self: Worker;
self.onmessage = () => {
  throw new Error('crashed on purpose');
};
