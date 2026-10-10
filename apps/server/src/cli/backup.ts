// ExecStartPre of sala.service: verified SQLite snapshot before the server opens the database.
// @ts-expect-error scripts/dev.mjs is untyped JS shared with the dev launcher
import { backupLibrary } from '../../../../scripts/dev.mjs';

const dataDir = process.env.DATA_DIR ?? './data';
const path: string | undefined = await backupLibrary(dataDir);
console.log(path ? `SQLite backup verified: ${path}` : 'No library.db yet: nothing to back up');
