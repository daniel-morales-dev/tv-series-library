export interface Profile {
  id: number;
  name: string;
}

export interface TitleSummary {
  id: number;
  kind: 'movie' | 'series' | 'anime';
  title: string;
  year: number | null;
  posterPath: string | null;
}

export type FileState = 'pending' | 'processing' | 'ready' | 'error';

export interface MediaFile {
  id: number;
  status: FileState;
  episodeId: number | null;
  extraLabel: string | null;
  durationS: number | null;
}

export interface Episode {
  id: number;
  number: number;
  name: string | null;
}

export interface Season {
  id: number;
  number: number;
  name: string | null;
  episodes: Episode[];
}

export interface TitleDetail extends TitleSummary {
  overview: string | null;
  seasons: Season[];
  files: MediaFile[];
}

export interface Job {
  id: number;
  mediaFileId: number;
  status: 'queued' | 'running' | 'done' | 'error';
  /** 0..1 */
  progress: number;
  error: string | null;
}
