// T21: resource budget derived from the hardware and the environment, so a Raspberry Pi and a big PC
// size themselves without per-machine numbers. Pure: hardware.ts does the probing.

export interface Hardware {
  /** Logical CPUs (respects affinity, capped by the cgroup quota when there is one). */
  cores: number;
  memAvailableMb: number;
  /** One entry per volume; `null` = unknown type (treated as rotational, like a slow SD card). */
  rotational: (boolean | null)[];
}

export interface BudgetConfig {
  /** Fraction of the logical CPUs the processing may use (PROCESS_CPU_SHARE). */
  cpuShare: number;
  /** Hard cap on parallel jobs (PROCESS_MAX_JOBS). */
  maxJobs: number;
  ramPerJobMb: number;
  ramReserveMb: number;
  io: 'auto' | 'ssd' | 'hdd';
  /** PROCESS_CONCURRENCY: a fixed job count wins over every derived limit. */
  concurrency: number | null;
  /** FFMPEG_THREADS: fixed threads per job. */
  threads: number | null;
}

export interface Budget {
  jobs: number;
  threadsPerJob: number;
  /** How many jobs the RAM alone could host (0 when not even one fits); the play slot needs jobs + 1. */
  ramJobs: number;
  limitedBy: 'cpu' | 'ram' | 'io' | 'env';
  reason: string;
}

const MIN_THREADS = 4;
// Provisional until the T21d benchmark: 1 job keeps today's 1xN sizing on every machine.
export const DEFAULT_MAX_JOBS = 1;

const positiveInt = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function budgetConfigFromEnv(env: Record<string, string | undefined>): BudgetConfig {
  const share = Number(env.PROCESS_CPU_SHARE);
  const reserve = Number(env.PROCESS_RAM_RESERVE_MB);
  return {
    cpuShare: Number.isFinite(share) && share > 0 ? Math.min(share, 1) : 0.5,
    maxJobs: positiveInt(env.PROCESS_MAX_JOBS) ?? DEFAULT_MAX_JOBS,
    ramPerJobMb: positiveInt(env.PROCESS_RAM_PER_JOB_MB) ?? 1200,
    ramReserveMb: Number.isFinite(reserve) && reserve >= 0 ? reserve : 1536,
    io: env.PROCESS_IO === 'ssd' || env.PROCESS_IO === 'hdd' ? env.PROCESS_IO : 'auto',
    concurrency: positiveInt(env.PROCESS_CONCURRENCY),
    threads: positiveInt(env.FFMPEG_THREADS),
  };
}

export function computeBudget(hw: Hardware, cfg: BudgetConfig): Budget {
  const cores = Math.max(1, Math.floor(hw.cores));
  const cpuBudget = Math.max(1, Math.floor(cores * cfg.cpuShare));
  const ramJobs = Math.max(0, Math.floor((hw.memAvailableMb - cfg.ramReserveMb) / cfg.ramPerJobMb));
  // A rotational or unknown volume takes one job; an unknown type only stops limiting when PROCESS_IO overrides it.
  const jobsIo = cfg.io === 'hdd' || (cfg.io === 'auto' && hw.rotational.some((r) => r !== false)) ? 1 : Infinity;
  const jobsCpu = Math.min(Math.max(Math.floor(cpuBudget / MIN_THREADS), 1), Math.max(1, cfg.maxJobs));

  if (cfg.concurrency !== null) {
    const threadsPerJob = cfg.threads ?? Math.max(1, Math.floor(cpuBudget / cfg.concurrency));
    return {
      jobs: cfg.concurrency,
      threadsPerJob,
      ramJobs,
      limitedBy: 'env',
      reason: `concurrencia fijada por PROCESS_CONCURRENCY: ${cfg.concurrency} job(s) × ${threadsPerJob} hilos`,
    };
  }

  const jobs = Math.max(1, Math.min(jobsCpu, ramJobs, jobsIo));
  const threadsPerJob = cfg.threads ?? Math.max(1, Math.floor(cpuBudget / jobs));
  const limitedBy = jobsCpu <= ramJobs && jobsCpu <= jobsIo ? 'cpu' : ramJobs <= jobsIo ? 'ram' : 'io';
  const reason =
    limitedBy === 'ram'
      ? `límite de memoria: solo caben ${ramJobs} job(s) en ${hw.memAvailableMb} MB disponibles`
      : limitedBy === 'io'
        ? 'límite de almacenamiento: un solo job sobre un volumen rotacional o de tipo desconocido'
        : `presupuesto de CPU: ${jobs} job(s) × ${threadsPerJob} hilos de ${cpuBudget} en total`;
  return { jobs, threadsPerJob, ramJobs, limitedBy, reason };
}
