/* =============================================================================
 *  Player.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  The hero ship.  Rendered as a THREE.Sprite backed by player_ship.png with an
 *  animated engine-trail sprite, a self-contained cyan engine-glow particle
 *  system, a shield bubble, banking animation, idle bob, multi-level weapons,
 *  a chargeable hyperbeam special, and full hit / invulnerability feedback.
 *
 *  Constructor:   new Player(scene)
 *      scene  THREE.Scene the ship is added to.
 *
 *  External interfaces the Player expects:
 *
 *      bulletManager.spawnPlayerBullet(x, y, vx, vy)
 *          Spawns one player bullet at world (x,y) with velocity (vx,vy).
 *          Called by Player.update() when firing.  Implemented in Bullet.js.
 *
 *      input = { left, right, up, down, fire, special }   // booleans
 *          Passed into update().  Implemented in Input.js.
 *
 *      this.onHit           = function(player) {}          // optional callback
 *      this.onSpecialFired = function(player, charge) {}   // optional callback
 *          Set by the Game; invoked on damage / hyperbeam release.
 *
 *  Textures loaded from assets/textures/:
 *      player_ship.png       (512x512)  ship hull (default / level 1)
 *      player_ship_0.png … player_ship_9.png   per-level ship skins
 *      engine_trail.png      (128x256)  engine exhaust trail
 *      powerup_ammo.png      ammo pickup
 *      powerup_coin.png      coin pickup
 *      powerup_magnet.png    magnet pickup
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  const SHIP_SIZE          = 120;      // sprite scale (world units)
  const TRAIL_SIZE         = 90;        // engine trail sprite scale
  const HIT_RADIUS         = 28;       // collision radius
  const MUZZLE_OFFSET_Y    = 55;       // bullet spawn offset from ship center
  const ACCEL              = 1600;      // px/s^2
  const MAX_SPEED          = 320;       // px/s
  const DECEL              = 2200;      // braking when no input
  const BANK_MAX           = 15 * Math.PI / 180;   // 15° max bank
  const BANK_LERP          = 6;         // bank smoothing speed
  const BOUNDS_X           = 360;       // playfield half-width
  const BOUNDS_Y_TOP       = -160;      // upper limit (don't fly into enemies)
  const BOUNDS_Y_BOTTOM   = -560;      // lower limit
  const START_POS_Y        = -500;
  const BULLET_SPEED       = 1200;      // px/s upward
  const FIRE_RATE_BASE     = 0.15;      // seconds between shots
  const FIRE_RATE_RAPID   = 0.06;       // with rapid-fire power-up
  const INVULN_DURATION    = 2.0;       // seconds of i-frames after hit
  const SPECIAL_CHARGE_TIME = 2.0;      // seconds to fully charge hyperbeam
  const ENGINE_PARTICLE_RATE = 0.012;    // seconds between particle emits
  const ENGINE_PARTICLE_LIFE = 0.45;     // seconds
  const ENGINE_PARTICLE_SPEED = 180;     // px/s downward (behind ship)
  const ENGINE_PARTICLE_SIZE = 24;       // sprite scale
  const MUZZLE_FLASH_TIME  = 0.06;       // seconds
  const IDLE_BOB_AMPLITUDE = 4;          // px
  const IDLE_BOB_SPEED     = 2.2;        // rad/s
  const SHIELD_RADIUS      = 60;

  /* ── Ammo / coin / magnet tunables ────────────────────────────────────── */
  const MAX_AMMO           = 999;      // effectively infinite but tracked
  const AMMO_PER_PICKUP    = 50;       // ammo power-up restores this many
  const MAGNET_DURATION    = 8.0;       // seconds the magnet effect lasts
  const MAGNET_RADIUS      = 220;      // px — how far the magnet reaches
  const MAGNET_FORCE       = 900;       // px/s^2 pull toward the ship

  /* ── Helpers ──────────────────────────────────────────────────────────── */

  /**
   * Build a soft radial-glow texture on a canvas.  Used for the engine-glow
   * particles and the muzzle flash so we don't depend on extra PNG assets.
   * Returns a THREE.Texture.
   */
  function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.25, 'rgba(180,250,255,0.85)');
    g.addColorStop(0.6, 'rgba(0,200,255,0.35)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Clamp a value into [min,max].
   */
  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  /**
   * Frame-rate independent exponential smoothing toward a target.
   * `speed` is the decay rate (higher = snappier).
   */
  function damp(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-speed * dt));
  }

  /* ── Player ───────────────────────────────────────────────────────────── */

  function Player(scene) {
    this.scene = scene;

    /* Position / motion.  We keep a 2D position/velocity and write the 3D
     * sprite position from it every frame (z=0 for sprites). */
    this.position = new THREE.Vector2(0, START_POS_Y);
    this.velocity = new THREE.Vector2(0, 0);
    this._startPos = new THREE.Vector2(0, START_POS_Y);

    /* Health / state. */
    this.maxHealth   = 3;
    this.health      = 3;
    this.weaponLevel = 1;
    this.invulnerable = false;
    this.shooting     = false;
    this.chargingSpecial = false;
    this.specialCharge  = 0;       // 0..1
    this._rapidFire  = false;
    this._shielded   = false;

    /* Ammo / coin / magnet state. */
    this.maxAmmo     = MAX_AMMO;
    this.ammo        = MAX_AMMO;   // tracked but effectively infinite
    this.coinCount    = 0;          // collected coins (progression/monetization)
    this.magnetTimer  = 0;          // >0 while magnet effect is active
    this.magnetActive = false;

    /* Timers. */
    this._fireCooldown     = 0;
    this._invulnTimer      = 0;
    this._muzzleFlashTimer = 0;
    this._engineParticleTimer = 0;
    this._bobPhase = Math.random() * Math.PI * 2;
    this._bankAngle = 0;           // current visual bank (radians)
    this._timeAlive = 0;

    /* Optional callbacks (set by Game). */
    this.onHit           = null;
    this.onSpecialFired  = null;

    /* ---- Visuals ---- */

    // Ship sprite
    this._textureLoader = new THREE.TextureLoader();
    this._shipTexturePath = 'assets/textures/player_ship.png';
    const shipTex = this._textureLoader.load(this._shipTexturePath);
    this._shipMat = new THREE.SpriteMaterial({
      map: shipTex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    this.sprite = new THREE.Sprite(this._shipMat);
    this.sprite.scale.set(SHIP_SIZE, SHIP_SIZE, 1);
    this.sprite.renderOrder = 10;
    scene.add(this.sprite);

    // Engine trail sprite (sits behind/below the ship)
    const trailTex = new THREE.TextureLoader().load('assets/textures/engine_trail.png');
    this._trailMat = new THREE.SpriteMaterial({
      map: trailTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.9
    });
    this._trail = new THREE.Sprite(this._trailMat);
    this._trail.scale.set(TRAIL_SIZE, TRAIL_SIZE * 1.6, 1);
    this._trail.renderOrder = 9;
    scene.add(this._trail);

    // Muzzle flash sprite (hidden until firing)
    this._glowTex = makeGlowTexture();
    this._muzzleMat = new THREE.SpriteMaterial({
      map: this._glowTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      color: new THREE.Color(0x00eaff)
    });
    this._muzzleFlash = new THREE.Sprite(this._muzzleMat);
    this._muzzleFlash.scale.set(SHIP_SIZE * 0.9, SHIP_SIZE * 0.9, 1);
    this._muzzleFlash.renderOrder = 11;
    scene.add(this._muzzleFlash);

    // Charge-glow sprite (pulses while charging special)
    this._chargeMat = new THREE.SpriteMaterial({
      map: this._glowTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      color: new THREE.Color(0x66ffff)
    });
    this._chargeGlow = new THREE.Sprite(this._chargeMat);
    this._chargeGlow.scale.set(SHIP_SIZE * 1.6, SHIP_SIZE * 1.6, 1);
    this._chargeGlow.renderOrder = 8;
    scene.add(this._chargeGlow);

    // Shield bubble — a semi-transparent sphere mesh + a wireframe overlay
    this._shieldGroup = new THREE.Group();
    const shieldGeo = new THREE.SphereGeometry(SHIELD_RADIUS, 24, 16);
    this._shieldMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this._shieldMesh = new THREE.Mesh(shieldGeo, this._shieldMat);
    this._shieldGroup.add(this._shieldMesh);

    const wireGeo = new THREE.SphereGeometry(SHIELD_RADIUS * 1.02, 12, 8);
    this._shieldWireMat = new THREE.MeshBasicMaterial({
      color: 0x66ffee,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
      depthTest: false,
      depthWrite: false
    });
    this._shieldWire = new THREE.Mesh(wireGeo, this._shieldWireMat);
    this._shieldGroup.add(this._shieldWire);
    this._shieldGroup.visible = false;
    scene.add(this._shieldGroup);

    /* ---- Engine-glow particle pool (self-contained) ---- */
    this._particles = [];
    this._particlePool = [];
    const poolSize = 64;
    for (let i = 0; i < poolSize; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._glowTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        color: new THREE.Color(0x00ddff)
      });
      const sp = new THREE.Sprite(mat);
      sp.scale.set(ENGINE_PARTICLE_SIZE, ENGINE_PARTICLE_SIZE, 1);
      sp.renderOrder = 9;
      sp.visible = false;
      scene.add(sp);
      this._particlePool.push(sp);
    }

    // Apply initial state.
    this._syncTransform();
  }

  /* ── Public API ───────────────────────────────────────────────────────── */

  /**
   * Per-frame update.
   * @param {number} dt   delta seconds
   * @param {object} input  {left,right,up,down,fire,special} booleans
   * @param {object} bulletManager  exposes spawnPlayerBullet(x,y,vx,vy)
   */
  Player.prototype.update = function (dt, input, bulletManager) {
    this._timeAlive += dt;

    this._updateMovement(dt, input);
    this._updateBanking(dt);
    this._updateFiring(dt, input, bulletManager);
    this._updateSpecial(dt, input);
    this._updateInvulnerability(dt);
    this._updateMagnet(dt);
    this._updateEngineTrail(dt);
    this._updateEngineParticles(dt);
    this._updateMuzzleFlash(dt);
    this._updateShield(dt);
    this._updateChargeGlow(dt);
    this._syncTransform();
  };

  /**
   * Apply one point of damage.  Returns true if damage was actually applied
   * (i.e. the ship was not invulnerable), false otherwise.
   */
  Player.prototype.takeDamage = function () {
    if (this.invulnerable || this._shielded) {
      // Shield absorbs a hit and is consumed.
      if (this._shielded) this.setShield(false);
      return false;
    }
    this.health -= 1;
    this.invulnerable = true;
    this._invulnTimer = INVULN_DURATION;
    if (this.onHit) this.onHit(this);
    return true;
  };

  /**
   * Reset the ship to its starting position and full state.  Called on respawn
   * / new game / continue.
   */
  Player.prototype.reset = function () {
    this.position.copy(this._startPos);
    this.velocity.set(0, 0);
    this.health = this.maxHealth;
    this.weaponLevel = 1;
    this.invulnerable = false;
    this._invulnTimer = 0;
    this._fireCooldown = 0;
    this._muzzleFlashTimer = 0;
    this.specialCharge = 0;
    this.chargingSpecial = false;
    this._rapidFire = false;
    this._shielded = false;
    this.ammo = this.maxAmmo;
    this.coinCount = 0;
    this.magnetTimer = 0;
    this.magnetActive = false;
    this._bankAngle = 0;
    this._shieldGroup.visible = false;
    this._shipMat.opacity = 1;
    // Restore default ship skin.
    this.setShipTexture('player_ship.png');
    this._syncTransform();
  };

  Player.prototype.setWeaponLevel = function (n) {
    this.weaponLevel = clamp(Math.floor(n), 1, 4);
    // Swap the ship skin to match the new level (player_ship_0.png …).
    this.setShipTextureForLevel(this.weaponLevel);
  };

  Player.prototype.setRapidFire = function (on) {
    this._rapidFire = !!on;
  };

  Player.prototype.setShield = function (on) {
    this._shielded = !!on;
    this._shieldGroup.visible = this._shielded;
  };

  /**
   * Swap the ship's hull texture.  Used for per-level ship skins
   * (player_ship_0.png … player_ship_9.png).  Disposes the old texture
   * and loads the new one onto the existing sprite material.
   * @param {string} texturePath  path under assets/textures/, e.g. 'player_ship_3.png'
   */
  Player.prototype.setShipTexture = function (texturePath) {
    if (!texturePath || texturePath === this._shipTexturePath) return;
    this._shipTexturePath = texturePath;
    const full = texturePath.indexOf('/') === -1
      ? 'assets/textures/' + texturePath
      : texturePath;
    const newTex = this._textureLoader.load(full);
    const oldTex = this._shipMat.map;
    this._shipMat.map = newTex;
    this._shipMat.needsUpdate = true;
    if (oldTex && oldTex.dispose) oldTex.dispose();
  };

  /**
   * Switch the ship skin to match the current weapon level (1..10).
   * Levels map to player_ship_0.png … player_ship_9.png.
   * @param {number} level  weapon level (clamped to 0..9 index)
   */
  Player.prototype.setShipTextureForLevel = function (level) {
    const idx = clamp(Math.floor(level) - 1, 0, 9);
    this.setShipTexture('player_ship_' + idx + '.png');
  };

  /**
   * Resize the ship sprite (and dependent visual elements: engine trail,
   * muzzle flash, charge glow, shield bubble).  Pass the desired sprite
   * scale in world units (e.g. 120).
   * @param {number} size  new ship sprite scale (world units)
   */
  Player.prototype.setShipSize = function (size) {
    const s = Math.max(1, Math.floor(size));
    this._shipSize = s;
    this.sprite.scale.set(s, s, 1);
    // Scale the dependent visual elements proportionally.
    const trailScale = (s / SHIP_SIZE) * TRAIL_SIZE;
    this._trail.scale.set(trailScale, trailScale * 1.6, 1);
    this._muzzleFlash.scale.set(s * 0.9, s * 0.9, 1);
    this._chargeGlow.scale.set(s * 1.6, s * 1.6, 1);
  };

  /* ── Ammo system ─────────────────────────────────────────────────────── */

  /**
   * Spend one unit of ammo.  Returns true if there was ammo to spend.
   * With maxAmmo=999 this is effectively always true but the count is tracked.
   */
  Player.prototype.spendAmmo = function (amount) {
    const n = amount || 1;
    if (this.ammo <= 0) return false;
    this.ammo = Math.max(0, this.ammo - n);
    return true;
  };

  /**
   * Restore ammo from a pickup.  Caps at maxAmmo.
   * @returns {number} ammo actually added (clamped).
   */
  Player.prototype.addAmmo = function (amount) {
    const before = this.ammo;
    this.ammo = Math.min(this.maxAmmo, this.ammo + (amount || AMMO_PER_PICKUP));
    return this.ammo - before;
  };

  /* ── Coin collection ─────────────────────────────────────────────────── */

  /**
   * Record collected coins.  @returns the new total coinCount.
   */
  Player.prototype.addCoins = function (amount) {
    this.coinCount += (amount || 1);
    return this.coinCount;
  };

  /* ── Magnet effect ──────────────────────────────────────────────────── */

  /**
   * Activate (or refresh) the pickup magnet for MAGNET_DURATION seconds.
   */
  Player.prototype.activateMagnet = function (duration) {
    this.magnetTimer = (duration !== undefined) ? duration : MAGNET_DURATION;
    this.magnetActive = true;
  };

  Player.prototype.deactivateMagnet = function () {
    this.magnetTimer = 0;
    this.magnetActive = false;
  };

  /**
   * @returns true if the magnet is currently pulling nearby pickups.
   */
  Player.prototype.isMagnetActive = function () {
    return this.magnetActive;
  };

  /**
   * Apply the magnet pull to a target world-space point {x,y}.
   * Mutates the target in place and returns it.  No-op if magnet inactive
   * or the target is outside MAGNET_RADIUS.
   * @param {{x:number,y:number}} target
   * @param {number} dt  delta seconds
   */
  Player.prototype.applyMagnetPull = function (target, dt) {
    if (!this.magnetActive) return target;
    const dx = this.position.x - target.x;
    const dy = this.position.y - target.y;
    const dist = Math.hypot(dx, dy);
    if (dist > MAGNET_RADIUS || dist < 1) return target;
    // Acceleration toward the ship, stronger as it gets closer.
    const strength = MAGNET_FORCE * (1 - dist / MAGNET_RADIUS);
    const inv = 1 / dist;
    target.x += dx * inv * strength * dt;
    target.y += dy * inv * strength * dt;
    return target;
  };

  Player.prototype.getHitRadius = function () {
    return HIT_RADIUS;
  };

  /**
   * @returns {THREE.Vector3} world-space position where bullets spawn.
   */
  Player.prototype.getMuzzlePosition = function () {
    return new THREE.Vector3(this.position.x, this.position.y + MUZZLE_OFFSET_Y, 0);
  };

  /**
   * Clean up all Three.js resources owned by this player.
   */
  Player.prototype.destroy = function () {
    const remove = (obj) => {
      this.scene.remove(obj);
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
      if (obj.geometry) obj.geometry.dispose();
    };

    remove(this.sprite);
    remove(this._trail);
    remove(this._muzzleFlash);
    remove(this._chargeGlow);
    remove(this._shieldMesh);
    remove(this._shieldWire);
    this.scene.remove(this._shieldGroup);

    for (let i = 0; i < this._particlePool.length; i++) remove(this._particlePool[i]);
    if (this._glowTex) this._glowTex.dispose();

    this._particles.length = 0;
  };

  /* ── Internal updates ─────────────────────────────────────────────────── */

  Player.prototype._updateMovement = function (dt, input) {
    const ax = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    const ay = (input.down ? -1 : 0) + (input.up ? 1 : 0);

    // Accelerate toward the requested direction.
    if (ax !== 0 || ay !== 0) {
      const len = Math.hypot(ax, ay) || 1;
      this.velocity.x += (ax / len) * ACCEL * dt;
      this.velocity.y += (ay / len) * ACCEL * dt;
    } else {
      // Decelerate toward zero when no input.
      const dec = DECEL * dt;
      const sp = this.velocity.length();
      if (sp <= dec) {
        this.velocity.set(0, 0);
      } else {
        this.velocity.multiplyScalar(1 - dec / sp);
      }
    }

    // Clamp top speed.
    const sp = this.velocity.length();
    if (sp > MAX_SPEED) this.velocity.multiplyScalar(MAX_SPEED / sp);

    // Integrate.
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;

    // World bounds — stop & zero velocity on the offending axis.
    if (this.position.x < -BOUNDS_X) {
      this.position.x = -BOUNDS_X;
      this.velocity.x = 0;
    } else if (this.position.x > BOUNDS_X) {
      this.position.x = BOUNDS_X;
      this.velocity.x = 0;
    }
    if (this.position.y < BOUNDS_Y_BOTTOM) {
      this.position.y = BOUNDS_Y_BOTTOM;
      this.velocity.y = 0;
    } else if (this.position.y > BOUNDS_Y_TOP) {
      this.position.y = BOUNDS_Y_TOP;
      this.velocity.y = 0;
    }
  };

  Player.prototype._updateBanking = function (dt) {
    // Target bank proportional to horizontal velocity.  Moving left (vx<0)
    // => positive rotation (nose tilts left / counter-clockwise).
    const target = clamp(-this.velocity.x * (BANK_MAX / MAX_SPEED), -BANK_MAX, BANK_MAX);
    this._bankAngle = damp(this._bankAngle, target, BANK_LERP, dt);
  };

  Player.prototype._updateFiring = function (dt, input, bulletManager) {
    this.shooting = !!input.fire;
    this._fireCooldown -= dt;
    if (this._fireCooldown < 0) this._fireCooldown = 0;

    if (this.shooting && this._fireCooldown <= 0 && this.ammo > 0) {
      const rate = this._rapidFire ? FIRE_RATE_RAPID : FIRE_RATE_BASE;
      this._fireCooldown = rate;
      this.spendAmmo(1);
      this._fire(bulletManager);
      this._muzzleFlashTimer = MUZZLE_FLASH_TIME;
    }
  };

  /**
   * Spawn bullets according to the current weapon level.
   */
  Player.prototype._fire = function (bulletManager) {
    if (!bulletManager || typeof bulletManager.spawnPlayerBullet !== 'function') return;

    const mx = this.position.x;
    const my = this.position.y + MUZZLE_OFFSET_Y;
    const s = BULLET_SPEED;

    /** helper: spawn one bolt at an angle (radians) from vertical-up */
    const fire = (offsetX, angle) => {
      // BulletManager.spawnPlayerBullet signature: (x, y, angle, speed, weaponLevel)
      bulletManager.spawnPlayerBullet(mx + offsetX, my, angle, s, this.weaponLevel);
    };

    switch (this.weaponLevel) {
      case 1:
        fire(0, 0);
        break;
      case 2:
        fire(-12, 0);
        fire(12, 0);
        break;
      case 3:
        fire(0, 0);
        fire(-14, -0.18);   // ~10°
        fire(14, 0.18);
        break;
      default: // 4+
        fire(-10, -0.09);   // inner-left
        fire(10, 0.09);      // inner-right
        fire(-18, -0.26);   // outer-left  ~15°
        fire(18, 0.26);      // outer-right ~15°
        break;
    }
  };

  Player.prototype._updateSpecial = function (dt, input) {
    if (input.special) {
      // Charging — only begin if we have at least one life.
      if (!this.chargingSpecial) {
        this.chargingSpecial = true;
        this.specialCharge = 0;
      }
      this.specialCharge += dt / SPECIAL_CHARGE_TIME;
      if (this.specialCharge > 1) this.specialCharge = 1;
    } else if (this.chargingSpecial) {
      // Released.
      this.chargingSpecial = false;
      if (this.specialCharge >= 1) {
        // Fire the hyperbeam — the Game layers the actual beam effect on top.
        if (this.onSpecialFired) this.onSpecialFired(this, this.specialCharge);
      }
      this.specialCharge = 0;
    }
  };

  Player.prototype._updateInvulnerability = function (dt) {
    if (this.invulnerable) {
      this._invulnTimer -= dt;
      // Flashing: opacity oscillates between 0.25 and 1.0.
      const flash = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(this._timeAlive * 28));
      this._shipMat.opacity = flash;
      if (this._invulnTimer <= 0) {
        this.invulnerable = false;
        this._shipMat.opacity = 1;
      }
    }
  };

  Player.prototype._updateMagnet = function (dt) {
    if (this.magnetTimer > 0) {
      this.magnetTimer -= dt;
      if (this.magnetTimer <= 0) {
        this.magnetTimer = 0;
        this.magnetActive = false;
      }
    }
  };

  Player.prototype._updateEngineTrail = function (dt) {
    // Flicker: a fast noise + a slow pulse layered together.
    const flicker = 0.65 + 0.25 * Math.sin(this._timeAlive * 22) +
                    0.10 * (Math.random() - 0.5);
    this._trailMat.opacity = clamp(flicker, 0.35, 1.0);
    // Slight scale breathing.
    const breath = 1.0 + 0.08 * Math.sin(this._timeAlive * 14);
    this._trail.scale.set(TRAIL_SIZE * breath, TRAIL_SIZE * 1.6 * breath, 1);
  };

  Player.prototype._updateEngineParticles = function (dt) {
    // Emit new particles while the ship is alive.
    this._engineParticleTimer -= dt;
    while (this._engineParticleTimer <= 0 && this.health > 0) {
      this._engineParticleTimer += ENGINE_PARTICLE_RATE;
      this._emitEngineParticle();
    }

    // Advance live particles.
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        p.sprite.material.opacity = 0;
        this._particlePool.push(p.sprite);
        this._particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 80 * dt;          // slight downward drag to feel like exhaust
      const t = p.life / p.maxLife;   // 1..0
      const scale = ENGINE_PARTICLE_SIZE * (0.4 + 0.6 * t);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = 0.9 * t;
      p.sprite.position.set(p.x, p.y, 0);
    }
  };

  Player.prototype._emitEngineParticle = function () {
    const sp = this._particlePool.pop();
    if (!sp) return; // pool exhausted
    // Spawn just below the ship, slight horizontal jitter from each engine.
    const jitter = (Math.random() - 0.5) * 36;
    const x = this.position.x + jitter;
    const y = this.position.y - SHIP_SIZE * 0.28;
    const life = ENGINE_PARTICLE_LIFE * (0.7 + 0.6 * Math.random());
    const speed = ENGINE_PARTICLE_SPEED * (0.6 + 0.8 * Math.random());
    sp.visible = true;
    sp.material.opacity = 0.9;
    // Subtle cyan shade variation.
    sp.material.color.setHSL(0.5 + (Math.random() - 0.5) * 0.05, 1, 0.6 + Math.random() * 0.2);
    const p = {
      sprite: sp,
      x: x, y: y,
      vx: (Math.random() - 0.5) * 40,
      vy: -speed,               // downward (behind ship which faces up)
      life: life,
      maxLife: life
    };
    this._particles.push(p);
  };

  Player.prototype._updateMuzzleFlash = function (dt) {
    if (this._muzzleFlashTimer > 0) {
      this._muzzleFlashTimer -= dt;
      const t = Math.max(0, this._muzzleFlashTimer / MUZZLE_FLASH_TIME);
      this._muzzleMat.opacity = t;
      const scale = SHIP_SIZE * (0.5 + 0.5 * t);
      this._muzzleFlash.scale.set(scale, scale * 1.4, 1);
      this._muzzleFlash.position.set(this.position.x, this.position.y + MUZZLE_OFFSET_Y, 0);
    } else {
      this._muzzleMat.opacity = 0;
    }
  };

  Player.prototype._updateShield = function (dt) {
    if (!this._shielded) return;
    // Energy shimmer: opacity pulses + wireframe rotates for a "scanning" feel.
    const pulse = 0.14 + 0.10 * (0.5 + 0.5 * Math.sin(this._timeAlive * 6));
    this._shieldMat.opacity = pulse;
    this._shieldWireMat.opacity = 0.15 + 0.15 * (0.5 + 0.5 * Math.sin(this._timeAlive * 4));
    this._shieldMesh.rotation.y += dt * 1.2;
    this._shieldWire.rotation.y -= dt * 0.8;
    this._shieldWire.rotation.x += dt * 0.5;
  };

  Player.prototype._updateChargeGlow = function (dt) {
    if (this.chargingSpecial && this.specialCharge > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this._timeAlive * 16);
      this._chargeMat.opacity = 0.25 + 0.55 * this.specialCharge * pulse;
      const scale = SHIP_SIZE * (1.4 + 0.4 * this.specialCharge * (0.7 + 0.3 * pulse));
      this._chargeGlow.scale.set(scale, scale, 1);
      // Shift colour from cyan -> white as it nears full charge.
      const c = new THREE.Color().setHSL(0.5, 1 - this.specialCharge * 0.6, 0.6 + 0.3 * this.specialCharge);
      this._chargeMat.color.copy(c);
    } else {
      this._chargeMat.opacity = 0;
    }
  };

  /**
   * Write the 2D position/rotation into the actual Three.js objects, applying
   * the idle bob and bank angle.
   */
  Player.prototype._syncTransform = function () {
    // Idle bob — subtle vertical float.
    const bob = Math.sin(this._bobPhase + this._timeAlive * IDLE_BOB_SPEED) * IDLE_BOB_AMPLITUDE;

    this.sprite.position.set(this.position.x, this.position.y + bob, 0);
    this.sprite.material.rotation = this._bankAngle;

    // Trail sits below the ship and tilts slightly opposite the bank for drag feel.
    this._trail.position.set(this.position.x, this.position.y - SHIP_SIZE * 0.42 + bob * 0.5, 0);
    this._trail.material.rotation = this._bankAngle * 0.4;

    this._muzzleFlash.position.set(this.position.x, this.position.y + MUZZLE_OFFSET_Y, 0);
    this._chargeGlow.position.set(this.position.x, this.position.y + bob, 0);
    this._shieldGroup.position.set(this.position.x, this.position.y + bob, 0);
  };

  /* ── Export ───────────────────────────────────────────────────────────── */
  global.Player = Player;
})(window);
