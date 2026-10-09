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

export interface AudioTrack {
  index: number;
  language: string | null;
  title: string | null;
}

export interface SubtitleTrack {
  index: number;
  language: string | null;
  title: string | null;
  supported: boolean;
  /** Path under /api/stream/:id/, e.g. `subs/0.vtt`; null when unsupported. */
  vtt: string | null;
}

export interface WatchProgress {
  mediaFileId: number;
  positionS: number;
  durationS: number;
  completed: boolean;
}

export interface MediaFile {
  id: number;
  status: FileState;
  episodeId: number | null;
  extraLabel: string | null;
  durationS: number | null;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
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
  progress?: WatchProgress[];
}

export interface Job {
  id: number;
  mediaFileId: number;
  status: 'queued' | 'running' | 'done' | 'error';
  /** 0..1 */
  progress: number;
  error: string | null;
}
