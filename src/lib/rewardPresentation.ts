export function getLandingRewards<T extends { id?: string; contentType?: string }>(catalog: readonly T[]): T[] {
  return catalog.filter((reward) => reward.id !== "youtube-shorts" && reward.contentType !== "youtube_short");
}
