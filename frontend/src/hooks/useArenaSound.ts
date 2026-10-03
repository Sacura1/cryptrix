import { useEffect, useRef, useState } from 'react';
import { ArenaAudio } from '../lib/arena-audio';
import { soundCues } from '../lib/sound-cues';
import type { State, TurnAction } from '../types';

export function useArenaSound(
  key: string,
  active: boolean,
  state?: State | null,
  actions?: Record<string, TurnAction>,
  events?: string[],
  complete = false,
) {
  const engine = useRef<ArenaAudio | null>(null),
    last = useRef(''),
    result = useRef('');
  const [enabled, setEnabled] = useState(false),
    [error, setError] = useState('');
  const toggle = async () => {
    if (enabled) {
      engine.current?.stop();
      setEnabled(false);
      return;
    }
    try {
      engine.current ??= new ArenaAudio();
      await engine.current.unlock();
      setEnabled(true);
      setError('');
    } catch {
      setError('Audio is unavailable in this browser.');
    }
  };
  useEffect(() => {
    if (!enabled || !active || !state || document.hidden) {
      engine.current?.stop();
      return;
    }
    if (last.current === key) return;
    last.current = key;
    engine.current?.stop();
    engine.current?.playCues(soundCues(state, actions, events));
  }, [key, enabled, active, state, actions, events]);
  useEffect(() => {
    if (enabled && complete && result.current !== key && !document.hidden) {
      result.current = key;
      engine.current?.play('victory', active ? 3.4 : 0);
    }
  }, [enabled, complete, key, active]);
  useEffect(() => {
    const silence = () => {
      if (document.hidden) engine.current?.stop();
    };
    document.addEventListener('visibilitychange', silence);
    return () => {
      document.removeEventListener('visibilitychange', silence);
      void engine.current?.close();
      engine.current = null;
    };
  }, []);
  return { enabled, toggle, error };
}
