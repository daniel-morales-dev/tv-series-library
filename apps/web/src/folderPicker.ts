export interface DirEntry { name: string; path: string }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[]; shortcuts: DirEntry[] }

/** Breadcrumb links for an absolute POSIX path, root first. */
export function crumbs(path: string): DirEntry[] {
  const out: DirEntry[] = [{ name: 'Raíz', path: '/' }];
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** Where the picker opens: the typed path if absolute, else undefined (server answers with home). */
export function startPath(typed: string): string | undefined {
  const value = typed.trim();
  return value.startsWith('/') ? value : undefined;
}

const MESSAGES: Record<string, string> = {
  not_found: 'Esa carpeta no existe.',
  not_directory: 'Esa ruta es un archivo, no una carpeta.',
  forbidden: 'No hay permiso para abrir esa carpeta.',
  invalid_path: 'Escribe la ruta completa de la carpeta (por ejemplo C:\\Users\\tu-usuario\\Videos\\Sala o /home/tu-usuario/Videos/Sala).',
};

export function pickerError(code: string): string {
  return MESSAGES[code] ?? 'No se pudo leer esa carpeta. Intenta de nuevo.';
}
