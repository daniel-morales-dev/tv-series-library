import { isAbsolute, join, resolve } from 'node:path';
import { configDir } from '../../config/config.ts';
import {
  assertCanSwitchPointer, buildPlan, clearJournal, freeOrigin, MigrationError, readHlsPointer, readJournal, runMigration,
  switchPointer, writeJournal, type FreeResult, type MigrationDeps, type MigrationPlan, type Progress,
} from './migrate.ts';

export interface MigrationServiceOptions {
  /** Where the journal lives (the SQLite state dir). */
  stateDir: string;
  /** HLS root the server booted with. */
  hlsDir: string;
  contentDir: () => string;
  diskPresent: () => boolean;
  minFreeBytes: number;
  minFreePct: number;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  deps?: MigrationDeps;
}

export interface JobState extends Progress {
  state: 'idle' | 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface MigrationStatus {
  job: JobState;
  from: string;
  to: string;
  /** config.json already points at the destination. */
  pointerSwitched: boolean;
  /** The running server still reads the origin: restart before freeing it. */
  restartRequired: boolean;
  canFreeOrigin: boolean;
  /** The server already serves from the library and no migration is pending. */
  alreadyThere: boolean;
}

export function createMigrationService(o: MigrationServiceOptions) {
  const env = o.env ?? process.env;
  const cfgDir = o.configDir ?? configDir(env);
  const defaultTo = () => join(o.contentDir(), '.sala', 'hls');
  let job: JobState = { state: 'idle', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, error: null };
  let running: Promise<void> | null = null;

  // A pending journal pins the origin and destination (after a restart the booted hlsDir is already the destination).
  function route(to?: string) {
    if (to !== undefined && !isAbsolute(to)) throw new MigrationError('invalid_path', 'El destino debe ser una ruta absoluta.');
    const journal = readJournal(o.stateDir);
    const target = journal?.to ?? to ?? defaultTo();
    if (!isAbsolute(target)) throw new MigrationError('invalid_path', 'El destino debe ser una ruta absoluta.');
    return { from: journal?.from ?? o.hlsDir, to: target, journal };
  }

  const options = (r: { from: string; to: string }) => ({ ...r, minFreeBytes: o.minFreeBytes, minFreePct: o.minFreePct, deps: o.deps });

  async function plan(to?: string): Promise<MigrationPlan> {
    if (!o.diskPresent()) throw new MigrationError('disk_absent', 'El disco de la biblioteca no está disponible.');
    const p = await buildPlan(options(route(to)));
    return p;
  }

  function status(): MigrationStatus {
    const journal = readJournal(o.stateDir);
    const to = journal?.to ?? defaultTo();
    const pointer = readHlsPointer(cfgDir);
    const pointerSwitched = job.state !== 'running' && !!pointer && resolve(pointer) === resolve(to);
    const restartRequired = pointerSwitched && resolve(o.hlsDir) !== resolve(to);
    return {
      job: { ...job },
      from: journal?.from ?? o.hlsDir,
      to,
      pointerSwitched,
      restartRequired,
      canFreeOrigin: !!journal && pointerSwitched && !restartRequired,
      alreadyThere: !journal && resolve(o.hlsDir) === resolve(defaultTo()),
    };
  }

  async function start(to?: string): Promise<MigrationStatus> {
    if (running) throw new MigrationError('running', 'Ya hay un movimiento en curso.');
    assertCanSwitchPointer(env, cfgDir);
    const r = route(to);
    const p = await plan(to);
    if (!p.fits) throw new MigrationError('no_space', 'No hay espacio suficiente en el destino.');
    await writeJournal(o.stateDir, { from: r.from, to: r.to, startedAt: new Date().toISOString() });
    job = { state: 'running', done: p.movedCount, total: p.packages.length, bytesDone: p.totalBytes - p.pendingBytes, bytesTotal: p.totalBytes, current: null, error: null };
    running = runMigration({
      ...options(r),
      diskPresent: o.diskPresent,
      onProgress: (progress) => (job = { ...job, ...progress }),
      switchPointer: async () => switchPointer(r.to, cfgDir),
    })
      .then(() => void (job = { ...job, state: 'completed', current: null }))
      .catch((err: unknown) => void (job = { ...job, state: 'failed', current: null, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => void (running = null));
    return status();
  }

  async function confirmFreeOrigin(): Promise<FreeResult> {
    const s = status();
    const journal = readJournal(o.stateDir);
    if (running) throw new MigrationError('running', 'Ya hay un movimiento en curso.');
    if (!journal) throw new MigrationError('nothing_to_free', 'No hay un movimiento pendiente de confirmar.');
    if (!s.pointerSwitched) throw new MigrationError('not_switched', 'Primero termina de mover los datos.');
    if (s.restartRequired) throw new MigrationError('restart_required', 'Reinicia Sala y comprueba que todo se ve bien antes de liberar el origen.');
    const result = await freeOrigin(journal);
    // Anything kept (e.g. processed after the move) stays pending: running the move again picks it up.
    if (!result.kept.length) await clearJournal(o.stateDir);
    return result;
  }

  return { plan, status, start, confirmFreeOrigin, idle: async () => void (await running) };
}

export type MigrationService = ReturnType<typeof createMigrationService>;
