/* =============================================================================
 *  Bullet.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  Bullet / projectile system.  Everything that leaves a gun barrel flows
 *  through here: player energy bolts, enemy plasma balls, boss crackling orbs,
 *  and the screen-filling hyperbeam special.
 *
 *  Visual goals:
 *    • Bright additive-blended cores with a soft glow halo.
 *    • Real motion trails (a ring-buffer of fading trail sprites per bullet).
 *    • A large faint "distortion" glow that approximates screen-space warping
 *      around each projectile.
 *    • Enemy / boss bullets can home toward a configurable target with a
 *      capped turn rate so curves stay smooth and readable.
 *    • Object pooling — bullets are recycled, never new'd per shot.
 *    • Circle-based collision with a per-type hit radius.
 *
 *  Constructor:   new BulletManager(scene)
 *
 *  Public API:
 *      spawnPlayerBullet(x, y, angle, speed, weaponLevel)
 *      spawnEnemyBullet(x, y, angle, speed, type)
 *      spawnBossBullet(x, y, angle, speed)
 *      fireSpecial(x, y)
 *      update(dt)
 *      checkCollisions(targets)            -> array of hit results
 *      getPlayerBullets() / getEnemyBullets()
 *      setHomingTarget(target)             // target: {x,y} | {getPosition()} | null
 *      clear()
 *      destroy()
 *
 *  Coordinate convention (matches the rest of the game):
 *      +y is up, -y is down.  `angle` is radians measured from the +y axis,
 *      clockwise positive (so angle = 0 fires straight up, angle = π fires
 *      straight down).  Velocity = (sin(angle), cos(angle)) * speed.
 *
 *  Textures (from assets/textures/):
 *      bullet_player.png   — cyan vertical energy bolt
 *      bullet_enemy.png    — orange/red plasma ball
 *  Procedural canvas textures are used for the glow halo, the trail puffs,
 *  and the hyperbeam column so we don't depend on extra PNG assets.
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ──────────────────────────────────────────────────────────── */

  const TEX_DIR        = 'assets/textures/';
  const TRAIL_LENGTH   = 7;       // trail sprites per bullet
  const PLAYER_POOL    = 80;      // pre-allocated player projectiles
  const ENEMY_POOL     = 240;     // pre-allocated enemy/boss projectiles
  const SPECIAL_POOL   = 6;       // pre-allocated hyperbeam columns
  const CULL_MARGIN    = 140;     // off-screen padding before recycling
  const FIELD_HALF_W   = 520;     // playfield half-width (with margin)
  const FIELD_TOP      = 720;     // top cull bound
  const FIELD_BOTTOM   = -760;    // bottom cull bound

  // Angle convention helpers.
  const angleToVec = (a) => ({ x: Math.sin(a), y: Math.cos(a) });

  /* Per-type configuration.  `size` is the main sprite scale (world units);
   * `glow` is the halo/distortion sprite scale; `hitRadius` is the collision
   * radius; `color` tints the main sprite material; `trailColor` tints the
   * trail puffs; `life` is a safety lifetime (seconds) before forced cull. */
  const TYPE = {
    PLAYER:  'player',
    ENEMY:   'enemy',
    BOSS:    'boss',
    SPECIAL: 'special'
  };

  const CONFIG = {
    player:  { size: 30,  glow: 80,  hitRadius: 14, color: 0x40ecff, trailColor: 0x00c8ff, life: 3.0,  spin: 0   },
    enemy:   { size: 26,  glow: 66,  hitRadius: 12, color: 0xff8a2a, trailColor: 0xff4400, life: 6.0,  spin: 6.0 },
    boss:    { size: 56,  glow: 150, hitRadius: 26, color: 0xcc55ff, trailColor: 0xaa33ff, life: 9.0,  spin: 4.0 },
    special: { size: 140, glow: 420, hitRadius: 64, color: 0xffffff, trailColor: 0x88ffff, life: 0.75, spin: 0   }
  };

  /* ── Procedural textures ───────────────────────────────────────────────── */

  /** Soft radial glow (white core fading to transparent).  Shared by halos,
   *  trail puffs, and the hyperbeam side-glow. */
  function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(180,235,255,0.40)');
    g.addColorStop(0.75, 'rgba(80,180,255,0.12)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /** Vertical beam column texture — bright white core, cyan edges, soft falloff
   *  on the horizontal axis, full-strength vertically (so it tiles by scaling). */
  function makeBeamTexture() {
    const W = 128, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Horizontal soft gradient (the beam profile).
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0.00, 'rgba(0,0,0,0)');
    g.addColorStop(0.35, 'rgba(120,220,255,0.25)');
    g.addColorStop(0.46, 'rgba(200,250,255,0.85)');
    g.addColorStop(0.50, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.54, 'rgba(200,250,255,0.85)');
    g.addColorStop(0.65, 'rgba(120,220,255,0.25)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Add a couple of brighter "energy striations" for crackle.
    for (let i = 0; i < 3; i++) {
      const x = W * (0.5 + (i - 1) * 0.03);
      const g2 = ctx.createLinearGradient(x - 6, 0, x + 6, 0);
      g2.addColorStop(0, 'rgba(255,255,255,0)');
      g2.addColorStop(0.5, 'rgba(255,255,255,0.6)');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(x - 6, 0, 12, H);
    }

    // Vertical fade at the very top/bottom so the beam softens at its ends.
    const vg = ctx.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0.00, 'rgba(0,0,0,0.35)');
    vg.addColorStop(0.08, 'rgba(0,0,0,0)');
    vg.addColorStop(0.92, 'rgba(0,0,0,0)');
    vg.addColorStop(1.00, 'rgba(0,0,0,0.5)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /* ── Bullet record ─────────────────────────────────────────────────────── */

  /**
   * A single projectile.  Built once, pooled, and recycled.  Holds the main
   * sprite, a glow/halo sprite, and a small ring-buffer of trail sprites.
   */
  function BulletRecord() {
    this.alive = false;
    this.type = null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.speed = 0;
    this.age = 0;
    this.life = 0;
    this.hitRadius = 0;
    this.spin = 0;          // visual spin rate (rad/s)
    this.homing = 0;        // 0 = none; >0 = steering strength
    this.turnRate = 0;      // max turn rate for homing (rad/s)
    this.size = 0;
    this.glowSize = 0;
    this.baseColor = null;  // THREE.Color (material color)
    this.trailColor = null;
    this.flickerPhase = 0;  // for enemy/boss flicker

    // SPECIAL (hyperbeam) extents — used for AABB collision.
    this.beamHalfWidth = 0;
    this.beamTop = 0;
    this.beamBottom = 0;

    // Trail ring buffer.
    this.trail = new Array(TRAIL_LENGTH);
    for (let i = 0; i < TRAIL_LENGTH; i++) this.trail[i] = { x: 0, y: 0, set: false };

    this.sprite = null;     // THREE.Sprite main body
    this.glow = null;       // THREE.Sprite halo / distortion
    this.trailSprites = null; // THREE.Sprite[] length TRAIL_LENGTH
  }

  /* ── BulletManager ─────────────────────────────────────────────────────── */

  function BulletManager(scene) {
    this.scene = scene;

    // Shared textures.
    const loader = new THREE.TextureLoader();
    this._texPlayer = loader.load(TEX_DIR + 'bullet_player.png');
    this._texEnemy  = loader.load(TEX_DIR + 'bullet_enemy.png');
    this._texGlow   = makeGlowTexture();
    this._texBeam   = makeBeamTexture();

    // Bullet pools.
    this._playerPool  = [];
    this._enemyPool   = [];
    this._specialPool = [];
    this._playerActive  = [];
    this._enemyActive   = [];
    this._specialActive = [];

    this._buildPool(this._playerPool,  PLAYER_POOL,  TYPE.PLAYER);
    this._buildPool(this._enemyPool,   ENEMY_POOL,   TYPE.ENEMY);   // boss shares this pool
    this._buildPool(this._specialPool, SPECIAL_POOL, TYPE.SPECIAL);

    // Homing target (the player, typically).  May be null.
    this.homingTarget = null;

    // Internal scratch vectors (avoid per-frame allocation).
    this._scratch = new THREE.Vector3();
  }

  /* ── Pool construction ────────────────────────────────────────────────── */

  BulletManager.prototype._buildPool = function (pool, count, type) {
    for (let i = 0; i < count; i++) {
      const b = new BulletRecord();
      this._buildSprites(b, type);
      this._hide(b);
      pool.push(b);
    }
  };

  /** Create the THREE.Sprite objects for a bullet record and add them to the
   *  scene.  Sprites start hidden. */
  BulletManager.prototype._buildSprites = function (b, type) {
    const cfg = CONFIG[type];

    // Choose the main-body texture.
    let map;
    if (type === TYPE.PLAYER) map = this._texPlayer;
    else if (type === TYPE.SPECIAL) map = this._texBeam;
    else map = this._texEnemy; // enemy + boss both use the plasma-ball texture

    // Main sprite.
    const mat = new THREE.SpriteMaterial({
      map: map,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color(cfg.color),
      opacity: 1.0
    });
    b.sprite = new THREE.Sprite(mat);
    b.sprite.renderOrder = 20;
    this.scene.add(b.sprite);

    // Glow / distortion halo (large, faint).
    const glowMat = new THREE.SpriteMaterial({
      map: this._texGlow,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color(cfg.color),
      opacity: 0.5
    });
    b.glow = new THREE.Sprite(glowMat);
    b.glow.renderOrder = 19;
    this.scene.add(b.glow);

    // Trail puffs.
    b.trailSprites = new Array(TRAIL_LENGTH);
    const trailColor = new THREE.Color(cfg.trailColor);
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const tm = new THREE.SpriteMaterial({
        map: this._texGlow,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: trailColor.clone(),
        opacity: 0
      });
      const ts = new THREE.Sprite(tm);
      ts.renderOrder = 18;
      this.scene.add(ts);
      b.trailSprites[i] = ts;
    }
  };

  /* ── Pool checkout / return ────────────────────────────────────────────── */

  BulletManager.prototype._checkout = function (pool, activeList, type) {
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].alive) {
        const b = pool[i];
        b.alive = true;
        b.type = type;
        activeList.push(b);
        return b;
      }
    }
    // Pool exhausted — grow it once.
    const b = new BulletRecord();
    this._buildSprites(b, type);
    this._hide(b);
    pool.push(b);
    b.alive = true;
    b.type = type;
    activeList.push(b);
    return b;
  };

  BulletManager.prototype._hide = function (b) {
    b.sprite.visible = false;
    b.glow.visible = false;
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      b.trailSprites[i].visible = false;
      b.trailSprites[i].material.opacity = 0;
    }
    for (let i = 0; i < TRAIL_LENGTH; i++) b.trail[i].set = false;
  };

  BulletManager.prototype._retire = function (b, activeList) {
    b.alive = false;
    this._hide(b);
    // Remove from active list (swap-pop).
    const idx = activeList.indexOf(b);
    if (idx >= 0) {
      const last = activeList.length - 1;
      activeList[idx] = activeList[last];
      activeList.pop();
    }
  };

  /* ── Public spawning API ───────────────────────────────────────────────── */

  /**
   * Spawn one or more player bolts based on the current weapon level.
   * @param {number} x            spawn x (world)
   * @param {number} y            spawn y (world)
   * @param {number} angle        direction (radians from +y, clockwise+)
   * @param {number} speed        px/s
   * @param {number} weaponLevel  1..4+
   */
  BulletManager.prototype.spawnPlayerBullet = function (x, y, angle, speed, weaponLevel) {
    const lvl = Math.max(1, Math.floor(weaponLevel) || 1);
    const s = speed || 1200;
    const a = angle || 0;

    // Helper to spawn a single bolt at an angle offset from the base angle.
    const fire = (offsetX, angleDelta) => {
      const ang = a + angleDelta;
      const v = angleToVec(ang);
      this._spawnOne(TYPE.PLAYER, x + offsetX, y, v.x * s, v.y * s);
    };

    switch (lvl) {
      case 1:
        fire(0, 0);
        break;
      case 2:
        fire(-12, 0);
        fire(12, 0);
        break;
      case 3:
        fire(0, 0);
        fire(-16, -0.18);   // ~10°
        fire(16, 0.18);
        break;
      default: // 4+
        fire(-10, -0.09);
        fire(10, 0.09);
        fire(-20, -0.26);   // ~15°
        fire(20, 0.26);
        break;
    }
  };

  /**
   * Spawn an enemy projectile.
   * @param {number} x
   * @param {number} y
   * @param {number} angle   direction (radians from +y, clockwise+)
   * @param {number} speed
   * @param {object|string} type  optional config.  String shorthand:
   *      'grunt'   straight shot
   *      'homing'  gently homes toward the homing target
   *      'curve'   slight sinusoidal curve
   *   Or an object: { homing:Number, turnRate:Number, size:Number, color:0xRRGGBB }
   */
  BulletManager.prototype.spawnEnemyBullet = function (x, y, angle, speed, type) {
    const opts = this._resolveEnemyOpts(type);
    const v = angleToVec(angle || 0);
    const b = this._spawnOne(TYPE.ENEMY, x, y, v.x * speed, v.y * speed);
    if (!b) return;

    if (opts.homing) {
      b.homing = opts.homing;
      b.turnRate = opts.turnRate != null ? opts.turnRate : 2.2; // rad/s
    }
    if (opts.size) {
      b.size = opts.size;
      b.sprite.scale.set(opts.size, opts.size, 1);
      b.glow.scale.set(opts.size * 2.6, opts.size * 2.6, 1);
    }
    if (opts.color != null) {
      b.sprite.material.color.setHex(opts.color);
      b.glow.material.color.setHex(opts.color);
      for (let i = 0; i < TRAIL_LENGTH; i++) {
        b.trailSprites[i].material.color.setHex(opts.color);
      }
    }
  };

  BulletManager.prototype._resolveEnemyOpts = function (type) {
    const opts = { homing: 0, turnRate: 0 };
    if (!type) return opts;
    if (typeof type === 'string') {
      switch (type) {
        case 'homing': opts.homing = 1.0; opts.turnRate = 2.2; break;
        case 'curve':  opts.homing = 0.3; opts.turnRate = 1.2; break;
        case 'grunt':
        default: break;
      }
      return opts;
    }
    // Object form.
    if (type.homing != null) opts.homing = type.homing;
    if (type.turnRate != null) opts.turnRate = type.turnRate;
    if (type.size != null) opts.size = type.size;
    if (type.color != null) opts.color = type.color;
    return opts;
  };

  /**
   * Spawn a boss projectile — a large purple plasma orb with crackling glow.
   * Boss orbs use the enemy texture scaled up and tinted purple; they home
   * gently toward the player.
   */
  BulletManager.prototype.spawnBossBullet = function (x, y, angle, speed) {
    const v = angleToVec(angle || 0);
    const b = this._spawnOne(TYPE.BOSS, x, y, v.x * speed, v.y * speed);
    if (!b) return;
    b.homing = 0.45;
    b.turnRate = 1.6;
  };

  /**
   * Fire the hyperbeam special — a massive vertical column of pure
   * white/cyan energy rising from (x, y) to the top of the playfield.
   */
  BulletManager.prototype.fireSpecial = function (x, y) {
    const b = this._checkout(this._specialPool, this._specialActive, TYPE.SPECIAL);
    const cfg = CONFIG.special;

    b.type = TYPE.SPECIAL;
    b.x = x;
    b.y = y;
    b.vx = 0;
    b.vy = 0;                 // the beam is stationary; it deals damage over its life
    b.speed = 0;
    b.age = 0;
    b.life = cfg.life;
    b.hitRadius = cfg.hitRadius;
    b.size = cfg.size;
    b.glowSize = cfg.glow;
    b.homing = 0;
    b.turnRate = 0;
    b.spin = 0;
    b.baseColor = new THREE.Color(cfg.color);
    b.trailColor = new THREE.Color(cfg.trailColor);

    // Beam extents (for AABB collision + visuals).
    b.beamHalfWidth = cfg.size * 0.5;
    b.beamBottom = y;
    b.beamTop = FIELD_TOP;

    const beamHeight = b.beamTop - b.beamBottom;
    const beamCenterY = (b.beamTop + b.beamBottom) * 0.5;

    // Main beam column.
    b.sprite.visible = true;
    b.sprite.position.set(x, beamCenterY, 0.1);
    b.sprite.scale.set(cfg.size, beamHeight, 1);
    b.sprite.material.opacity = 1.0;
    b.sprite.material.rotation = 0;

    // Wide side-glow / distortion.
    b.glow.visible = true;
    b.glow.position.set(x, beamCenterY, 0.05);
    b.glow.scale.set(cfg.glow, beamHeight * 1.05, 1);
    b.glow.material.opacity = 0.55;

    // Trails off for the beam.
    for (let i = 0; i < TRAIL_LENGTH; i++) b.trailSprites[i].visible = false;

    // Seed trail buffer.
    for (let i = 0; i < TRAIL_LENGTH; i++) { b.trail[i].set = false; }
  };

  /* ── Internal single-bullet spawn ──────────────────────────────────────── */

  BulletManager.prototype._spawnOne = function (type, x, y, vx, vy) {
    const pool    = (type === TYPE.PLAYER) ? this._playerPool  : this._enemyPool;
    const active  = (type === TYPE.PLAYER) ? this._playerActive : this._enemyActive;
    const b = this._checkout(pool, active, type);
    const cfg = CONFIG[type];

    b.type = type;
    b.x = x; b.y = y;
    b.vx = vx; b.vy = vy;
    b.speed = Math.hypot(vx, vy);
    b.age = 0;
    b.life = cfg.life;
    b.hitRadius = cfg.hitRadius;
    b.size = cfg.size;
    b.glowSize = cfg.glow;
    b.spin = cfg.spin;
    b.homing = 0;
    b.turnRate = 0;
    b.baseColor = new THREE.Color(cfg.color);
    b.trailColor = new THREE.Color(cfg.trailColor);
    b.flickerPhase = Math.random() * Math.PI * 2;
    b.beamHalfWidth = 0;

    // Reset material colors (boss re-tints enemy bullets purple).
    b.sprite.material.color.copy(b.baseColor);
    b.glow.material.color.copy(b.baseColor);
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      b.trailSprites[i].material.color.copy(b.trailColor);
    }

    // Orient player bolts along their velocity.
    if (type === TYPE.PLAYER) {
      b.sprite.material.rotation = Math.atan2(vx, vy);
    } else {
      b.sprite.material.rotation = 0;
    }

    // Scale.
    b.sprite.scale.set(cfg.size, cfg.size, 1);
    b.glow.scale.set(cfg.glow, cfg.glow, 1);

    // Reveal.
    b.sprite.visible = true;
    b.sprite.material.opacity = 1.0;
    b.glow.visible = true;
    b.glow.material.opacity = 0.5;
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      b.trailSprites[i].visible = true;
      b.trailSprites[i].material.opacity = 0;
      b.trailSprites[i].scale.set(cfg.size * 0.5, cfg.size * 0.5, 1);
    }

    // Seed trail buffer at the spawn point so the first frames don't smear.
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      b.trail[i].x = x; b.trail[i].y = y; b.trail[i].set = true;
    }

    this._placeSprites(b);
    return b;
  };

  /* ── Per-frame update ──────────────────────────────────────────────────── */

  BulletManager.prototype.update = function (dt) {
    this._updateList(this._playerActive,  dt, false);
    this._updateList(this._enemyActive,   dt, true);
    this._updateList(this._specialActive, dt, false);
  };

  BulletManager.prototype._updateList = function (list, dt, allowHoming) {
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (!b.alive) continue;

      b.age += dt;

      // Special (hyperbeam) just ages and fades — no motion.
      if (b.type === TYPE.SPECIAL) {
        this._updateSpecial(b, dt);
        if (b.age >= b.life) this._retire(b, list);
        continue;
      }

      // Homing / curving for enemy & boss bullets.
      if (allowHoming && b.homing > 0 && this.homingTarget) {
        this._steerTowardTarget(b, dt);
      }

      // Integrate motion.
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Visual spin (plasma balls look alive when rotating).
      if (b.spin !== 0) {
        b.sprite.material.rotation += b.spin * dt;
      }

      // Trail: push current position into the ring buffer.
      // Shift older entries back, then write the newest into slot 0.
      for (let t = TRAIL_LENGTH - 1; t > 0; t--) {
        b.trail[t].x = b.trail[t - 1].x;
        b.trail[t].y = b.trail[t - 1].y;
        b.trail[t].set = b.trail[t - 1].set;
      }
      b.trail[0].x = b.x;
      b.trail[0].y = b.y;
      b.trail[0].set = true;

      this._placeSprites(b);
      this._updateTrailVisuals(b);
      this._updateFlicker(b, dt);

      // Cull when off-screen or expired.
      if (this._isCullable(b) || b.age >= b.life) {
        this._retire(b, list);
      }
    }
  };

  /** Steer a bullet's velocity toward the homing target, capped by turnRate. */
  BulletManager.prototype._steerTowardTarget = function (b, dt) {
    const tgt = this._targetPos(this.homingTarget);
    if (!tgt) return;

    const dx = tgt.x - b.x;
    const dy = tgt.y - b.y;
    if (dx === 0 && dy === 0) return;

    // Current heading.
    const curAng = Math.atan2(b.vx, b.vy);
    const desired = Math.atan2(dx, dy);

    // Shortest angular delta.
    let delta = desired - curAng;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Cap how fast we can turn, modulated by homing strength.
    const maxTurn = b.turnRate * b.homing * dt;
    const turn = Math.abs(delta) <= maxTurn ? delta : Math.sign(delta) * maxTurn;
    const newAng = curAng + turn;

    const sp = b.speed;
    b.vx = Math.sin(newAng) * sp;
    b.vy = Math.cos(newAng) * sp;
  };

  BulletManager.prototype._targetPos = function (tgt) {
    if (!tgt) return null;
    if (typeof tgt.getPosition === 'function') return tgt.getPosition();
    if (tgt.position) return tgt.position;
    if ('x' in tgt && 'y' in tgt) return tgt;
    return null;
  };

  /** Place the main sprite + glow halo at the bullet's current position. */
  BulletManager.prototype._placeSprites = function (b) {
    b.sprite.position.set(b.x, b.y, 0.2);
    b.glow.position.set(b.x, b.y, 0.15);
  };

  /** Lay out the trail sprites along the ring buffer with fading opacity/size. */
  BulletManager.prototype._updateTrailVisuals = function (b) {
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const ts = b.trailSprites[i];
      const entry = b.trail[i];
      if (!entry.set || i === 0) {
        // The newest slot (0) is the bullet itself — keep its puff faint.
        if (i === 0) {
          ts.material.opacity = 0;
          ts.visible = false;
        }
        continue;
      }
      const f = i / (TRAIL_LENGTH - 1);   // 0 (near) .. 1 (far)
      const opacity = (1 - f) * 0.55;
      const scale = b.size * (0.45 + 0.55 * (1 - f));
      ts.visible = true;
      ts.position.set(entry.x, entry.y, 0.1);
      ts.scale.set(scale, scale, 1);
      ts.material.opacity = opacity;
    }
  };

  /** Per-type flicker / crackle for the glow halo. */
  BulletManager.prototype._updateFlicker = function (b, dt) {
    b.flickerPhase += dt;
    if (b.type === TYPE.ENEMY) {
      // Orange/red plasma flicker.
      const f = 0.45 + 0.25 * Math.sin(b.flickerPhase * 22) + 0.15 * Math.sin(b.flickerPhase * 7.3);
      b.glow.material.opacity = Math.max(0.2, Math.min(0.85, f));
      const s = b.glowSize * (0.95 + 0.08 * Math.sin(b.flickerPhase * 18));
      b.glow.scale.set(s, s, 1);
    } else if (b.type === TYPE.BOSS) {
      // Purple crackling: faster, sharper, with random jitter.
      const crackle = Math.random() < 0.25 ? 0.2 : 0;
      const f = 0.5 + 0.3 * Math.sin(b.flickerPhase * 16) + crackle;
      b.glow.material.opacity = Math.max(0.25, Math.min(1.0, f));
      const s = b.glowSize * (0.9 + 0.15 * Math.sin(b.flickerPhase * 25) + crackle * 0.3);
      b.glow.scale.set(s, s, 1);
      // Tint shift between purple and hot-magenta for the crackle.
      const hue = 0.75 + 0.05 * Math.sin(b.flickerPhase * 9);
      b.glow.material.color.setHSL(hue, 0.85, 0.6);
    } else if (b.type === TYPE.PLAYER) {
      // Gentle cyan pulse.
      const f = 0.45 + 0.12 * Math.sin(b.flickerPhase * 12);
      b.glow.material.opacity = f;
    }
  };

  /** Hyperbeam aging: bright flash → sustained → fade-out, with crackle. */
  BulletManager.prototype._updateSpecial = function (b, dt) {
    const t = b.age / b.life;           // 0..1
    let opacity;
    if (t < 0.15) {
      opacity = t / 0.15;                // snap on
    } else if (t < 0.7) {
      opacity = 1.0;                     // sustained
    } else {
      opacity = 1.0 - (t - 0.7) / 0.3;  // fade out
    }
    opacity = Math.max(0, Math.min(1, opacity));

    // Crackle jitter on the beam width.
    const crackle = 1.0 + 0.06 * Math.sin(b.age * 60) + (Math.random() - 0.5) * 0.05;
    const w = b.size * crackle;
    const beamHeight = b.beamTop - b.beamBottom;
    const beamCenterY = (b.beamTop + b.beamBottom) * 0.5;

    b.sprite.material.opacity = opacity;
    b.sprite.scale.set(w, beamHeight, 1);
    b.sprite.position.set(b.x, beamCenterY, 0.1);

    b.glow.material.opacity = opacity * 0.5 * (0.9 + 0.1 * Math.sin(b.age * 30));
    b.glow.scale.set(b.glowSize * crackle, beamHeight * 1.05, 1);
    b.glow.position.set(b.x, beamCenterY, 0.05);
  };

  /** Should this bullet be recycled (off-screen)? */
  BulletManager.prototype._isCullable = function (b) {
    if (b.x < -FIELD_HALF_W - CULL_MARGIN) return true;
    if (b.x >  FIELD_HALF_W + CULL_MARGIN) return true;
    if (b.y < FIELD_BOTTOM - CULL_MARGIN) return true;
    if (b.y > FIELD_TOP    + CULL_MARGIN) return true;
    return false;
  };

  /* ── Collision detection ───────────────────────────────────────────────── */

  /**
   * Check active bullets against a list of targets.
   *
   * @param {Array} targets  objects exposing getPosition() -> {x,y} or a
   *                         `.position` / {x,y}, plus getHitRadius() -> Number.
   *                         Player-bullet targets are typically enemies/boss;
   *                         enemy-bullet targets are typically the player.
   * @returns {Array<{bullet, target, x, y, type}>}  hit results.  Colliding
   *          player bullets are consumed; enemy/boss bullets pass through
   *          (configurable) — by default enemy bullets are also consumed on hit
   *          so they behave like classic Galaga fire-and-forget shots.
   */
  BulletManager.prototype.checkCollisions = function (targets) {
    const hits = [];
    if (!targets || targets.length === 0) return hits;

    // Player bullets vs targets.
    this._checkList(this._playerActive, this._playerActive, targets, hits, true);
    // Enemy/boss bullets vs targets.
    this._checkList(this._enemyActive, this._enemyActive, targets, hits, false);
    // Hyperbeam vs targets (AABB).
    this._checkSpecial(targets, hits);

    return hits;
  };

  BulletManager.prototype._checkList = function (list, activeList, targets, hits, consumeOnHit) {
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (!b.alive) continue;

      const r1 = b.hitRadius;
      for (let t = 0; t < targets.length; t++) {
        const tgt = targets[t];
        if (!tgt || tgt.dead) continue;
        const tp = this._targetPos(tgt);
        if (!tp) continue;
        const r2 = typeof tgt.getHitRadius === 'function' ? tgt.getHitRadius() : (tgt.hitRadius || 20);
        const dx = tp.x - b.x;
        const dy = tp.y - b.y;
        const rr = r1 + r2;
        if (dx * dx + dy * dy <= rr * rr) {
          hits.push({ bullet: b, target: tgt, x: b.x, y: b.y, type: b.type });
          if (consumeOnHit) {
            this._retire(b, activeList);
            break;
          }
        }
      }
    }
  };

  /** Hyperbeam uses an axis-aligned box (full beam width × vertical extent). */
  BulletManager.prototype._checkSpecial = function (targets, hits) {
    const list = this._specialActive;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b.alive) continue;
      const halfW = b.beamHalfWidth;
      for (let t = 0; t < targets.length; t++) {
        const tgt = targets[t];
        if (!tgt || tgt.dead) continue;
        const tp = this._targetPos(tgt);
        if (!tp) continue;
        const r2 = typeof tgt.getHitRadius === 'function' ? tgt.getHitRadius() : (tgt.hitRadius || 20);
        // Closest point on the beam AABB to the target center.
        const cx = Math.max(b.x - halfW, Math.min(tp.x, b.x + halfW));
        const cy = Math.max(b.beamBottom, Math.min(tp.y, b.beamTop));
        const dx = tp.x - cx;
        const dy = tp.y - cy;
        if (dx * dx + dy * dy <= r2 * r2) {
          hits.push({ bullet: b, target: tgt, x: tp.x, y: tp.y, type: TYPE.SPECIAL });
        }
      }
    }
  };

  /* ── Accessors ─────────────────────────────────────────────────────────── */

  BulletManager.prototype.getPlayerBullets = function () {
    return this._playerActive;
  };

  BulletManager.prototype.getEnemyBullets = function () {
    return this._enemyActive;
  };

  BulletManager.prototype.getSpecialBullets = function () {
    return this._specialActive;
  };

  /**
   * Set the object that enemy/boss homing bullets steer toward.  Accepts
   *  • an object with getPosition() -> {x,y}
   *  • an object with .position ({x,y} or THREE.Vector2/3)
   *  • a plain {x,y}
   *  • null to disable homing.
   */
  BulletManager.prototype.setHomingTarget = function (target) {
    this.homingTarget = target || null;
  };

  /* ── Bulk operations ───────────────────────────────────────────────────── */

  BulletManager.prototype.clear = function () {
    while (this._playerActive.length)  this._retire(this._playerActive[0],  this._playerActive);
    while (this._enemyActive.length)   this._retire(this._enemyActive[0],   this._enemyActive);
    while (this._specialActive.length) this._retire(this._specialActive[0], this._specialActive);
  };

  BulletManager.prototype.destroy = function () {
    this.clear();

    const disposePool = (pool) => {
      for (let i = 0; i < pool.length; i++) {
        const b = pool[i];
        this.scene.remove(b.sprite);
        this.scene.remove(b.glow);
        b.sprite.material.dispose();
        b.glow.material.dispose();
        for (let j = 0; j < b.trailSprites.length; j++) {
          this.scene.remove(b.trailSprites[j]);
          b.trailSprites[j].material.dispose();
        }
      }
    };

    disposePool(this._playerPool);
    disposePool(this._enemyPool);
    disposePool(this._specialPool);

    this._texPlayer.dispose();
    this._texEnemy.dispose();
    this._texGlow.dispose();
    this._texBeam.dispose();

    this._playerPool.length = 0;
    this._enemyPool.length = 0;
    this._specialPool.length = 0;
  };

  /* ── Export ────────────────────────────────────────────────────────────── */

  BulletManager.TYPE = TYPE;
  global.BulletManager = BulletManager;

})(typeof window !== 'undefined' ? window : globalThis);
