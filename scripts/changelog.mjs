#!/usr/bin/env node
// Genera el changelog de una release a partir de los Conventional Commits.
//
// Uso:
//   node scripts/changelog.mjs --since v0.6.0 --notes-file /tmp/notes.md --repo owner/name
//   node scripts/changelog.mjs --since v0.6.0 --force-version 0.7.0 --notes-file /tmp/notes.md
//
// Escribe el changelog en --notes-file e imprime en stdout la version a publicar.
// Si ningun commit amerita release, no imprime nada y sale con 0.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Que tipo de commit produce que salto de version. docs/ci/chore/refactor no publican
// release por si solos: aparecen en el changelog de la proxima que si lo amerite.
const RELEASE_BUMP = { feat: 'minor', fix: 'patch', perf: 'patch' };

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['docs', 'Documentation'],
  ['ci', 'CI'],
];
const MAINTENANCE = 'Maintenance';

export const parseCommits = (raw) =>
  raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f');
      const match = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(subject);
      return {
        sha: sha.trim(),
        type: match ? match[1].toLowerCase() : null,
        scope: match?.[2] ?? null,
        text: match ? match[4].trim() : subject.trim(),
        breaking: Boolean(match?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
      };
    });

export const bumpFor = (commits) => {
  if (commits.some((c) => c.breaking)) return 'major';
  for (const bump of ['minor', 'patch']) {
    if (commits.some((c) => RELEASE_BUMP[c.type] === bump)) return bump;
  }
  return null;
};

export const nextVersion = (current, bump) => {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

export const changelogFor = (commits, { version, previous = null, repo = null } = {}) => {
  const item = (c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.text} (\`${c.sha}\`)`;
  const parts = [version ? `## ${version}` : '## Cambios'];

  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) parts.push(['### ⚠️ Breaking changes', ...breaking.map(item)].join('\n'));

  for (const [type, title] of SECTIONS) {
    const hits = commits.filter((c) => c.type === type && !c.breaking);
    if (hits.length) parts.push([`### ${title}`, ...hits.map(item)].join('\n'));
  }

  const known = new Set(SECTIONS.map(([type]) => type));
  const rest = commits.filter((c) => !c.breaking && !known.has(c.type));
  if (rest.length) parts.push([`### ${MAINTENANCE}`, ...rest.map(item)].join('\n'));

  if (repo && previous) {
    parts.push(`**Full diff**: https://github.com/${repo}/compare/${previous}...${version ? `v${version}` : 'HEAD'}`);
  }
  return `${parts.join('\n\n')}\n`;
};

const main = () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(`--${name}`);
    return at > -1 ? args[at + 1] : null;
  };

  const since = flag('since');
  const force = flag('force-version');
  const notesFile = flag('notes-file');
  if (!notesFile) throw new Error('falta --notes-file <ruta>');

  const raw = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', since ? `${since}..HEAD` : 'HEAD'],
    { encoding: 'utf8' },
  );
  const commits = parseCommits(raw);
  const base = since ? since.replace(/^v/, '') : '0.0.0';
  const version = force || (bumpFor(commits) ? nextVersion(base, bumpFor(commits)) : null);

  if (!version) {
    console.error(`Sin feat/fix desde ${since ?? 'el inicio del historial'}: no amerita release.`);
    return;
  }
  writeFileSync(notesFile, changelogFor(commits, { version, previous: since, repo: flag('repo') }));
  process.stdout.write(`${version}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
