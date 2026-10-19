interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * An async push/pull queue: `push()` from a listener, `for await` on the other
 * side. Closing with an error rejects the pending reader.
 *
 * Used for the `analyze()` update stream; exported because it is handy for any
 * producer/consumer bridge across the worker boundary.
 *
 * @example
 * ```ts
 * const queue = new AsyncQueue<AnalysisInfo>();
 * engine.on('info', (info) => queue.push(info));
 * for await (const info of queue) render(info);
 * ```
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<Waiter<T>> = [];
  private closed = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length)
          return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
