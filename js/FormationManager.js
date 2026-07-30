/* =============================================================================
 *  FormationManager.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  Classic Galaga-style formation system.  Rows and columns of enemies are
 *  arranged in a grid at the top of the playfield and move as a group:
 *  a left-right sweeping motion with a smooth sinusoidal turn at the edges.
 *  Over time the whole formation descends slightly toward the player, and
 *  a dive scheduler periodically picks enemies to break formation and dive
 *  at the player along curved paths.
 *
 *  Entry animation: when a wave begins, enemies fly in from off-screen along
 *  curved (arc) paths to their assigned formation slots, with staggered
 *  timing, before the group sweep begins.
 *
 *  The manager is agnostic to how enemies are rendered — it only manipulates
 *  their `position` ({x,y}) and reads a small interface from each enemy:
 *
 *      enemy.position            {x,y}          (read/write; updated by us)
 *      enemy.formationRow       int             (assigned by configure())
 *      enemy.formationCol       int             (assigned by configure())
 *      enemy.state              string          ('entry'|'formation'|'dive'|'returning')
 *      enemy.divePath           object|null      (set when diving)
 *      enemy.update(dt, ...)    optional; called by the Game, not by us.
 *      enemy.sprite             THREE.Sprite     (optional; we set rotation for banking)
 *
 *  Constructor:   new FormationManager(playfieldWidth, playfieldHeight)
 *
 *  Properties:
 *      formationOffset   current x offset of the whole formation (world units)
 *      formationY        current baseline y of the formation
 *      direction         current sweep direction: 1 (right) or -1 (left)
 *      speed             current sweep speed (px/s)
 *      enemies           array of enemies in the current formation (alias)
 *
 *  Public API:
 *      configure(waveNum, enemies)
 *      update(dt, enemies, playerPos)
 *      getFormationPosition(row, col, rows, cols)  -> {x, y}
 *      startEntry(enemies)
 *      isEntryComplete()                            -> bool
 *      getFormationBounds()                         -> {minX,maxX,minY,maxY}
 *      triggerDive(enemies, playerPos, [count])     manual dive request
 *      destroy()
 *
 *  THREE.js (r0.160) global from CDN. No ES6 modules.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  var ROW_SPACING   = 110;   // vertical distance between formation rows
  var COL_SPACING   = 90;    // horizontal distance between formation columns
  var FORMATION_TOP = 360;   // baseline y of the top formation row (world units, +y = up)
  var SWEEP_MARGIN   = 60;    // distance from the playfield edge before reversing
  var DESCEND_RATE   = 8;     // px/s — slow downward creep of the formation
  var DESCEND_MAX    = 220;   // max extra descent from the starting baseline
  var SWEEP_BASE     = 90;    // base sweep speed (px/s)
  var SWEEP_PER_WAVE = 14;    // speed added per wave number
  var SWEEP_MAX      = 320;   // cap on sweep speed
  var TURN_SMOOTH   = 2.5;    // how quickly direction reverses (higher = snappier)
  var DIVE_INTERVAL  = 2.6;    // seconds between automatic dive selections
  var DIVE_INTERVAL_JITTER = 1.2;  // random ± seconds added to interval
  var DIVE_COUNT_MAX = 3;     // max enemies diving at once per trigger
  var ENTRY_SPEED    = 520;    // px/s entry path speed
  var ENTRY_ARC      = 0.55;   // curvature factor for entry arcs (0=straight, 1=semicircle)
  var ENTRY_STAGGER   = 0.12;   // seconds between successive enemy entries

  /* ── Helpers ──────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function damp(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-speed * dt));
  }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* Quadratic Bézier evaluation. */
  function bezier(t, p0, p1, p2) {
    var u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
  }

  /* ── FormationManager ─────────────────────────────────────────────────── */

  function FormationManager(playfieldWidth, playfieldHeight) {
    this.playfieldW = playfieldWidth || 800;
    this.playfieldH = playfieldHeight || 1200;
    this.halfW = this.playfieldW / 2;

    // Current formation state.
    this.formationOffset = 0;       // x offset of the whole formation
    this.formationY = FORMATION_TOP; // baseline y of the top row
    this._baseFormationY = FORMATION_TOP;
    this._descendAccum = 0;
    this.direction = 1;              // 1 = moving right, -1 = moving left
    this._dirSmooth = 1;             // smoothed direction (for sinusoidal turn)
    this.speed = SWEEP_BASE;
    this.waveNum = 1;

    // Layout bookkeeping.
    this.rows = 0;
    this.cols = 0;
    this.enemies = [];
    this._enemySlots = {};           // id -> {row, col, homeX, homeY}

    // Entry animation state.
    this._entryActive = false;
    this._entryTimer = 0;
    this._entryOrder = [];           // ordered list of enemies for staggered entry

    // Dive scheduler.
    this._diveTimer = DIVE_INTERVAL;
    this._divingCount = 0;

    // Cached bounds (updated each frame).
    this._bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  /* ── Layout ────────────────────────────────────────────────────────────── */

  /**
   * Compute the world position of a grid slot in the formation.
   * @param {number} row   0-based row index (0 = top)
   * @param {number} col   0-based column index
   * @param {number} rows  total rows
   * @param {number} cols  total columns
   * @returns {{x:number, y:number}}
   */
  FormationManager.prototype.getFormationPosition = function (row, col, rows, cols) {
    // Centre the grid horizontally around x = 0 (offset applied later).
    var gridWidth = (cols - 1) * COL_SPACING;
    var startX = -gridWidth / 2;
    var x = startX + col * COL_SPACING;
    var y = this.formationY + row * ROW_SPACING;
    return { x: x, y: y };
  };

  /**
   * Configure the formation for a wave's enemies.  Assigns each enemy a
   * (row, col) slot based on a rough grid layout, sets state to 'formation'
   * (entry animation is started separately via startEntry()), and scales
   * sweep speed with wave number.
   *
   * Each enemy may carry an optional `formationRow`/`formationCol` hint
   * (set by the wave configuration) — otherwise enemies are auto-assigned
   * by fill order.
   *
   * @param {number} waveNum
   * @param {Array} enemies   live enemy objects for this wave
   */
  FormationManager.prototype.configure = function (waveNum, enemies) {
    this.waveNum = Math.max(1, waveNum | 0);
    this.enemies = enemies || [];
    this.speed = clamp(SWEEP_BASE + (this.waveNum - 1) * SWEEP_PER_WAVE, SWEEP_BASE, SWEEP_MAX);

    // Reset sweep / descent.
    this.formationOffset = 0;
    this._baseFormationY = FORMATION_TOP;
    this.formationY = FORMATION_TOP;
    this._descendAccum = 0;
    this.direction = Math.random() < 0.5 ? 1 : -1;
    this._dirSmooth = this.direction;

    // Determine grid dimensions from the enemy count.
    var n = this.enemies.length;
    var rows = 0, cols = 0;
    // Prefer an explicit per-enemy row/col hint if all enemies carry one.
    var allHinted = n > 0;
    var maxRow = -1, maxCol = -1;
    for (var h = 0; h < n; h++) {
      var e = this.enemies[h];
      if (e.formationRow == null || e.formationCol == null) { allHinted = false; break; }
      if (e.formationRow > maxRow) maxRow = e.formationRow;
      if (e.formationCol > maxCol) maxCol = e.formationCol;
    }
    if (allHinted) {
      rows = maxRow + 1;
      cols = maxCol + 1;
    } else {
      // Auto-grid: aim for ~6 columns, rows as needed.
      cols = clamp(Math.ceil(Math.sqrt(n * 1.5)), 4, 8);
      rows = Math.ceil(n / cols);
    }
    this.rows = rows;
    this.cols = cols;

    // Assign slots.
    this._enemySlots = {};
    var idx = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (idx >= n) break;
        var en = this.enemies[idx++];
        en.formationRow = r;
        en.formationCol = c;
        var slot = this.getFormationPosition(r, c, rows, cols);
        // Store the *home* position without the live offset; offset is
        // applied each frame.
        this._enemySlots[this._id(en)] = { row: r, col: c, homeX: slot.x, homeY: slot.y };
      }
    }

    // Reset dive scheduler.
    this._diveTimer = DIVE_INTERVAL + rand(-DIVE_INTERVAL_JITTER, DIVE_INTERVAL_JITTER);
    this._divingCount = 0;
  };

  FormationManager.prototype._id = function (enemy) {
    if (enemy.__fid == null) enemy.__fid = 'f' + (++FormationManager._seq);
    return enemy.__fid;
  };

  /* ── Entry animation ───────────────────────────────────────────────────── */

  /**
   * Begin the entry animation.  Enemies fly in from off-screen along curved
   * paths to their formation slots, with staggered timing.  While entry is
   * active, the group sweep is paused.
   * @param {Array} enemies
   */
  FormationManager.prototype.startEntry = function (enemies) {
    this.enemies = enemies || this.enemies;
    this._entryActive = true;
    this._entryTimer = 0;
    this._entryOrder = [];

    // Order enemies for staggered entry: alternate sides, top rows first.
    var list = this.enemies.slice(0);
    var self = this;
    list.sort(function (a, b) {
      var ra = a.formationRow || 0, rb = b.formationRow || 0;
      if (ra !== rb) return ra - rb;
      var ca = a.formationCol || 0, cb = b.formationCol || 0;
      return Math.abs(ca - (self.cols - 1) / 2) - Math.abs(cb - (self.cols - 1) / 2);
    });

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var slot = this._enemySlots[this._id(e)];
      if (!slot) continue;

      // Pick an off-screen start point on the left or right (alternating).
      var side = (i % 2 === 0) ? -1 : 1;
      var startX = side * (this.halfW + 140 + Math.random() * 80);
      var startY = this.formationY + rand(-80, 160);

      // Control point for the curve: pull toward the entry side then in.
      var ctrlX = side * (this.halfW * 0.5);
      var ctrlY = startY - rand(120, 260);

      e.position.x = startX;
      e.position.y = startY;
      e._entryStart = { x: startX, y: startY };
      e._entryCtrl  = { x: ctrlX,  y: ctrlY };
      e._entryT = 0;
      e._entryDelay = i * ENTRY_STAGGER + rand(0, 0.15);
      e.state = 'entry';
      if (e.sprite) e.sprite.visible = true;
      this._entryOrder.push(e);
    }
  };

  /** True once all enemies have reached their formation slots. */
  FormationManager.prototype.isEntryComplete = function () {
    if (!this._entryActive) return true;
    for (var i = 0; i < this._entryOrder.length; i++) {
      var e = this._entryOrder[i];
      if (e.state === 'entry' && e._entryT < 1) return false;
    }
    return true;
  };

  FormationManager.prototype._updateEntry = function (dt) {
    if (!this._entryActive) return;
    var allDone = true;

    for (var i = 0; i < this._entryOrder.length; i++) {
      var e = this._entryOrder[i];
      if (e.state !== 'entry') continue;

      if (e._entryDelay > 0) {
        e._entryDelay -= dt;
        allDone = false;
        continue;
      }
      e._entryT += dt * (ENTRY_SPEED / 700);  // normalised so ~1.4s to traverse
      var t = clamp(e._entryT, 0, 1);

      var slot = this._enemySlots[this._id(e)];
      var homeX = slot.homeX + this.formationOffset;
      var homeY = slot.homeY;
      var s = e._entryStart, c = e._entryCtrl;
      // Bézier from start -> control -> home.
      var bx = bezier(t, s.x, c.x, homeX);
      var by = bezier(t, s.y, c.y, homeY);
      e.position.x = bx;
      e.position.y = by;
      // Bank the sprite along the path for a pleasing entry.
      if (e.sprite) {
        var dx = (homeX - bx);
        e.sprite.material.rotation = clamp(dx * 0.002, -0.35, 0.35);
      }

      if (t >= 1) {
        e._entryT = 1;
        e.position.x = homeX;
        e.position.y = homeY;
        e.state = 'formation';
        if (e.sprite) e.sprite.material.rotation = 0;
        delete e._entryStart;
        delete e._entryCtrl;
        delete e._entryDelay;
      } else {
        allDone = false;
      }
    }

    if (allDone) {
      this._entryActive = false;
      this._entryOrder.length = 0;
    }
  };

  /* ── Group sweep + descent ─────────────────────────────────────────────── */

  FormationManager.prototype._updateSweep = function (dt) {
    // Smooth the direction into _dirSmooth so the turn at the edges reads as
    // a gentle sinusoidal arc rather than an instant flip.
    this._dirSmooth = damp(this._dirSmooth, this.direction, TURN_SMOOTH, dt);

    // Advance the offset using the smoothed direction.
    this.formationOffset += this._dirSmooth * this.speed * dt;

    // Compute the formation's horizontal bounds (with margin) and reverse
    // when it crosses the playfield edge.
    var bounds = this.getFormationBounds();
    var leftEdge  = -this.halfW + SWEEP_MARGIN;
    var rightEdge =  this.halfW - SWEEP_MARGIN;
    if (bounds.maxX >= rightEdge && this.direction > 0) this.direction = -1;
    else if (bounds.minX <= leftEdge && this.direction < 0) this.direction = 1;

    // Slow descent toward the player (clamped).
    if (this._descendAccum < DESCEND_MAX) {
      var dy = DESCEND_RATE * dt;
      this.formationY -= dy;
      this._descendAccum += dy;
    }
  };

  FormationManager.prototype._applyFormationPositions = function (enemies) {
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.state !== 'formation') continue;
      var slot = this._enemySlots[this._id(e)];
      if (!slot) continue;
      e.position.x = slot.homeX + this.formationOffset;
      e.position.y = slot.homeY;
      // Subtle group banking based on sweep direction.
      if (e.sprite) {
        e.sprite.material.rotation = damp(
          e.sprite.material.rotation || 0,
          this._dirSmooth * 0.12,
          TURN_SMOOTH, 1 / 60);
      }
    }
  };

  /* ── Dive scheduling ───────────────────────────────────────────────────── */

  FormationManager.prototype._updateDives = function (dt, enemies, playerPos) {
    if (this._entryActive) return;

    this._diveTimer -= dt;
    if (this._diveTimer <= 0) {
      this._diveTimer = DIVE_INTERVAL + rand(-DIVE_INTERVAL_JITTER, DIVE_INTERVAL_JITTER);
      var count = 1 + ((Math.random() * DIVE_COUNT_MAX) | 0);
      this.triggerDive(enemies, playerPos, count);
    }

    // Advance active dives.
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.state !== 'dive' || !e.divePath) continue;
      e.divePath.t += dt / e.divePath.duration;
      var t = clamp(e.divePath.t, 0, 1);
      var p = e.divePath;
      e.position.x = bezier(t, p.start.x, p.ctrl.x, p.end.x);
      e.position.y = bezier(t, p.start.y, p.ctrl.y, p.end.y);
      if (e.sprite) {
        // Bank along the dive.
        var dx = p.end.x - e.position.x;
        e.sprite.material.rotation = clamp(dx * 0.003, -0.6, 0.6);
      }
      if (t >= 1) {
        // Begin return to formation.
        e.state = 'returning';
        e._returnT = 0;
        e._returnStart = { x: e.position.x, y: e.position.y };
        e.divePath = null;
      }
    }

    // Advance returns.
    for (var j = 0; j < enemies.length; j++) {
      var en = enemies[j];
      if (en.state !== 'returning') continue;
      en._returnT += dt / 1.4;   // ~1.4s return flight
      var rt = clamp(en._returnT, 0, 1);
      var slot = this._enemySlots[this._id(en)];
      if (!slot) { en.state = 'formation'; continue; }
      var targetX = slot.homeX + this.formationOffset;
      var targetY = slot.homeY;
      en.position.x = damp(en._returnStart.x, targetX, 3.0, dt);
      en.position.y = damp(en._returnStart.y, targetY, 3.0, dt);
      if (rt >= 1) {
        en.state = 'formation';
        en.position.x = targetX;
        en.position.y = targetY;
        if (en.sprite) en.sprite.material.rotation = 0;
      }
    }
  };

  /**
   * Manually trigger a dive: pick `count` eligible enemies currently in
   * formation and send them on a curved attack run at the player.
   * @param {Array} enemies
   * @param {{x,y}} playerPos
   * @param {number} [count=1]
   */
  FormationManager.prototype.triggerDive = function (enemies, playerPos, count) {
    var n = count != null ? count : 1;
    var candidates = [];
    for (var i = 0; i < enemies.length; i++) {
      if (enemies[i].state === 'formation') candidates.push(enemies[i]);
    }
    if (candidates.length === 0) return;

    // Prefer bottom-row (closest to player) enemies first, with randomness.
    candidates.sort(function (a, b) {
      return (b.formationRow || 0) - (a.formationRow || 0);
    });

    for (var k = 0; k < n && candidates.length; k++) {
      // Pick from the front (bottom rows) with some randomisation.
      var idx = (Math.random() < 0.7) ? 0 : (Math.floor(Math.random() * Math.min(3, candidates.length)));
      var e = candidates.splice(idx, 1)[0];
      var slot = this._enemySlots[this._id(e)];
      if (!slot) continue;

      var sx = e.position.x;
      var sy = e.position.y;
      var tx = (playerPos && playerPos.x != null) ? playerPos.x : 0;
      var ty = (playerPos && playerPos.y != null) ? playerPos.y : -500;

      // Control point: sweep out to the side then down toward the player.
      var side = sx < 0 ? -1 : 1;
      if (Math.abs(sx) < 50) side = (Math.random() < 0.5 ? -1 : 1);
      var ctrlX = sx + side * rand(140, 260);
      var ctrlY = (sy + ty) * 0.5 + rand(40, 160);

      e.state = 'dive';
      e.divePath = {
        start: { x: sx, y: sy },
        ctrl:  { x: ctrlX, y: ctrlY },
        end:   { x: tx + rand(-60, 60), y: ty - 40 },
        t: 0,
        duration: rand(1.8, 2.8)
      };
    }
  };

  /* ── Main update ──────────────────────────────────────────────────────── */

  /**
   * Per-frame update: advances entry animation, group sweep + descent, and
   * the dive scheduler.
   * @param {number} dt
   * @param {Array} enemies
   * @param {{x,y}} playerPos
   */
  FormationManager.prototype.update = function (dt, enemies, playerPos) {
    this.enemies = enemies || this.enemies;

    if (this._entryActive) {
      this._updateEntry(dt);
    } else {
      this._updateSweep(dt);
      this._applyFormationPositions(this.enemies);
    }

    this._updateDives(dt, this.enemies, playerPos);
    this._computeBounds();
  };

  /* ── Bounds ────────────────────────────────────────────────────────────── */

  /**
   * Compute the current bounding box of all enemies that are in formation
   * (including those returning), accounting for the live formation offset.
   * @returns {{minX,maxX,minY,maxY}}
   */
  FormationManager.prototype.getFormationBounds = function () {
    return this._bounds;
  };

  FormationManager.prototype._computeBounds = function () {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var any = false;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.state === 'dive' || e.state === 'entry') continue;
      if (!e.position) continue;
      var x = e.position.x, y = e.position.y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      any = true;
    }
    if (!any) {
      // Fall back to the nominal grid bounds.
      var gridW = Math.max(0, (this.cols - 1) * COL_SPACING);
      minX = -gridW / 2 + this.formationOffset - 40;
      maxX =  gridW / 2 + this.formationOffset + 40;
      minY = this.formationY - 40;
      maxY = this.formationY + Math.max(0, (this.rows - 1)) * ROW_SPACING + 40;
    }
    this._bounds.minX = minX;
    this._bounds.maxX = maxX;
    this._bounds.minY = minY;
    this._bounds.maxY = maxY;
  };

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  FormationManager.prototype.destroy = function () {
    this.enemies = [];
    this._enemySlots = {};
    this._entryOrder = [];
    this._entryActive = false;
  };

  /* ── Static ───────────────────────────────────────────────────────────── */
  FormationManager._seq = 0;

  /* ── Export ───────────────────────────────────────────────────────────── */
  global.FormationManager = FormationManager;
})(window);
