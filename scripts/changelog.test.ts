import { describe, expect, it } from 'vitest';
import { bumpFor, changelogFor, mergeChangelog, nextVersion, parseCommits } from './changelog.mjs';

const record = (sha: string, subject: string, body = '') => [sha, subject, body].join('\x1f');
const log = (...rows: string[]) => rows.join('\x1e');
const of = (...subjects: string[]) => parseCommits(log(...subjects.map((s, i) => record(`s${i}`, s))));

describe('parseCommits', () => {
  it('separa tipo, scope y texto', () => {
    const [c] = parseCommits(log(record('abc1234', 'feat(player): add 2x speed')));
    expect(c).toMatchObject({
      sha: 'abc1234',
      type: 'feat',
      scope: 'player',
      text: 'add 2x speed',
      breaking: false,
    });
  });

  it('marca breaking con ! y con BREAKING CHANGE en el cuerpo', () => {
    const commits = parseCommits(
      log(
        record('aaa1111', 'feat(api)!: drop v1'),
        record('bbb2222', 'fix(db): migrate', 'BREAKING CHANGE: la tabla cambia de forma'),
      ),
    );
    expect(commits.map((c) => c.breaking)).toEqual([true, true]);
  });

  it('no rompe con un commit que no sigue Conventional Commits', () => {
    const [c] = parseCommits(log(record('ccc3333', 'arreglo rapido')));
    expect(c).toMatchObject({ type: null, scope: null, text: 'arreglo rapido', breaking: false });
  });
});

describe('bumpFor', () => {
  it('feat sube minor', () => {
    expect(bumpFor(of('feat: a'))).toBe('minor');
  });

  it('fix y perf suben patch', () => {
    expect(bumpFor(of('fix: a'))).toBe('patch');
    expect(bumpFor(of('perf: a'))).toBe('patch');
  });

  it('breaking sube major aunque haya feat', () => {
    expect(bumpFor(of('feat: a', 'fix(b)!: b'))).toBe('major');
  });

  it('docs, ci y chore no publican solos', () => {
    expect(bumpFor(of('docs: a', 'ci: b', 'chore: c'))).toBeNull();
  });
});

describe('nextVersion', () => {
  it('respeta el salto pedido', () => {
    expect(nextVersion('0.6.0', 'patch')).toBe('0.6.1');
    expect(nextVersion('0.6.0', 'minor')).toBe('0.7.0');
    expect(nextVersion('0.6.0', 'major')).toBe('1.0.0');
  });
});

describe('changelogFor', () => {
  const commits = parseCommits(
    log(
      record('aaa1111', 'feat(player): add 2x speed'),
      record('bbb2222', 'fix(ingest): place pending episodes'),
      record('ccc3333', 'docs(readme): add screenshots'),
      record('ddd4444', 'ci(macos): check the language branch'),
      record('eee5555', 'chore: limpieza'),
    ),
  );

  it('agrupa por tipo y omite los grupos vacios', () => {
    const md = changelogFor(commits, { version: '0.7.0' });
    expect(md).toContain('### Features');
    expect(md).toContain('### Bug Fixes');
    expect(md).toContain('### Documentation');
    expect(md).toContain('### CI');
    expect(md).toContain('### Maintenance');
    expect(md).not.toContain('### Performance');
    expect(md).not.toContain('Breaking changes');
  });

  it('incluye el scope y el sha corto', () => {
    expect(changelogFor(commits, { version: '0.7.0' })).toContain(
      '- **player:** add 2x speed (`aaa1111`)',
    );
  });

  it('lista los breaking aparte, sin repetirlos en su grupo', () => {
    const md = changelogFor(parseCommits(log(record('fff6666', 'feat(api)!: drop v1'))), {
      version: '1.0.0',
    });
    expect(md).toContain('### ⚠️ Breaking changes');
    expect(md).not.toContain('### Features');
    expect(md.match(/drop v1/g)).toHaveLength(1);
  });

  it('agrega el enlace de comparacion cuando hay repo y tag previo', () => {
    const md = changelogFor(commits, { version: '0.7.0', previous: 'v0.6.0', repo: 'o/r' });
    expect(md).toContain('https://github.com/o/r/compare/v0.6.0...v0.7.0');
  });
});

describe('mergeChangelog', () => {
  const section = '## 0.7.0\n\n### Features\n- add 2x speed (`abc1111`)\n';

  it('crea el archivo con encabezado cuando no existe', () => {
    const out = mergeChangelog('', section);
    expect(out.startsWith('# Changelog')).toBe(true);
    expect(out).toContain(section);
  });

  it('antepone la seccion nueva y conserva las anteriores', () => {
    const existing = '# Changelog\n\nIntro.\n\n## 0.6.1\n\n### Bug Fixes\n- old (`1111111`)\n';
    const out = mergeChangelog(existing, section);
    expect(out.indexOf('## 0.7.0')).toBeLessThan(out.indexOf('## 0.6.1'));
    expect(out).toContain('- old (`1111111`)');
    expect(out).toContain('Intro.');
    expect(out.match(/# Changelog/g)).toHaveLength(1);
  });

  it('agrega al final si el archivo no tiene secciones previas', () => {
    const out = mergeChangelog('# Changelog\n\nIntro.\n', section);
    expect(out).toContain('Intro.');
    expect(out).toContain(section);
  });
});
