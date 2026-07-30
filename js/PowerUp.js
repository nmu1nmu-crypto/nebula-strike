/* =============================================================================
 *  PowerUp.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  Power-up system.  Power-ups drop from destroyed enemies, drift downward
 *  toward the player, float / bob / spin, glow with an additive aura, and —
 *  when collected — grant a timed effect (shield, rapid fire, weapon level,
 *  extra life, or a screen-clearing bomb) accompanied by a bright flash and
 *  a particle burst.
 *
 *  Power-up types:
 *      SHIELD  — green / cyan, grants a shield bubble (10 s)
 *      RAPID   — yellow,   rapid fire                         ( 8 s)
 *      MULTI   — magenta,   weapon level +1 (capped at 4)
 *      LIFE    — red heart, extra life
 *      BOMB    — orange,    screen-clearing bomb (onCollect callback)
 *
 *  Each power-up is a THREE.Sprite (icon) layered over a larger additive
 *  THREE.Sprite aura.  Both are pooled.  A 10-second lifetime with a blink
 *  warning in the final 2 seconds precedes despawn.
 *
 *  Constructor:   new PowerUpManager(scene, particleSystem)
 *
 *      scene           THREE.Scene the sprites are added to.
 *      particleSystem  optional object exposing
 *                      burst(x, y, count, colorHex, opts)
 *                      used for the collection particle burst.  If absent a
 *                      small self-contained burst is rendered instead.
 *
 *  Public API:
 *      spawn(x, y, type)                 create one power-up
 *      maybeDrop(x, y, [chanceOverride]) random drop on enemy death
 *      update(dt, playerPos, player)     advance motion / lifetime / effects
 *      checkPickup(player)               -> array of collected {x,y,type}
 *      clear()                           remove all live power-ups
 *      destroy()                         dispose all GPU resources
 *
 *  Player interface (any subset may be present):
 *      player.setShield(true|false)
 *      player.setRapidFire(true|false)
 *      player.setWeaponLevel(n)
 *      player.health / player.maxHealth   (for LIFE)
 *      player.position                    ({x,y})
 *
 *  Textures (from assets/textures/, with procedural fallbacks):
 *      powerup_shield.png  powerup_rapid.png  powerup_multi.png
 *      (LIFE and BOMB use procedural canvas textures so no extra assets
 *       are required.)
 *
 *  THREE.js (r0.160) global from CDN. No ES6 modules.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  var TEX_DIR        = 'assets/textures/';
  var POWERUP_SIZE    = 56;     // icon sprite scale (world units)
  var AURA_SIZE       = 120;    // aura sprite scale
  var DRIFT_SPEED     = 90;     // px/s downward drift toward player
  var DRIFT_ACCEL     = 28;     // px/s^2 — slight gravitational pull
  var LIFETIME         = 10;    // seconds before despawn
  var BLINK_TIME       = 2;     // blink in the final N seconds
  var PICKUP_RADIUS    = 46;    // collection distance from player centre
  var DROP_CHANCE      = 0.15;  // base probability an enemy drops a power-up
  var POOL_SIZE        = 24;    // pre-allocated power-up records

  // Timed effect durations (seconds).
  var SHIELD_DURATION = 10;
  var RAPID_DURATION  = 8;

  // Power-up type registry.  `color` is the aura colour (hex), `tex` is the
  // texture filename (null => procedural), `weight` biases random selection.
  var TYPES = {
    SHIELD: { id: 'SHIELD', color: 0x00ffcc, tex: 'powerup_shield.png', weight: 3, label: 'SHIELD' },
    RAPID:  { id: 'RAPID',  color: 0xffe000, tex: 'powerup_rapid.png',  weight: 3, label: 'RAPID FIRE' },
    MULTI:  { id: 'MULTI',  color: 0xff44dd, tex: 'powerup_multi.png',  weight: 3, label: 'WEAPON UP' },
    LIFE:   { id: 'LIFE',   color: 0xff3050, tex: null,                  weight: 1, label: 'EXTRA LIFE' },
    BOMB:   { id: 'BOMB',   color: 0xff8a1a, tex: null,                  weight: 1, label: 'BOMB' }
  };
  var TYPE_IDS = ['SHIELD', 'RAPID', 'MULTI', 'LIFE', 'BOMB'];

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function weightedPick() {
    var total = 0, i;
    for (i = 0; i < TYPE_IDS.length; i++) total += TYPES[TYPE_IDS[i]].weight;
    var r = Math.random() * total;
    for (i = 0; i < TYPE_IDS.length; i++) {
      r -= TYPES[TYPE_IDS[i]].weight;
      if (r <= 0) return TYPE_IDS[i];
    }
    return TYPE_IDS[0];
  }

  /** Soft radial-glow canvas texture (white core → transparent). */
  function makeGlowTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.20, 'rgba(255,255,255,0.80)');
    g.addColorStop(0.50, 'rgba(255,255,255,0.30)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /** Red heart icon texture for the LIFE power-up. */
  function makeHeartTexture() {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var cx = s / 2;
    // soft outer glow
    var g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0.00, 'rgba(255,80,100,0.55)');
    g.addColorStop(0.45, 'rgba(255,40,70,0.25)');
    g.addColorStop(1.00, 'rgba(255,0,0,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // heart shape
    ctx.fillStyle = 'rgba(255,60,80,1.0)';
    ctx.beginPath();
    var top = cx - 6;
    ctx.moveTo(cx, cx + 34);
    ctx.bezierCurveTo(cx + 40, cx + 4, cx + 34, top - 22, cx + 6, top - 14);
    ctx.bezierCurveTo(cx + 2, top - 16, cx - 2, top - 16, cx - 6, top - 14);
    ctx.bezierCurveTo(cx - 34, top - 22, cx - 40, cx + 4, cx, cx + 34);
    ctx.closePath();
    ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,200,210,0.85)';
    ctx.beginPath();
    ctx.ellipse(cx - 12, top - 4, 8, 12, -0.5, 0, Math.PI * 2);
    ctx.fill();
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /** Orange bomb / starburst icon texture for the BOMB power-up. */
  function makeBombTexture() {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var cx = s / 2;
    // glow
    var g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0.00, 'rgba(255,180,60,0.65)');
    g.addColorStop(0.45, 'rgba(255,120,20,0.28)');
    g.addColorStop(1.00, 'rgba(255,80,0,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // spiked star
    var spikes = 8, outer = 44, inner = 18;
    ctx.beginPath();
    for (var i = 0; i < spikes * 2; i++) {
      var r = (i % 2 === 0) ? outer : inner;
      var a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      var x = cx + Math.cos(a) * r;
      var y = cx + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    var fg = ctx.createRadialGradient(cx, cx, 0, cx, cx, outer);
    fg.addColorStop(0, 'rgba(255,240,180,1.0)');
    fg.addColorStop(1, 'rgba(255,120,0,1.0)');
    ctx.fillStyle = fg;
    ctx.fill();
    // bright core
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cx, 8, 0, Math.PI * 2);
    ctx.fill();
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /* ── PowerUp record ───────────────────────────────────────────────────── */

  /** A single power-up instance.  Built once, pooled, and recycled. */
  function PowerUpRecord() {
    this.alive = false;
    this.type = null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.age = 0;
    this.life = LIFETIME;
    this.phase = 0;       // bob / spin phase
    this.spin = 0;        // current rotation (radians)
    this.flashTimer = 0;  // collection flash countdown
    this.blinkOn = true;

    this.icon = null;     // THREE.Sprite (icon)
    this.aura = null;     // THREE.Sprite (additive glow)
    this.iconMat = null;
    this.auraMat = null;
  }

  /* ── PowerUpManager ───────────────────────────────────────────────────── */

  function PowerUpManager(scene, particleSystem) {
    this.scene = scene;
    this.particleSystem = particleSystem || null;

    // Shared textures.
    var loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    this._glowTex = makeGlowTexture();
    this._heartTex = makeHeartTexture();
    this._bombTex = makeBombTexture();
    this._tex = {};
    this._tex.SHIELD = this._load(loader, 'powerup_shield.png');
    this._tex.RAPID  = this._load(loader, 'powerup_rapid.png');
    this._tex.MULTI  = this._load(loader, 'powerup_multi.png');
    this._tex.LIFE   = this._heartTex;
    this._tex.BOMB   = this._bombTex;

    // Active + pool.
    this.active = [];
    this._pool = [];
    this._built = false;
    this._buildPool(POOL_SIZE);
    this._built = true;

    // Active timed effects on the player (for cleanup when superseded).
    this._shieldTimer = 0;
    this._rapidTimer  = 0;
    this._activePlayer = null;

    // Optional callback invoked when a BOMB is collected — the Game wires
    // this to clear the screen of enemies / bullets.
    this.onBomb = null;

    // Optional callback invoked whenever any power-up is collected:
    //     onCollect(type, x, y)
    this.onCollect = null;

    // Collection flash pool (a few reusable additive sprites).
    this._flashPool = [];
    this._flashActive = [];
    this._buildFlashPool(6);
  }

  PowerUpManager.prototype._load = function (loader, name) {
    var tex;
    try { tex = loader.load(TEX_DIR + name); } catch (e) { tex = this._glowTex; }
    return tex;
  };

  /* ── Pool construction ───────────────────────────────────────────────── */

  PowerUpManager.prototype._buildPool = function (n) {
    for (var i = 0; i < n; i++) {
      var rec = new PowerUpRecord();
      this._buildSprites(rec);
      this._hide(rec);
      this._pool.push(rec);
    }
  };

  PowerUpManager.prototype._buildSprites = function (rec) {
    // Aura (additive glow) — created first so it renders behind the icon.
    rec.auraMat = new THREE.SpriteMaterial({
      map: this._glowTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      color: new THREE.Color(0xffffff)
    });
    rec.aura = new THREE.Sprite(rec.auraMat);
    rec.aura.scale.set(AURA_SIZE, AURA_SIZE, 1);
    rec.aura.renderOrder = 14;
    this.scene.add(rec.aura);

    // Icon.
    rec.iconMat = new THREE.SpriteMaterial({
      map: this._glowTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
      rotation: 0
    });
    rec.icon = new THREE.Sprite(rec.iconMat);
    rec.icon.scale.set(POWERUP_SIZE, POWERUP_SIZE, 1);
    rec.icon.renderOrder = 15;
    this.scene.add(rec.icon);
  };

  PowerUpManager.prototype._buildFlashPool = function (n) {
    for (var i = 0; i < n; i++) {
      var mat = new THREE.SpriteMaterial({
        map: this._glowTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        color: new THREE.Color(0xffffff)
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(AURA_SIZE * 2, AURA_SIZE * 2, 1);
      sp.renderOrder = 30;
      sp.visible = false;
      this.scene.add(sp);
      this._flashPool.push({ sprite: sp, mat: mat, life: 0, maxLife: 1 });
    }
  };

  /* ── Pool checkout / return ───────────────────────────────────────────── */

  PowerUpManager.prototype._checkout = function () {
    for (var i = 0; i < this._pool.length; i++) {
      if (!this._pool[i].alive) {
        var rec = this._pool[i];
        rec.alive = true;
        this.active.push(rec);
        return rec;
      }
    }
    // Grow the pool once.
    var rec2 = new PowerUpRecord();
    this._buildSprites(rec2);
    this._hide(rec2);
    this._pool.push(rec2);
    rec2.alive = true;
    this.active.push(rec2);
    return rec2;
  };

  PowerUpManager.prototype._hide = function (rec) {
    rec.icon.visible = false;
    rec.aura.visible = false;
    rec.iconMat.opacity = 0;
    rec.auraMat.opacity = 0;
  };

  PowerUpManager.prototype._retire = function (rec) {
    rec.alive = false;
    this._hide(rec);
    var idx = this.active.indexOf(rec);
    if (idx >= 0) {
      var last = this.active.length - 1;
      this.active[idx] = this.active[last];
      this.active.pop();
    }
  };

  /* ── Public spawning API ──────────────────────────────────────────────── */

  /**
   * Spawn a power-up of the given type at world (x, y).
   * @param {number} x
   * @param {number} y
   * @param {string} type  one of TYPE_IDS ('SHIELD','RAPID','MULTI','LIFE','BOMB')
   */
  PowerUpManager.prototype.spawn = function (x, y, type) {
    if (!TYPES[type]) type = weightedPick();
    var rec = this._checkout();
    var cfg = TYPES[type];

    rec.type = type;
    rec.x = x;
    rec.y = y;
    rec.vx = (Math.random() - 0.5) * 40;
    rec.vy = DRIFT_SPEED * (0.7 + Math.random() * 0.6);
    rec.age = 0;
    rec.life = LIFETIME;
    rec.phase = Math.random() * Math.PI * 2;
    rec.spin = 0;
    rec.flashTimer = 0;
    rec.blinkOn = true;

    // Wire textures / colours.
    var tex = this._tex[type] || this._glowTex;
    if (rec.iconMat.map !== tex) {
      rec.iconMat.map = tex;
      rec.iconMat.needsUpdate = true;
    }
    rec.iconMat.color.setHex(0xffffff);
    rec.iconMat.opacity = 1;
    rec.iconMat.rotation = 0;
    rec.auraMat.color.setHex(cfg.color);
    rec.auraMat.opacity = 0.55;

    rec.icon.visible = true;
    rec.aura.visible = true;

    this._syncTransform(rec);
    return rec;
  };

  /**
   * Roll for a random drop on enemy death.  Returns the spawned record or null.
   * @param {number} x
   * @param {number} y
   * @param {number} [chance]  override drop probability (default DROP_CHANCE)
   */
  PowerUpManager.prototype.maybeDrop = function (x, y, chance) {
    var p = (chance != null) ? chance : DROP_CHANCE;
    if (Math.random() >= p) return null;
    return this.spawn(x, y, weightedPick());
  };

  /* ── Update ───────────────────────────────────────────────────────────── */

  /**
   * Per-frame update.
   * @param {number} dt          delta seconds
   * @param {object} playerPos   {x, y} player position (for gravity pull)
   * @param {object} player      the Player (for timed-effect application)
   */
  PowerUpManager.prototype.update = function (dt, playerPos, player) {
    this._updateTimedEffects(dt, player);
    this._updateFlashes(dt);

    for (var i = this.active.length - 1; i >= 0; i--) {
      var rec = this.active[i];

      // Lifetime.
      rec.age += dt;
      var remaining = rec.life - rec.age;

      // Motion: drift downward, with a gentle pull toward the player's x.
      if (playerPos) {
        var dx = playerPos.x - rec.x;
        rec.vx += clamp(dx, -1, 1) * 18 * dt;   // nudge horizontally toward player
      }
      rec.vy += DRIFT_ACCEL * dt;                 // accelerate downward
      // Cap velocities so it never homes too aggressively.
      var maxV = 220;
      if (rec.vx > maxV) rec.vx = maxV; else if (rec.vx < -maxV) rec.vx = -maxV;
      if (rec.vy > maxV) rec.vy = maxV; else if (rec.vy < 0) rec.vy = 0;
      rec.x += rec.vx * dt;
      rec.y += rec.vy * dt;

      // Bob + spin.
      rec.phase += dt * 3.0;
      rec.spin += dt * 1.8;

      // Blink in the final BLINK_TIME seconds.
      if (remaining < BLINK_TIME) {
        // ~8 Hz blink, accelerating slightly near the end.
        var freq = 8 + (1 - remaining / BLINK_TIME) * 6;
        rec.blinkOn = (Math.sin(rec.age * freq * Math.PI) > -0.2);
      } else {
        rec.blinkOn = true;
      }

      // Aura pulse.
      var pulse = 0.45 + 0.25 * Math.sin(rec.phase * 1.5);
      rec.auraMat.opacity = rec.blinkOn ? pulse : 0;
      rec.iconMat.opacity = rec.blinkOn ? 1 : 0.15;

      // Despawn off the bottom of the playfield or at end of life.
      if (rec.y < -700 || remaining <= 0) {
        this._retire(rec);
        continue;
      }

      this._syncTransform(rec);
    }
  };

  /** Apply / expire the timed shield + rapid-fire effects on the player. */
  PowerUpManager.prototype._updateTimedEffects = function (dt, player) {
    if (!player) return;
    if (this._shieldTimer > 0) {
      this._shieldTimer -= dt;
      if (this._shieldTimer <= 0) {
        this._shieldTimer = 0;
        if (typeof player.setShield === 'function') player.setShield(false);
      }
    }
    if (this._rapidTimer > 0) {
      this._rapidTimer -= dt;
      if (this._rapidTimer <= 0) {
        this._rapidTimer = 0;
        if (typeof player.setRapidFire === 'function') player.setRapidFire(false);
      }
    }
  };

  /* ── Pickup detection ─────────────────────────────────────────────────── */

  /**
   * Check all live power-ups for overlap with the player.  Collects any that
   * are within PICKUP_RADIUS, applies their effect, triggers a flash + particle
   * burst, and returns the list of collected items.
   * @param {object} player   expected to expose {position:{x,y}, setShield,
   *                          setRapidFire, setWeaponLevel, health, maxHealth}
   * @returns {Array<{x,y,type}>} collected items this frame
   */
  PowerUpManager.prototype.checkPickup = function (player) {
    var collected = [];
    if (!player) return collected;
    var px = player.position ? player.position.x : 0;
    var py = player.position ? player.position.y : 0;

    for (var i = this.active.length - 1; i >= 0; i--) {
      var rec = this.active[i];
      if (!rec.alive) continue;
      var ddx = rec.x - px;
      var ddy = rec.y - py;
      var dist = Math.hypot(ddx, ddy);
      if (dist <= PICKUP_RADIUS) {
        this._applyEffect(rec, player);
        this._spawnFlash(rec.x, rec.y, TYPES[rec.type].color);
        this._spawnBurst(rec.x, rec.y, TYPES[rec.type].color);
        collected.push({ x: rec.x, y: rec.y, type: rec.type });
        this._retire(rec);
      }
    }
    return collected;
  };

  /** Apply a single power-up's gameplay effect to the player. */
  PowerUpManager.prototype._applyEffect = function (rec, player) {
    switch (rec.type) {
      case 'SHIELD':
        if (typeof player.setShield === 'function') player.setShield(true);
        this._shieldTimer = SHIELD_DURATION;
        this._activePlayer = player;
        break;
      case 'RAPID':
        if (typeof player.setRapidFire === 'function') player.setRapidFire(true);
        this._rapidTimer = RAPID_DURATION;
        this._activePlayer = player;
        break;
      case 'MULTI':
        if (typeof player.setWeaponLevel === 'function') {
          var lvl = (player.weaponLevel != null) ? player.weaponLevel + 1 : 2;
          player.setWeaponLevel(lvl);
        }
        break;
      case 'LIFE':
        if (player.maxHealth != null && player.health != null) {
          player.health = Math.min(player.maxHealth + 1, player.health + 1);
          if (player.maxHealth < player.health) player.maxHealth = player.health;
        }
        break;
      case 'BOMB':
        // Screen-clearing bomb — delegate to the Game via callback.
        if (typeof this.onBomb === 'function') this.onBomb(rec.x, rec.y);
        break;
    }
    if (typeof this.onCollect === 'function') {
      this.onCollect(rec.type, rec.x, rec.y);
    }
  };

  /* ── Visual feedback: flash + particle burst ──────────────────────────── */

  PowerUpManager.prototype._spawnFlash = function (x, y, color) {
    var f = this._flashPool.pop() || { sprite: null, mat: null, life: 0, maxLife: 1 };
    if (!f.sprite) {
      var mat = new THREE.SpriteMaterial({
        map: this._glowTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        color: new THREE.Color(color)
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(AURA_SIZE * 2, AURA_SIZE * 2, 1);
      sp.renderOrder = 30;
      this.scene.add(sp);
      f.sprite = sp;
      f.mat = mat;
    }
    f.mat.color.setHex(color);
    f.mat.opacity = 1;
    f.life = 0.4;
    f.maxLife = 0.4;
    f.sprite.position.set(x, y, 0.2);
    f.sprite.visible = true;
    this._flashActive.push(f);
  };

  PowerUpManager.prototype._updateFlashes = function (dt) {
    for (var i = this._flashActive.length - 1; i >= 0; i--) {
      var f = this._flashActive[i];
      f.life -= dt;
      var t = clamp(f.life / f.maxLife, 0, 1);
      f.mat.opacity = t;
      var s = AURA_SIZE * 2 * (1 + (1 - t) * 0.6);
      f.sprite.scale.set(s, s, 1);
      if (f.life <= 0) {
        f.sprite.visible = false;
        f.mat.opacity = 0;
        this._flashActive.splice(i, 1);
        this._flashPool.push(f);
      }
    }
  };

  /**
   * Spawn a collection particle burst.  Delegates to the supplied
   * particleSystem.burst(...) when available, otherwise renders a small
   * self-contained radial burst of additive sprites.
   */
  PowerUpManager.prototype._spawnBurst = function (x, y, color) {
    if (this.particleSystem && typeof this.particleSystem.burst === 'function') {
      try {
        this.particleSystem.burst(x, y, 24, color, { speed: 260, life: 0.6, size: 22 });
      } catch (e) { /* ignore particle system errors */ }
      return;
    }
    // Fallback: reuse the flash pool sprites as quick sparks.
    if (typeof color !== 'number') color = 0xffffff;
    // (The flash sprite already provides a bright additive pop; we add a
    // couple of extra mini-flashes offset randomly for a burst feel.)
    for (var k = 0; k < 4; k++) {
      var off = 30;
      var ox = (Math.random() - 0.5) * off;
      var oy = (Math.random() - 0.5) * off;
      this._spawnFlash(x + ox, y + oy, color);
    }
  };

  /* ── Transform sync ───────────────────────────────────────────────────── */

  PowerUpManager.prototype._syncTransform = function (rec) {
    var bob = Math.sin(rec.phase) * 6;
    rec.icon.position.set(rec.x, rec.y + bob, 0);
    rec.iconMat.rotation = rec.spin;
    rec.aura.position.set(rec.x, rec.y + bob, -0.5);
    rec.auraMat.rotation = rec.spin * 0.5;
  };

  /* ── Clear / destroy ──────────────────────────────────────────────────── */

  /** Remove all live power-ups immediately (e.g. on wave change). */
  PowerUpManager.prototype.clear = function () {
    while (this.active.length) this._retire(this.active[0]);
    // Expire timed effects.
    this._shieldTimer = 0;
    this._rapidTimer = 0;
  };

  /**
   * Dispose all GPU resources.  After this the manager is unusable.
   */
  PowerUpManager.prototype.destroy = function () {
    // Retire actives first (so the pool holds everything).
    while (this.active.length) this._retire(this.active[0]);

    var disposeSprite = function (sp) {
      if (!sp) return;
      this.scene.remove(sp);
      if (sp.material) {
        // Shared textures are disposed separately below; don't double-dispose.
        sp.material.dispose();
      }
    }.bind(this);

    for (var i = 0; i < this._pool.length; i++) {
      var rec = this._pool[i];
      disposeSprite(rec.icon);
      disposeSprite(rec.aura);
    }
    for (var f = 0; f < this._flashActive.length; f++) disposeSprite(this._flashActive[f].sprite);
    while (this._flashPool.length) disposeSprite(this._flashPool.pop().sprite);
    this._flashActive.length = 0;

    // Dispose shared textures we own.
    if (this._glowTex) this._glowTex.dispose();
    if (this._heartTex) this._heartTex.dispose();
    if (this._bombTex) this._bombTex.dispose();
    // Loaded PNG textures: dispose those that aren't shared fallbacks.
    var keys = ['SHIELD', 'RAPID', 'MULTI'];
    for (var k = 0; k < keys.length; k++) {
      var t = this._tex[keys[k]];
      if (t && t !== this._glowTex) {
        try { t.dispose(); } catch (e) {}
      }
    }
    this._pool.length = 0;
    this.active.length = 0;
  };

  /* ── Export ───────────────────────────────────────────────────────────── */
  PowerUpManager.TYPES = TYPES;
  global.PowerUpManager = PowerUpManager;
})(window);
