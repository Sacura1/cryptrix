export interface SessionAudio {
  readonly running: boolean;
  unlock(confirmation?: boolean): Promise<void>;
  setVolume(value: number): void;
  stop(): void;
  play(kind: 'victory'): void;
  close(): Promise<void>;
}
type Preferences = Pick<Storage, 'getItem' | 'setItem'>;

// One audio context for the whole visit, including navigation into a lazy-loaded match.
export class GameAudioSession<T extends SessionAudio> {
  audio: T | null = null;
  private listeners = new Set<() => void>();
  private snapshot = { enabled: true, ready: false, volume: 0.65, error: '' };
  private factory: (onStateChange: (running: boolean) => void) => T;
  private preferences?: Preferences;
  constructor(
    factory: (onStateChange: (running: boolean) => void) => T,
    preferences?: Preferences,
  ) {
    this.factory = factory;
    this.preferences = preferences;
    try {
      this.snapshot.enabled = preferences?.getItem('cryptrix.sound') !== 'off';
      const stored = preferences?.getItem('cryptrix.volume');
      const volume = stored === null || stored === undefined ? 0.65 : Number(stored);
      this.snapshot.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.65;
    } catch {
      /* Storage is optional. */
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<typeof this.snapshot>) {
    if (
      Object.entries(change).every(
        ([key, value]) => this.snapshot[key as keyof typeof this.snapshot] === value,
      )
    )
      return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  private save(key: string, value: string) {
    try {
      this.preferences?.setItem(key, value);
    } catch {
      /* Storage is optional. */
    }
  }
  async activate(confirmation = false) {
    if (!this.snapshot.enabled) return;
    try {
      if (!this.audio) this.audio = this.factory((ready) => this.update({ ready }));
      const instance = this.audio;
      instance.setVolume(this.snapshot.volume);
      await instance.unlock(confirmation);
      // A pending browser resume must not undo a mute chosen meanwhile.
      if (!this.snapshot.enabled) {
        instance.stop();
        instance.setVolume(0);
      }
      this.update({ ready: instance.running, error: '' });
    } catch {
      this.update({
        ready: false,
        error: confirmation ? 'Sound could not start. Tap Test sound to retry.' : '',
      });
    }
  }
  toggle = () => {
    if (this.snapshot.enabled && this.snapshot.ready) {
      this.update({ enabled: false });
      this.save('cryptrix.sound', 'off');
      this.audio?.stop();
      this.audio?.setVolume(0);
    } else {
      this.update({ enabled: true });
      this.save('cryptrix.sound', 'on');
      void this.activate(true);
    }
  };
  setVolume = (value: number) => {
    const volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.65;
    this.update({ volume });
    this.save('cryptrix.volume', String(volume));
    this.audio?.setVolume(this.snapshot.enabled ? volume : 0);
  };
  testSound = async () => {
    this.update({ enabled: true });
    this.save('cryptrix.sound', 'on');
    if (!this.snapshot.volume) this.setVolume(0.65);
    await this.activate(true);
    if (this.audio?.running && this.snapshot.enabled) this.audio.play('victory');
  };
}

export function installAudioActivation(
  target: EventTarget,
  session: Pick<GameAudioSession<SessionAudio>, 'activate' | 'getSnapshot'>,
  isAudioControl: (target: EventTarget | null) => boolean = () => false,
) {
  const gesture = (event: Event) => {
    if (isAudioControl(event.target)) return;
    const state = session.getSnapshot();
    if (state.enabled && !state.ready) void session.activate();
  };
  // Click/pointerup also cover touch browsers that don't unlock on pointerdown.
  const events = ['pointerdown', 'pointerup', 'click', 'keydown'];
  for (const type of events) target.addEventListener(type, gesture, true);
  void session.activate();
  return () => {
    for (const type of events) target.removeEventListener(type, gesture, true);
  };
}
