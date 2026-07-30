/* =============================================================================
 *  Effects.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  Screen-space and world-space visual effects layer.  This module owns all the
 *  "juice": screen shake, full-screen colour flashes, chromatic aberration,
 *  vignette pulse, slow-motion time scaling, scanline intensification, wave-
 *  transition flash, and floating combat text (score popups, combo text, boss
 *  damage numbers).
 *
 *  Architecture
 *  ------------
 *    • Effects sits between the Game and the renderer.  The Game calls
 *      effects.update(dt) each frame *before* rendering, then renders.  Effects
 *      applies transient offsets to the supplied camera (shake) and mutates a
 *      stack of overlay layers (DOM divs / canvas) that sit above the WebGL
 *      canvas.  After rendering the Game is expected to call
 *      effects.restoreCamera() — or, more simply, Effects restores the camera
 *      baseline itself at the end of update() and applies the shake offset on
 *      top of the stored baseline, so the camera never drifts.
 *
 *    • Overlays are lightweight DOM elements appended to the provided
 *      `container` (the game's overlay div, positioned above the canvas).
 *      Using DOM for flashes / vignette / scanlines keeps the WebGL pipeline
 *      untouched and is plenty fast for a few full-screen tinted divs.
 *
 *    • Floating combat text uses a small pooled set of DOM elements to avoid
 *      per-frame allocation churn.  Each floating element has a velocity,
 *      life, and is animated in update(dt) and recycled when it fades out.
 *
 *    • Slow motion is implemented as a time-scale value the Game reads via
 *      getTimeScale(); the Game multiplies its dt by this.  setSlowMo(bool)
 *      toggles a sustained slow-mo, while slowMotion(scale,duration) fires a
 *      one-shot brief slow-mo that eases back to 1.0.
 *
 *  Constructor:   new Effects(scene, camera, container)
 *      scene      THREE.Scene (currently unused but reserved for future
 *                 world-space effect meshes, e.g. a shockwave ring).
 *      camera     THREE.Camera whose position is shaken.
 *      container  HTMLElement overlay div above the canvas (absolute pos).
 *
 *  Public API:
 *      shake(intensity, duration)
 *      flash(color, duration)
 *      slowMotion(scale, duration)
 *      scorePopup(x, y, text, color)
 *      comboPopup(x, y, multiplier)
 *      damageNumber(x, y, amount)
 *      update(dt)
 *      setSlowMo(bool)
 *      getTimeScale()                 // for the Game to scale its dt
 *      restoreCamera()                // snap camera back to baseline
 *      destroy()
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  var SHAKE_DECAY       = 5.0;     // shake amplitude decay rate (1/s)
  var SHAKE_FREQ        = 28;       // shake noise frequency (hz-ish)
  var MAX_FLOATERS      = 64;       // pooled floating-text elements
  var FLOATER_POOL_GROW = 16;       // grow step if pool runs out
  var SLOWMO_EASE       = 3.0;      // how fast slow-mo eases back to 1.0
  var VIGNETTE_PULSE_DECAY = 4.0;
  var SCANLINE_DECAY    = 5.0;
  var CHROMA_DECAY      = 4.0;

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(min, max) { return min + Math.random() * (max - min); }

  /** Parse a color string into r,g,b ints (supports #rgb, #rrggbb, and named
   *  colors via a temporary canvas).  Falls back to white. */
  function parseColor(str) {
    var tmp = parseColor._canvas || (parseColor._canvas = document.createElement('canvas'));
    var ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = str;
    var v = ctx.fillStyle;
    // Normalize to #rrggbb.
    if (typeof v === 'string' && v[0] === '#') {
      var hex = v.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return {
        r: parseInt(hex.slice(0, 2), 16) || 255,
        g: parseInt(hex.slice(2, 4), 16) || 255,
        b: parseInt(hex.slice(4, 6), 16) || 255
      };
    }
    return { r: 255, g: 255, b: 255 };
  }

  /* ── Effects ──────────────────────────────────────────────────────────── */

  function Effects(scene, camera, container) {
    this.scene = scene;
    this.camera = camera;
    this.container = container || document.body;

    /* Camera baseline (the rest position shake is applied around). */
    this._camBase = new THREE.Vector3();
    if (camera) this._camBase.copy(camera.position);

    /* Shake state. */
    this._shakeAmp = 0;         // current amplitude (world units)
    this._shakeMax = 0;         // peak amplitude this shake
    this._shakeTime = 0;        // elapsed time in current shake
    this._shakeDuration = 0;    // total duration of current shake (s)
    this._shakeSeed = 0;        // phase seed for noise

    /* Flash overlay (single full-screen div). */
    this._flashEl = this._makeOverlay();
    this._flashColor = { r: 255, g: 255, b: 255 };
    this._flashTime = 0;
    this._flashDuration = 0;
    this._flashIntensity = 0;   // current alpha 0..1

    /* Vignette overlay (always present; pulses on damage). */
    this._vignetteEl = this._makeOverlay();
    this._vignetteEl.style.pointerEvents = 'none';
    this._vignetteEl.style.background =
      'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)';
    this._vignetteEl.style.opacity = '1';
    this._vignetteBaseOpacity = 1.0;
    this._vignettePulse = 0;     // extra opacity added by a pulse, decays to 0

    /* Scanline overlay. */
    this._scanlineEl = this._makeOverlay();
    this._scanlineEl.style.backgroundImage =
      'repeating-linear-gradient(0deg, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0.25) 1px, transparent 1px, transparent 3px)';
    this._scanlineEl.style.opacity = '0.18';
    this._scanlineBaseOpacity = 0.18;
    this._scanlineBoost = 0;     // extra opacity, decays

    /* Chromatic aberration — applied via CSS filter on the container's canvas.
     * We approximate RGB channel split using a drop-shadow hack layered onto
     * the canvas filter string.  _chromaAmount decays toward 0. */
    this._chromaAmount = 0;
    this._canvas = null;        // discovered lazily

    /* Slow motion. */
    this._timeScale = 1.0;       // current effective time scale
    this._slowMoTarget = 1.0;    // sustained target (setSlowMo)
    this._slowMoOneShot = null;  // { scale, duration, time } or null

    /* Floating combat text pool. */
    this._floaters = [];
    this._floaterPool = [];
    this._buildFloaterPool(MAX_FLOATERS);

    /* Wave-transition flash is just flash('white', duration) — no separate
     * state needed, but we keep a flag so callers can chain a vignette pulse. */
  }

  /* ── Overlay helpers ──────────────────────────────────────────────────── */

  /** Create a full-size absolute overlay div appended to the container. */
  Effects.prototype._makeOverlay = function () {
    var el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    el.style.opacity = '0';
    el.style.zIndex = '20';
    el.style.mixBlendMode = 'screen';
    this.container.appendChild(el);
    return el;
  };

  /** Lazily find the WebGL canvas inside the container (for chroma filter). */
  Effects.prototype._findCanvas = function () {
    if (this._canvas) return this._canvas;
    var c = this.container.querySelector('canvas');
    if (!c) {
      // Fall back to the first canvas in the document.
      c = document.querySelector('canvas');
    }
    this._canvas = c;
    return c;
  };

  /* ── Screen shake ─────────────────────────────────────────────────────── */

  /**
   * Trigger a screen shake of the given intensity (world-space amplitude) and
   * duration (seconds).  A new call reinforces the shake: if the new shake is
   * stronger than the remainder of the current one, it replaces it.
   */
  Effects.prototype.shake = function (intensity, duration) {
    intensity = Math.max(0, intensity || 0);
    duration = Math.max(0.05, duration || 0.3);
    // Compute remaining amplitude of the current shake.
    var remaining = this._shakeAmp;
    if (intensity >= remaining) {
      this._shakeMax = intensity;
      this._shakeAmp = intensity;
      this._shakeTime = 0;
      this._shakeDuration = duration;
      this._shakeSeed = Math.random() * 1000;
    } else {
      // Extend duration slightly for a minor additive jolt.
      this._shakeDuration = Math.max(this._shakeDuration - this._shakeTime, duration);
      this._shakeTime = 0;
    }
  };

  /** Apply the current shake offset to the camera.  Called from update(). */
  Effects.prototype._applyShake = function (dt) {
    if (!this.camera) return;
    if (this._shakeAmp <= 0.0001) {
      // Restore baseline.
      this.camera.position.copy(this._camBase);
      return;
    }

    this._shakeTime += dt;
    // Exponential decay of amplitude over the shake window.
    var t = this._shakeTime / this._shakeDuration;
    if (t >= 1) {
      this._shakeAmp = 0;
      this.camera.position.copy(this._camBase);
      return;
    }
    var decayed = this._shakeMax * Math.pow(1 - t, SHAKE_DECAY / 3);
    this._shakeAmp = decayed;

    // Smooth pseudo-noise via summed sines (cheap, no allocations).
    var s = this._shakeSeed;
    var f = SHAKE_FREQ;
    var nx = Math.sin(s + this._shakeTime * f) * 0.6 +
             Math.sin(s * 1.7 + this._shakeTime * f * 2.3) * 0.3 +
             Math.sin(s * 3.1 + this._shakeTime * f * 0.7) * 0.1;
    var ny = Math.cos(s * 1.3 + this._shakeTime * f * 1.1) * 0.6 +
             Math.cos(s * 2.1 + this._shakeTime * f * 1.9) * 0.3 +
             Math.cos(s * 0.9 + this._shakeTime * f * 2.7) * 0.1;

    this.camera.position.x = this._camBase.x + nx * decayed;
    this.camera.position.y = this._camBase.y + ny * decayed;
    // Keep z steady so we don't alter apparent scale.
    this.camera.position.z = this._camBase.z;
  };

  /** Snap the camera back to its baseline immediately. */
  Effects.prototype.restoreCamera = function () {
    if (this.camera) this.camera.position.copy(this._camBase);
    this._shakeAmp = 0;
  };

  /* ── Flash overlay ────────────────────────────────────────────────────── */

  /**
   * Full-screen colour flash.  `color` may be a CSS color string ('#fff',
   * 'red', 'rgba(0,255,255,0.8)') or a hex int 0xRRGGBB.  Fades out over
   * `duration` seconds.  A new flash replaces the current one.
   */
  Effects.prototype.flash = function (color, duration) {
    duration = Math.max(0.05, duration || 0.25);
    var css;
    if (typeof color === 'number') {
      css = '#' + color.toString(16).padStart(6, '0');
    } else if (typeof color === 'string') {
      css = color;
    } else {
      css = '#ffffff';
    }
    this._flashColor = parseColor(css);
    this._flashEl.style.background = css;
    this._flashDuration = duration;
    this._flashTime = 0;
    this._flashIntensity = 1;
    this._flashEl.style.opacity = '1';
  };

  Effects.prototype._updateFlash = function (dt) {
    if (this._flashIntensity <= 0) return;
    this._flashTime += dt;
    var t = this._flashTime / this._flashDuration;
    if (t >= 1) {
      this._flashIntensity = 0;
      this._flashEl.style.opacity = '0';
      return;
    }
    // Fast onset, smooth exponential fade.
    var a = Math.pow(1 - t, 2.2);
    this._flashIntensity = a;
    this._flashEl.style.opacity = a.toFixed(3);
  };

  /* ── Chromatic aberration ────────────────────────────────────────────── */

  /**
   * Kick chromatic aberration intensity up by `amount` (0..~1).  Decays
   * automatically.  Approximated via CSS filter drop-shadows on the canvas
   * (red offset one way, blue the other) — a cheap, GPU-accelerated stand-in
   * for a real channel-split shader pass.
   */
  Effects.prototype.chromaticAberration = function (amount) {
    this._chromaAmount = Math.min(1.2, Math.max(this._chromaAmount, amount || 0.4));
  };

  Effects.prototype._updateChroma = function (dt) {
    if (this._chromaAmount <= 0.001) {
      if (this._canvas) this._canvas.style.filter = '';
      return;
    }
    this._chromaAmount = Math.max(0, this._chromaAmount - dt * CHROMA_DECAY * this._chromaAmount);
    var px = (this._chromaAmount * 6).toFixed(2);          // pixel offset
    // Two drop-shadows: warm to the left, cool to the right.
    var filter =
      'drop-shadow(-' + px + 'px 0 0 rgba(255,0,80,0.55)) ' +
      'drop-shadow(' + px + 'px 0 0 rgba(0,200,255,0.55))';
    var c = this._findCanvas();
    if (c) c.style.filter = filter;
  };

  /* ── Vignette pulse ──────────────────────────────────────────────────── */

  /**
   * Pulse the vignette darker for a moment — call on player damage.  The
   * extra darkness decays over ~0.4s.
   */
  Effects.prototype.vignettePulse = function (strength) {
    this._vignettePulse = clamp(strength || 0.6, 0, 1);
  };

  Effects.prototype._updateVignette = function (dt) {
    if (this._vignettePulse > 0) {
      this._vignettePulse = Math.max(0, this._vignettePulse - dt * VIGNETTE_PULSE_DECAY);
    }
    // Total opacity = base (always visible) + pulse-driven extra darkness.
    var op = clamp(this._vignetteBaseOpacity + this._vignettePulse * 0.6, 0, 1.4);
    this._vignetteEl.style.opacity = op.toFixed(3);
  };

  /* ── Scanline intensification ────────────────────────────────────────── */

  /**
   * Briefly strengthen the scanline overlay — used on EMP / special effects.
   */
  Effects.prototype.scanlinePulse = function (strength) {
    this._scanlineBoost = clamp(strength || 0.5, 0, 1);
  };

  Effects.prototype._updateScanlines = function (dt) {
    if (this._scanlineBoost > 0) {
      this._scanlineBoost = Math.max(0, this._scanlineBoost - dt * SCANLINE_DECAY * this._scanlineBoost);
    }
    var op = clamp(this._scanlineBaseOpacity + this._scanlineBoost * 0.5, 0, 1);
    this._scanlineEl.style.opacity = op.toFixed(3);
  };

  /* ── Slow motion ─────────────────────────────────────────────────────── */

  /**
   * Sustained slow-mo toggle.  When on, time scale eases toward 0.4; when off
   * it eases back to 1.0.  One-shot slowMotion() calls stack on top but do
   * not override this target when they finish.
   */
  Effects.prototype.setSlowMo = function (on) {
    this._slowMoTarget = on ? 0.4 : 1.0;
  };

  /**
   * Fire a one-shot brief slow-motion: instantly dip the time scale to `scale`
   * and ease it back to 1.0 (or to the sustained target) over `duration`.
   */
  Effects.prototype.slowMotion = function (scale, duration) {
    scale = clamp(scale || 0.3, 0.05, 1.0);
    duration = Math.max(0.1, duration || 0.5);
    this._slowMoOneShot = { scale: scale, duration: duration, time: 0 };
    // Snap immediately for impact.
    this._timeScale = scale;
  };

  /** Current effective time scale for the Game to multiply its dt by. */
  Effects.prototype.getTimeScale = function () {
    return this._timeScale;
  };

  Effects.prototype._updateSlowMo = function (dt) {
    // One-shot overrides the sustained easing while it's active.
    if (this._slowMoOneShot) {
      this._slowMoOneShot.time += dt;
      var tt = this._slowMoOneShot.time / this._slowMoOneShot.duration;
      if (tt >= 1) {
        this._slowMoOneShot = null;
        this._timeScale = this._slowMoTarget;
      } else {
        // Ease from the one-shot scale up toward the sustained target.
        var from = this._slowMoOneShot.scale;
        var to = this._slowMoTarget;
        this._timeScale = lerp(from, to, 1 - Math.pow(1 - tt, 2));
      }
      return;
    }
    // Ease toward the sustained target.
    this._timeScale = lerp(this._timeScale, this._slowMoTarget, clamp(dt * SLOWMO_EASE, 0, 1));
  };

  /* ── Wave transition flash ───────────────────────────────────────────── */

  /**
   * A bright white flash at the start of each wave, paired with a vignette
   * pulse for emphasis.
   */
  Effects.prototype.waveFlash = function () {
    this.flash('#ffffff', 0.45);
    this.vignettePulse(0.4);
  };

  /* ── Floating combat text ─────────────────────────────────────────────── */

  /**
   * Build a pool of DOM elements used for floating text.  They start hidden.
   */
  Effects.prototype._buildFloaterPool = function (n) {
    for (var i = 0; i < n; i++) {
      this._floaterPool.push(this._makeFloater());
    }
  };

  Effects.prototype._makeFloater = function () {
    var el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    el.style.fontFamily = "'Consolas','Courier New',monospace";
    el.style.fontWeight = 'bold';
    el.style.whiteSpace = 'nowrap';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.textShadow = '0 0 6px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.8)';
    el.style.zIndex = '30';
    el.style.opacity = '0';
    el.style.display = 'none';
    this.container.appendChild(el);
    return el;
  };

  /** Check out a floater element from the pool (grows the pool if needed). */
  Effects.prototype._checkoutFloater = function () {
    for (var i = 0; i < this._floaterPool.length; i++) {
      if (!this._floaterPool[i]._active) return this._floaterPool[i];
    }
    // Grow the pool.
    for (var j = 0; j < FLOATER_POOL_GROW; j++) {
      this._floaterPool.push(this._makeFloater());
    }
    return this._floaterPool[this._floaterPool.length - FLOATER_POOL_GROW];
  };

  /**
   * Spawn a generic floating-text popup at screen coords (x,y) in pixels,
   * relative to the container.
   * @param {number} x        container-relative pixel x
   * @param {number} y        container-relative pixel y
   * @param {string} text     text content
   * @param {string} color    CSS color
   * @param {number} size     font size in px
   * @param {number} vy       upward velocity (px/s; negative = rises)
   * @param {number} life      lifetime in seconds
   */
  Effects.prototype._spawnFloater = function (x, y, text, color, size, vy, life) {
    var el = this._checkoutFloater();
    el._active = true;
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = size + 'px';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.opacity = '1';
    el.style.display = 'block';
    // Grow-in pop.
    el.style.transition = 'none';
    el.style.transform = 'translate(-50%, -50%) scale(0.4)';
    // Force reflow so the scale transition resets cleanly.
    void el.offsetWidth;
    el.style.transition = 'transform 0.18s cubic-bezier(0.2,1.4,0.4,1)';
    el.style.transform = 'translate(-50%, -50%) scale(1)';

    this._floaters.push({
      el: el,
      x: x,
      y: y,
      vx: rand(-12, 12),
      vy: vy,
      life: life,
      maxLife: life,
      size: size,
      baseSize: size
    });
  };

  /**
   * Score popup: floating text that rises and fades when an enemy is killed.
   * @param {number} x   container-relative px
   * @param {number} y   container-relative px
   * @param {string} text  e.g. "+100"
   * @param {string} color CSS color
   */
  Effects.prototype.scorePopup = function (x, y, text, color) {
    this._spawnFloater(x, y, text, color || '#ffe66b', 22, -70, 0.9);
  };

  /**
   * Combo text: "COMBO xN" that grows in size with the combo multiplier.
   * @param {number} x
   * @param {number} y
   * @param {number} multiplier
   */
  Effects.prototype.comboPopup = function (x, y, multiplier) {
    var n = Math.max(2, Math.floor(multiplier || 2));
    var size = 22 + Math.min(28, n * 2);          // grows with combo
    var color = n >= 8 ? '#ff4ad8' : (n >= 4 ? '#ff9d3a' : '#7fffd4');
    this._spawnFloater(x, y, 'COMBO x' + n, color, size, -90, 1.1);
  };

  /**
   * Damage number: floating damage on the boss (or any tanky enemy).
   * @param {number} x
   * @param {number} y
   * @param {number} amount
   */
  Effects.prototype.damageNumber = function (x, y, amount) {
    this._spawnFloater(x, y, String(Math.floor(amount)), '#ffffff', 18, -55, 0.8);
  };

  /** Update all active floaters; recycle dead ones. */
  Effects.prototype._updateFloaters = function (dt) {
    for (var i = this._floaters.length - 1; i >= 0; i--) {
      var f = this._floaters[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el._active = false;
        f.el.style.display = 'none';
        f.el.style.opacity = '0';
        this._floaters.splice(i, 1);
        continue;
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      // Slight upward deceleration (gravity-ish but still floating).
      f.vy += 18 * dt;
      var t = f.life / f.maxLife;            // 1 -> 0
      var alpha = Math.min(1, t * 1.6);       // fade in the last 60%
      f.el.style.left = f.x + 'px';
      f.el.style.top = f.y + 'px';
      f.el.style.opacity = alpha.toFixed(3);
    }
  };

  /* ── Master update ────────────────────────────────────────────────────── */

  /**
   * Per-frame update.  Call BEFORE rendering (so the camera shake offset is in
   * place) and pass the resulting getTimeScale()-scaled dt for the next frame.
   * @param {number} dt  real delta seconds (NOT yet time-scaled)
   */
  Effects.prototype.update = function (dt) {
    // Keep the camera baseline synced if the game moves the camera elsewhere
    // (e.g. a zoom effect) — we snapshot the rest position when not shaking.
    if (this._shakeAmp <= 0.0001 && this.camera) {
      this._camBase.copy(this.camera.position);
    }

    this._applyShake(dt);
    this._updateFlash(dt);
    this._updateChroma(dt);
    this._updateVignette(dt);
    this._updateScanlines(dt);
    this._updateSlowMo(dt);
    this._updateFloaters(dt);
  };

  /* ── Teardown ──────────────────────────────────────────────────────────── */

  /**
   * Destroy all DOM elements and release references.  Safe to call once.
   */
  Effects.prototype.destroy = function () {
    // Floaters.
    for (var i = 0; i < this._floaters.length; i++) {
      this._floaters[i].el._active = false;
      if (this._floaters[i].el.parentNode) {
        this._floaters[i].el.parentNode.removeChild(this._floaters[i].el);
      }
    }
    this._floaters.length = 0;
    for (var j = 0; j < this._floaterPool.length; j++) {
      if (this._floaterPool[j].parentNode) {
        this._floaterPool[j].parentNode.removeChild(this._floaterPool[j]);
      }
    }
    this._floaterPool.length = 0;

    // Overlays.
    [this._flashEl, this._vignetteEl, this._scanlineEl].forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    this._flashEl = this._vignetteEl = this._scanlineEl = null;

    // Reset canvas filter.
    if (this._canvas) this._canvas.style.filter = '';

    this.camera = null;
    this.scene = null;
    this.container = null;
  };

  /* ── Export ─────────────────────────────────────────────────────────────── */
  global.Effects = Effects;

})(typeof window !== 'undefined' ? window : this);
