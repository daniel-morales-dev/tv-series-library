export interface Profile {
  id: number;
  name: string;
  avatar: string | null;
}

export interface TitleSummary {
  id: number;
  kind: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle: string | null;
  overview: string | null;
  year: number | null;
  runtimeMin: number | null;
  rating: number | null;
  genres: string[];
  posterPath: string | null;
  backdropPath: string | null;
  logoPath: string | null;
}

export interface ContinueItem {
  title: TitleSummary;
  mediaFileId: number;
  positionS: number;
  durationS: number | null;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
  episodeId: number | null;
  stillPath: string | null;
  updatedAt: string;
}

export interface Suggestion {
  type: 'title' | 'person';
  id: number;
  label: string;
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
  overview: string | null;
  runtimeMin: number | null;
  stillPath: string | null;
  /** ISO date `YYYY-MM-DD`. */
  airDate: string | null;
}

export interface Season {
  id: number;
  number: number;
  name: string | null;
  episodes: Episode[];
}

export interface Credit {
  personId: number;
  name: string;
  profilePath: string | null;
  role: 'cast' | 'director';
  character: string | null;
}

export interface TitleDetail extends TitleSummary {
  seasons: Season[];
  files: MediaFile[];
  credits: Credit[];
  inMyList?: boolean;
  finished?: boolean;
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
