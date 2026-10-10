/**
 * T40d: a normal shutdown leaves the running ffmpeg alive (`stop({ killChildren: false })`); the next
 * server adopts it or terminates it as an orphan at start(), so there is never a second writer.
 * T34: `node --watch` restarts and the dev launcher SIGTERM the server; without a handler the
 * process died instantly and left its ffmpeg children alive, still writing `data/hls/<id>.tmp`.
 * A restarted server requeued the same job and a second ffmpeg rewrote the same package
 * (playlists flip-flopped, A/V desynced). `stop()` runs before close(); the timeout is the safety net.
 */
export interface Stoppable {
  stop(opts?: { killChildren?: boolean }): unknown;
}

export interface ShutdownDeps {
  /** Fastify server (anything with close()). */
  app: { close(): unknown };
  /** Stops the poll loop; the in-flight ffmpeg keeps running (killChildren: false). */
  worker?: Stoppable;
  /** Clears the ingestor timers. */
  ingestor?: Stoppable;
  /** Bound for the whole cleanup; past it we force-exit so a hung child cannot block watch restarts. */
  timeoutMs?: number;
  /** Injection point for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export const SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Returns the signal handler: first call stops worker/ingestor, closes the app, then exits 0;
 * any later call force-exits immediately (a second Ctrl+C must never hang on cleanup).
 * Calls are idempotent: cleanup runs at most once.
 */
export function createShutdown({
  app,
  worker,
  ingestor,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  exit = process.exit,
  log = () => {},
}: ShutdownDeps): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return function shutdown() {
    if (stopping) {
      log('second shutdown signal: forcing exit');
      exit(1);
      return Promise.resolve();
    }
    stopping = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        // The array literal calls both stop()s synchronously, before app.close() starts.
        const cleaned = Promise.all([worker?.stop({ killChildren: false }), ingestor?.stop(), app.close()]).then(() => 'done' as const);
        if ((await Promise.race([cleaned, timeout])) === 'timeout') {
          log(`shutdown did not finish in ${timeoutMs}ms: forcing exit`);
          exit(1);
        } else {
          exit(0);
        }
      } catch (err) {
        log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}: forcing exit`);
        exit(1);
      } finally {
        clearTimeout(timer);
      }
    })();
    return stopping;
  };
}
