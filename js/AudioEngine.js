/* =============================================================================
 *  AudioEngine.js  —  Galaxy Reborn
 *  -----------------------------------------------------------------------------
 *  A fully procedural audio engine built on the Web Audio API.  Every sound in
 *  the game — lasers, explosions, power-ups, UI blips, the boss alarm, engine
 *  hum, the special-weapon charge/boom, and a looping synthwave/chiptune music
 *  bed — is synthesised on the fly from oscillators and noise buffers.  No
 *  external audio assets are loaded.
 *
 *  Design notes
 *  ------------
 *    • A single shared AudioContext is created lazily on first use (browsers
 *      block audio until a user gesture, so the engine is safe to construct
 *      at load time and will resume() on the first playSound / playMusic call).
 *    • A master GainNode feeds the destination; mute and volume are applied
 *      here so every voice inherits them automatically.
 *    • A long stereo noise buffer is pre-rendered once and reused by every
 *      noise-based effect (explosions, hits, charge sweep).  This avoids
 *      allocating a new AudioBuffer per shot.
 *    • Each effect generator returns the source nodes it creates so callers
 *      could (optionally) stop them early; the engine also tracks active
 *      short voices in a weak list so destroy() can tear everything down.
 *    • Small random pitch/duration jitter is applied to SFX on every trigger
 *      to prevent repetition fatigue — the same laser never sounds identical
 *      twice in a row.
 *    • The music loop is a lightweight scheduler that steps through a pattern
 *      of bass / arpeggio / pad voices every 16th note, using lookahead
 *      scheduling so timing stays solid even if the RAF rate jitters.
 *
 *  Constructor:   new AudioEngine()        // no arguments
 *
 *  Public API:
 *      playSound(name)            // name: 'laser'|'hit'|'explosion'|'powerup'
 *                                  //       'damage'|'wavestart'|'gameover'
 *                                  //       'boss'|'ui'|'special'|'explosion_big'
 *      playMusic()
 *      stopMusic()
 *      setVolume(v)               // 0..1 master volume
 *      toggleMute()               // returns new muted state
 *      update(playerVelocity)     // pass the player's velocity vector to
 *                                  // modulate the continuous engine hum
 *      destroy()
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ── Tunables ─────────────────────────────────────────────────────────── */
  var SAMPLE_RATE     = 44100;          // nominal; clamped to ctx rate at init
  var NOISE_SECONDS   = 2.0;            // length of the pre-rendered noise buffer
  var MAX_VOICES      = 48;             // hard cap on simultaneous short voices
  var MUSIC_BPM       = 120;            // synthwave loop tempo
  var MUSIC_LOOKAHEAD = 0.1;            // scheduler lookahead (seconds)
  var MUSIC_INTERVAL  = 25;             // scheduler tick (ms)

  /* ── Small helpers ────────────────────────────────────────────────────── */

  /** Clamp v into [min,max]. */
  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  /** Random float in [min,max). */
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /** Random jitter multiplier centred on 1.0 (e.g. 0.95..1.05). */
  function jitter(amount) {
    return 1 + (Math.random() * 2 - 1) * amount;
  }

  /** Convert a MIDI note number to a frequency in Hz. */
  function mtof(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /* ── AudioEngine ──────────────────────────────────────────────────────── */

  function AudioEngine() {
    /* Lazily created AudioContext (browsers require a user gesture). */
    this._ctx = null;
    this._master = null;       // master GainNode -> destination
    this._musicGain = null;    // sub-bus for music so it can be ducked
    this._sfxGain = null;      // sub-bus for SFX

    this._volume = 0.8;        // user volume 0..1
    this._muted  = false;

    /* Pre-rendered noise buffer (white + brownish). */
    this._noiseBuffer = null;

    /* Active short-lived voices, tracked so destroy() can stop them. */
    this._activeVoices = [];

    /* Continuous engine-hum voice (created on first update). */
    this._engine = null;

    /* Music scheduler state. */
    this._musicPlaying = false;
    this._musicTimer = null;
    this._musicNextNoteTime = 0;
    this._musicStep = 0;
    this._musicTrack = 0;        // selected music track index (0..2)
    this._musicTargetGain = 0.55; // base music bus gain (for crossfades)
  }

  /* ── Context / graph setup ─────────────────────────────────────────────── */

  /**
   * Create the AudioContext (if needed) and the master / sub-bus gain graph.
   * Resumes a suspended context (post-autoplay-policy browsers suspend until
   * a gesture).  Safe to call repeatedly — only builds once.
   * @returns {AudioContext|null} the context, or null if unavailable.
   */
  AudioEngine.prototype._ensureContext = function () {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') {
        this._ctx.resume();
      }
      return this._ctx;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;

    var ctx;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
    this._ctx = ctx;
    SAMPLE_RATE = ctx.sampleRate;

    /* Master gain -> destination. */
    this._master = ctx.createGain();
    this._master.gain.value = this._muted ? 0 : this._volume;
    this._master.connect(ctx.destination);

    /* Sub-buses for SFX and music. */
    this._sfxGain = ctx.createGain();
    this._sfxGain.gain.value = 1.0;
    this._sfxGain.connect(this._master);

    this._musicGain = ctx.createGain();
    this._musicTargetGain = 0.55; // music sits a touch under SFX
    this._musicGain.gain.value = this._musicTargetGain;   // music sits a touch under SFX
    this._musicGain.connect(this._master);

    /* Pre-render the shared noise buffer. */
    this._noiseBuffer = this._makeNoiseBuffer(NOISE_SECONDS);

    return ctx;
  };

  /**
   * Build a short white-noise AudioBuffer (stereo) for reuse by all
   * noise-based effects.
   */
  AudioEngine.prototype._makeNoiseBuffer = function (seconds) {
    var ctx = this._ctx;
    var length = Math.floor(seconds * ctx.sampleRate);
    var buf = ctx.createBuffer(2, length, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      // Brownian-ish noise: a little smoother than pure white, good for rumbles.
      var last = 0;
      for (var i = 0; i < length; i++) {
        var white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.0 + white * 0.5;
      }
    }
    return buf;
  };

  /** Create a BufferSource wired to the shared noise buffer. */
  AudioEngine.prototype._noiseSource = function () {
    var src = this._ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    return src;
  };

  /* ── Voice bookkeeping ─────────────────────────────────────────────────── */

  /**
   * Track a voice (array of nodes) and auto-remove it when the final node
   * stops.  Caps total active voices to MAX_VOICES by stealing the oldest.
   * @returns the same voice array, for convenience.
   */
  AudioEngine.prototype._track = function (voice, finalNode, duration) {
    // Cap active voices.
    while (this._activeVoices.length >= MAX_VOICES) {
      var old = this._activeVoices.shift();
      this._stopVoice(old);
    }
    this._activeVoices.push(voice);

    if (finalNode && finalNode.onended !== null && finalNode.onended !== undefined) {
      // Wrap any existing onended (rare here).
      var prev = finalNode.onended;
      finalNode.onended = (function (self) {
        return function () {
          if (typeof prev === 'function') prev.call(finalNode);
          self._untrack(voice);
        };
      })(this);
    } else {
      // Fallback: schedule untrack after the duration.
      var self = this;
      var ms = Math.max(0, (duration || 1) * 1000) + 50;
      setTimeout(function () { self._untrack(voice); }, ms);
    }
    return voice;
  };

  AudioEngine.prototype._untrack = function (voice) {
    var idx = this._activeVoices.indexOf(voice);
    if (idx >= 0) this._activeVoices.splice(idx, 1);
  };

  /** Force-stop and disconnect every node in a voice. */
  AudioEngine.prototype._stopVoice = function (voice) {
    for (var i = 0; i < voice.length; i++) {
      var n = voice[i];
      try {
        if (n && typeof n.stop === 'function') n.stop();
      } catch (e) { /* already stopped */ }
      try {
        if (n) n.disconnect();
      } catch (e) { /* ignore */ }
    }
  };

  /* ── Public: playSound ────────────────────────────────────────────────── */

  /**
   * Play a named sound effect.  Unknown names silently no-op.
   * @param {string} name
   */
  AudioEngine.prototype.playSound = function (name) {
    var ctx = this._ensureContext();
    if (!ctx) return;

    switch (name) {
      case 'laser':
      case 'fire':
        this._sfxLaser();
        break;
      case 'hit':
        this._sfxHit();
        break;
      case 'explosion':
        this._sfxExplosion(false);
        break;
      case 'explosion_big':
        this._sfxExplosion(true);
        break;
      case 'powerup':
        this._sfxPowerup();
        break;
      case 'damage':
        this._sfxDamage();
        break;
      case 'wavestart':
        this._sfxWaveStart();
        break;
      case 'gameover':
        this._sfxGameOver();
        break;
      case 'boss':
        this._sfxBossWarning();
        break;
      case 'ui':
        this._sfxUI();
        break;
      case 'special':
        this._sfxSpecial();
        break;
      default:
        break;
    }
  };

  /* ── Sound generators ─────────────────────────────────────────────────── */

  /**
   * Laser / fire: a sharp "pew" — sawtooth oscillator with a fast downward
   * frequency sweep and an exponential gain decay.  Jittered so each shot
   * sounds slightly different.
   */
  AudioEngine.prototype._sfxLaser = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';

    var startFreq = rand(1100, 1300) * jitter(0.04);
    var endFreq   = rand(220, 320);
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), now + 0.16 * jitter(0.1));

    var gain = ctx.createGain();
    var peak = 0.22 * jitter(0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 * jitter(0.1));

    // A gentle low-pass tames the sawtooth harshness.
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4000, now);
    lp.frequency.exponentialRampToValueAtTime(800, now + 0.18);

    osc.connect(lp); lp.connect(gain); gain.connect(this._sfxGain);
    osc.start(now);
    osc.stop(now + 0.25);

    var voice = [osc, lp, gain];
    this._track(voice, osc, 0.25);
  };

  /**
   * Enemy hit: a very short noise burst through a bandpass filter centred in
   * the upper-midrange — a crisp "tick".
   */
  AudioEngine.prototype._sfxHit = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var noise = this._noiseSource();
    var dur = 0.07 * jitter(0.12);
    // Offset the loop start for variety.
    noise.loopStart = Math.random() * (NOISE_SECONDS - dur);
    noise.loopEnd = noise.loopStart + dur;

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1800, 2600) * jitter(0.05);
    bp.Q.value = 1.4;

    var gain = ctx.createGain();
    var peak = 0.30 * jitter(0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(bp); bp.connect(gain); gain.connect(this._sfxGain);
    noise.start(now, noise.loopStart);
    noise.stop(now + dur + 0.02);

    var voice = [noise, bp, gain];
    this._track(voice, noise, dur + 0.05);
  };

  /**
   * Explosion: a burst of (low-passed) noise with a downward filter sweep plus
   * a sub-bass sine thump.  `big` increases duration, depth, and adds extra
   * crackle — used for boss deaths and the special boom.
   */
  AudioEngine.prototype._sfxExplosion = function (big) {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var dur = big ? rand(0.7, 0.9) : rand(0.35, 0.5);

    /* Noise body. */
    var noise = this._noiseSource();
    noise.loopStart = Math.random() * (NOISE_SECONDS - dur);
    noise.loopEnd = noise.loopStart + dur;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    var startCut = big ? rand(3500, 5000) : rand(2500, 3500);
    var endCut   = big ? rand(120, 220)   : rand(300, 500);
    lp.frequency.setValueAtTime(startCut, now);
    lp.frequency.exponentialRampToValueAtTime(endCut, now + dur);
    lp.Q.value = 0.8;

    var ng = ctx.createGain();
    var peak = big ? 0.55 : 0.38;
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(peak * jitter(0.1), now + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(lp); lp.connect(ng); ng.connect(this._sfxGain);
    noise.start(now, noise.loopStart);
    noise.stop(now + dur + 0.02);

    /* Sub-bass thump. */
    var sub = ctx.createOscillator();
    sub.type = 'sine';
    var subStart = big ? rand(110, 140) : rand(140, 180);
    var subEnd   = big ? rand(30, 45)   : rand(50, 70);
    sub.frequency.setValueAtTime(subStart, now);
    sub.frequency.exponentialRampToValueAtTime(subEnd, now + dur * 0.8);

    var sg = ctx.createGain();
    var subPeak = big ? 0.5 : 0.3;
    sg.gain.setValueAtTime(0.0001, now);
    sg.gain.exponentialRampToValueAtTime(subPeak, now + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.9);

    sub.connect(sg); sg.connect(this._sfxGain);
    sub.start(now);
    sub.stop(now + dur);

    var voice = [noise, lp, ng, sub, sg];
    this._track(voice, sub, dur + 0.05);
  };

  /**
   * Power-up pickup: a bright ascending arpeggio of sine notes.
   */
  AudioEngine.prototype._sfxPowerup = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;
    // A major-ish arpeggio: C5, E5, G5, C6 (MIDI 72,76,79,84) + an extra sparkle.
    var notes = [72, 76, 79, 84, 88];
    var step = 0.06;

    for (var i = 0; i < notes.length; i++) {
      var t = now + i * step;
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = mtof(notes[i]) * jitter(0.01);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * 2.2);

      osc.connect(g); g.connect(this._sfxGain);
      osc.start(t);
      osc.stop(t + step * 2.5 + 0.02);
      this._track([osc, g], osc, step * 2.5 + 0.05);
    }
  };

  /**
   * Player damage: a descending tone with a waveshaper distortion curve for
   * a harsh, alarming character.
   */
  AudioEngine.prototype._sfxDamage = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    var f0 = rand(520, 600) * jitter(0.03);
    var f1 = rand(80, 120);
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.35 * jitter(0.1));

    // Distortion curve.
    var shaper = ctx.createWaveShaper();
    shaper.curve = this._distortionCurve(40);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, now);
    lp.frequency.exponentialRampToValueAtTime(500, now + 0.35);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

    osc.connect(shaper); shaper.connect(lp); lp.connect(g); g.connect(this._sfxGain);
    osc.start(now);
    osc.stop(now + 0.45);

    this._track([osc, shaper, lp, g], osc, 0.45);
  };

  /**
   * Wave start: an ambient rising tone with a feedback delay tail to evoke
   * a reverb-like space.
   */
  AudioEngine.prototype._sfxWaveStart = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    var f0 = rand(220, 260);
    var f1 = rand(660, 760);
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.6);

    // Delay-based "reverb".
    var delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.22;
    var fb = ctx.createGain();
    fb.gain.value = 0.38;
    var wet = ctx.createGain();
    wet.gain.value = 0.5;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.28, now + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    osc.connect(g);
    g.connect(this._sfxGain);
    g.connect(delay);
    delay.connect(fb); fb.connect(delay);
    delay.connect(wet); wet.connect(this._sfxGain);

    osc.start(now);
    osc.stop(now + 1.3);

    this._track([osc, g, delay, fb, wet], osc, 1.3);
  };

  /**
   * Game over: a descending dramatic chord — three detuned sawtooth voices
   * falling through a lowpass, with a slow decay.
   */
  AudioEngine.prototype._sfxGameOver = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var chord = [196, 233, 294]; // G3, A#3, D4 (G minor-ish).
    for (var i = 0; i < chord.length; i++) {
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(chord[i] * jitter(0.01), now);
      osc.frequency.exponentialRampToValueAtTime(chord[i] * 0.45, now + 1.4);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, now);
      lp.frequency.exponentialRampToValueAtTime(300, now + 1.4);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.18, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);

      osc.connect(lp); lp.connect(g); g.connect(this._sfxGain);
      osc.start(now);
      osc.stop(now + 1.9);
      this._track([osc, lp, g], osc, 1.9);
    }

    // A final sub drop.
    var sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, now + 0.3);
    sub.frequency.exponentialRampToValueAtTime(35, now + 1.6);
    var sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, now + 0.3);
    sg.gain.exponentialRampToValueAtTime(0.32, now + 0.33);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 1.7);
    sub.connect(sg); sg.connect(this._sfxGain);
    sub.start(now + 0.3);
    sub.stop(now + 1.8);
    this._track([sub, sg], sub, 1.8);
  };

  /**
   * Boss warning: a deep, slow alarm pulse — a low-frequency oscillator
   * amplitude-modulated by another LFO, repeated a few times.
   */
  AudioEngine.prototype._sfxBossWarning = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var pulses = 4;
    for (var i = 0; i < pulses; i++) {
      var t = now + i * 0.32;

      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = rand(70, 85);

      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 6.0;            // fast wobble within the pulse
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 18;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.30, t + 0.02);
      g.gain.setValueAtTime(0.30, t + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;

      osc.connect(lp); lp.connect(g); g.connect(this._sfxGain);
      osc.start(t); lfo.start(t);
      osc.stop(t + 0.32); lfo.stop(t + 0.32);
      this._track([osc, lfo, lfoGain, lp, g], osc, 0.35);
    }
  };

  /**
   * UI click: a short blip.
   */
  AudioEngine.prototype._sfxUI = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    var osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = rand(900, 1100) * jitter(0.02);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    osc.connect(g); g.connect(this._sfxGain);
    osc.start(now);
    osc.stop(now + 0.08);
    this._track([osc, g], osc, 0.1);
  };

  /**
   * Special weapon fire: a two-stage sound — a rising charge (pitched sweep +
   * noise build) then a release boom (big explosion + sub drop).
   */
  AudioEngine.prototype._sfxSpecial = function () {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    /* --- Charge phase (0.0 .. 0.9s) --- */
    var chargeDur = 0.9;

    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + chargeDur);

    var osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(120, now);            // detuned layer
    osc2.frequency.exponentialRampToValueAtTime(1350, now + chargeDur);

    var noise = this._noiseSource();
    var np = ctx.createBiquadFilter();
    np.type = 'bandpass';
    np.frequency.setValueAtTime(400, now);
    np.frequency.exponentialRampToValueAtTime(6000, now + chargeDur);
    np.Q.value = 1.0;

    var cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.30, now + chargeDur);   // steady build
    cg.gain.linearRampToValueAtTime(0.0001, now + chargeDur + 0.02); // cut at release

    osc.connect(cg); osc2.connect(cg);
    noise.connect(np); np.connect(cg);
    cg.connect(this._sfxGain);

    osc.start(now); osc2.start(now); noise.start(now);
    osc.stop(now + chargeDur + 0.05);
    osc2.stop(now + chargeDur + 0.05);
    noise.stop(now + chargeDur + 0.05);
    this._track([osc, osc2, noise, np, cg], osc, chargeDur + 0.1);

    /* --- Release boom (scheduled after the charge) --- */
    var self = this;
    var releaseAt = now + chargeDur + 0.01;
    var rDur = 1.0;

    var rNoise = this._noiseSource();
    var rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.setValueAtTime(5000, releaseAt);
    rlp.frequency.exponentialRampToValueAtTime(100, releaseAt + rDur);
    var rng = ctx.createGain();
    rng.gain.setValueAtTime(0.0001, releaseAt);
    rng.gain.exponentialRampToValueAtTime(0.6, releaseAt + 0.02);
    rng.gain.exponentialRampToValueAtTime(0.0001, releaseAt + rDur);
    rNoise.connect(rlp); rlp.connect(rng); rng.connect(this._sfxGain);
    rNoise.start(releaseAt); rNoise.stop(releaseAt + rDur + 0.02);

    var rSub = ctx.createOscillator();
    rSub.type = 'sine';
    rSub.frequency.setValueAtTime(140, releaseAt);
    rSub.frequency.exponentialRampToValueAtTime(28, releaseAt + rDur * 0.85);
    var rsg = ctx.createGain();
    rsg.gain.setValueAtTime(0.0001, releaseAt);
    rsg.gain.exponentialRampToValueAtTime(0.55, releaseAt + 0.02);
    rsg.gain.exponentialRampToValueAtTime(0.0001, releaseAt + rDur);
    rSub.connect(rsg); rsg.connect(this._sfxGain);
    rSub.start(releaseAt); rSub.stop(releaseAt + rDur + 0.02);
    this._track([rNoise, rlp, rng, rSub, rsg], rSub, rDur + 0.1);
  };

  /**
   * Pre-compute a waveshaper distortion curve.
   * @param {number} amount  distortion amount (higher = nastier)
   */
  AudioEngine.prototype._distortionCurve = function (amount) {
    var n = 44100;
    var curve = new Float32Array(n);
    var k = amount;
    var deg = Math.PI / 180;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  };

  /* ── Engine hum (continuous) ───────────────────────────────────────────── */

  /**
   * Lazily create the continuous engine-hum voice: a low sawtooth pair
   * through a lowpass, gently modulated.  The hum's pitch is steered by
   * update(playerVelocity).
   * @returns {object} the engine voice bundle.
   */
  AudioEngine.prototype._ensureEngine = function () {
    var ctx = this._ensureContext();
    if (!ctx) return null;
    if (this._engine) return this._engine;

    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;

    var osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 55.5;          // slight detune for a richer rumble

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    lp.Q.value = 2.5;

    var g = ctx.createGain();
    g.gain.value = 0.0;                   // starts silent; ramps in via update()

    osc.connect(lp); osc2.connect(lp);
    lp.connect(g); g.connect(this._sfxGain);
    osc.start(); osc2.start();

    this._engine = {
      osc: osc,
      osc2: osc2,
      lp: lp,
      gain: g,
      targetGain: 0.0,
      targetFreq: 55,
      currentFreq: 55
    };
    return this._engine;
  };

  /**
   * Per-frame update.  Pass the player's current velocity (a THREE.Vector2
   * or {x,y}) so the engine hum pitch responds to movement; speed up the
   * rumble as the ship accelerates.
   * @param {{x:number,y:number}|THREE.Vector2} velocity
   */
  AudioEngine.prototype.update = function (velocity) {
    var ctx = this._ctx;
    if (!ctx) return;
    var eng = this._ensureEngine();
    if (!eng) return;

    // Speed magnitude (clamped).  Higher speed => higher pitch + louder hum.
    var vx = velocity ? (velocity.x || 0) : 0;
    var vy = velocity ? (velocity.y || 0) : 0;
    var speed = Math.min(1, Math.hypot(vx, vy) / 520);

    var now = ctx.currentTime;
    var targetFreq = 48 + speed * 70;            // 48Hz idle .. 118Hz full
    var targetGain = 0.05 + speed * 0.13;        // quiet idle, louder in motion

    // Smooth ramp (avoids zipper noise).
    eng.osc.frequency.setTargetAtTime(targetFreq, now, 0.08);
    eng.osc2.frequency.setTargetAtTime(targetFreq * 1.01, now, 0.08);
    eng.gain.gain.setTargetAtTime(targetGain, now, 0.1);
    eng.lp.frequency.setTargetAtTime(180 + speed * 260, now, 0.1);
  };

  /* ── Background music ─────────────────────────────────────────────────── */

  /**
   * Start the procedural music loop for the currently selected track.
   * Each track has its own BPM, pattern, and voicing (see _musicStepVoice).
   * @param {number} [trackIndex] optional track (0,1,2) to select first
   */
  AudioEngine.prototype.playMusic = function (trackIndex) {
    var ctx = this._ensureContext();
    if (!ctx) return;
    if (this._musicPlaying) return;
    if (typeof trackIndex === 'number') {
      this._musicTrack = clamp(Math.floor(trackIndex), 0, 2);
    }
    this._musicPlaying = true;

    var bpm = this._currentTrackBPM();
    var secPerBeat = 60 / bpm;
    this._musicStepDur = secPerBeat / 4;     // 16th notes
    this._musicNextNoteTime = ctx.currentTime + 0.1;
    this._musicStep = 0;

    // Ensure the music bus is at its target level (e.g. after a crossfade).
    if (this._musicGain) {
      this._musicGain.gain.setTargetAtTime(this._musicTargetGain, ctx.currentTime, 0.05);
    }

    var self = this;
    this._musicTimer = setInterval(function () {
      self._musicScheduler();
    }, MUSIC_INTERVAL);
  };

  /**
   * Stop the music loop and silence any in-flight notes.
   */
  AudioEngine.prototype.stopMusic = function () {
    this._musicPlaying = false;
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
  };

  /**
   * Lookahead scheduler: while the next note time is within the lookahead
   * window, schedule voices for that step and advance.
   */
  AudioEngine.prototype._musicScheduler = function () {
    var ctx = this._ctx;
    if (!ctx || !this._musicPlaying) return;

    while (this._musicNextNoteTime < ctx.currentTime + MUSIC_LOOKAHEAD) {
      this._musicStepVoice(this._musicStep, this._musicNextNoteTime);
      this._musicNextNoteTime += this._musicStepDur;
      this._musicStep = (this._musicStep + 1) % 16;
    }
  };

  /**
   * Voice a single 16th-note step of the music loop.  Dispatches to the
   * pattern for the currently selected track (this._musicTrack).
   */
  AudioEngine.prototype._musicStepVoice = function (step, time) {
    switch (this._musicTrack) {
      case 1:
        this._musicStepNebula(step, time);
        break;
      case 2:
        this._musicStepStellar(step, time);
        break;
      case 0:
      default:
        this._musicStepCosmic(step, time);
        break;
    }
  };

  /**
   * Return the BPM of the currently selected track.
   */
  AudioEngine.prototype._currentTrackBPM = function () {
    switch (this._musicTrack) {
      case 1: return 70;
      case 2: return 50;
      case 0:
      default: return MUSIC_BPM;
    }
  };

  /* ── Track 0: "Cosmic Drift" — energetic synthwave (original pattern) ── */
  /**
   * Pattern (step 0..15):
   *   • Bass:    root on 0,3,6,8,10,14  (a driving synthwave bass)
   *   • Arp:     16th arpeggio over an A minor / C major vibe
   *   • Pad:     sustained chord at the start of each bar
   */
  AudioEngine.prototype._musicStepCosmic = function (step, time) {
    // Root MIDI notes per step (0 = none).  A minor groove.
    var bassPattern = [45, 0, 0, 45, 0, 0, 48, 0, 50, 0, 0, 52, 0, 0, 48, 0];
    // Arp notes (higher, bright): A4 C5 E5 A5 ... etc.
    var arpPattern = [69, 0, 72, 0, 76, 0, 72, 0, 74, 0, 77, 0, 81, 0, 77, 0];

    var bd = bassPattern[step];
    if (bd) this._musicVoice(bd, time, this._musicStepDur * 1.8, 'sawtooth', 0.12, 'bass');

    var ad = arpPattern[step];
    if (ad) this._musicVoice(ad, time, this._musicStepDur * 1.2, 'square', 0.05, 'arp');

    // Pad chord at bar start.
    if (step === 0) {
      var chord = [57, 60, 64];   // A minor
      for (var i = 0; i < chord.length; i++) {
        this._musicVoice(chord[i], time, this._musicStepDur * 15, 'triangle', 0.04, 'pad');
      }
    }
  };

  /* ── Track 1: "Nebula Lullaby" — serene, slow, ambient ─────────────── */
  /**
   * Sparse pad chords, gentle bell-like arpeggios, no driving bass.
   * Slower BPM (~70), longer note durations, soft sine/triangle waves.
   */
  AudioEngine.prototype._musicStepNebula = function (step, time) {
    // No driving bass — only a soft, occasional low anchor on step 0 & 8.
    var bassPattern = [33, 0, 0, 0, 0, 0, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0];
    // Gentle bell-like arpeggio (sine), very sparse — C major / A minor feel.
    var arpPattern = [72, 0, 0, 76, 0, 0, 79, 0, 77, 0, 0, 72, 0, 0, 69, 0];

    var bd = bassPattern[step];
    if (bd) this._musicVoice(bd, time, this._musicStepDur * 3.5, 'sine', 0.06, 'bass');

    var ad = arpPattern[step];
    if (ad) this._musicVoice(ad, time, this._musicStepDur * 2.6, 'sine', 0.045, 'bell');

    // Pad chord at bar start and halfway — sustained, soft triangle pad.
    if (step === 0) {
      var chord = [57, 60, 64];     // A minor
      for (var i = 0; i < chord.length; i++) {
        this._musicVoice(chord[i], time, this._musicStepDur * 15, 'triangle', 0.035, 'pad');
      }
    } else if (step === 8) {
      var chord2 = [60, 64, 67];    // C major
      for (var j = 0; j < chord2.length; j++) {
        this._musicVoice(chord2[j], time, this._musicStepDur * 15, 'triangle', 0.035, 'pad');
      }
    }
  };

  /* ── Track 2: "Stellar Peace" — most serene, meditative ────────────── */
  /**
   * Very slow (~50 BPM).  Single sustained pad chords with slow filter
   * sweeps, occasional crystal-clear high notes like distant chimes, no
   * percussion feel at all, extremely sparse notes.
   */
  AudioEngine.prototype._musicStepStellar = function (step, time) {
    // No bass at all.  Extremely sparse chime notes.
    var chimePattern = [84, 0, 0, 0, 0, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0];

    var cd = chimePattern[step];
    if (cd) this._musicVoice(cd, time, this._musicStepDur * 4.0, 'sine', 0.03, 'chime');

    // Single sustained pad chord at bar start; a softer one at bar mid.
    if (step === 0) {
      var chord = [48, 55, 60, 67];   // C major (low voicing, lush)
      for (var i = 0; i < chord.length; i++) {
        this._musicVoice(chord[i], time, this._musicStepDur * 15, 'triangle', 0.03, 'padslow');
      }
    } else if (step === 8) {
      var chord2 = [50, 57, 62, 65];  // D minor-ish, gentle change
      for (var j = 0; j < chord2.length; j++) {
        this._musicVoice(chord2[j], time, this._musicStepDur * 15, 'triangle', 0.028, 'padslow');
      }
    }
  };

  /**
   * A single music voice note.  Supports the original roles plus the serene
   * track roles: 'bell', 'chime', 'padslow'.  The 'padslow' role adds a slow
   * filter sweep for a meditative character; 'bell'/'chime' are crystal-clear
   * high notes with a brighter filter and longer decay.
   */
  AudioEngine.prototype._musicVoice = function (midi, time, dur, type, peak, role) {
    var ctx = this._ctx;
    var osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = mtof(midi);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);

    // Envelope shape per role.
    if (role === 'bass') {
      g.gain.exponentialRampToValueAtTime(peak, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    } else if (role === 'arp') {
      g.gain.exponentialRampToValueAtTime(peak, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    } else if (role === 'bell') {
      // Gentle bell: quick attack, long soft decay.
      g.gain.exponentialRampToValueAtTime(peak, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    } else if (role === 'chime') {
      // Crystal-clear distant chime: very soft, long shimmer decay.
      g.gain.exponentialRampToValueAtTime(peak, time + 0.015);
      g.gain.linearRampToValueAtTime(peak * 0.5, time + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    } else if (role === 'padslow') {
      // Meditative pad: very slow swell, long sustain, slow release.
      g.gain.linearRampToValueAtTime(peak, time + dur * 0.25);
      g.gain.linearRampToValueAtTime(peak * 0.85, time + dur - dur * 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    } else { // pad (original)
      g.gain.linearRampToValueAtTime(peak, time + 0.15);
      g.gain.linearRampToValueAtTime(peak * 0.7, time + dur - 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    }

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    if (role === 'bass') {
      lp.frequency.value = 500;
    } else if (role === 'padslow') {
      // Slow filter sweep for a meditative, breathing character.
      lp.frequency.setValueAtTime(500, time);
      lp.frequency.linearRampToValueAtTime(1400, time + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(700, time + dur);
      lp.Q.value = 0.7;
    } else if (role === 'bell' || role === 'chime') {
      // Bright, open filter so the high notes stay crystal-clear.
      lp.frequency.value = 5000;
      lp.Q.value = 0.5;
    } else if (role === 'pad') {
      lp.frequency.value = 1200;
    } else { // arp
      lp.frequency.value = 3000;
    }

    osc.connect(lp); lp.connect(g); g.connect(this._musicGain);
    osc.start(time);
    osc.stop(time + dur + 0.05);
    // Music voices are short-lived; no need to track in the SFX voice list.
  };

  /* ── Volume / mute ─────────────────────────────────────────────────────── */

  /**
   * Set the master volume (0..1).  Respects mute (stays silent while muted).
   */
  AudioEngine.prototype.setVolume = function (v) {
    this._volume = clamp(v, 0, 1);
    if (this._master && !this._muted) {
      var now = this._ctx.currentTime;
      this._master.gain.setTargetAtTime(this._volume, now, 0.05);
    }
  };

  /**
   * Toggle mute.  Returns the new muted state.
   */
  AudioEngine.prototype.toggleMute = function () {
    this._muted = !this._muted;
    if (this._master && this._ctx) {
      var now = this._ctx.currentTime;
      this._master.gain.setTargetAtTime(this._muted ? 0 : this._volume, now, 0.05);
    }
    return this._muted;
  };

  /**
   * Return the current mute state.
   * @returns {boolean}
   */
  AudioEngine.prototype.isMuted = function () {
    return !!this._muted;
  };

  /* ── Music track selection ───────────────────────────────────────────── */

  /** Human-readable names for the three music tracks. */
  AudioEngine.prototype._musicTrackNames = ['Cosmic Drift', 'Nebula Lullaby', 'Stellar Peace'];

  /**
   * Select which music track (0, 1, or 2) plays.  If music is currently
   * playing, smoothly crossfade: briefly lower the music bus gain, switch
   * the track, then raise the gain back over ~1 second.
   * @param {number} trackIndex  0, 1, or 2
   */
  AudioEngine.prototype.setMusicTrack = function (trackIndex) {
    var idx = clamp(Math.floor(trackIndex), 0, 2);
    if (idx === this._musicTrack) return;          // no change needed

    if (this._musicPlaying && this._ctx && this._musicGain) {
      // Smooth crossfade: duck the music bus, switch track, raise it back.
      var ctx = this._ctx;
      var now = ctx.currentTime;
      var target = this._musicTargetGain;

      // 1) Fade down over ~0.3s to a near-silent level.
      this._musicGain.gain.cancelScheduledValues(now);
      this._musicGain.gain.setValueAtTime(this._musicGain.gain.value, now);
      this._musicGain.gain.linearRampToValueAtTime(target * 0.05, now + 0.3);

      // 2) Switch the track and recalculate step duration for the new BPM.
      this._musicTrack = idx;
      var bpm = this._currentTrackBPM();
      this._musicStepDur = (60 / bpm) / 4;
      // Reset the step so the new track begins cleanly at the bar.
      this._musicStep = 0;
      this._musicNextNoteTime = ctx.currentTime + 0.35;

      // 3) Fade the music bus back up to its target over ~1s starting now.
      this._musicGain.gain.setValueAtTime(target * 0.05, now + 0.3);
      this._musicGain.gain.linearRampToValueAtTime(target, now + 1.3);
    } else {
      // Not playing — just record the selection.
      this._musicTrack = idx;
    }
  };

  /**
   * Return the current music track index (0..2).
   * @returns {number}
   */
  AudioEngine.prototype.getMusicTrack = function () {
    return this._musicTrack;
  };

  /**
   * Return the human-readable name of the current music track.
   * @returns {string}
   */
  AudioEngine.prototype.getMusicTrackName = function () {
    return this._musicTrackNames[this._musicTrack] || 'Cosmic Drift';
  };

  /* ── Teardown ──────────────────────────────────────────────────────────── */

  /**
   * Destroy the engine: stop music, stop all active voices, stop the engine
   * hum, and close the AudioContext.
   */
  AudioEngine.prototype.destroy = function () {
    this.stopMusic();

    if (this._engine) {
      try { this._engine.osc.stop(); } catch (e) {}
      try { this._engine.osc2.stop(); } catch (e) {}
      this._stopVoice([this._engine.osc, this._engine.osc2, this._engine.lp, this._engine.gain]);
      this._engine = null;
    }

    for (var i = 0; i < this._activeVoices.length; i++) {
      this._stopVoice(this._activeVoices[i]);
    }
    this._activeVoices.length = 0;

    if (this._ctx) {
      try { this._ctx.close(); } catch (e) {}
      this._ctx = null;
      this._master = null;
      this._sfxGain = null;
      this._musicGain = null;
    }
  };

  /* ── Export ─────────────────────────────────────────────────────────────── */
  global.AudioEngine = AudioEngine;

})(typeof window !== 'undefined' ? window : this);
