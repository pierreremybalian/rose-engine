import { describe, expect, it } from 'vitest';
import { Playback } from '../../src/render/playback';
import { Store } from '../../src/state/store';
import type { Toolpath } from '../../src/engine/types';

const tp = { totalSamples: 10000, samplesPerRev: 1000 } as Toolpath;

function setup(speed: number, progress = 0) {
  const store = new Store({ playback: { playing: true, speed, progress } });
  const pb = new Playback(store, () => tp);
  return { store, pb };
}

describe('Playback', () => {
  it('advances by speed × samplesPerRev × dt', () => {
    const { store, pb } = setup(2);
    pb.step(1000);
    pb.step(1050); // 50 ms
    expect(store.get().playback.progress).toBeCloseTo(2 * 1000 * 0.05);
  });

  it('caps a long frame so background tabs do not jump', () => {
    const { store, pb } = setup(1);
    pb.step(0.001);
    pb.step(5000);
    expect(store.get().playback.progress).toBeCloseTo(100); // 0.1 s max
  });

  it('stops at the end and sets playing false', () => {
    const { store, pb } = setup(50, 9990);
    pb.step(1);
    pb.step(60);
    const s = store.get().playback;
    expect(s.progress).toBe(10000);
    expect(s.playing).toBe(false);
  });

  it('speed 0 jumps to the end instantly', () => {
    const { store, pb } = setup(0);
    pb.step(1);
    expect(store.get().playback).toMatchObject({ progress: 10000, playing: false });
  });

  it('pressing play at the end restarts from 0', () => {
    const { store, pb } = setup(1, 10000);
    pb.step(1);
    expect(store.get().playback.progress).toBe(0);
    expect(store.get().playback.playing).toBe(true);
  });

  it('does nothing while paused', () => {
    const store = new Store({ playback: { playing: false, speed: 5, progress: 42 } });
    const pb = new Playback(store, () => tp);
    pb.step(1);
    pb.step(100);
    expect(store.get().playback.progress).toBe(42);
  });
});
