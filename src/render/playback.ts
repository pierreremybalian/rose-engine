// Playback clock: advances store.playback.progress at speed (revs/sec) × samplesPerRev.
import type { Toolpath } from '../engine/types';
import type { Store } from '../state/store';

/** Longest frame step we integrate (s), so a background tab doesn't jump the pen. */
const MAX_DT = 0.1;

export class Playback {
  private raf = 0;
  private last = 0;
  private running = false;
  private wasPlaying = false;

  constructor(
    private readonly store: Store,
    private readonly getToolpath: () => Toolpath | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.wasPlaying = false;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** One clock step; exposed for tests. `now` in ms. */
  step(now: number): void {
    const st = this.store.get();
    const pb = st.playback;
    const dt = this.last ? Math.min(MAX_DT, Math.max(0, (now - this.last) / 1000)) : 0;
    this.last = now;
    if (!pb.playing) {
      this.wasPlaying = false;
      return;
    }
    const tp = this.getToolpath();
    if (!tp || tp.totalSamples <= 0) return;
    const total = tp.totalSamples;
    let progress = pb.progress;
    // pressing play at the end starts over
    if (!this.wasPlaying && progress >= total) progress = 0;
    this.wasPlaying = true;
    if (pb.speed <= 0) {
      this.store.set({ playback: { ...pb, progress: total, playing: false } });
      this.wasPlaying = false;
      return;
    }
    progress += pb.speed * tp.samplesPerRev * dt;
    if (progress >= total) {
      this.store.set({ playback: { ...pb, progress: total, playing: false } });
      this.wasPlaying = false;
      return;
    }
    if (progress !== pb.progress) this.store.set({ playback: { ...pb, progress } });
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    this.step(now);
  };
}
