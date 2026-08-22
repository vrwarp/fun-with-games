import { clamp } from '../shared/math.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('render:engine');

/**
 * Engine note, spatialised, with a Doppler shift.
 *
 * Everything here is synthesised — no samples, no network, in keeping with the
 * "runs with no art at all" rule. An engine is a good fit for that, because it
 * genuinely is a periodic noise source: the firing frequency of a running
 * engine is `rpm / 60 x cylinders / 2`, so a sawtooth at that frequency with
 * its harmonics shaped by a filter is not an impression of an engine, it is
 * the same construction.
 *
 * The three things that make it read as an engine rather than a tone:
 *
 *  - **Pitch comes from RPM, not from speed.** Those differ because of the
 *    gearbox, and the difference is the whole sound of accelerating: the note
 *    climbs, drops on the shift, and climbs again. Tie pitch straight to road
 *    speed and you get a siren.
 *  - **Load shapes the timbre.** A car pulling hard and a car coasting at the
 *    same speed are at the same RPM and sound nothing alike, so the filter
 *    opens with load and closes when the driver lifts. That is the part that
 *    answers the throttle.
 *  - **Doppler is computed, not configured.** WebAudio used to do this
 *    (`PannerNode.setVelocity`, `AudioListener.dopplerFactor`) and both were
 *    removed from the spec and from browsers, so the shift is applied to the
 *    oscillator frequency directly. See `dopplerRatio`.
 */

/** Firing frequency at idle, in Hz. Low enough to be a rumble. */
const IDLE_HZ = 42;
/** Firing frequency at the redline. */
const REDLINE_HZ = 235;
/** Ratios of the fundamental voiced alongside it, and their relative levels. */
const HARMONICS: readonly { ratio: number; level: number }[] = [
  { ratio: 0.5, level: 0.5 },
  { ratio: 1, level: 1 },
  { ratio: 2, level: 0.35 },
];
/** Gears in the box. More gears means a busier, higher-strung engine. */
const GEARS = 6;
/**
 * How much longer each gear is than the one below it.
 *
 * Above 1 the ratios spread out toward the top of the range, so first is short
 * and sixth is long — which is both what a real gearbox does and what makes
 * pulling away sound busy and a straight sound relaxed.
 */
const GEAR_SPREAD = 1.4;
/**
 * Speed of sound, in world units per second.
 *
 * The kit's units are near enough to metres — a car is about a metre wide and
 * tops out around 27, which is 97 km/h — so the real figure is also the right
 * one here, and it gives a closing car about 8% of pitch, or a little over a
 * semitone. That is the shift a real car passing at that speed has. It is
 * deliberately not exaggerated: the ask was for the right Doppler.
 */
const SPEED_OF_SOUND = 343;
/** Bounds on the shift, so a pathological velocity cannot produce a squeal. */
const MIN_DOPPLER = 0.5;
const MAX_DOPPLER = 2;
/** Cars further away than this are not worth a voice. */
const MAX_AUDIBLE_DISTANCE = 90;
/**
 * How many rivals may sound at once.
 *
 * HRTF panning is not free, and a phone is the primary target. The nearest few
 * are the ones a driver is actually listening for anyway.
 */
const MAX_VOICES = 6;
/** Seconds over which measured acceleration is smoothed into engine load. */
const LOAD_SMOOTHING = 0.18;

/** A body that can be heard, or heard from. */
export interface AudioBody {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

/** Where the ears are, and which way they point. */
export interface AudioListenerPose extends AudioBody {
  readonly y: number;
  /** Unit forward vector, in the same left-handed space as the scene. */
  readonly forwardX: number;
  readonly forwardZ: number;
}

/** One car's engine, as the audio layer needs to see it. */
export interface EngineVoiceInput extends AudioBody {
  readonly id: string;
  readonly y: number;
  /** True for the player's own car, which is heard from inside it. */
  readonly isLocal: boolean;
}

/**
 * Which gear a car would be in, and how far up the rev range.
 *
 * `speedFraction` is road speed over top speed. Returns the gear (0-based) and
 * `rev` in [0, 1] within it — which is the number the pitch actually follows,
 * and why accelerating sweeps up and then drops rather than rising forever.
 */
export function gearFor(speedFraction: number, gears = GEARS): { gear: number; rev: number } {
  const s = clamp(speedFraction, 0, 1);
  // Boundary i sits at (i / gears) ^ spread, so the ratios bunch toward the
  // bottom: short low gears, long high ones.
  for (let gear = 0; gear < gears; gear++) {
    const lo = (gear / gears) ** GEAR_SPREAD;
    const hi = ((gear + 1) / gears) ** GEAR_SPREAD;
    if (s < hi || gear === gears - 1) {
      const span = hi - lo;
      return { gear, rev: span > 0 ? clamp((s - lo) / span, 0, 1) : 0 };
    }
  }
  return { gear: gears - 1, rev: 1 };
}

/** Firing frequency in Hz for a point in the rev range. */
export function engineHz(rev: number): number {
  return IDLE_HZ + clamp(rev, 0, 1) * (REDLINE_HZ - IDLE_HZ);
}

/**
 * The Doppler ratio to multiply a source's frequency by.
 *
 * `f' = f (c + vr) / (c + vs)`, where `vr` is the listener's speed **toward**
 * the source and `vs` is the source's speed **away from** the listener — both
 * measured along the line between them, because only motion along that line
 * changes the arrival rate of the wavefronts. A car crossing your path at
 * right angles is briefly not shifted at all, which is exactly the moment the
 * pitch audibly drops as it goes by.
 *
 * Returns 1 when the two are on top of each other, when the geometry is
 * degenerate, or when the source is supersonic — none of which have a
 * meaningful answer, and all of which have a harmless one.
 */
export function dopplerRatio(
  listener: AudioBody,
  source: AudioBody,
  speedOfSound = SPEED_OF_SOUND,
): number {
  const dx = source.x - listener.x;
  const dz = source.z - listener.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance < 1e-6 || speedOfSound <= 0) return 1;

  // Unit vector from the listener toward the source.
  const nx = dx / distance;
  const nz = dz / distance;

  const sourceAway = source.vx * nx + source.vz * nz;
  const listenerToward = listener.vx * nx + listener.vz * nz;

  const denominator = speedOfSound + sourceAway;
  if (denominator <= 0) return MAX_DOPPLER;

  return clamp((speedOfSound + listenerToward) / denominator, MIN_DOPPLER, MAX_DOPPLER);
}

/**
 * How hard the engine is working, in [0, 1], from measured acceleration.
 *
 * A number the audio layer has to derive rather than read: a rival's throttle
 * position is not transmitted (and should not be — it is not simulation state
 * anyone else needs). What IS visible is how its speed is changing, and that
 * is the same information for this purpose. Pulling hard reads as load;
 * coasting and braking read as a lift.
 */
export function engineLoad(acceleration: number, engineAccel: number): number {
  if (engineAccel <= 0) return 0.5;
  return clamp(0.35 + 0.65 * (acceleration / engineAccel), 0.12, 1);
}

/** One car's synthesis chain. */
interface Voice {
  readonly oscillators: OscillatorNode[];
  readonly gains: GainNode[];
  readonly filter: BiquadFilterNode;
  readonly output: GainNode;
  readonly panner: PannerNode | null;
  /** Last road speed seen, for differentiating into load. */
  speed: number;
  /** Smoothed load, so a single noisy frame does not flap the filter. */
  load: number;
  /** Set false at the start of each update; survivors are still racing. */
  alive: boolean;
}

/**
 * The running engines.
 *
 * Owned by `GameAudio`, which creates it alongside the AudioContext and throws
 * it away when the player mutes — an engine is a continuous sound, so unlike a
 * cue it cannot simply be dropped on the floor while muted.
 */
export class EngineSound {
  #ctx: AudioContext;
  #master: GainNode;
  #voices = new Map<string, Voice>();
  #topSpeed: number;
  #engineAccel: number;
  #spatial: boolean;

  constructor(ctx: AudioContext, options: { topSpeed: number; engineAccel: number }) {
    this.#ctx = ctx;
    this.#topSpeed = Math.max(1, options.topSpeed);
    this.#engineAccel = options.engineAccel;
    this.#spatial = typeof ctx.createPanner === 'function';

    this.#master = ctx.createGain();
    this.#master.gain.value = 0.5;
    this.#master.connect(ctx.destination);
  }

  /**
   * Advances every engine by one frame.
   *
   * `dt` is real seconds since the last call, used only to differentiate speed
   * into load — never to schedule anything. Everything audible is set through
   * AudioParams on the audio clock.
   */
  update(cars: readonly EngineVoiceInput[], listener: AudioListenerPose, dt: number): void {
    if (this.#ctx.state !== 'running') return;

    for (const voice of this.#voices.values()) voice.alive = false;
    this.#placeListener(listener);

    for (const car of this.#nearest(cars, listener)) {
      const voice = this.#voices.get(car.id) ?? this.#createVoice(car.id, !car.isLocal);
      if (!voice) continue;
      voice.alive = true;
      this.#tune(voice, car, listener, dt);
    }

    for (const [id, voice] of this.#voices) {
      if (voice.alive) continue;
      this.#stop(voice);
      this.#voices.delete(id);
    }
  }

  dispose(): void {
    for (const voice of this.#voices.values()) this.#stop(voice);
    this.#voices.clear();
    try {
      this.#master.disconnect();
    } catch (error) {
      log.debug('master disconnect failed', error);
    }
  }

  // -------------------------------------------------------------- internals

  /**
   * The cars worth hearing: the local one always, then the nearest rivals.
   *
   * Sorted by distance and capped, because HRTF panning costs real CPU on a
   * phone and the far side of the circuit is not what a driver is listening
   * for.
   */
  #nearest(
    cars: readonly EngineVoiceInput[],
    listener: AudioListenerPose,
  ): readonly EngineVoiceInput[] {
    const audible = cars
      .map((car) => ({
        car,
        distance: Math.hypot(car.x - listener.x, car.z - listener.z),
      }))
      .filter((entry) => entry.car.isLocal || entry.distance < MAX_AUDIBLE_DISTANCE)
      .sort((a, b) => {
        if (a.car.isLocal !== b.car.isLocal) return a.car.isLocal ? -1 : 1;
        return a.distance - b.distance;
      });

    return audible.slice(0, MAX_VOICES + 1).map((entry) => entry.car);
  }

  #createVoice(id: string, spatial: boolean): Voice | null {
    const ctx = this.#ctx;
    try {
      const output = ctx.createGain();
      output.gain.value = 0;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.9;
      filter.connect(output);

      const oscillators: OscillatorNode[] = [];
      const gains: GainNode[] = [];
      for (const harmonic of HARMONICS) {
        const osc = ctx.createOscillator();
        // Sawtooth: an engine's spectrum is dense and falls away with
        // frequency, which is what a saw already is. A sine would be a flute.
        osc.type = 'sawtooth';
        osc.frequency.value = IDLE_HZ * harmonic.ratio;

        const gain = ctx.createGain();
        gain.gain.value = harmonic.level;
        osc.connect(gain);
        gain.connect(filter);
        osc.start();

        oscillators.push(osc);
        gains.push(gain);
      }

      let panner: PannerNode | null = null;
      if (spatial && this.#spatial) {
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 6;
        panner.maxDistance = MAX_AUDIBLE_DISTANCE;
        panner.rolloffFactor = 1.1;
        output.connect(panner);
        panner.connect(this.#master);
      } else {
        // The local car is heard from inside it: no panning, no distance
        // attenuation, and no Doppler either — you never move relative to
        // your own engine.
        output.connect(this.#master);
      }

      const voice: Voice = {
        oscillators,
        gains,
        filter,
        output,
        panner,
        speed: 0,
        load: 0.4,
        alive: true,
      };
      this.#voices.set(id, voice);
      return voice;
    } catch (error) {
      log.debug('engine voice failed', error);
      return null;
    }
  }

  #tune(voice: Voice, car: EngineVoiceInput, listener: AudioListenerPose, dt: number): void {
    const ctx = this.#ctx;
    const now = ctx.currentTime;
    // Long enough to be smooth, short enough that the engine answers the
    // throttle rather than trailing it.
    const glide = 0.05;

    const speed = Math.hypot(car.vx, car.vz);
    const acceleration = dt > 0 ? (speed - voice.speed) / dt : 0;
    voice.speed = speed;

    const target = engineLoad(acceleration, this.#engineAccel);
    const blend = dt > 0 ? Math.min(1, dt / LOAD_SMOOTHING) : 1;
    voice.load += (target - voice.load) * blend;

    const { rev } = gearFor(speed / this.#topSpeed);
    const shift = voice.panner ? dopplerRatio(listener, car) : 1;
    const fundamental = engineHz(rev) * shift;

    for (let i = 0; i < voice.oscillators.length; i++) {
      const harmonic = HARMONICS[i];
      const osc = voice.oscillators[i];
      if (!harmonic || !osc) continue;
      this.#ramp(osc.frequency, fundamental * harmonic.ratio, now, glide);
    }

    // Load opens the filter: a labouring engine is bright and buzzy, a
    // coasting one is a muffled hum an octave of harmonics lower.
    this.#ramp(voice.filter.frequency, 420 + voice.load * rev * 3400 + rev * 900, now, glide);

    // Idle is quiet; a car on the limiter is not. Local gets more level
    // because it is the one the driver is steering by.
    const level = (0.16 + 0.5 * voice.load) * (0.4 + 0.6 * rev);
    this.#ramp(voice.output.gain, car.isLocal ? level : level * 0.7, now, glide);

    if (voice.panner) this.#placeSource(voice.panner, car, now);
  }

  /**
   * Positions the listener, converting handedness.
   *
   * The scene is left-handed (Babylon's default) and WebAudio is right-handed
   * with -Z forward, so every Z is negated on the way across. Doing it to the
   * listener and to every source alike preserves the geometry between them and
   * lands "to my right" on the right ear rather than the left.
   */
  #placeListener(listener: AudioListenerPose): void {
    const target = this.#ctx.listener;
    const now = this.#ctx.currentTime;
    try {
      if (target.positionX) {
        this.#set(target.positionX, listener.x, now);
        this.#set(target.positionY, listener.y, now);
        this.#set(target.positionZ, -listener.z, now);
        this.#set(target.forwardX, listener.forwardX, now);
        this.#set(target.forwardY, 0, now);
        this.#set(target.forwardZ, -listener.forwardZ, now);
        this.#set(target.upX, 0, now);
        this.#set(target.upY, 1, now);
        this.#set(target.upZ, 0, now);
        return;
      }
      // Safari and anything else still on the removed setters.
      target.setPosition?.(listener.x, listener.y, -listener.z);
      target.setOrientation?.(listener.forwardX, 0, -listener.forwardZ, 0, 1, 0);
    } catch (error) {
      log.debug('listener placement failed', error);
    }
  }

  #placeSource(panner: PannerNode, car: EngineVoiceInput, now: number): void {
    try {
      if (panner.positionX) {
        this.#set(panner.positionX, car.x, now);
        this.#set(panner.positionY, car.y, now);
        this.#set(panner.positionZ, -car.z, now);
        return;
      }
      panner.setPosition?.(car.x, car.y, -car.z);
    } catch (error) {
      log.debug('panner placement failed', error);
    }
  }

  /** Ramps a parameter rather than stepping it, so nothing clicks. */
  #ramp(param: AudioParam, value: number, now: number, seconds: number): void {
    if (!Number.isFinite(value)) return;
    try {
      param.setTargetAtTime(value, now, seconds);
    } catch {
      param.value = value;
    }
  }

  #set(param: AudioParam, value: number, now: number): void {
    if (!Number.isFinite(value)) return;
    // Listener and panner positions move every frame anyway, so a short ramp
    // is enough to stop zipper noise without smearing the position.
    param.setTargetAtTime(value, now, 0.02);
  }

  #stop(voice: Voice): void {
    try {
      for (const osc of voice.oscillators) {
        osc.stop();
        osc.disconnect();
      }
      for (const gain of voice.gains) gain.disconnect();
      voice.filter.disconnect();
      voice.output.disconnect();
      voice.panner?.disconnect();
    } catch (error) {
      log.debug('engine voice teardown failed', error);
    }
  }
}
