import type { DatabaseSync } from 'node:sqlite';
import { all, get, run } from '../../db/sql.ts';

export interface Profile {
  id: number;
  name: string;
  avatar: string | null;
  theme: 'dark' | 'light';
  preferredAudioLang: string | null;
  preferredSubtitleLang: string | null;
  createdAt: string;
}

export interface ProfileInput {
  name?: string;
  avatar?: string | null;
  theme?: 'dark' | 'light';
  preferredAudioLang?: string | null;
  preferredSubtitleLang?: string | null;
}

interface ProfileRow {
  id: number;
  name: string;
  avatar: string | null;
  theme: 'dark' | 'light';
  preferred_audio_lang: string | null;
  preferred_subtitle_lang: string | null;
  created_at: string;
}

const COLUMNS: Record<keyof ProfileInput, string> = {
  name: 'name',
  avatar: 'avatar',
  theme: 'theme',
  preferredAudioLang: 'preferred_audio_lang',
  preferredSubtitleLang: 'preferred_subtitle_lang',
};

const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  name: r.name,
  avatar: r.avatar,
  theme: r.theme,
  preferredAudioLang: r.preferred_audio_lang,
  preferredSubtitleLang: r.preferred_subtitle_lang,
  createdAt: r.created_at,
});

export function listProfiles(db: DatabaseSync): Profile[] {
  return all<ProfileRow>(db, 'SELECT * FROM profiles ORDER BY id').map(toProfile);
}

export function getProfile(db: DatabaseSync, id: number): Profile | undefined {
  const row = get<ProfileRow>(db, 'SELECT * FROM profiles WHERE id = ?', id);
  return row && toProfile(row);
}

export function profileExists(db: DatabaseSync, id: number): boolean {
  return get(db, 'SELECT 1 AS x FROM profiles WHERE id = ?', id) !== undefined;
}

export function createProfile(db: DatabaseSync, input: ProfileInput & { name: string }): Profile {
  const keys = (Object.keys(input) as (keyof ProfileInput)[]).filter((k) => input[k] !== undefined);
  const { lastInsertId } = run(
    db,
    `INSERT INTO profiles (${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => input[k] ?? null),
  );
  return getProfile(db, lastInsertId)!;
}

export function updateProfile(db: DatabaseSync, id: number, input: ProfileInput): Profile | undefined {
  const keys = (Object.keys(input) as (keyof ProfileInput)[]).filter((k) => input[k] !== undefined);
  if (keys.length > 0) {
    const set = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
    run(db, `UPDATE profiles SET ${set} WHERE id = ?`, ...keys.map((k) => input[k] ?? null), id);
  }
  return getProfile(db, id);
}

export function deleteProfile(db: DatabaseSync, id: number): boolean {
  return run(db, 'DELETE FROM profiles WHERE id = ?', id).changes > 0;
}
