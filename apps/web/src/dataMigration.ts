// T47e: view logic of the "mover datos con la biblioteca" settings section.

export interface DataPlan {
  from: string;
  to: string;
  method: 'link' | 'copy';
  pendingCount: number;
  movedCount: number;
  pendingBytes: number;
  totalBytes: number;
  freeBytes: number;
  requiredBytes: number;
  fits: boolean;
}

export interface DataStatus {
  job: { state: 'idle' | 'running' | 'completed' | 'failed'; done: number; total: number; bytesDone: number; bytesTotal: number; current: string | null; error: string | null };
  pointerSwitched: boolean;
  restartRequired: boolean;
  canFreeOrigin: boolean;
  alreadyThere: boolean;
}

export interface MigrationView {
  stage: 'loading' | 'done' | 'running' | 'failed' | 'restart' | 'free' | 'nospace' | 'ready' | 'idle';
  lines: string[];
  /** 0-100 while running, else null. */
  progress: number | null;
  canStart: boolean;
  canFree: boolean;
}

const GB = 1024 ** 3;
export const formatGb = (bytes: number) => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;

/** Plan load state: undefined while the fetch is in flight, null when it failed, else the plan. */
export type PlanState = DataPlan | null | undefined;

export function migrationView(plan: PlanState, status: DataStatus): MigrationView {
  const view = (stage: MigrationView['stage'], lines: string[], extra: Partial<MigrationView> = {}): MigrationView => ({
    stage, lines, progress: null, canStart: false, canFree: false, ...extra,
  });
  const { job } = status;
  if (job.state === 'running') {
    const progress = job.bytesTotal > 0 ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100)) : 0;
    return view('running', [`Moviendo: ${job.done} de ${job.total} paquetes (${formatGb(job.bytesDone)} de ${formatGb(job.bytesTotal)}).`], { progress });
  }
  if (status.canFreeOrigin) {
    return view('free', ['Todo está verificado y Sala ya lee de la biblioteca. Si comprobaste que se ve bien, puedes liberar el espacio del origen (no se puede deshacer).'], { canFree: true });
  }
  if (status.pointerSwitched && status.restartRequired) {
    return view('restart', ['Los datos ya están copiados y verificados. Reinicia Sala (en la terminal: sala restart), comprueba que todo se ve bien y vuelve aquí para liberar el origen.']);
  }
  if (status.alreadyThere) return view('done', ['Los datos de video ya están junto a la biblioteca.']);
  if (plan === undefined) return view('loading', ['Calculando el plan…']);
  if (plan === null) return view('idle', ['No se pudo calcular el plan: revisa que el disco de la biblioteca esté conectado.']);

  const method = plan.method === 'link' ? 'Misma partición: se usan enlaces y no ocupa espacio extra.' : 'Otra partición: se copia cada paquete y se verifica.';
  const lines = [
    `Destino: ${plan.to}`,
    `${plan.pendingCount} paquetes (${formatGb(plan.pendingBytes)}) por mover${plan.movedCount ? `, ${plan.movedCount} ya movidos` : ''}.`,
    method,
    `Espacio en el destino: ${formatGb(plan.freeBytes)} libres${plan.requiredBytes ? `, hacen falta ${formatGb(plan.requiredBytes)}` : ''}.`,
  ];
  if (job.state === 'failed') {
    return view('failed', [`Se interrumpió: ${job.error ?? 'error desconocido'}. El origen sigue intacto; puedes reanudar.`, ...lines], { canStart: plan.fits && plan.pendingCount > 0 });
  }
  if (plan.pendingCount === 0) return view('idle', ['No hay paquetes por mover.', ...lines]);
  if (!plan.fits) return view('nospace', ['No hay espacio suficiente en el destino. No se moverá nada.', ...lines]);
  return view('ready', lines, { canStart: true });
}
