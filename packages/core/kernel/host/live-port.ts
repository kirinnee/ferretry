/** A cached provider is still a live capability: check its owner again at each property access and invocation. */
export function livePort<T>(value: T, check: () => void): T {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
  const cache = new WeakMap<object, unknown>();
  const wrap = (source: object, receiver?: object): unknown => {
    const existing = cache.get(source);
    if (existing !== undefined) return existing;
    const callable = typeof source === 'function';
    const proxy = new Proxy(callable ? () => {} : {}, {
      get: (_target, key) => {
        check();
        if (callable && key === 'bind')
          return (thisArg: unknown, ...args: unknown[]) => {
            check();
            return wrap(Reflect.apply(Function.prototype.bind, source, [receiver ?? thisArg, ...args]));
          };
        const field = Reflect.get(source, key, source);
        return (typeof field === 'object' && field !== null) || typeof field === 'function'
          ? wrap(field, source)
          : field;
      },
      apply: (_target, _this, args) => {
        check();
        return Reflect.apply(source as (...args: unknown[]) => unknown, receiver, args);
      },
      ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(source)])],
      getOwnPropertyDescriptor: (target, key) => {
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own?.configurable === false) return own;
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        return descriptor === undefined ? own : { ...descriptor, configurable: true };
      },
    });
    cache.set(source, proxy);
    return proxy;
  };
  return wrap(value as object) as T;
}
