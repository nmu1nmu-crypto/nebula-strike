/* =============================================================================
 *  Enemy.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  The enemy system.  Four distinct enemy archetypes — the disposable Grunt,
 *  the steady Bomber, the elite Commander, and the screen-filling Boss — each
 *  rendered as a THREE.Sprite with the appropriate texture and brought to life
 *  with damage flashes, engine-glow trails, hit sparks, animated death
 *  explosions, formation interpolation, curved-bezier dive attacks, and a
 *  full boss bullet-hell pattern cycle.
 *
 *  Coordinate convention (matches the rest of the game):
 *      +y is up, -y is down.  The player sits near the bottom; enemies spawn
 *      near the top.  Angles follow the Bullet.js convention: radians from
 *      the +y axis, clockwise positive (angle = π fires straight down).  A
 *      downward shot therefore uses angle = π, velocity = (0, -speed).
 *
 *  Bullet spawning delegates to the BulletManager (Bullet.js):
 *      bulletManager.spawnEnemyBullet(x, y, angle, speed, type)
 *      bulletManager.spawnBossBullet(x, y, angle, speed)
 *  Enemy fire is one-way (down toward the player) so the homing target is set
 *  by the Game on the BulletManager; we just point the shots.
 *
 *  Death explosions use the 16-frame explosion_00.png … explosion_15.png
 *  sequence as an animated sprite (one material.map swap per frame).  Each
 *  Enemy owns a single "explosion sprite" reused on death.
 *
 *  Formation movement is driven by a FormationManager (separate file) which
 *  assigns each enemy a `formationPos = {x, y}` slot.  The Enemy smoothly
 *  interpolates toward that slot while in formation, and breaks away on dive.
 *
 *  Public surface:
 *      class Enemy
 *          new Enemy(scene, type, formationPos)
 *          .update(dt, playerPos, bulletManager)
 *          .takeDamage(amount) -> true if killed
 *          .dive()
 *          .returnToFormation()
 *          .getHitRadius()
 *          .getPosition() -> {x, y}
 *          .destroy()
 *
 *      class EnemyManager
 *          new EnemyManager(scene)
 *          .spawnWave(waveNum)
 *          .update(dt, playerPos, bulletManager)
 *          .getEnemies()
 *          .checkCollisions(bullets) -> [{enemy, bullet, x, y}]
 *          .clear()
 *          .destroy()
 *
 *  Both classes are attached to `window` (global) since the game loads JS
 *  files as plain scripts, not ES6 modules.
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ──────────────────────────────────────────────────────────── */

  var TEX_DIR = 'assets/textures/';

  // Playfield bounds (match Background.js / Player.js; small margin).
  var FIELD_HALF_W = 420;        // horizontal playfield half-width
  var FIELD_TOP = 640;           // top of play area (enemies spawn above this)
  var FIELD_BOTTOM = -720;      // bottom cull line

  // Formation interpolation smoothing (higher = snappier).
  var FORMATION_LERP = 3.2;

  // Dive timing (seconds).
  var DIVE_DURATION = 3.2;      // total dive time before return
  var DIVE_RETURN_DURATION = 2.0;

  // Damage flash.
  var DAMAGE_FLASH_TIME = 0.12;  // seconds white flash on hit

  // Explosion animation.
  var EXPLOSION_FRAMES = 16;     // explosion_00 .. explosion_15
  var EXPLOSION_FRAME_TIME = 0.05; // seconds per frame
  var EXPLOSION_SIZE_BASE = 80;  // base sprite scale for grunt/bomber
  var EXPLOSION_SIZE_BOSS = 320;

  // Engine-glow trail particles (per diving enemy).
  var ENGINE_PARTICLE_RATE = 0.03;   // seconds between emits
  var ENGINE_PARTICLE_LIFE = 0.5;
  var ENGINE_PARTICLE_SPEED = 140;   // px/s trailing behind the dive
  var ENGINE_PARTICLE_POOL = 16;      // max live particles per enemy
  var ENGINE_PARTICLE_SIZE = 22;

  // Hit spark.
  var SPARK_COUNT = 8;
  var SPARK_LIFE = 0.35;
  var SPARK_SPEED = 220;

  // Procedural glow texture cache (shared across all enemies).
  var _glowTex = null;
  function getGlowTexture() {
    if (_glowTex) return _glowTex;
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.25, 'rgba(255,240,200,0.85)');
    g.addColorStop(0.6, 'rgba(255,120,40,0.35)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    _glowTex = new THREE.Texture(c);
    _glowTex.needsUpdate = true;
    return _glowTex;
  }

  // Procedural white spark texture (for hit sparks).
  var _sparkTex = null;
  function getSparkTexture() {
    if (_sparkTex) return _sparkTex;
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.4, 'rgba(255,255,220,0.7)');
    g.addColorStop(1.0, 'rgba(255,200,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    _sparkTex = new THREE.Texture(c);
    _sparkTex.needsUpdate = true;
    return _sparkTex;
  }

  /* ── Per-type configuration ────────────────────────────────────────────── */
  //
  //  hp         base health (before wave scaling)
  //  score      score awarded on kill
  //  size       THREE.Sprite scale (world units)
  //  hitRadius  circle collision radius
  //  speed      formation-follow speed multiplier
  //  color      tint applied to the sprite material (0 = no tint / white)
  //  texFile    texture filename under assets/textures/
  //  diveChance per-second probability of initiating a dive (when allowed)
  //  canShoot   whether the enemy fires at the player
  //  fireRate   seconds between shots (when in range and canShoot)
  //  shotSpeed  bullet speed in px/s
  //  shotType   bullet type token passed to BulletManager
  var TYPE_CONFIG = {
    grunt: {
      hp: 30, score: 100, size: 56, hitRadius: 24, speed: 1.0,
      color: 0xffffff, texFile: 'enemy_grunt.png',
      diveChance: 0.18, canShoot: false, fireRate: 0, shotSpeed: 0, shotType: null
    },
    bomber: {
      hp: 60, score: 250, size: 64, hitRadius: 28, speed: 0.8,
      color: 0xffffff, texFile: 'enemy_bomber.png',
      diveChance: 0.06, canShoot: true, fireRange: 760, fireRate: 2.4, shotSpeed: 360, shotType: 'grunt'
    },
    commander: {
      hp: 100, score: 500, size: 72, hitRadius: 32, speed: 1.25,
      color: 0xffffff, texFile: 'enemy_commander.png',
      diveChance: 0.35, canShoot: true, fireRange: 900, fireRate: 1.6, shotSpeed: 420, shotType: 'grunt'
    },
    boss: {
      hp: 1000, score: 5000, size: 260, hitRadius: 120, speed: 0.6,
      color: 0xffffff, texFile: 'boss.png',
      diveChance: 0, canShoot: true, fireRange: 99999, fireRate: 0.6, shotSpeed: 320, shotType: 'boss'
    }
  };

  // Boss attack pattern durations and parameters.
  var BOSS_PATTERN_TIME = 5.5;          // seconds per pattern before cycling
  var BOSS_PATTERNS = ['aimedSpread', 'spiral', 'fan', 'summon'];
  var BOSS_SUMMON_COUNT = 4;
  var BOSS_MINION_HP = 40;

  /* ── Helpers ──────────────────────────────────────────────────────────── */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Frame-rate independent exponential approach toward a target.
  function damp(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-speed * dt));
  }

  // Quadratic bezier point.  p0..p2 are {x,y}.  t in [0,1].
  function bezier2(p0, p1, p2, t) {
    var u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
  }

  // Cubic bezier point.  p0..p3 are {x,y}.  t in [0,1].
  function bezier3(p0, p1, p2, p3, t) {
    var u = 1 - t;
    var uu = u * u;
    var tt = t * t;
    return {
      x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
      y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y
    };
  }

  // Angle (radians, Bullet.js convention: 0 = +y/up, π = -y/down) from
  // a source point toward a target point.  Because velocity = (sin,cos)*speed,
  // the correct angle is atan2(dx, dy) — no sign flip (in the Bullet.js world
  // +y is up and that is already the cos-axis).
  function angleToward(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    return Math.atan2(dx, dy);
  }

  /* =============================================================================
   *  Enemy
   * ========================================================================== */

  function Enemy(scene, type, formationPos) {
    this.scene = scene;
    this.type = type;
    var cfg = TYPE_CONFIG[type] || TYPE_CONFIG.grunt;

    /* ---- Core state ---- */
    this.position = new THREE.Vector2(0, FIELD_TOP + 120);  // spawn above field
    this._cfg = cfg;
    this.maxHealth = cfg.hp;
    this.health = cfg.hp;
    this.alive = true;
    this.diving = false;
    this.formationPos = { x: formationPos ? formationPos.x : 0, y: formationPos ? formationPos.y : 200 };
    this.score = cfg.score;
    this.shootCooldown = cfg.fireRate ? (0.8 + Math.random() * cfg.fireRate) : 0;

    /* ---- Dive state ---- */
    this._diveTime = 0;
    this._diveCurve = null;     // array of control points
    this._diveReturning = false;

    /* ---- Damage flash ---- */
    this._flashTimer = 0;

    /* ---- Idle animation ---- */
    this._idlePhase = Math.random() * Math.PI * 2;
    this._idleRot = 0;

    /* ---- Boss state ---- */
    this._bossPatternIdx = 0;
    this._bossPatternTimer = BOSS_PATTERN_TIME;
    this._bossSpiralAngle = 0;
    this._bossFireTimer = 0;

    /* ---- Explosion state ---- */
    this._exploding = false;
    this._explosionTime = 0;
    this._explosionFrame = 0;
    this._explosionTextures = null;   // loaded lazily / shared
    this._explosionMaterial = null;
    this._explosionSprite = null;

    /* ---- Engine-glow particle pool (self-contained per enemy) ---- */
    this._engineParticles = [];
    this._enginePool = [];
    this._engineTimer = 0;
    this._engineActive = false;       // true while diving

    /* ---- Hit sparks ---- */
    this._sparks = [];
    this._sparkPool = [];

    /* ---- Build visuals ---- */
    this._buildSprite(cfg);
    this._buildExplosion(cfg);
    this._buildEngineParticles();
    this._buildSparks();

    // If boss, build a health-bar group.
    if (type === 'boss') this._buildBossHealthBar();

    // Start at formation slot (so it doesn't snap from spawn point).
    if (formationPos) {
      this.position.x = formationPos.x;
      this.position.y = FIELD_TOP + 120;  // enter from top
    }

    this._syncTransform();
  }

  /* ── Visual construction ───────────────────────────────────────────────── */

  Enemy.prototype._buildSprite = function (cfg) {
    var loader = new THREE.TextureLoader();
    this._texture = loader.load(TEX_DIR + cfg.texFile);
    this._material = new THREE.SpriteMaterial({
      map: this._texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    if (cfg.color !== 0xffffff) {
      this._material.color = new THREE.Color(cfg.color);
    }
    this.sprite = new THREE.Sprite(this._material);
    this.sprite.scale.set(cfg.size, cfg.size, 1);
    this.sprite.renderOrder = 12;
    this.scene.add(this.sprite);
  };

  Enemy.prototype._buildExplosion = function (cfg) {
    // The explosion is a single sprite whose material.map is swapped each
    // frame through the 16 explosion textures.  We create the material with
    // a placeholder (the first frame) and load all frames up front.
    this._explosionTextures = Enemy._getExplosionTextures();
    this._explosionMaterial = new THREE.SpriteMaterial({
      map: this._explosionTextures[0],
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 1.0
    });
    var scale = (this.type === 'boss') ? EXPLOSION_SIZE_BOSS : EXPLOSION_SIZE_BASE;
    this._explosionSprite = new THREE.Sprite(this._explosionMaterial);
    this._explosionSprite.scale.set(scale, scale, 1);
    this._explosionSprite.renderOrder = 30;
    this._explosionSprite.visible = false;
    this.scene.add(this._explosionSprite);
  };

  Enemy.prototype._buildEngineParticles = function () {
    var glow = getGlowTexture();
    for (var i = 0; i < ENGINE_PARTICLE_POOL; i++) {
      var mat = new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        color: new THREE.Color(0xffaa44)
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(ENGINE_PARTICLE_SIZE, ENGINE_PARTICLE_SIZE, 1);
      sp.renderOrder = 11;
      sp.visible = false;
      this.scene.add(sp);
      this._enginePool.push(sp);
    }
  };

  Enemy.prototype._buildSparks = function () {
    var sparkTex = getSparkTexture();
    for (var i = 0; i < SPARK_COUNT; i++) {
      var mat = new THREE.SpriteMaterial({
        map: sparkTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        color: new THREE.Color(0xffffcc)
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(14, 14, 1);
      sp.renderOrder = 29;
      sp.visible = false;
      this.scene.add(sp);
      this._sparkPool.push(sp);
    }
  };

  Enemy.prototype._buildBossHealthBar = function () {
    // A background bar + a fill bar, both THREE.Sprite-based for crisp 2D.
    // Drawn just above the boss sprite.  We use procedural canvas textures
    // so we don't depend on external assets.
    var bgCanvas = document.createElement('canvas');
    bgCanvas.width = 256; bgCanvas.height = 16;
    var bgCtx = bgCanvas.getContext('2d');
    bgCtx.fillStyle = 'rgba(20,20,30,0.85)';
    bgCtx.fillRect(0, 0, 256, 16);
    bgCtx.strokeStyle = 'rgba(120,120,160,0.9)';
    bgCtx.lineWidth = 2;
    bgCtx.strokeRect(1, 1, 254, 14);
    var bgTex = new THREE.Texture(bgCanvas);
    bgTex.needsUpdate = true;

    var fillCanvas = document.createElement('canvas');
    fillCanvas.width = 256; fillCanvas.height = 16;
    // (the fill is redrawn each frame via scale, so the canvas is a gradient template)
    var fillCtx = fillCanvas.getContext('2d');
    var grad = fillCtx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, '#ff3344');
    grad.addColorStop(0.5, '#ffaa33');
    grad.addColorStop(1, '#ffee44');
    fillCtx.fillStyle = grad;
    fillCtx.fillRect(0, 0, 256, 16);
    var fillTex = new THREE.Texture(fillCanvas);
    fillTex.needsUpdate = true;

    this._hpBarBgMat = new THREE.SpriteMaterial({
      map: bgTex, transparent: true, depthTest: false, depthWrite: false
    });
    this._hpBarFillMat = new THREE.SpriteMaterial({
      map: fillTex, transparent: true, depthTest: false, depthWrite: false
    });
    this._hpBarBg = new THREE.Sprite(this._hpBarBgMat);
    this._hpBarBg.scale.set(300, 18, 1);
    this._hpBarBg.renderOrder = 40;
    this.scene.add(this._hpBarBg);

    this._hpBarFill = new THREE.Sprite(this._hpBarFillMat);
    this._hpBarFill.scale.set(296, 14, 1);
    this._hpBarFill.renderOrder = 41;
    this.scene.add(this._hpBarFill);
  };

  /* ── Shared explosion textures (cached on the constructor) ─────────────── */

  // Lazily load and cache the 16 explosion frame textures on the Enemy
  // constructor so they are shared by all enemies.
  Enemy._getExplosionTextures = function () {
    if (Enemy._explosionTexCache) return Enemy._explosionTexCache;
    var loader = new THREE.TextureLoader();
    var arr = [];
    for (var i = 0; i < EXPLOSION_FRAMES; i++) {
      var name = 'explosion_' + (i < 10 ? '0' + i : i) + '.png';
      arr.push(loader.load(TEX_DIR + name));
    }
    Enemy._explosionTexCache = arr;
    return arr;
  };

  /* ── Public API ─────────────────────────────────────────────────────────── */

  /**
   * Per-frame update: AI, movement, shooting, animations, explosions.
   * @param {number} dt          delta seconds
   * @param {{x:number,y:number}} playerPos  player position
   * @param {object} bulletManager  BulletManager instance
   */
  Enemy.prototype.update = function (dt, playerPos, bulletManager) {
    if (this._exploding) {
      this._updateExplosion(dt);
      return;
    }
    if (!this.alive) return;

    // Timers.
    if (this._flashTimer > 0) this._flashTimer -= dt;

    // Idle animation phase (used for bob + slight rotation).
    this._idlePhase += dt;

    if (this.type === 'boss') {
      this._updateBoss(dt, playerPos, bulletManager);
    } else {
      this._updateAI(dt, playerPos, bulletManager);
    }

    // Remember the player position so dive() can aim at the current target
    // even though dive() itself takes no arguments.
    if (playerPos) this._lastPlayerPos = { x: playerPos.x, y: playerPos.y };

    this._updateMovement(dt);
    this._updateShooting(dt, playerPos, bulletManager);

    // Particles + sparks always advance (even if not emitting).
    this._updateEngineParticles(dt);
    this._updateSparks(dt);

    // Damage flash material effect.
    this._updateFlash();

    this._syncTransform();
  };

  /** Apply damage.  Returns true if this damage killed the enemy. */
  Enemy.prototype.takeDamage = function (amount) {
    if (!this.alive || this._exploding) return false;
    this.health -= amount;
    this._flashTimer = DAMAGE_FLASH_TIME;
    if (this.health <= 0) {
      this._die();
      return true;
    }
    // Hit spark burst.
    this._spawnSparks(this.position.x, this.position.y, 4);
    return false;
  };

  /** Begin a dive attack toward the player. */
  Enemy.prototype.dive = function () {
    if (this.diving || this._exploding || !this.alive) return;
    if (this.type === 'boss') return; // boss never dives
    this.diving = true;
    this._diveReturning = false;
    this._diveTime = 0;
    this._engineActive = true;

    // Build a cubic bezier curve: start at current pos, swoop down toward
    // the player, arc back up toward the formation slot.
    var start = { x: this.position.x, y: this.position.y };
    var target = this.formationPos;
    // Aim toward the player's last known x, well below.
    var px = (this._lastPlayerPos && this._lastPlayerPos.x) || 0;
    var midX = (this.position.x + px) * 0.5;
    var diveDepth = FIELD_BOTTOM + 80;
    // Control points: c1 pulls down toward player, c2 sweeps across, c3 returns.
    var c1 = { x: midX, y: (start.y + diveDepth) * 0.5 };
    var c2 = { x: (this.position.x + target.x) * 0.5 + (Math.random() - 0.5) * 200, y: diveDepth };
    var c3 = { x: target.x, y: target.y };
    this._diveCurve = [start, c1, c2, c3];
  };

  /** Return to the formation slot (aborts a dive). */
  Enemy.prototype.returnToFormation = function () {
    this.diving = false;
    this._diveReturning = false;
    this._engineActive = false;
    this._diveCurve = null;
  };

  Enemy.prototype.getHitRadius = function () {
    return this._cfg.hitRadius;
  };

  Enemy.prototype.getPosition = function () {
    return { x: this.position.x, y: this.position.y };
  };

  /** Clean up all Three.js resources owned by this enemy. */
  Enemy.prototype.destroy = function () {
    this._disposeSprite(this.sprite);
    if (this._explosionSprite) this._disposeSprite(this._explosionSprite);
    if (this._hpBarBg) this._disposeSprite(this._hpBarBg);
    if (this._hpBarFill) this._disposeSprite(this._hpBarFill);

    var i;
    for (i = 0; i < this._enginePool.length; i++) this._disposeSprite(this._enginePool[i]);
    for (i = 0; i < this._sparkPool.length; i++) this._disposeSprite(this._sparkPool[i]);

    // Dispose per-instance textures (ship sprite + boss HP-bar canvases).
    // Shared cached textures (glow, spark, explosion frame cache) are left
    // intact so other enemies can keep using them.
    if (this._texture) this._texture.dispose();
    if (this._hpBarBgMat && this._hpBarBgMat.map) this._hpBarBgMat.map.dispose();
    if (this._hpBarFillMat && this._hpBarFillMat.map) this._hpBarFillMat.map.dispose();

    this.alive = false;
    this._exploding = false;
  };

  Enemy.prototype._disposeSprite = function (sp) {
    if (!sp) return;
    this.scene.remove(sp);
    if (sp.material) sp.material.dispose();
  };

  /* ── AI per type ───────────────────────────────────────────────────────── */

  Enemy.prototype._updateAI = function (dt, playerPos, bulletManager) {
    var cfg = this._cfg;

    // Diving initiation (only when in formation, not already diving).
    if (!this.diving && Math.random() < cfg.diveChance * dt) {
      // Commanders dive aggressively; grunts occasionally; bombers rarely.
      this.dive();
    }
  };

  /* ── Boss AI & attack patterns ──────────────────────────────────────────── */

  Enemy.prototype._updateBoss = function (dt, playerPos, bulletManager) {
    // The boss holds position near the top of the field, drifting slowly
    // side to side.  It cycles through attack patterns.
    this._bossPatternTimer -= dt;
    if (this._bossPatternTimer <= 0) {
      this._bossPatternIdx = (this._bossPatternIdx + 1) % BOSS_PATTERNS.length;
      this._bossPatternTimer = BOSS_PATTERN_TIME;
      this._bossSpiralAngle = 0;
      this._bossFireTimer = 0;
    }

    // Slow lateral drift across the top.
    var driftTarget = Math.sin(this._idlePhase * 0.4) * (FIELD_HALF_W - 80);
    this.position.x = damp(this.position.x, driftTarget, 1.2, dt);
    this.position.y = damp(this.position.y, FIELD_TOP - 100, 1.5, dt);

    var pattern = BOSS_PATTERNS[this._bossPatternIdx];
    this._bossFireTimer -= dt;

    switch (pattern) {
      case 'aimedSpread':
        // 3-shot spread aimed at the player, every ~0.7s.
        if (this._bossFireTimer <= 0) {
          this._bossFireTimer = 0.7;
          this._fireAimedSpread(playerPos, bulletManager, 3, 0.32);
        }
        break;

      case 'spiral':
        // Rotating bullet stream — a fan of bullets whose base angle spins.
        this._bossSpiralAngle += dt * 2.4;
        if (this._bossFireTimer <= 0) {
          this._bossFireTimer = 0.09;
          this._fireSpiral(bulletManager);
        }
        break;

      case 'fan':
        // Wide fan covering the screen, every ~0.9s.
        if (this._bossFireTimer <= 0) {
          this._bossFireTimer = 0.9;
          this._fireFan(bulletManager, 11, Math.PI * 0.9);
        }
        break;

      case 'summon':
        // Summon 4 grunts once at pattern start.
        if (this._bossFireTimer <= 0 && !this._summonedThisCycle) {
          this._bossFireTimer = 1.0;
          this._summonedThisCycle = true;
          this._summonMinions(bulletManager);
        }
        break;
    }

    // Reset the summon flag when leaving the summon pattern.
    if (pattern !== 'summon') this._summonedThisCycle = false;
  };

  Enemy.prototype._fireAimedSpread = function (playerPos, bulletManager, count, spreadRad) {
    if (!bulletManager || !playerPos) return;
    var base = angleToward(this.position, playerPos);
    var half = spreadRad * 0.5;
    for (var i = 0; i < count; i++) {
      var t = count === 1 ? 0.5 : i / (count - 1);
      var ang = base + (t - 0.5) * spreadRad;
      bulletManager.spawnBossBullet(this.position.x, this.position.y - 40, ang, this._cfg.shotSpeed);
    }
  };

  Enemy.prototype._fireSpiral = function (bulletManager) {
    if (!bulletManager) return;
    // Emit a few bullets whose base angle continuously rotates, producing a
    // multi-arm spiral stream.  The angle is measured in the Bullet.js
    // convention (0 = up, π = down); we bias the stream downward by adding
    // a downward offset so the spiral leans toward the player.
    var arms = 3;
    for (var a = 0; a < arms; a++) {
      var ang = this._bossSpiralAngle + (a / arms) * Math.PI * 2;
      bulletManager.spawnBossBullet(this.position.x, this.position.y - 40, ang, this._cfg.shotSpeed);
    }
  };

  Enemy.prototype._fireFan = function (bulletManager, count, totalSpread) {
    if (!bulletManager) return;
    var base = Math.PI; // straight down
    var half = totalSpread * 0.5;
    for (var i = 0; i < count; i++) {
      var t = count === 1 ? 0.5 : i / (count - 1);
      var ang = base - half + t * totalSpread;
      bulletManager.spawnBossBullet(this.position.x, this.position.y - 40, ang, this._cfg.shotSpeed);
    }
  };

  Enemy.prototype._summonMinions = function (bulletManager) {
    // Summon 4 grunts around the boss.  We delegate to the EnemyManager if
    // available via a callback; otherwise spawn local Enemy instances.
    if (typeof this.onSummonMinions === 'function') {
      this.onSummonMinions(this, BOSS_SUMMON_COUNT);
      return;
    }
    // Fallback: spawn locally (not managed, will not collide with bullets
    // unless the manager picks them up — but better than nothing).
    if (!this._localMinions) this._localMinions = [];
    for (var i = 0; i < BOSS_SUMMON_COUNT; i++) {
      var fx = this.position.x + (i - 1.5) * 80;
      var fy = this.position.y - 60;
      var m = new Enemy(this.scene, 'grunt', { x: fx, y: fy });
      m.maxHealth = BOSS_MINION_HP;
      m.health = BOSS_MINION_HP;
      m.position.set(fx, fy);
      this._localMinions.push(m);
    }
  };

  /* ── Shooting (non-boss) ───────────────────────────────────────────────── */

  Enemy.prototype._updateShooting = function (dt, playerPos, bulletManager) {
    var cfg = this._cfg;
    if (this.type === 'boss') return; // boss handled in _updateBoss
    if (!cfg.canShoot || !bulletManager || !playerPos) return;

    this.shootCooldown -= dt;
    if (this.shootCooldown > 0) return;

    // Only fire when within range and roughly facing the player (below the enemy).
    var dx = playerPos.x - this.position.x;
    var dy = playerPos.y - this.position.y;
    var dist = Math.hypot(dx, dy);
    if (cfg.fireRange && dist > cfg.fireRange) return;
    if (dy > 40) return; // player is above us — don't fire backward

    this.shootCooldown = cfg.fireRate * (0.8 + 0.4 * Math.random());

    if (this.type === 'commander') {
      // Spread of 3 shots.
      var base = angleToward(this.position, playerPos);
      for (var i = -1; i <= 1; i++) {
        var ang = base + i * 0.22;
        bulletManager.spawnEnemyBullet(this.position.x, this.position.y - 24, ang, cfg.shotSpeed, cfg.shotType);
      }
    } else {
      // Bomber: single aimed shot.
      var a = angleToward(this.position, playerPos);
      bulletManager.spawnEnemyBullet(this.position.x, this.position.y - 24, a, cfg.shotSpeed, cfg.shotType);
    }
  };

  /* ── Movement: formation follow + dive bezier ──────────────────────────── */

  Enemy.prototype._updateMovement = function (dt) {
    if (this.diving && this._diveCurve) {
      this._diveTime += dt;
      var total = DIVE_DURATION + DIVE_RETURN_DURATION;
      var t = clamp(this._diveTime / DIVE_DURATION, 0, 1);

      // Phase 1: swoop down along the first 2/3 of the cubic curve.
      // Phase 2: return along the last 1/3.
      if (this._diveTime < DIVE_DURATION) {
        var p = bezier3(this._diveCurve[0], this._diveCurve[1], this._diveCurve[2], this._diveCurve[3], t);
        this.position.x = p.x;
        this.position.y = p.y;
      } else {
        // Returning: ease from current pos back to formation.
        if (!this._diveReturning) {
          this._diveReturning = true;
          this._returnStart = { x: this.position.x, y: this.position.y };
          this._returnT = 0;
        }
        this._returnT += dt / DIVE_RETURN_DURATION;
        var rt = clamp(this._returnT, 0, 1);
        // Smooth ease.
        var e = rt * rt * (3 - 2 * rt);
        this.position.x = damp(this.position.x, this.formationPos.x, 4, dt);
        this.position.y = damp(this.position.y, this.formationPos.y, 4, dt);
        if (rt >= 1) {
          this.returnToFormation();
        }
      }
    } else {
      // Formation follow: smoothly interpolate toward the formation slot.
      this.position.x = damp(this.position.x, this.formationPos.x, FORMATION_LERP * this._cfg.speed, dt);
      this.position.y = damp(this.position.y, this.formationPos.y, FORMATION_LERP * this._cfg.speed, dt);
    }

    // Keep the engine trail emitting only while diving.
    this._engineActive = this.diving;
  };

  /* ── Death ────────────────────────────────────────────────────────────── */

  Enemy.prototype._die = function () {
    this.alive = false;
    this._exploding = true;
    this._explosionTime = 0;
    this._explosionFrame = 0;
    this._explosionSprite.visible = true;
    this._explosionSprite.position.set(this.position.x, this.position.y, 0.3);
    this._explosionMaterial.map = this._explosionTextures[0];
    this._explosionMaterial.opacity = 1.0;
    // Hide the ship sprite immediately; the explosion plays on top.
    this.sprite.visible = false;
    if (this._hpBarBg) this._hpBarBg.visible = false;
    if (this._hpBarFill) this._hpBarFill.visible = false;
    // Stop engine particles.
    this._engineActive = false;
  };

  Enemy.prototype._updateExplosion = function (dt) {
    this._explosionTime += dt;
    var frame = Math.floor(this._explosionTime / EXPLOSION_FRAME_TIME);
    if (frame >= EXPLOSION_FRAMES) {
      // Explosion finished.
      this._exploding = false;
      this._explosionSprite.visible = false;
      return;
    }
    if (frame !== this._explosionFrame) {
      this._explosionFrame = frame;
      this._explosionMaterial.map = this._explosionTextures[frame];
      this._explosionMaterial.needsUpdate = true;
    }
    // Scale grows over the animation for a "bloom".
    var f = frame / (EXPLOSION_FRAMES - 1);
    var base = (this.type === 'boss') ? EXPLOSION_SIZE_BOSS : EXPLOSION_SIZE_BASE;
    var s = base * (0.6 + 0.8 * f);
    this._explosionSprite.scale.set(s, s, 1);
    // Fade out near the end.
    var fade = 1.0;
    if (frame > EXPLOSION_FRAMES - 4) {
      fade = (EXPLOSION_FRAMES - frame) / 4;
    }
    this._explosionMaterial.opacity = clamp(fade, 0, 1);
    this._explosionSprite.position.set(this.position.x, this.position.y, 0.3);
  };

  /* ── Damage flash ─────────────────────────────────────────────────────── */

  Enemy.prototype._updateFlash = function () {
    if (this._flashTimer > 0) {
      // Brighten / whiten the sprite while flashing.
      var t = this._flashTimer / DAMAGE_FLASH_TIME;
      // Use material.color to lerp toward white; store original tint.
      if (!this._origColor) this._origColor = this._material.color ? this._material.color.clone() : new THREE.Color(0xffffff);
      this._material.color.setRGB(
        clamp(this._origColor.r + (1 - this._origColor.r) * t, 0, 1),
        clamp(this._origColor.g + (1 - this._origColor.g) * t, 0, 1),
        clamp(this._origColor.b + (1 - this._origColor.b) * t, 0, 1)
      );
      this._material.opacity = 0.6 + 0.4 * t;
    } else {
      if (this._origColor && this._material.color) {
        this._material.color.copy(this._origColor);
        this._material.opacity = 1.0;
      }
    }
  };

  /* ── Engine-glow particles ─────────────────────────────────────────────── */

  Enemy.prototype._updateEngineParticles = function (dt) {
    if (this._engineActive && this.alive && !this._exploding) {
      this._engineTimer -= dt;
      while (this._engineTimer <= 0) {
        this._engineTimer += ENGINE_PARTICLE_RATE;
        this._emitEngineParticle();
      }
    }
    for (var i = this._engineParticles.length - 1; i >= 0; i--) {
      var p = this._engineParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        p.sprite.material.opacity = 0;
        this._enginePool.push(p.sprite);
        this._engineParticles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      var t = p.life / p.maxLife;
      var scale = ENGINE_PARTICLE_SIZE * (0.4 + 0.7 * t);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = 0.8 * t;
      p.sprite.position.set(p.x, p.y, 0.1);
    }
  };

  Enemy.prototype._emitEngineParticle = function () {
    var sp = this._enginePool.pop();
    if (!sp) return;
    var x = this.position.x + (Math.random() - 0.5) * 18;
    var y = this.position.y + (this.diving ? 18 : -18); // trail behind motion
    sp.visible = true;
    sp.material.opacity = 0.8;
    // Color tint by enemy type.
    var col = 0xffaa44;
    if (this.type === 'commander') col = 0xffdd66;
    else if (this.type === 'boss') col = 0xcc66ff;
    sp.material.color.setHex(col);
    var p = {
      sprite: sp,
      x: x, y: y,
      vx: (Math.random() - 0.5) * 60,
      vy: this.diving ? ENGINE_PARTICLE_SPEED : -ENGINE_PARTICLE_SPEED,
      life: ENGINE_PARTICLE_LIFE * (0.7 + 0.6 * Math.random()),
      maxLife: ENGINE_PARTICLE_LIFE
    };
    p.maxLife = p.life;
    this._engineParticles.push(p);
  };

  /* ── Hit sparks ────────────────────────────────────────────────────────── */

  Enemy.prototype._spawnSparks = function (x, y, count) {
    count = count || SPARK_COUNT;
    for (var i = 0; i < count; i++) {
      var sp = this._sparkPool.pop();
      if (!sp) break;
      var ang = Math.random() * Math.PI * 2;
      var spd = SPARK_SPEED * (0.5 + Math.random());
      sp.visible = true;
      sp.material.opacity = 1.0;
      var col = 0xffffcc;
      sp.material.color.setHex(col);
      var p = {
        sprite: sp,
        x: x, y: y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: SPARK_LIFE * (0.6 + 0.8 * Math.random())
      };
      p.maxLife = p.life;
      this._sparks.push(p);
    }
  };

  Enemy.prototype._updateSparks = function (dt) {
    for (var i = this._sparks.length - 1; i >= 0; i--) {
      var p = this._sparks[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        p.sprite.material.opacity = 0;
        this._sparkPool.push(p.sprite);
        this._sparks.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      var t = p.life / p.maxLife;
      var scale = 14 * (0.4 + 0.6 * t);
      p.sprite.scale.set(scale, scale, 1);
      p.sprite.material.opacity = t;
      p.sprite.position.set(p.x, p.y, 0.2);
    }
  };

  /* ── Transform sync (idle anim + sprite placement) ─────────────────────── */

  Enemy.prototype._syncTransform = function () {
    if (this._exploding) return; // explosion sprite positioned separately

    // Idle bob + slight rotation for a "living" feel.
    var bobAmp = (this.type === 'boss') ? 6 : 4;
    var bob = Math.sin(this._idlePhase * 2.2) * bobAmp;
    var rot = Math.sin(this._idlePhase * 1.3) * 0.12; // ~7° sway

    this.sprite.position.set(this.position.x, this.position.y + bob, 0.2);
    this.sprite.material.rotation = rot;

    // Boss health bar follows above the boss.
    if (this.type === 'boss' && this._hpBarFill && this._hpBarBg) {
      var barY = this.position.y + this._cfg.size * 0.55 + 16;
      this._hpBarBg.position.set(this.position.x, barY, 0.4);
      this._hpBarFill.position.set(this.position.x, barY, 0.41);
      var pct = clamp(this.health / this.maxHealth, 0, 1);
      // Scale the fill horizontally around its left edge: we move it so the
      // bar shrinks from the right.  Achieve by scaling and offsetting.
      var fillW = 296 * pct;
      this._hpBarFill.scale.set(fillW, 14, 1);
      // Offset so the left edge stays fixed.
      this._hpBarFill.position.x = this.position.x - (296 - fillW) * 0.5;
      // Fade slightly when low to add urgency.
      this._hpBarFill.material.opacity = 0.7 + 0.3 * pct;
    }
  };

  /* =============================================================================
   *  EnemyManager
   * ========================================================================== */

  function EnemyManager(scene) {
    this.scene = scene;
    this.enemies = [];
    this.wave = 0;

    // Callbacks the Game can set.
    this.onEnemyKilled = null;      // function(enemy) -> score/sfx hook
    this.onBossSummon = null;       // function(boss, count) handled by manager
  }

  /* ── Wave spawning ─────────────────────────────────────────────────────── */

  /**
   * Spawn a wave of enemies.  Wave composition scales with waveNum:
   *   - Waves 1-2:   grunts only
   *   - Waves 3-4:   grunts + a few bombers
   *   - Waves 5-7:   grunts + bombers + a commander
   *   - Wave 8:      BOSS (plus minions summoned during the fight)
   *   - Wave 9+:     repeat with scaling HP
   *   - Every 8th wave: boss
   */
  EnemyManager.prototype.spawnWave = function (waveNum) {
    this.wave = waveNum;
    // Don't clear here — the Game calls clear() between waves.  But we do
    // ensure we're empty.
    if (this.enemies.length) this.clear();

    var isBossWave = (waveNum % 8 === 0);
    var hpScale = 1 + (waveNum - 1) * 0.18; // +18% HP per wave

    if (isBossWave) {
      this._spawnBossWave(waveNum, hpScale);
      return;
    }

    // Formation grid: rows x columns of slots.
    var cols = clamp(6 + Math.floor(waveNum / 2), 6, 10);
    var rows = clamp(2 + Math.floor(waveNum / 3), 2, 4);
    var spacingX = 90;
    var spacingY = 70;
    var topY = FIELD_TOP - 80;
    var leftX = -((cols - 1) * spacingX) * 0.5;

    var slotIndex = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var fx = leftX + c * spacingX;
        var fy = topY - r * spacingY;

        // Pick type based on row (top rows = stronger).
        var type = 'grunt';
        if (r === 0 && waveNum >= 5) type = 'commander';
        else if (r <= 1 && waveNum >= 3) type = 'bomber';
        else type = 'grunt';

        // Only one commander per wave (the first slot of row 0).
        if (type === 'commander' && slotIndex > 0 && this._hasCommander()) {
          type = 'grunt';
        }

        var e = new Enemy(this.scene, type, { x: fx, y: fy });
        // Apply wave HP scaling.
        e.maxHealth = Math.round(e.maxHealth * hpScale);
        e.health = e.maxHealth;

        // Wire up summon callback so boss minions register with the manager.
        var self = this;
        e.onSummonMinions = function (boss, count) {
          self._spawnMinions(boss, count, hpScale);
        };

        this.enemies.push(e);
        slotIndex++;
      }
    }
  };

  EnemyManager.prototype._hasCommander = function () {
    for (var i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].type === 'commander' && this.enemies[i].alive) return true;
    }
    return false;
  };

  EnemyManager.prototype._spawnBossWave = function (waveNum, hpScale) {
    var boss = new Enemy(this.scene, 'boss', { x: 0, y: FIELD_TOP - 100 });
    // Boss HP scales hard with wave number beyond the first boss appearance.
    var bossHp = 1000 + Math.floor((waveNum / 8) - 1) * 600;
    boss.maxHealth = Math.round(bossHp * hpScale);
    boss.health = boss.maxHealth;
    var self = this;
    boss.onSummonMinions = function (b, count) {
      self._spawnMinions(b, count, hpScale);
    };
    this.enemies.push(boss);
  };

  EnemyManager.prototype._spawnMinions = function (boss, count, hpScale) {
    for (var i = 0; i < count; i++) {
      var fx = boss.position.x + (i - (count - 1) * 0.5) * 80;
      var fy = boss.position.y - 70;
      var m = new Enemy(this.scene, 'grunt', { x: fx, y: fy });
      m.maxHealth = Math.round(BOSS_MINION_HP * hpScale);
      m.health = m.maxHealth;
      m.position.set(fx, fy);
      m.onSummonMinions = boss.onSummonMinions;
      this.enemies.push(m);
    }
  };

  /* ── Per-frame update ──────────────────────────────────────────────────── */

  EnemyManager.prototype.update = function (dt, playerPos, bulletManager) {
    for (var i = this.enemies.length - 1; i >= 0; i--) {
      var e = this.enemies[i];
      e.update(dt, playerPos, bulletManager);

      // Remove fully-dead, finished-exploding enemies.
      if (!e.alive && !e._exploding) {
        e.destroy();
        this.enemies.splice(i, 1);
      } else if (e._exploding && !e._explosionSprite.visible && e._explosionTime > 0) {
        // Explosion finished — remove.
        e.destroy();
        this.enemies.splice(i, 1);
      }
    }
  };

  EnemyManager.prototype.getEnemies = function () {
    // Return only alive enemies (those that can be collided with / shot).
    var live = [];
    for (var i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].alive && !this.enemies[i]._exploding) live.push(this.enemies[i]);
    }
    return live;
  };

  EnemyManager.prototype.getAllEnemies = function () {
    return this.enemies;
  };

  /* ── Collisions ────────────────────────────────────────────────────────── */

  /**
   * Check all alive enemies against a bullet manager's player bullets.
   * Delegates the spatial check to the BulletManager's own collision system
   * by passing the enemy list as targets, then applies damage for each hit.
   *
   * @param {object} bullets  BulletManager (uses its checkCollisions)
   * @returns {Array<{enemy, bullet, x, y}>}  hit records
   */
  EnemyManager.prototype.checkCollisions = function (bullets) {
    var hits = [];
    if (!bullets || typeof bullets.checkCollisions !== 'function') return hits;

    var targets = this.getEnemies();
    if (targets.length === 0) return hits;

    var rawHits = bullets.checkCollisions(targets);
    for (var i = 0; i < rawHits.length; i++) {
      var h = rawHits[i];
      var enemy = h.target;
      if (!enemy || !enemy.alive) continue;

      // Only player bullets and the hyperbeam damage enemies.
      if (h.type !== 'player' && h.type !== 'special') continue;

      var dmg = (h.type === 'special') ? 3 : 1; // hyperbeam hits harder
      var killed = enemy.takeDamage(dmg);
      hits.push({ enemy: enemy, bullet: h.bullet, x: h.x, y: h.y, killed: killed });

      if (killed && typeof this.onEnemyKilled === 'function') {
        this.onEnemyKilled(enemy);
      }
    }
    return hits;
  };

  /* ── Bulk operations ───────────────────────────────────────────────────── */

  EnemyManager.prototype.clear = function () {
    for (var i = 0; i < this.enemies.length; i++) {
      this.enemies[i].destroy();
    }
    this.enemies.length = 0;
  };

  EnemyManager.prototype.destroy = function () {
    this.clear();
  };

  EnemyManager.prototype.getAliveCount = function () {
    return this.getEnemies().length;
  };

  EnemyManager.prototype.hasBoss = function () {
    for (var i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].type === 'boss' && this.enemies[i].alive) return true;
    }
    return false;
  };

  /* ── Export ────────────────────────────────────────────────────────────── */

  Enemy.TYPE_CONFIG = TYPE_CONFIG;
  global.Enemy = Enemy;
  global.EnemyManager = EnemyManager;

})(typeof window !== 'undefined' ? window : globalThis);
