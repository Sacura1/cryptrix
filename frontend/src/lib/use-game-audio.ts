import { useEffect, useRef, useSyncExternalStore } from 'react';
import { gameAudio } from './browser-audio';

export function useGameAudio() {
  const state = useSyncExternalStore(gameAudio.subscribe, gameAudio.getSnapshot);
  const audio = useRef(gameAudio.audio);
  audio.current = gameAudio.audio;
  useEffect(() => {
    void gameAudio.activate();
    // Cancel lingering effects when leaving a match, but retain the unlocked context.
    return () => gameAudio.audio?.stop();
  }, []);
  return {
    audio,
    ...state,
    setVolume: gameAudio.setVolume,
    toggle: gameAudio.toggle,
    testSound: gameAudio.testSound,
  };
}
