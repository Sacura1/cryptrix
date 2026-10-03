import { ArenaAudio } from './arena-audio';
import { GameAudioSession, installAudioActivation } from './audio-session';

let preferences: Storage | undefined;
try {
  preferences = localStorage;
} catch {
  /* Preferences are optional. */
}
export const gameAudio = new GameAudioSession(
  (onStateChange) => new ArenaAudio(onStateChange),
  preferences,
);
export function installGameAudio() {
  return installAudioActivation(
    document,
    gameAudio,
    (target) => target instanceof Element && !!target.closest('[data-audio-action]'),
  );
}
