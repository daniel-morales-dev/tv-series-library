export interface Candidate {
  mediaFileId: number;
  titleId: number;
  /** An episode of a series or anime, not a movie. */
  episodic: boolean;
  /** The requesting profile has finished this file. */
  watched: boolean;
}

/** Unseen episodes win over watched ones; movies always stay in the pool. */
export function pickRandom(candidates: Candidate[], random: () => number = Math.random): Candidate | undefined {
  const hasUnseenEpisode = candidates.some((c) => c.episodic && !c.watched);
  const pool = hasUnseenEpisode ? candidates.filter((c) => !(c.episodic && c.watched)) : candidates;
  return pool[Math.floor(random() * pool.length)];
}
