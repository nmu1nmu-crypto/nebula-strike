/**
 * Game.js — Main orchestrator for Galaxy Reborn.
 * Ties together all subsystems: renderer, input, player, enemies, bullets,
 * particles, background, audio, effects, power-ups, formations, and UI.
 */
(function (global) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────
  var PLAY_W = 800;
  var PLAY_H = 1200;
  var CAM_Z  = 100;

  // Scale factor: world units → screen (computed on resize)
  var SCALE = 1;

  var STATE = {
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    WAVE_TRANS: 'wave_transition',
    GAME_OVER: 'game_over'
  };

  // ── Level Definitions ──────────────────────────────────────────────────
  // 10 themed levels, each cycling through different background themes and
  // escalating difficulty. After level 10, levels repeat with increased HP.
  var LEVELS = [
    { name: 'Deep Space',     themeIdx: 0, musicTrack: 0, enemyHpMul: 1.0,  enemyCount: 8,  diveRate: 0.4,  bossWave: false },
    { name: 'Crimson Nebula', themeIdx: 1, musicTrack: 0, enemyHpMul: 1.1,  enemyCount: 10, diveRate: 0.5,  bossWave: false },
    { name: 'Emerald Void',   themeIdx: 2, musicTrack: 1, enemyHpMul: 1.2,  enemyCount: 12, diveRate: 0.5,  bossWave: false },
    { name: 'Purple Haze',    themeIdx: 3, musicTrack: 1, enemyHpMul: 1.3,  enemyCount: 12, diveRate: 0.6,  bossWave: false },
    { name: 'Golden Wastes',  themeIdx: 4, musicTrack: 0, enemyHpMul: 1.4,  enemyCount: 14, diveRate: 0.6,  bossWave: false },
    { name: 'Ice Fields',     themeIdx: 5, musicTrack: 1, enemyHpMul: 1.5,  enemyCount: 14, diveRate: 0.7,  bossWave: false },
    { name: 'Inferno',        themeIdx: 6, musicTrack: 0, enemyHpMul: 1.6,  enemyCount: 16, diveRate: 0.7,  bossWave: true  },
    { name: 'Twilight',       themeIdx: 7, musicTrack: 2, enemyHpMul: 1.8,  enemyCount: 16, diveRate: 0.8,  bossWave: false },
    { name: 'Aurora',         themeIdx: 8, musicTrack: 2, enemyHpMul: 2.0,  enemyCount: 18, diveRate: 0.8,  bossWave: false },
    { name: 'The Void',       themeIdx: 9, musicTrack: 2, enemyHpMul: 2.5,  enemyCount: 20, diveRate: 0.9,  bossWave: true  }
  ];

  // ── Game ──────────────────────────────────────────────────────────────
  function Game() {
    // ── Three.js core ──
    this.canvas   = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000510, 1);
    this.renderer.autoClear = true;

    this.scene  = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000510, 0.0004);

    // Orthographic camera for 2.5D sprite game — shows full playfield
    this.camera = new THREE.OrthographicCamera(-400, 400, 600, -600, 1, 2000);
    this.camera.position.set(0, 0, CAM_Z);
    this.camera.lookAt(0, 0, 0);

    // Set up camera frustum based on initial viewport size
    this._onResize();

    // ── Subsystems ──
    this.input       = new Input();
    this.ui          = new UI();
    this.audio       = new AudioEngine();
    this.effects     = new Effects(this.scene, this.camera, document.getElementById('game-container'));
    this.background  = new Background(this.scene);
    this.particles   = new ParticleSystem(this.scene, 6000);
    this.bullets     = new BulletManager(this.scene);
    this.player      = new Player(this.scene);
    this.enemies     = new EnemyManager(this.scene);
    this.powerups    = new PowerUpManager(this.scene, this.particles);
    this.formation   = new FormationManager(PLAY_W, PLAY_H);

    // ── Game state ──
    this.state      = STATE.MENU;
    this.waveNum    = 0;
    this.levelIdx   = 0;  // index into LEVELS array
    this.currentLevel = null;
    this.score      = 0;
    this.combo      = 1;
    this.comboTimer = 0;
    this.maxCombo   = 1;
    this.timeScale  = 1.0;
    this.waveTransitionTimer = 0;
    this.enemySpawnPending = false;
    this.bossWarningTimer  = 0;

    // ── Callback wiring ──
    this.player.onHit = this._onPlayerHit.bind(this);
    this.player.onSpecialFired = this._onSpecialFired.bind(this);
    this.enemies.onEnemyKilled = this._onEnemyKilled.bind(this);
    this.powerups.onBomb = this._onBomb.bind(this);

    // ── DOM events ──
    window.addEventListener('resize', this._onResize.bind(this));
    document.getElementById('start-btn').addEventListener('click', this.startGame.bind(this));
    document.getElementById('restart-btn').addEventListener('click', this.startGame.bind(this));
    document.getElementById('resume-btn').addEventListener('click', this.togglePause.bind(this));

    // Sound toggle button
    var soundBtn = document.getElementById('sound-toggle');
    if (soundBtn) {
      soundBtn.addEventListener('click', this._toggleSound.bind(this));
    }

    // Key handling for start/pause
    this.input.onKeyPress(this._onKeyPress.bind(this));

    // Player initial position
    this.player.position.x = 0;
    this.player.position.y = -PLAY_H / 2 + 120;

    // Show start screen
    this.ui.showStart(true);
    this.ui.setScore(0);
    this.ui.setLives(3);
    this.ui.setCombo(1, 0);

    // Start render loop
    this._lastTime = performance.now();
    this._startLoop();
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  Game.prototype._loopBound = null;

  Game.prototype._startLoop = function () {
    if (this._loopBound) return;
    this._loopBound = this._loop.bind(this);
    this._lastTime = performance.now();
    requestAnimationFrame(this._loopBound);
  };

  Game.prototype._loop = function () {
    requestAnimationFrame(this._loopBound);
    var now = performance.now();
    var dt  = Math.min(0.1, (now - this._lastTime) / 1000); // cap at 100ms max to avoid huge jumps
    this._lastTime = now;

    // Apply slow-mo time scale from Effects
    var ts = this.effects.getTimeScale();
    var scaledDt = dt * ts;

    this._update(scaledDt, dt);
    this._render();
  };

  Game.prototype._update = function (dt, realDt) {
    this.input.update();

    // Always update background for ambient motion
    this.background.update(dt, this.player.velocity);

    switch (this.state) {
      case STATE.MENU:
        // idle player bob
        this.player.update(dt, { left: false, right: false, up: false, down: false, fire: false, special: false }, null);
        break;

      case STATE.PLAYING:
        this._updatePlaying(dt);
        break;

      case STATE.PAUSED:
        // Still update particles/effects minimally
        this.effects.update(realDt);
        this.particles.update(dt * 0.1);
        break;

      case STATE.WAVE_TRANS:
        this.waveTransitionTimer -= realDt;
        this.player.update(dt, { left: false, right: false, up: false, down: false, fire: false, special: false }, this.bullets);
        this.particles.update(dt);
        this.bullets.update(dt);
        if (this.waveTransitionTimer <= 0) {
          this._spawnWave();
        }
        break;

      case STATE.GAME_OVER:
        this.particles.update(dt);
        this.bullets.update(dt);
        break;
    }

    // Effects & UI always update
    this.effects.update(realDt);
    this.ui.update(dt);
  };

  Game.prototype._updatePlaying = function (dt) {
    // Build input adapter for Player (which expects left/right/up/down/fire/special booleans)
    var move = this.input.getMovement();
    var inputAdapter = {
      left: move.x < -0.1,
      right: move.x > 0.1,
      up: move.y < -0.1,
      down: move.y > 0.1,
      fire: this.input.fire,
      special: this.input.special
    };

    // Player
    this.player.update(dt, inputAdapter, this.bullets);

    // Audio engine update (engine hum pitch based on velocity)
    this.audio.update(this.player.velocity);

    // Enemies
    this.enemies.update(dt, this.player.position, this.bullets);

    // Formation
    this.formation.update(dt, this.enemies.getEnemies(), this.player.position);

    // Bullets
    this.bullets.update(dt);

    // Collisions: player bullets vs enemies
    var hits = this.enemies.checkCollisions(this.bullets);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      // Hit spark
      this.particles.emitHitSpark(h.x, h.y, 0);
      this.audio.playSound('hit');
      if (h.killed) {
        this._onEnemyKilled(h.enemy);
      }
    }

    // Collisions: enemy bullets vs player
    if (!this.player.invulnerable) {
      var enemyBullets = this.bullets.getEnemyBullets();
      for (var j = 0; j < enemyBullets.length; j++) {
        var eb = enemyBullets[j];
        if (!eb.alive) continue;
        var dx = eb.x - this.player.position.x;
        var dy = eb.y - this.player.position.y;
        var rr = (this.player.getHitRadius() + (eb.hitRadius || 10));
        if (dx * dx + dy * dy <= rr * rr) {
          // Player hit by enemy bullet
          this.player.takeDamage();
          // Retire bullet
          if (typeof this.bullets._retire === 'function') {
            // Find which active list it's in
            var idx = this.bullets._enemyActive.indexOf(eb);
            if (idx >= 0) this.bullets._retire(eb, this.bullets._enemyActive);
          }
          break;
        }
      }
    }

    // Collisions: enemies vs player (diving enemies can hit player)
    if (!this.player.invulnerable) {
      var enemies = this.enemies.getEnemies();
      for (var k = 0; k < enemies.length; k++) {
        var en = enemies[k];
        if (!en.alive) continue;
        var edx = en.position.x - this.player.position.x;
        var edy = en.position.y - this.player.position.y;
        var err = this.player.getHitRadius() + en.getHitRadius();
        if (edx * edx + edy * edy <= err * err) {
          this.player.takeDamage();
          en.takeDamage(999); // destroy the colliding enemy
          this._onEnemyKilled(en);
          break;
        }
      }
    }

    // Power-ups
    this.powerups.update(dt, this.player.position, this.player);
    var collected = this.powerups.checkPickup(this.player);
    for (var c = 0; c < collected.length; c++) {
      this.audio.playSound('powerup');
      this.effects.flash('rgba(0,255,200,0.3)', 0.2);
      this.particles.emitPowerupSparkle(collected[c].x, collected[c].y);
    }

    // Particles
    this.particles.update(dt);

    // Combo decay
    if (this.combo > 1) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 1;
        this.ui.setCombo(1, 0);
      } else {
        this.ui.setCombo(this.combo, this.comboTimer / 3.0);
      }
    }

    // Check wave clear
    if (this.enemies.getAliveCount() === 0 && !this.enemySpawnPending) {
      this.enemySpawnPending = true;
      this._startWaveTransition();
    }

    // Boss warning
    if (this.bossWarningTimer > 0) {
      this.bossWarningTimer -= dt;
      if (this.bossWarningTimer <= 0) {
        this.audio.playSound('boss');
      }
    }
  };

  // ── Game flow ─────────────────────────────────────────────────────────
  Game.prototype.startGame = function () {
    this.state    = STATE.PLAYING;
    this.waveNum  = 0;
    this.score    = 0;
    this.combo    = 1;
    this.maxCombo = 1;
    this.comboTimer = 0;
    this.enemySpawnPending = false;

    this.ui.hideAll();
    this.ui.setScore(0);
    this.ui.setLives(3);
    this.ui.setCombo(1, 0);

    this.player.reset();
    this.player.position.x = 0;
    this.player.position.y = -PLAY_H / 2 + 120;

    this.enemies.clear();
    this.bullets.clear();
    this.powerups.clear();
    this.particles.clear();

    this.audio.playMusic();
    this._startWaveTransition();
  };

  Game.prototype._startWaveTransition = function () {
    this.waveNum++;
    this.state = STATE.WAVE_TRANS;
    this.waveTransitionTimer = 2.5;
    this.enemySpawnPending = false;

    // Determine which level config to use (cycle through LEVELS, escalating after 10)
    this.levelIdx = (this.waveNum - 1) % LEVELS.length;
    var cycleMul = 1.0 + Math.floor((this.waveNum - 1) / LEVELS.length) * 0.5; // +50% HP per cycle
    this.currentLevel = LEVELS[this.levelIdx];

    // Apply background theme
    if (this.background && typeof this.background.setTheme === 'function') {
      if (typeof Background !== 'undefined' && Background.THEMES) {
        this.background.setTheme(Background.THEMES[this.currentLevel.themeIdx]);
      }
    }

    // Apply music track for this level
    if (this.audio && typeof this.audio.setMusicTrack === 'function') {
      this.audio.setMusicTrack(this.currentLevel.musicTrack);
    }

    this.ui.setWave(this.waveNum);
    // Show level name in HUD and wave transition
    this.ui.setLevelName(this.currentLevel.name || '');
    this.ui.showWaveTransition(this.waveNum, 2.5);
    if (this.currentLevel.name) {
      var elTrans = document.getElementById('wave-transition');
      if (elTrans) {
        var elName = elTrans.querySelector('.wave-subtext');
        if (elName) elName.textContent = this.currentLevel.name.toUpperCase();
      }
    }
    this.effects.waveFlash();
    this.audio.playSound('wavestart');

    // Boss warning for boss waves
    if (this.currentLevel.bossWave) {
      this.bossWarningTimer = 1.5;
    }

    // Speed up background for visual intensity
    this.background.setSpeed(1.0 + this.waveNum * 0.05);
  };

  Game.prototype._spawnWave = function () {
    this.state = STATE.PLAYING;
    this.enemies.spawnWave(this.waveNum);

    // Apply level-specific HP multiplier to all spawned enemies
    if (this.currentLevel && this.currentLevel.enemyHpMul) {
      var enemies = this.enemies.getAllEnemies ? this.enemies.getAllEnemies() : this.enemies.getEnemies();
      var hpMul = this.currentLevel.enemyHpMul;
      for (var i = 0; i < enemies.length; i++) {
        enemies[i].maxHealth = Math.round(enemies[i].maxHealth * hpMul);
        enemies[i].health = enemies[i].maxHealth;
      }
    }

    // Configure formation
    enemies = this.enemies.getEnemies();
    this.formation.configure(this.waveNum, enemies);
    this.formation.startEntry(enemies);
  };

  Game.prototype.togglePause = function () {
    if (this.state === STATE.PLAYING) {
      this.state = STATE.PAUSED;
      this.ui.showPause(true);
      this.audio.stopMusic();
    } else if (this.state === STATE.PAUSED) {
      this.state = STATE.PLAYING;
      this.ui.showPause(false);
      this.audio.playMusic();
    }
  };

  Game.prototype._gameOver = function () {
    this.state = STATE.GAME_OVER;
    this.ui.showGameOver(true, this.score, this.waveNum, this.maxCombo);
    this.audio.stopMusic();
    this.audio.playSound('gameover');
    this.effects.shake(30, 1.0);
    this.effects.flash('rgba(255,0,0,0.4)', 0.5);
  };

  // ── Event handlers ─────────────────────────────────────────────────────
  Game.prototype._onKeyPress = function (code) {
    if (code === 'Enter') {
      if (this.state === STATE.MENU || this.state === STATE.GAME_OVER) {
        this.startGame();
      }
    }
    if (code === 'KeyP') {
      if (this.state === STATE.PLAYING || this.state === STATE.PAUSED) {
        this.togglePause();
      }
    }
    if (code === 'KeyM') {
      this._toggleSound();
    }
  };

  // ── Sound toggle ────────────────────────────────────────────────────────
  Game.prototype._toggleSound = function () {
    var muted = this.audio.toggleMute();
    var btn = document.getElementById('sound-toggle');
    if (btn) {
      btn.textContent = muted ? '🔇' : '🔊';
      btn.classList.toggle('muted', muted);
    }
  };

  Game.prototype._onPlayerHit = function (player) {
    this.audio.playSound('damage');
    this.effects.shake(20, 0.4);
    this.effects.flash('rgba(255,0,0,0.3)', 0.2);
    this.effects.vignettePulse(1.5);
    this.particles.emitExplosion(player.position.x, player.position.y, 1.5);
    this.effects.slowMotion(0.3, 0.4);
    this.ui.setLives(player.health);

    // Reset combo on player hit
    this.combo = 1;
    this.ui.setCombo(1, 0);

    if (player.health <= 0) {
      this._gameOver();
    }
  };

  Game.prototype._onSpecialFired = function (player, charge) {
    this.audio.playSound('special');
    this.effects.shake(15, 0.3);
    this.effects.flash('rgba(0,229,255,0.3)', 0.3);
    this.bullets.fireSpecial(player.position.x, player.position.y);
    // Clear nearby enemy bullets (EMP effect)
    this._clearEnemyBulletsNear(player.position.x, player.position.y, 300);
  };

  Game.prototype._onBomb = function (x, y) {
    this.audio.playSound('explosion_big');
    this.effects.shake(25, 0.6);
    this.effects.flash('rgba(255,200,0,0.4)', 0.4);
    // Damage all on-screen enemies
    var enemies = this.enemies.getEnemies();
    for (var i = 0; i < enemies.length; i++) {
      var killed = enemies[i].takeDamage(50);
      if (killed) this._onEnemyKilled(enemies[i]);
    }
    // Clear all enemy bullets
    this.bullets.clear();
    this.particles.emitExplosion(x, y, 3);
  };

  Game.prototype._onEnemyKilled = function (enemy) {
    // Score with combo multiplier
    var baseScore = enemy.score || 100;
    var totalScore = baseScore * this.combo;
    this.score += totalScore;
    this.ui.setScore(this.score);

    // Combo increment
    this.combo++;
    this.comboTimer = 3.0;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.ui.setCombo(this.combo, 1.0);

    // Effects
    this.audio.playSound('explosion');
    this.particles.emitExplosion(enemy.position.x, enemy.position.y, enemy.type === 'boss' ? 3 : 1);
    this.effects.shake(enemy.type === 'boss' ? 15 : 4, enemy.type === 'boss' ? 0.5 : 0.15);
    this.effects.scorePopup(enemy.position.x, enemy.position.y, '+' + totalScore, this.combo > 3 ? '#FF00AA' : '#00E5FF');

    if (this.combo >= 5) {
      this.effects.comboPopup(enemy.position.x, enemy.position.y - 30, this.combo);
    }

    // Power-up drop chance
    this.powerups.maybeDrop(enemy.position.x, enemy.position.y, enemy.type === 'boss' ? 1.0 : 0.15);

    // Boss kill
    if (enemy.type === 'boss') {
      this.effects.slowMotion(0.3, 1.0);
      this.effects.flash('rgba(255,215,0,0.3)', 0.5);
      this.audio.playSound('explosion_big');
      this.score += 5000;
      this.ui.setScore(this.score);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  Game.prototype._clearEnemyBulletsNear = function (x, y, radius) {
    var enemyBullets = this.bullets.getEnemyBullets();
    for (var i = enemyBullets.length - 1; i >= 0; i--) {
      var eb = enemyBullets[i];
      if (!eb.alive) continue;
      var dx = eb.x - x;
      var dy = eb.y - y;
      if (dx * dx + dy * dy <= radius * radius) {
        var idx = this.bullets._enemyActive.indexOf(eb);
        if (idx >= 0) this.bullets._retire(eb, this.bullets._enemyActive);
      }
    }
  };

  Game.prototype._onResize = function () {
    // Maintain the playfield in ortho camera, adapting to screen aspect
    var aspect = window.innerWidth / window.innerHeight;
    
    // Fit the full playfield vertically, extend horizontally if wider
    var halfH = PLAY_H / 2; // 600
    var halfW = halfH * aspect;
    
    // If screen is narrower than playfield, fit by width instead
    if (halfW < PLAY_W / 2) {
      halfW = PLAY_W / 2;
      halfH = halfW / aspect;
    }
    
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._updateBounds();
    if (this.background) this.background.resize(window.innerWidth, window.innerHeight);
  };

  Game.prototype._updateBounds = function () {
    this.bounds = {
      left: this.camera.left,
      right: this.camera.right,
      top: this.camera.top,
      bottom: this.camera.bottom,
      width: this.camera.right - this.camera.left,
      height: this.camera.top - this.camera.bottom
    };
  };

  // ── Render ─────────────────────────────────────────────────────────────
  Game.prototype._render = function () {
    this.renderer.render(this.scene, this.camera);
  };

  // ── Start (called from HTML) ────────────────────────────────────────────
  Game.prototype.start = function () {
    // The loop already started in constructor; this is a no-op placeholder
    // for the HTML's `game.start()` call.
  };

  global.Game = Game;
})(window);
