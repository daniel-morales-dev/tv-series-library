import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.ts';

/** A promise that never settles: simulates a hung close()/stop(). */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('createShutdown', () => {
  it('stops worker and ingestor, closes the app, then exits 0', async () => {
    const order: string[] = [];
    const worker = { stop: vi.fn(() => void order.push('worker')) };
    const ingestor = { stop: vi.fn(() => void order.push('ingestor')) };
    const app = { close: vi.fn(async () => void order.push('close')) };
    const exit = vi.fn();

    await createShutdown({ app, worker, ingestor, exit })();

    expect(order).toEqual(['worker', 'ingestor', 'close']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops the worker without killing the running ffmpeg so the next server adopts it', async () => {
    const worker = { stop: vi.fn() };

    await createShutdown({ app: { close: async () => {} }, worker, exit: vi.fn() })();

    expect(worker.stop).toHaveBeenCalledWith({ killChildren: false });
  });

  it('is idempotent: the second signal force-exits immediately without repeating cleanup', async () => {
    const worker = { stop: vi.fn() };
    const app = { close: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdown({ app, worker, exit });

    const first = shutdown();
    await shutdown();
    await first;

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenNthCalledWith(1, 1);
    expect(exit).toHaveBeenNthCalledWith(2, 0);
  });

  it('force-exits after the timeout when the app never closes', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({ app: { close: () => never() }, exit, timeoutMs: 20 });

    const startedAt = Date.now();
    await shutdown();

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('force-exits after the timeout when a stop() hangs', async () => {
    const exit = vi.fn();
    const worker = { stop: () => never() };
    const shutdown = createShutdown({ app: { close: async () => {} }, worker, exit, timeoutMs: 20 });

    await shutdown();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('force-exits when cleanup fails', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({ app: { close: () => Promise.reject(new Error('boom')) }, exit });

    await shutdown();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
