import { describe, expect, it } from 'vitest';
import { EngineSound, type EngineVoiceInput } from '@/render/enginesound.js';

/**
 * The WebAudio graph, against a fake context.
 *
 * A browser test can only tell you an engine sounds wrong by ear, and a unit
 * test cannot listen. What it *can* check is everything structural: that a car
 * gets exactly one voice, that a rival is panned and the local car is not,
 * that the note tracks speed and the Doppler shift, and that a voice is torn
 * down when its car leaves. Those are the failures that would otherwise show
 * up as a silent race or a leaking oscillator.
 */

class FakeParam {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(target: number): void {
    // The fake settles instantly; the real one is a smoothing filter, and the
    // difference does not matter to anything asserted here.
    this.value = target;
  }
}

class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  connect(target: FakeNode): FakeNode {
    this.connections.push(target);
    return target;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}

class FakePanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'linear';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  positionX = new FakeParam(0);
  positionY = new FakeParam(0);
  positionZ = new FakeParam(0);
}

class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  listener = {
    positionX: new FakeParam(0),
    positionY: new FakeParam(0),
    positionZ: new FakeParam(0),
    forwardX: new FakeParam(0),
    forwardY: new FakeParam(0),
    forwardZ: new FakeParam(-1),
    upX: new FakeParam(0),
    upY: new FakeParam(1),
    upZ: new FakeParam(0),
  };

  oscillators: FakeOscillator[] = [];
  panners: FakePanner[] = [];
  gains: FakeGain[] = [];

  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createPanner(): FakePanner {
    const node = new FakePanner();
    this.panners.push(node);
    return node;
  }
}

function makeEngine(ctx: FakeContext): EngineSound {
  return new EngineSound(ctx as unknown as AudioContext, { topSpeed: 27, engineAccel: 22 });
}

const listener = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vz: 0,
  forwardX: 0,
  forwardZ: 1,
};

function car(overrides: Partial<EngineVoiceInput> & { id: string }): EngineVoiceInput {
  return { x: 0, y: 0, z: 0, vx: 0, vz: 0, isLocal: false, ...overrides };
}

/** Fundamental of the voice created nth, after the harmonics below it. */
function fundamentalOf(ctx: FakeContext, voiceIndex: number): number {
  // Three oscillators per voice, and the fundamental is the second of them.
  return ctx.oscillators[voiceIndex * 3 + 1]!.frequency.value;
}

describe('engine graph', () => {
  it('builds one voice per audible car and starts it', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    engine.update([car({ id: 'a', isLocal: true }), car({ id: 'b', z: 10 })], listener, 1 / 60);

    expect(ctx.oscillators).toHaveLength(6);
    expect(ctx.oscillators.every((osc) => osc.started)).toBe(true);
    expect(ctx.oscillators.every((osc) => osc.type === 'sawtooth')).toBe(true);
  });

  it('reuses a voice rather than stacking a new one every frame', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    for (let i = 0; i < 30; i++) {
      engine.update([car({ id: 'a', isLocal: true })], listener, 1 / 60);
    }
    expect(ctx.oscillators).toHaveLength(3);
  });

  it('pans rivals but not the car you are sitting in', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    engine.update([car({ id: 'me', isLocal: true }), car({ id: 'them', x: 8 })], listener, 1 / 60);

    // Exactly one panner: your own engine has no direction to come from.
    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0]!.panningModel).toBe('HRTF');
  });

  it('places a rival on the correct side, with the scene handedness undone', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    engine.update([car({ id: 'them', x: 12, z: 5 })], listener, 1 / 60);

    const panner = ctx.panners[0]!;
    expect(panner.positionX.value).toBeCloseTo(12, 6);
    // The scene is left-handed and WebAudio is not, so z flips on the way.
    expect(panner.positionZ.value).toBeCloseTo(-5, 6);
    expect(ctx.listener.forwardZ.value).toBeCloseTo(-1, 6);
  });

  it('drops a car that has left the race', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    engine.update([car({ id: 'a', isLocal: true }), car({ id: 'b', z: 10 })], listener, 1 / 60);
    engine.update([car({ id: 'a', isLocal: true })], listener, 1 / 60);

    const stopped = ctx.oscillators.filter((osc) => osc.stopped);
    expect(stopped).toHaveLength(3);
  });

  it('ignores a car on the far side of the circuit', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    engine.update([car({ id: 'a', isLocal: true }), car({ id: 'far', z: 400 })], listener, 1 / 60);
    expect(ctx.panners).toHaveLength(0);
  });

  it('caps how many rivals sound at once', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);

    const field = [car({ id: 'me', isLocal: true })];
    for (let i = 0; i < 20; i++) field.push(car({ id: `r${i}`, z: 5 + i }));
    engine.update(field, listener, 1 / 60);

    // HRTF is not free and a phone is the primary target.
    expect(ctx.panners.length).toBeLessThanOrEqual(6);
  });

  it('revs higher as the car speeds up', () => {
    const idle = new FakeContext();
    makeEngine(idle).update([car({ id: 'a', isLocal: true })], listener, 1 / 60);

    const moving = new FakeContext();
    makeEngine(moving).update([car({ id: 'a', isLocal: true, vz: 8 })], listener, 1 / 60);

    expect(fundamentalOf(moving, 0)).toBeGreaterThan(fundamentalOf(idle, 0));
  });

  it('shifts an approaching rival sharp and a departing one flat', () => {
    const closing = new FakeContext();
    makeEngine(closing).update([car({ id: 'r', z: 30, vz: -24 })], listener, 1 / 60);

    const leaving = new FakeContext();
    makeEngine(leaving).update([car({ id: 'r', z: 30, vz: 24 })], listener, 1 / 60);

    // Same car, same speed, same gear — only the direction differs, so any
    // difference in pitch here is the Doppler shift and nothing else.
    expect(fundamentalOf(closing, 0)).toBeGreaterThan(fundamentalOf(leaving, 0));
  });

  it('leaves your own engine unshifted however fast you are going', () => {
    const slow = new FakeContext();
    makeEngine(slow).update([car({ id: 'me', isLocal: true, vz: 2 })], listener, 1 / 60);
    const slowHz = fundamentalOf(slow, 0);

    const fast = new FakeContext();
    makeEngine(fast).update(
      [car({ id: 'me', isLocal: true, vz: 2 })],
      { ...listener, vz: 26 },
      1 / 60,
    );

    // You never move relative to your own engine, so a listener velocity must
    // not touch it — only the road speed may.
    expect(fundamentalOf(fast, 0)).toBeCloseTo(slowHz, 10);
  });

  it('says nothing at all while the context is suspended', () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    makeEngine(ctx).update([car({ id: 'a', isLocal: true })], listener, 1 / 60);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('tears the whole graph down on dispose', () => {
    const ctx = new FakeContext();
    const engine = makeEngine(ctx);
    engine.update([car({ id: 'a', isLocal: true }), car({ id: 'b', z: 6 })], listener, 1 / 60);
    engine.dispose();

    expect(ctx.oscillators.every((osc) => osc.stopped)).toBe(true);
    expect(ctx.panners.every((panner) => panner.disconnected)).toBe(true);
  });
});
