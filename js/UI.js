/**
 * UI.js — HUD manager for Galaxy Reborn.
 * Manages all DOM-based UI: score, lives, wave, combo, screens.
 */
(function (global) {
  'use strict';

  function UI() {
    this.elScore   = document.getElementById('score');
    this.elWave    = document.getElementById('wave');
    this.elLives   = document.getElementById('lives');
    this.elCombo   = document.getElementById('combo-bar');
    this.elComboTx = document.getElementById('combo-text');
    this.elStart   = document.getElementById('start-screen');
    this.elOver    = document.getElementById('game-over-screen');
    this.elPause   = document.getElementById('pause-screen');
    this.elTrans   = document.getElementById('wave-transition');
    this.elNextWv  = document.getElementById('next-wave');
    this.elFinSc   = document.getElementById('final-score');
    this.elFinWv   = document.getElementById('final-wave');
    this.elFinCm   = document.getElementById('final-combo');

    this._score  = 0;
    this._wave   = 1;
    this._lives  = 3;
    this._combo  = 1;
    this._comboPct = 0;
    this._transTimer = 0;

    // Level name element (shown in HUD during gameplay)
    this.elLevelName = document.getElementById('level-name');
  }

  UI.prototype.setLevelName = function (name) {
    if (this.elLevelName) this.elLevelName.textContent = name || '';
  };

  UI.prototype.setScore = function (v) {
    this._score = Math.max(0, Math.floor(v));
    if (this.elScore) this.elScore.textContent = String(this._score).padStart(6, '0');
  };

  UI.prototype.addScore = function (v) {
    this.setScore(this._score + v);
  };

  UI.prototype.getScore = function () { return this._score; };

  UI.prototype.setWave = function (w) {
    this._wave = w;
    if (this.elWave) this.elWave.textContent = String(w);
  };

  UI.prototype.setLives = function (n) {
    this._lives = n;
    if (this.elLives) {
      var hearts = '';
      for (var i = 0; i < Math.max(0, n); i++) hearts += '\u2665';
      this.elLives.textContent = hearts || '\u2014';
    }
  };

  UI.prototype.setCombo = function (multiplier, pct) {
    this._combo = multiplier;
    this._comboPct = Math.max(0, Math.min(1, pct));
    if (this.elCombo) this.elCombo.style.width = (this._comboPct * 100) + '%';
    if (this.elComboTx) this.elComboTx.textContent = 'COMBO x' + this._combo;
  };

  UI.prototype.showStart = function (show) {
    _toggle(this.elStart, show);
  };

  UI.prototype.showGameOver = function (show, score, wave, combo) {
    _toggle(this.elOver, show);
    if (show) {
      if (this.elFinSc) this.elFinSc.textContent = String(score || 0);
      if (this.elFinWv) this.elFinWv.textContent = String(wave || 0);
      if (this.elFinCm) this.elFinCm.textContent = 'x' + (combo || 1);
    }
  };

  UI.prototype.showPause = function (show) {
    _toggle(this.elPause, show);
  };

  UI.prototype.showWaveTransition = function (waveNum, duration) {
    if (this.elNextWv) this.elNextWv.textContent = String(waveNum);
    if (this.elTrans) {
      this.elTrans.classList.remove('hidden');
      this.elTrans.style.opacity = '1';
    }
    this._transTimer = duration || 2.0;
  };

  UI.prototype.update = function (dt) {
    if (this._transTimer > 0) {
      this._transTimer -= dt;
      if (this._transTimer <= 0 && this.elTrans) {
        this.elTrans.style.opacity = '0';
        this.elTrans.classList.add('hidden');
      }
    }
  };

  UI.prototype.hideAll = function () {
    if (this.elStart) this.elStart.classList.add('hidden');
    if (this.elOver)  this.elOver.classList.add('hidden');
    if (this.elPause) this.elPause.classList.add('hidden');
    if (this.elTrans) this.elTrans.classList.add('hidden');
  };

  function _toggle(el, show) {
    if (!el) return;
    if (show) el.classList.remove('hidden');
    else     el.classList.add('hidden');
  }

  global.UI = UI;
})(window);
