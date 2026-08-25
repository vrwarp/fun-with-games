import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { marksGround, slipOf, type MarkSource } from './marks.js';

/**
 * Tyre smoke and kicked-up dust: the air showing what the tyres are doing.
 *
 * The tyre marks already put the story on the GROUND; this puts it in the
 * air, and the pairing is what a slide looks like on television — a puff
 * hanging over a black streak. It is gated by exactly the same pure
 * functions the marks use (`marksGround`, `slipOf`), so the two can never
 * disagree about whether a car is in trouble, and anything worth testing
 * about "when" is already tested there.
 *
 * ## One system per car
 *
 * A particle system has one emitter position, and eight cars slide in eight
 * places. Systems are made lazily per player id and stopped (not disposed)
 * when the car behaves — a stopped system costs nothing per frame, and the
 * pool never exceeds the player count.
 *
 * ## Why the texture is drawn
 *
 * The classic smoke sprite is a photographed puff; the kit ships no binaries,
 * so this draws a soft radial blob into a canvas once. At 15-40 particles a
 * car, softness is all a puff needs.
 */

/** Particles per second at full slip. */
const FULL_RATE = 34;
/** Seconds a puff lives. Short: smoke marks the moment, not the lap. */
const LIFE = 0.8;

/** A soft white radial blob, the one texture every particle shares. */
function puffTexture(scene: Scene): DynamicTexture {
  const size = 64;
  const texture = new DynamicTexture('smoke:puff', { width: size, height: size }, scene, false);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 2, half, half, half);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  return texture;
}

export class TyreSmoke {
  readonly #scene: Scene;
  readonly #texture: DynamicTexture;
  #systems = new Map<string, ParticleSystem>();

  constructor(scene: Scene) {
    this.#scene = scene;
    this.#texture = puffTexture(scene);
  }

  /** One frame: emit where cars are scrubbing, idle where they are not. */
  update(sources: readonly MarkSource[]): void {
    const seen = new Set<string>();
    for (const source of sources) {
      seen.add(source.id);
      const scrubbing = marksGround(source);
      const system = this.#systems.get(source.id);

      if (!scrubbing) {
        system?.stop();
        continue;
      }

      const live = system ?? this.#create(source.id);
      // Behind the car, at axle height: smoke comes off the rear tyres.
      const back = 0.9;
      (live.emitter as Vector3).set(
        source.x - Math.sin(source.heading) * back,
        0.25,
        source.z - Math.cos(source.heading) * back,
      );

      // Harder slides smoke harder; off the road it is dust, denser and
      // browner. The colour swap tells the two stories apart at a glance —
      // white smoke is a driver on the limit, brown dust is one off it.
      const slip = Math.min(1, Math.abs(slipOf(source)) * 1.6);
      const dusty = !source.onTrack;
      live.emitRate = FULL_RATE * (dusty ? 1 : Math.max(0.3, slip));
      const tint = dusty ? new Color4(0.62, 0.54, 0.4, 0.5) : new Color4(0.86, 0.86, 0.88, 0.42);
      live.color1 = tint;
      live.color2 = tint;
      live.colorDead = new Color4(tint.r, tint.g, tint.b, 0);
      if (!live.isStarted()) live.start();
    }

    // Cars that left the session take their systems with them.
    for (const [id, system] of this.#systems) {
      if (seen.has(id)) continue;
      system.dispose();
      this.#systems.delete(id);
    }
  }

  dispose(): void {
    for (const system of this.#systems.values()) system.dispose();
    this.#systems.clear();
    this.#texture.dispose();
  }

  #create(id: string): ParticleSystem {
    const system = new ParticleSystem(`smoke:${id}`, 64, this.#scene);
    system.particleTexture = this.#texture;
    system.emitter = new Vector3(0, 0, 0);
    system.minLifeTime = LIFE * 0.6;
    system.maxLifeTime = LIFE;
    system.minSize = 0.5;
    system.maxSize = 1.4;
    // Puffs grow as they fade — smoke disperses, it does not shrink.
    system.minScaleX = 1;
    system.maxScaleX = 1;
    // Drifting up and slightly scattered; no gravity, smoke is lighter than
    // the argument for simulating it.
    system.direction1 = new Vector3(-0.6, 0.9, -0.6);
    system.direction2 = new Vector3(0.6, 1.6, 0.6);
    system.minEmitPower = 0.4;
    system.maxEmitPower = 1.1;
    system.updateSpeed = 0.016;
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    this.#systems.set(id, system);
    return system;
  }
}
