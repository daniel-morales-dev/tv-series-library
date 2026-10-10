// ExecStartPre of sala.service: verified SQLite snapshot before the server opens the database.
// @ts-expect-error scripts/dev.mjs is untyped JS shared with the dev launcher
import { backupLibrary, checkPort } from '../../../../scripts/dev.mjs';

const dataDir = process.env.DATA_DIR ?? './data';
const port = Number(process.env.PORT ?? 8080);

// A busy port means the server cannot start: fail here so neither a backup nor the server touches the database.
try {
  await checkPort(port);
} catch {
  console.error(`El puerto ${port} esta ocupado (otro proceso, p. ej. npm run dev): no se hizo copia ni se inicia el servidor.`);
  process.exit(1);
}

const path: string | undefined = await backupLibrary(dataDir, { minAgeMs: 10 * 60_000 });
console.log(path ? `SQLite backup verified: ${path}` : 'No library.db yet: nothing to back up');
