/** iPhone/iPad, including iPadOS 13+ which reports itself as a Mac with a touch screen. */
export function isIOS(ua: string, platform: string, touchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
}

/** Phones and tablets, where the player should go fullscreen/landscape on play. */
export function isMobile(ua: string, platform: string, touchPoints: number): boolean {
  return isIOS(ua, platform, touchPoints) || /Android|Mobile/.test(ua);
}

/** iOS ignores writes to `video.volume` (the hardware buttons own it), so write a value and read it back. */
export function volumeWritable(el: { volume: number }): boolean {
  const prev = el.volume;
  el.volume = prev > 0.5 ? 0.25 : 0.75;
  const ok = el.volume !== prev;
  el.volume = prev;
  return ok;
}

/** iPhone uses the native player (approved T43); everything else keeps our controls on the container. */
export function fullscreenMode(ios: boolean): 'native' | 'container' {
  return ios ? 'native' : 'container';
}
