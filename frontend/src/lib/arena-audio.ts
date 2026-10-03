import type { SoundCue, SoundKind } from './sound-cues';

// Procedural mechanical effects: no downloads, music license or audio asset payload.
export class ArenaAudio {
  private context: AudioContext;
  private master: GainNode;
  private meter: AnalyserNode;
  private voices = new Set<AudioScheduledSourceNode>();
  constructor(onStateChange?: (running: boolean) => void) {
    const Audio =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) throw new Error('Web Audio is unavailable.');
    this.context = new Audio({ latencyHint: 'interactive' });
    this.master = this.context.createGain();
    this.meter = this.context.createAnalyser();
    this.meter.fftSize = 256;
    this.master.gain.value = 0.65;
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    this.master.connect(limiter);
    limiter.connect(this.meter);
    this.meter.connect(this.context.destination);
    this.context.onstatechange = () => onStateChange?.(this.running);
  }
  get running() {
    return this.context.state === 'running';
  }
  setVolume(value: number) {
    this.master.gain.setTargetAtTime(
      Math.max(0, Math.min(1, value)),
      this.context.currentTime,
      0.02,
    );
  }
  level() {
    const data = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  }
  async unlock(confirm = true) {
    await this.context.resume();
    if (!this.running) throw new Error('Audio is waiting for browser permission.');
    if (confirm) this.play('scan', 0, 0);
  }
  playCues(cues: SoundCue[]) {
    for (const cue of cues) this.play(cue.kind, cue.delay, cue.pan);
  }
  play(kind: SoundKind, delay = 0, pan = 0) {
    if (!this.running) return;
    const ctx = this.context,
      at = ctx.currentTime + delay;
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = pan;
    stereo.connect(this.master);
    const tone = (
      frequency: number,
      end: number,
      duration: number,
      volume: number,
      type: OscillatorType = 'sine',
      offset = 0,
    ) => {
      const source = ctx.createOscillator(),
        gain = ctx.createGain();
      source.type = type;
      source.frequency.setValueAtTime(frequency, at + offset);
      source.frequency.exponentialRampToValueAtTime(Math.max(20, end), at + offset + duration);
      gain.gain.setValueAtTime(0.001, at + offset);
      gain.gain.exponentialRampToValueAtTime(volume, at + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, at + offset + duration);
      source.connect(gain);
      gain.connect(stereo);
      this.voices.add(source);
      source.onended = () => {
        this.voices.delete(source);
        source.disconnect();
        gain.disconnect();
      };
      source.start(at + offset);
      source.stop(at + offset + duration + 0.02);
    };
    const noise = (duration: number, cutoff: number, volume: number) => {
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource(),
        filter = ctx.createBiquadFilter(),
        gain = ctx.createGain();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      gain.gain.setValueAtTime(volume, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      source.buffer = buffer;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(stereo);
      this.voices.add(source);
      source.onended = () => {
        this.voices.delete(source);
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
      source.start(at);
      source.stop(at + duration + 0.02);
    };
    if (kind === 'dig') {
      tone(1450, 350, 0.12, 0.15, 'triangle');
      tone(180, 45, 0.22, 0.18, 'triangle', 0.03);
      noise(0.17, 2200, 0.12);
    }
    if (kind === 'rattle') {
      noise(0.5, 7500, 0.17);
      tone(1850, 900, 0.2, 0.06, 'sawtooth');
    }
    if (kind === 'bite') {
      noise(0.22, 4300, 0.23);
      tone(680, 80, 0.24, 0.2, 'sawtooth');
    }
    if (kind === 'warning') {
      tone(600, 600, 0.14, 0.1, 'triangle');
      tone(480, 480, 0.15, 0.1, 'triangle', 0.23);
    }
    if (kind === 'collapse') {
      noise(1.2, 850, 0.25);
      tone(85, 25, 0.85, 0.24, 'triangle');
      noise(0.3, 2300, 0.12);
    }
    if (kind === 'step') {
      tone(120, 45, 0.18, 0.25, 'triangle');
      noise(0.1, 1500, 0.09);
    }
    if (kind === 'shot') {
      tone(850, 65, 0.28, 0.23, 'sawtooth');
      noise(0.16, 3100, 0.22);
    }
    if (kind === 'impact') {
      noise(0.42, 1900, 0.4);
      tone(170, 30, 0.38, 0.3, 'triangle');
    }
    if (kind === 'shield') {
      tone(250, 640, 0.55, 0.16, 'sine');
      tone(370, 950, 0.55, 0.09, 'sine');
    }
    if (kind === 'scan') {
      tone(850, 1000, 0.12, 0.13);
      tone(1150, 1250, 0.12, 0.1, 'sine', 0.2);
    }
    if (kind === 'charge') {
      tone(95, 460, 0.85, 0.13, 'triangle');
      tone(190, 920, 0.85, 0.06);
    }
    if (kind === 'collect' || kind === 'deposit') {
      tone(530, 620, 0.17, 0.18);
      tone(kind === 'deposit' ? 1050 : 800, 1100, 0.25, 0.14, 'sine', 0.16);
    }
    if (kind === 'defeat') {
      noise(0.9, 750, 0.38);
      tone(260, 25, 1.1, 0.25, 'sawtooth');
    }
    if (kind === 'victory')
      [330, 440, 660, 880].forEach((f, i) => tone(f, f, 0.6, 0.14, 'triangle', i * 0.15));
    window.setTimeout(() => stereo.disconnect(), (delay + 2) * 1000);
  }
  stop() {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* already ended */
      }
    }
    this.voices.clear();
  }
  async close() {
    this.stop();
    this.context.onstatechange = null;
    if (this.context.state !== 'closed') await this.context.close();
  }
}
