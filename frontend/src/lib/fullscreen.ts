export type ScreenMode = 'window' | 'native' | 'expanded';
export async function enterGameFullscreen(element: HTMLElement): Promise<ScreenMode> {
  try {
    if (!element.requestFullscreen) return 'expanded';
    await element.requestFullscreen();
    return document.fullscreenElement === element ? 'native' : 'expanded';
  } catch {
    return 'expanded';
  }
}
export async function leaveGameFullscreen() {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch {
      /* still offer the on-page exit control */
    }
  }
  return !document.fullscreenElement;
}
