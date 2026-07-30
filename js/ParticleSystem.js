/* =============================================================================
 *  ParticleSystem.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  A high-performance, GPU-driven generic particle system built on
 *  THREE.Points + THREE.BufferGeometry + a custom ShaderMaterial.
 *
 *  Design goals:
 *    • Single draw call for thousands of simultaneous particles.
 *    • Object-pooled particles (pre-allocated, recycled, never GC churn).
 *    • Per-particle behaviours: alpha fade, size grow/shrink, color-shift
 *      gradient over lifetime, velocity drag, optional gravity, rotation/spin.
 *    • Soft circular particles with a radial glow falloff, authored entirely
 *      in the fragment shader (no texture asset required).
 *    • Additive blending for glow particles (engines, sparks, flashes,
 *      star dust, power-ups, shield ripples) and normal blending for smoke.
 *
 *  Constructor:   new ParticleSystem(scene, maxParticles = 5000)
 *
 *  Public API:
 *      emit(x, y, options)          emit one particle at position with config
 *      emitBurst(x, y, count, opts) emit N particles at position
 *      emitTrail(x, y, color)       emit a single engine-trail particle
 *      emitExplosion(x, y, scale)   full explosion (debris + smoke + flash)
 *      emitHitSpark(x, y, angle)    small spark burst from bullet impact
 *      emitPowerupSparkle(x, y)     glittering effect around a power-up
 *      update(dt)                   advance all particles, recycle dead ones
 *      clear()                      kill every active particle
 *      destroy()                     free Three.js resources
 *
 *  Coordinate convention matches the rest of the game:
 *      +y is up, -y is down, camera at (0, 0, 100) looking at origin.
 *
 *  `options` (any subset; sensible defaults apply):
 *      count       number of particles to emit (default 1)
 *      angle       base direction in radians from +y, clockwise+ (default 0)
 *      spread      full cone angle in radians of random directional spread
 *      speed       [min,max] initial speed range (px/s)
 *      life        [min,max] lifetime range (seconds)
 *      size        [min,max] base sprite size (world units)
 *      color       array of stops [{t, c}] or a single 0xRRGGBB; interpolated
 *                  over the particle's normalized life. `c` is 0xRRGGBB.
 *      alpha       [startAlpha, endAlpha] (default [1, 0])
 *      sizeCurve   [sizeAtBirth, sizeAtDeath] multiplier on base size
 *                  (e.g. [0.3, 1.6] for growing smoke). default [1, 1]
 *      drag        velocity deceleration coefficient (per second). default 0
 *      gravity     downward acceleration (px/s^2). default 0
 *      spin        [min,max] angular velocity (rad/s). default [0, 0]
 *      additive    boolean — use additive blending. default true
 *      ring        boolean — render as expanding ring (shield ripple). default false
 *      ringWidth   ring thickness fraction (0..1). default 0.25
 *      stretch     boolean — stretch particle along velocity for motion streaks
 *      positionJitter  [x,y] random positional offset range at spawn
 *
 *  Texture: a procedural radial-glow canvas texture is generated so the
 *  fragment shader can sample it; the shader also synthesises a soft glow
 *  analytically so the look is consistent even without the texture.
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  const PLAYFIELD_Z = 0;       // particles live in the z=0 plane
  const COLOR_STEPS = 8;       // max color gradient stops baked per particle
  const DEFAULT_MAX = 5000;

  /* ── Procedural radial-glow texture ──────────────────────────────────── */
  function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.40)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.12)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  /* ── Inline GLSL shaders ─────────────────────────────────────────────── */

  /**
   * Vertex shader.
   *
   * Per-particle attributes: position (vec3), aColor (vec3, CPU-baked current
   * color), aAlpha (float, CPU-baked current alpha), aSize (float, current
   * sprite size already multiplied by the size curve), aRotation, aLife,
   * aMaxLife.  The CPU integrates kinematics and colour each frame and writes
   * the results into the buffer attributes; the shader only projects and
   * sets the gl_PointSize.
   *
   * For this 2.5D game the camera distance is effectively constant, so the
   * classic perspective-size attenuation is collapsed into a single uniform
   * (uSizeScale) which folds together pixel ratio and distance compensation.
   */
  const VERT_SHADER = [
    'precision highp float;',
    '',
    'uniform float uPixelRatio;',
    'uniform float uSizeScale;',
    '',
    'attribute float aLife;',
    'attribute float aMaxLife;',
    'attribute float aSize;',
    'attribute float aRotation;',
    'attribute vec3  aColor;',
    'attribute float aAlpha;',
    'attribute float aRing;',       // 1.0 = ring, 0.0 = solid disc
    'attribute float aRingWidth;',  // ring annulus thickness fraction
    '',
    'varying float vRotation;',
    'varying vec4  vColor;',
    'varying float vAlive;',
    'varying float vRing;',
    'varying float vRingWidth;',
    '',
    'void main() {',
    '  vRotation   = aRotation;',
    '  vColor      = vec4(aColor, aAlpha);',
    '  vAlive      = (aLife > 0.0) ? 1.0 : 0.0;',
    '  vRing       = aRing;',
    '  vRingWidth  = aRingWidth;',
    '',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '',
    '  gl_PointSize = max(aSize * uSizeScale, 1.0) * uPixelRatio;',
    '}'
  ].join('\n');

  /**
   * Fragment shader.
   *
   * Produces a soft circular particle with a glow falloff.  The CPU bakes the
   * current per-particle colour and alpha (interpolated over lifetime) into
   * aColor / aAlpha, so the shader only needs to apply:
   *   • a soft-disc alpha mask (analytic radial falloff),
   *   • an optional expanding-ring annulus mask (for shield ripples),
   *   • a procedural glow boost sampled from the shared radial texture.
   */
  const FRAG_SHADER = [
    'precision highp float;',
    '',
    'uniform sampler2D uTex;',
    '',
    'varying float vRotation;',
    'varying vec4  vColor;',
    'varying float vAlive;',
    'varying float vRing;',
    'varying float vRingWidth;',
    '',
    'void main() {',
    '  if (vAlive < 0.5) discard;',
    '',
    '  vec2 uv = gl_PointCoord;',
    '  vec2 centered = uv - 0.5;',
    '  float dist = length(centered) * 2.0;   // 0 center, 1 edge',
    '',
    '  // Soft circular falloff.',
    '  float alpha = smoothstep(1.0, 0.0, dist);',
    '  if (alpha <= 0.001) discard;',
    '',
    '  // Expanding-ring annulus mask (per-particle via vRing/vRingWidth).',
    '  float rw = max(vRingWidth, 0.001);',
    '  float ringMask = smoothstep(0.0, rw, 1.0 - dist) *',
    '                   smoothstep(0.0, rw, dist);',
    '  ringMask = clamp(ringMask, 0.0, 1.0);',
    '  alpha = mix(alpha, ringMask, vRing);',
    '  if (alpha <= 0.001) discard;',
    '',
    '  // Procedural glow boost from the shared radial texture.',
    '  float glow = texture2D(uTex, uv).a;',
    '',
    '  gl_FragColor = vec4(vColor.rgb * (0.6 + 0.4 * glow), alpha * vColor.a);',
    '}'
  ].join('\n');

  /* ── Particle record ────────────────────────────────────────────────── */

  /**
   * A single particle.  Created once in the pool and recycled.  All fields
   * are flat numbers / arrays to avoid per-particle allocations and keep
   * the update loop branch-free.
   */
  function Particle() {
    this.active = false;

    // Kinematics (world units, px).
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;

    // Lifetime.
    this.life = 0;       // remaining seconds
    this.maxLife = 0;

    // Visuals.
    this.size = 8;        // base sprite size (world units)
    this.sizeBirth = 1;   // size multiplier at birth (sizeCurve[0])
    this.sizeDeath = 1;   // size multiplier at death (sizeCurve[1])
    this.rotation = 0;    // radians
    this.spin = 0;        // rad/s

    // Color + alpha curve.  We bake up to COLOR_STOPS into flat arrays.
    this.colorStops = 1;
    this.colorT = [0, 0, 0, 0, 0, 0, 0, 0];   // normalized life for each stop
    this.colorR = [1, 0, 0, 0, 0, 0, 0, 0];   // 0..1 per channel
    this.colorG = [1, 0, 0, 0, 0, 0, 0, 0];
    this.colorB = [1, 0, 0, 0, 0, 0, 0, 0];

    this.alphaBirth = 1;
    this.alphaDeath = 0;

    // Behaviour.
    this.drag = 0;        // velocity damping per second
    this.gravity = 0;     // downward accel (px/s^2)
    this.blendAdditive = true;
    this.ring = false;
    this.ringWidth = 0.25;
    this.stretch = false;
  }

  /* ── Color helpers ──────────────────────────────────────────────────── */

  const _tmpColor = new THREE.Color();

  function hexToRgb01(hex) {
    _tmpColor.setHex(hex);
    return [_tmpColor.r, _tmpColor.g, _tmpColor.b];
  }

  /**
   * Bake a `color` option into a particle's gradient arrays.
   * `color` may be:
   *   • undefined / null     -> single white stop
   *   • number 0xRRGGBB      -> single stop
   *   • array of numbers     -> evenly spaced stops
   *   • array of {t,c}       -> explicit stops (t in 0..1, c 0xRRGGBB)
   */
  function bakeColor(p, color) {
    let stops;
    if (color == null) {
      stops = [{ t: 0, c: 0xffffff }];
    } else if (typeof color === 'number') {
      stops = [{ t: 0, c: color }];
    } else if (Array.isArray(color)) {
      if (color.length === 0) {
        stops = [{ t: 0, c: 0xffffff }];
      } else if (typeof color[0] === 'number') {
        // Evenly distribute numeric stops across [0,1].
        stops = color.map(function (c, i) {
          return { t: color.length === 1 ? 0 : i / (color.length - 1), c: c };
        });
      } else {
        // Already {t,c} objects; default t to even spacing if missing.
        stops = color.map(function (s, i) {
          return {
            t: (s.t != null) ? s.t : (color.length === 1 ? 0 : i / (color.length - 1)),
            c: s.c
          };
        });
      }
    } else {
      stops = [{ t: 0, c: 0xffffff }];
    }

    const n = Math.min(stops.length, COLOR_STEPS);
    p.colorStops = n;
    for (let i = 0; i < COLOR_STEPS; i++) {
      if (i < n) {
        const rgb = hexToRgb01(stops[i].c);
        p.colorT[i] = stops[i].t;
        p.colorR[i] = rgb[0];
        p.colorG[i] = rgb[1];
        p.colorB[i] = rgb[2];
      } else {
        // Pad with the last stop so sampling saturates.
        p.colorT[i] = stops[n - 1].t;
        p.colorR[i] = p.colorR[n - 1];
        p.colorG[i] = p.colorG[n - 1];
        p.colorB[i] = p.colorB[n - 1];
      }
    }
  }

  /** Sample a particle's baked gradient at normalized life t (0..1, 0=birth). */
  function sampleColor(p, t, out) {
    const n = p.colorStops;
    if (n === 1 || t <= p.colorT[0]) {
      out[0] = p.colorR[0]; out[1] = p.colorG[0]; out[2] = p.colorB[0];
      return;
    }
    if (t >= p.colorT[n - 1]) {
      out[0] = p.colorR[n - 1]; out[1] = p.colorG[n - 1]; out[2] = p.colorB[n - 1];
      return;
    }
    for (let i = 0; i < n - 1; i++) {
      const t0 = p.colorT[i], t1 = p.colorT[i + 1];
      if (t >= t0 && t <= t1) {
        const span = t1 - t0;
        const k = span > 0 ? (t - t0) / span : 0;
        out[0] = p.colorR[i] + (p.colorR[i + 1] - p.colorR[i]) * k;
        out[1] = p.colorG[i] + (p.colorG[i + 1] - p.colorG[i]) * k;
        out[2] = p.colorB[i] + (p.colorB[i + 1] - p.colorB[i]) * k;
        return;
      }
    }
    out[0] = p.colorR[n - 1]; out[1] = p.colorG[n - 1]; out[2] = p.colorB[n - 1];
  }

  /* ── Option defaults ───────────────────────────────────────────────── */

  function clampRange(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /* ── ParticleSystem ────────────────────────────────────────────────── */

  function ParticleSystem(scene, maxParticles) {
    this.scene = scene;
    this.maxParticles = maxParticles || DEFAULT_MAX;

    // Pool of particle records.
    this.pool = new Array(this.maxParticles);
    for (let i = 0; i < this.maxParticles; i++) this.pool[i] = new Particle();
    this.cursor = 0;          // round-robin search cursor for free slots
    this.activeCount = 0;

    // Shared procedural glow texture (sampled by the fragment shader).
    this._tex = makeGlowTexture();

    // Two ShaderMaterials, one per blend mode.  Each renders its own geometry
    // so additive and normal-blend particles each cost a single draw call.
    // Ring vs disc rendering is handled per-particle via an `aRing` attribute,
    // so ring particles (shield ripples) can share the same additive draw call.
    this.materialAdditive = this._makeMaterial(true);
    this.materialNormal   = this._makeMaterial(false);

    // Two geometries + two THREE.Points: additive and normal-blend.
    this._buildDualGeometries();

    // Scratch.
    this._colorOut = [0, 0, 0];
  }

  /* ── Material factory ───────────────────────────────────────────────── */

  ParticleSystem.prototype._makeMaterial = function (additive) {
    const uniforms = {
      uTex:        { value: this._tex },
      uPixelRatio: { value: (typeof window !== 'undefined' && window.devicePixelRatio) || 1 },
      uSizeScale:  { value: 1.0 }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    // For additive glow: result = src*srcAlpha + dst*1  (accumulate brightness).
    // For normal smoke:  result = src*srcAlpha + dst*(1-srcAlpha) (over).
    // THREE's blending enum already sets these factors, but we pin them
    // explicitly so the intent is unambiguous and immune to enum changes.
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    mat.blendEquation = THREE.AddEquation;
    return mat;
  };

  /* ── Dual geometry build ────────────────────────────────────────────── */

  ParticleSystem.prototype._buildDualGeometries = function () {
    const N = this.maxParticles;

    // Additive geometry/buffers.
    this._posA    = new Float32Array(N * 3);
    this._lifeA   = new Float32Array(N);
    this._maxA    = new Float32Array(N);
    this._sizeA   = new Float32Array(N);
    this._rotA    = new Float32Array(N);
    this._colA    = new Float32Array(N * 3);
    this._alphaA  = new Float32Array(N);
    this._ringA   = new Float32Array(N);
    this._ringWA  = new Float32Array(N);

    this.geoA = new THREE.BufferGeometry();
    this.geoA.setAttribute('position',   new THREE.BufferAttribute(this._posA, 3));
    this.geoA.setAttribute('aLife',      new THREE.BufferAttribute(this._lifeA, 1));
    this.geoA.setAttribute('aMaxLife',   new THREE.BufferAttribute(this._maxA, 1));
    this.geoA.setAttribute('aSize',      new THREE.BufferAttribute(this._sizeA, 1));
    this.geoA.setAttribute('aRotation',  new THREE.BufferAttribute(this._rotA, 1));
    this.geoA.setAttribute('aColor',     new THREE.BufferAttribute(this._colA, 3));
    this.geoA.setAttribute('aAlpha',     new THREE.BufferAttribute(this._alphaA, 1));
    this.geoA.setAttribute('aRing',      new THREE.BufferAttribute(this._ringA, 1));
    this.geoA.setAttribute('aRingWidth', new THREE.BufferAttribute(this._ringWA, 1));
    this.geoA.setDrawRange(0, N);

    // Normal geometry/buffers.
    this._posN    = new Float32Array(N * 3);
    this._lifeN   = new Float32Array(N);
    this._maxN    = new Float32Array(N);
    this._sizeN   = new Float32Array(N);
    this._rotN    = new Float32Array(N);
    this._colN    = new Float32Array(N * 3);
    this._alphaN  = new Float32Array(N);
    this._ringN   = new Float32Array(N);
    this._ringWN  = new Float32Array(N);

    this.geoN = new THREE.BufferGeometry();
    this.geoN.setAttribute('position',   new THREE.BufferAttribute(this._posN, 3));
    this.geoN.setAttribute('aLife',      new THREE.BufferAttribute(this._lifeN, 1));
    this.geoN.setAttribute('aMaxLife',   new THREE.BufferAttribute(this._maxN, 1));
    this.geoN.setAttribute('aSize',      new THREE.BufferAttribute(this._sizeN, 1));
    this.geoN.setAttribute('aRotation',  new THREE.BufferAttribute(this._rotN, 1));
    this.geoN.setAttribute('aColor',     new THREE.BufferAttribute(this._colN, 3));
    this.geoN.setAttribute('aAlpha',     new THREE.BufferAttribute(this._alphaN, 1));
    this.geoN.setAttribute('aRing',      new THREE.BufferAttribute(this._ringN, 1));
    this.geoN.setAttribute('aRingWidth', new THREE.BufferAttribute(this._ringWN, 1));
    this.geoN.setDrawRange(0, N);

    // Points objects.
    this.pointsA = new THREE.Points(this.geoA, this.materialAdditive);
    this.pointsA.frustumCulled = false;
    this.pointsA.renderOrder = 15;
    this.scene.add(this.pointsA);

    this.pointsN = new THREE.Points(this.geoN, this.materialNormal);
    this.pointsN.frustumCulled = false;
    this.pointsN.renderOrder = 14;
    this.scene.add(this.pointsN);
  };

  /* ── Slot checkout ─────────────────────────────────────────────────── */

  /**
   * Find a free particle slot.  Uses a round-robin cursor for O(1)-ish
   * amortised lookup; falls back to a linear scan if the cursor misses.
   * Returns null if the pool is exhausted (rare — we pre-allocate generously).
   */
  ParticleSystem.prototype._checkout = function () {
    const pool = this.pool;
    const N = pool.length;
    for (let i = 0; i < N; i++) {
      const idx = (this.cursor + i) % N;
      if (!pool[idx].active) {
        pool[idx].active = true;
        this.cursor = (idx + 1) % N;
        this.activeCount++;
        return pool[idx];
      }
    }
    return null;
  };

  ParticleSystem.prototype._retire = function (p) {
    if (!p.active) return;
    p.active = false;
    this.activeCount--;
  };

  /* ── Resolve an `options` object into normalized fields ────────────── */

  function resolveOpts(opts) {
    opts = opts || {};
    const o = {
      angle:         (opts.angle != null) ? opts.angle : 0,
      spread:        (opts.spread != null) ? opts.spread : Math.PI * 2,
      speed:         opts.speed || [20, 80],
      life:          opts.life  || [0.4, 0.8],
      size:          opts.size  || [6, 10],
      color:         opts.color,
      alpha:         opts.alpha || [1, 0],
      sizeCurve:     opts.sizeCurve || [1, 1],
      drag:          (opts.drag != null) ? opts.drag : 0,
      gravity:       (opts.gravity != null) ? opts.gravity : 0,
      spin:          opts.spin || [0, 0],
      additive:      (opts.additive != null) ? opts.additive : true,
      ring:          (opts.ring != null) ? opts.ring : false,
      ringWidth:     (opts.ringWidth != null) ? opts.ringWidth : 0.25,
      stretch:       (opts.stretch != null) ? opts.stretch : false,
      positionJitter:opts.positionJitter || [0, 0]
    };
    return o;
  }

  /* ── Spawn one particle from resolved options ──────────────────────── */

  ParticleSystem.prototype._spawnOne = function (x, y, o) {
    const p = this._checkout();
    if (!p) return null;

    // Direction with cone spread.  angle is measured from +y, clockwise+,
    // matching the rest of the game: dir = (sin(a), cos(a)).
    const halfSpread = o.spread * 0.5;
    const a = o.angle + randRange(-halfSpread, halfSpread);
    const speed = randRange(o.speed[0], o.speed[1]);
    p.x = x + randRange(-o.positionJitter[0], o.positionJitter[0]);
    p.y = y + randRange(-o.positionJitter[1], o.positionJitter[1]);
    p.vx = Math.sin(a) * speed;
    p.vy = Math.cos(a) * speed;

    // Lifetime.
    p.maxLife = randRange(o.life[0], o.life[1]);
    p.life = p.maxLife;

    // Size.
    p.size = randRange(o.size[0], o.size[1]);
    p.sizeBirth = o.sizeCurve[0];
    p.sizeDeath = o.sizeCurve[1];

    // Rotation / spin.
    p.rotation = Math.random() * Math.PI * 2;
    p.spin = randRange(o.spin[0], o.spin[1]);

    // Color + alpha curve.
    bakeColor(p, o.color);
    p.alphaBirth = o.alpha[0];
    p.alphaDeath = o.alpha[1];

    // Behaviour.
    p.drag = o.drag;
    p.gravity = o.gravity;
    p.blendAdditive = o.additive;
    p.ring = o.ring;
    p.ringWidth = o.ringWidth;
    p.stretch = o.stretch;

    return p;
  };

  /* ── Public emit API ───────────────────────────────────────────────── */

  /**
   * Emit `options.count` particles at (x, y).  Returns the number actually
   * spawned (may be less if the pool is full).
   */
  ParticleSystem.prototype.emit = function (x, y, options) {
    const o = resolveOpts(options);
    const count = Math.max(1, options && options.count ? options.count : 1);
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (this._spawnOne(x, y, o)) spawned++;
    }
    return spawned;
  };

  /** Emit a burst — same as emit() but with an explicit count parameter. */
  ParticleSystem.prototype.emitBurst = function (x, y, count, options) {
    const o = resolveOpts(options);
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (this._spawnOne(x, y, o)) spawned++;
    }
    return spawned;
  };

  /** Emit a single engine-trail particle (cyan, small, fast fade). */
  ParticleSystem.prototype.emitTrail = function (x, y, color) {
    return this._spawnOne(x, y, resolveOpts({
      count: 1,
      angle: Math.PI,           // downward (behind an upward-flying ship)
      spread: 0.4,
      speed: [40, 120],
      life: [0.25, 0.5],
      size: [8, 16],
      color: color || [
        { t: 0, c: 0xaff8ff },
        { t: 0.5, c: 0x18c8ff },
        { t: 1, c: 0x00408a }
      ],
      alpha: [0.9, 0],
      sizeCurve: [1.0, 0.2],
      drag: 1.5,
      additive: true
    })) ? 1 : 0;
  };

  /* ── Preset effects ────────────────────────────────────────────────── */

  /** Full explosion: bright flash + sparks/debris + expanding smoke. */
  ParticleSystem.prototype.emitExplosion = function (x, y, scale) {
    scale = scale || 1;
    const S = scale;

    // Bright initial flash (fast, additive, white→yellow).
    this.emitBurst(x, y, 14 * S, {
      angle: 0, spread: Math.PI * 2,
      speed: [120, 360],
      life: [0.12, 0.22],
      size: [30 * S, 60 * S],
      color: [
        { t: 0, c: 0xffffff },
        { t: 0.5, c: 0xfff2a0 },
        { t: 1, c: 0xffaa20 }
      ],
      alpha: [1, 0],
      sizeCurve: [0.4, 1.6],
      drag: 2.0,
      additive: true
    });

    // Hot sparks / debris flying outward with deceleration + gravity.
    this.emitBurst(x, y, Math.floor(28 * S), {
      angle: 0, spread: Math.PI * 2,
      speed: [180, 520],
      life: [0.5, 1.1],
      size: [3 * S, 7 * S],
      color: [
        { t: 0,   c: 0xffffff },
        { t: 0.2, c: 0xffe060 },
        { t: 0.5, c: 0xff7a18 },
        { t: 0.8, c: 0xc02000 },
        { t: 1,   c: 0x200000 }
      ],
      alpha: [1, 0],
      sizeCurve: [1, 0.3],
      drag: 1.8,
      gravity: 160,
      spin: [-8, 8],
      additive: true,
      stretch: true
    });

    // Expanding smoke clouds (normal blend, dark core fading to transparent).
    this.emitBurst(x, y, Math.floor(10 * S), {
      angle: 0, spread: Math.PI * 2,
      speed: [20, 90],
      life: [0.9, 1.6],
      size: [40 * S, 70 * S],
      color: [
        { t: 0,   c: 0x3a3030 },
        { t: 0.4, c: 0x504040 },
        { t: 0.7, c: 0x2a2020 },
        { t: 1,   c: 0x101010 }
      ],
      alpha: [0.8, 0],
      sizeCurve: [0.3, 2.2],
      drag: 1.2,
      additive: false
    });
  };

  /** Small spark burst from a bullet impact, directed back along `angle`. */
  ParticleSystem.prototype.emitHitSpark = function (x, y, angle) {
    // Bright core flash.
    this.emitBurst(x, y, 6, {
      angle: angle || 0,
      spread: 1.2,
      speed: [80, 260],
      life: [0.08, 0.18],
      size: [10, 22],
      color: [
        { t: 0,   c: 0xffffff },
        { t: 0.4, c: 0xb0f8ff },
        { t: 1,   c: 0x18a0ff }
      ],
      alpha: [1, 0],
      sizeCurve: [0.5, 1.5],
      drag: 3.0,
      additive: true
    });
    // A few sharp sparks.
    this.emitBurst(x, y, 10, {
      angle: angle || 0,
      spread: 1.6,
      speed: [200, 460],
      life: [0.18, 0.4],
      size: [2, 5],
      color: [
        { t: 0,   c: 0xffffff },
        { t: 0.3, c: 0xffe080 },
        { t: 0.7, c: 0xff5020 },
        { t: 1,   c: 0x400000 }
      ],
      alpha: [1, 0],
      sizeCurve: [1, 0.2],
      drag: 2.5,
      gravity: 120,
      additive: true,
      stretch: true
    });
  };

  /** Glittering effect around a power-up — multi-colored twinkles. */
  ParticleSystem.prototype.emitPowerupSparkle = function (x, y) {
    const palette = [0x60ffe0, 0xffe060, 0xff60c0, 0x80a0ff, 0xffffff];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const col = palette[(Math.random() * palette.length) | 0];
      this._spawnOne(x, y, resolveOpts({
        angle: Math.random() * Math.PI * 2,
        spread: 0,
        speed: [20, 70],
        life: [0.5, 1.0],
        size: [4, 10],
        color: [
          { t: 0,   c: 0xffffff },
          { t: 0.3, c: col },
          { t: 1,   c: col }
        ],
        alpha: [1, 0],
        sizeCurve: [0.2, 1.4],
        drag: 1.5,
        spin: [-6, 6],
        additive: true,
        positionJitter: [30, 30]
      }));
    }
  };

  /**
   * Emit a shield-impact ripple — a couple of concentric expanding rings.
   * Exposed as a convenience even though it isn't in the required method
   * list; call as particleSystem.emitShieldRipple(x, y, scale).
   */
  ParticleSystem.prototype.emitShieldRipple = function (x, y, scale) {
    scale = scale || 1;
    for (let i = 0; i < 3; i++) {
      const p = this._spawnOne(x, y, resolveOpts({
        angle: 0, spread: 0,
        speed: [0, 0],
        life: [0.45 + i * 0.08, 0.45 + i * 0.08],
        size: [40 * scale, 40 * scale],
        color: [
          { t: 0, c: 0xa0f8ff },
          { t: 0.5, c: 0x40b0ff },
          { t: 1, c: 0x1040a0 }
        ],
        alpha: [0.9, 0],
        sizeCurve: [1, 3.5 + i * 0.6],
        additive: true,
        ring: true,
        ringWidth: 0.18
      }));
      if (p) {
        // Stagger the rings slightly by shortening the first life.
        p.life = p.maxLife * (1 - i * 0.08);
      }
    }
  };

  /** Muzzle flash — short bright burst at a gun barrel. */
  ParticleSystem.prototype.emitMuzzleFlash = function (x, y, angle) {
    this.emitBurst(x, y, 8, {
      angle: angle != null ? angle : Math.PI * 0.5,
      spread: 0.8,
      speed: [60, 200],
      life: [0.06, 0.14],
      size: [18, 34],
      color: [
        { t: 0,   c: 0xffffff },
        { t: 0.4, c: 0xb0f8ff },
        { t: 1,   c: 0x18a0ff }
      ],
      alpha: [1, 0],
      sizeCurve: [0.3, 1.8],
      drag: 4.0,
      additive: true
    });
  };

  /** Ambient star-dust background particles (slow, faint, long-lived). */
  ParticleSystem.prototype.emitStarDust = function (x, y) {
    this._spawnOne(x, y, resolveOpts({
      angle: Math.random() * Math.PI * 2,
      spread: 0,
      speed: [4, 18],
      life: [3.0, 6.0],
      size: [2, 5],
      color: [
        { t: 0, c: 0xffffff },
        { t: 0.5, c: 0xb0c8ff },
        { t: 1, c: 0x5060a0 }
      ],
      alpha: [0.0, 0.5],
      sizeCurve: [1, 1],
      drag: 0.1,
      additive: true
    }));
  };

  /* ── Update ────────────────────────────────────────────────────────── */

  /**
   * Advance every active particle by `dt` seconds, apply behaviours, bake
   * the current color/size/alpha into the geometry buffers, and mark dead
   * particles for recycling.  Two buffer sets are written (additive +
   * normal) so each blend mode renders in one draw call.
   */
  ParticleSystem.prototype.update = function (dt) {
    if (dt <= 0) return;
    // Clamp dt to avoid huge steps after tab switches.
    if (dt > 0.05) dt = 0.05;

    const pool = this.pool;
    const N = pool.length;

    // Live-particle write cursors for the two blend-mode geometries.
    let aCount = 0, nCount = 0;

    // Reusable scratch for color sampling.
    const out = this._colorOut;

    // Local references to the additive buffers (hot loop).
    const posA = this._posA, colA = this._colA, alpA = this._alphaA,
          sizA = this._sizeA, rotA = this._rotA, maxA = this._maxA,
          lifeA = this._lifeA, ringA = this._ringA, ringWA = this._ringWA;
    // Local references to the normal-blend buffers.
    const posN = this._posN, colN = this._colN, alpN = this._alphaN,
          sizN = this._sizeN, rotN = this._rotN, maxN = this._maxN,
          lifeN = this._lifeN, ringN = this._ringN, ringWN = this._ringWN;

    for (let i = 0; i < N; i++) {
      const p = pool[i];
      if (!p.active) continue;

      // Lifetime.
      p.life -= dt;
      if (p.life <= 0) {
        this._retire(p);
        continue;
      }

      // Velocity integration with exponential drag + gravity.
      const df = Math.exp(-p.drag * dt);
      p.vx *= df;
      p.vy *= df;
      p.vy -= p.gravity * dt;   // gravity pulls toward -y (down)
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Rotation / spin.
      p.rotation += p.spin * dt;

      // Normalized life: 0 = birth, 1 = death.
      const t = 1.0 - (p.life / p.maxLife);

      // Size interpolation (base * sizeCurve(t)).
      const sizeMul = p.sizeBirth + (p.sizeDeath - p.sizeBirth) * t;
      const size = p.size * sizeMul;

      // Alpha interpolation.
      const alpha = p.alphaBirth + (p.alphaDeath - p.alphaBirth) * t;
      if (alpha <= 0.001) {
        this._retire(p);
        continue;
      }

      // Cull particles that drift far outside the playfield (safety).
      if (p.x < -900 || p.x > 900 || p.y < -1000 || p.y > 1100) {
        this._retire(p);
        continue;
      }

      // Color sampling.
      sampleColor(p, t, out);

      // Write into the appropriate buffer set.
      if (p.blendAdditive) {
        if (aCount >= N) continue;   // buffer full (shouldn't happen)
        const o3 = aCount * 3;
        posA[o3]      = p.x; posA[o3 + 1] = p.y; posA[o3 + 2] = PLAYFIELD_Z;
        colA[o3]      = out[0]; colA[o3 + 1] = out[1]; colA[o3 + 2] = out[2];
        alpA[aCount]   = alpha;
        sizA[aCount]   = size;
        rotA[aCount]   = p.rotation;
        maxA[aCount]   = p.maxLife;
        lifeA[aCount]  = p.life;          // >0 => alive in the shader
        ringA[aCount]  = p.ring ? 1.0 : 0.0;
        ringWA[aCount] = p.ringWidth;
        aCount++;
      } else {
        if (nCount >= N) continue;
        const o3 = nCount * 3;
        posN[o3]      = p.x; posN[o3 + 1] = p.y; posN[o3 + 2] = PLAYFIELD_Z;
        colN[o3]      = out[0]; colN[o3 + 1] = out[1]; colN[o3 + 2] = out[2];
        alpN[nCount]   = alpha;
        sizN[nCount]   = size;
        rotN[nCount]   = p.rotation;
        maxN[nCount]   = p.maxLife;
        lifeN[nCount]  = p.life;
        ringN[nCount]  = p.ring ? 1.0 : 0.0;
        ringWN[nCount] = p.ringWidth;
        nCount++;
      }
    }

    // Zero the life of dead slots beyond the live count so the vertex
    // shader's `vAlive` check discards them (defence in depth on top of
    // the draw range, which already limits the emitted vertices).
    for (let i = aCount; i < N; i++) lifeA[i] = 0;
    for (let i = nCount; i < N; i++) lifeN[i] = 0;

    // Restrict the draw range to only the live particles.
    this.geoA.setDrawRange(0, aCount);
    this.geoN.setDrawRange(0, nCount);

    // Flag attributes for GPU upload.
    const ga = this.geoA.attributes, gn = this.geoN.attributes;
    ga.position.needsUpdate = true;    gn.position.needsUpdate = true;
    ga.aLife.needsUpdate = true;        gn.aLife.needsUpdate = true;
    ga.aMaxLife.needsUpdate = true;     gn.aMaxLife.needsUpdate = true;
    ga.aSize.needsUpdate = true;        gn.aSize.needsUpdate = true;
    ga.aRotation.needsUpdate = true;    gn.aRotation.needsUpdate = true;
    ga.aColor.needsUpdate = true;        gn.aColor.needsUpdate = true;
    ga.aAlpha.needsUpdate = true;        gn.aAlpha.needsUpdate = true;
    ga.aRing.needsUpdate = true;         gn.aRing.needsUpdate = true;
    ga.aRingWidth.needsUpdate = true;    gn.aRingWidth.needsUpdate = true;
  };

  /* ── Clear / Destroy ───────────────────────────────────────────────── */

  /** Kill every active particle immediately. */
  ParticleSystem.prototype.clear = function () {
    const pool = this.pool;
    for (let i = 0; i < pool.length; i++) {
      pool[i].active = false;
    }
    this.activeCount = 0;
    // Zero the alive-flag buffers and shrink the draw range so nothing renders.
    for (let i = 0; i < this._lifeA.length; i++) this._lifeA[i] = 0;
    for (let i = 0; i < this._lifeN.length; i++) this._lifeN[i] = 0;
    if (this.geoA) {
      this.geoA.attributes.aLife.needsUpdate = true;
      this.geoA.setDrawRange(0, 0);
    }
    if (this.geoN) {
      this.geoN.attributes.aLife.needsUpdate = true;
      this.geoN.setDrawRange(0, 0);
    }
  };

  /** Free all GPU resources and detach from the scene. */
  ParticleSystem.prototype.destroy = function () {
    this.clear();
    if (this.pointsA) {
      this.scene.remove(this.pointsA);
      this.geoA.dispose();
      this.materialAdditive.dispose();
      this.pointsA = null;
    }
    if (this.pointsN) {
      this.scene.remove(this.pointsN);
      this.geoN.dispose();
      this.materialNormal.dispose();
      this.pointsN = null;
    }
    if (this._tex) {
      this._tex.dispose();
      this._tex = null;
    }
    this.pool = null;
  };

  /* ── Export ────────────────────────────────────────────────────────── */

  global.ParticleSystem = ParticleSystem;

})(typeof window !== 'undefined' ? window : this);
