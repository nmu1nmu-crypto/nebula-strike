/* ============================================================
 * Galaxy Reborn — Background.js
 * Multi-layer parallax starfield, nebula clouds, distant
 * galaxies, a subtle warp/vortex and occasional shooting stars.
 *
 * Constructor:  new Background(scene)
 * Methods:      update(dt, playerVelocity)
 *               resize(w, h)
 *               setSpeed(multiplier)   // warp / hyperspace
 *
 * THREE.js (r0.160) global from CDN. No ES6 modules.
 * ============================================================ */
(function (global) {
  'use strict';

  // ------------------------------------------------------------
  // Tunable constants
  // ------------------------------------------------------------
  var PLAYFIELD_W = 900;
  var PLAYFIELD_H = 1300;
  var STAR_SPREAD_X = 1100;   // half-width of the star volume
  var STAR_SPREAD_Y = 1500;   // half-height of the star volume
  var NEBULA_Z = -260;
  var GALAXY_Z = -340;
  var VORTEX_Z = -420;

  // Star colour palette (RGB 0..1)
  var STAR_COLORS = [
    [1.00, 1.00, 1.00],   // white
    [0.70, 0.80, 1.00],   // blue-white
    [1.00, 1.00, 0.70],   // yellow
    [1.00, 0.70, 0.60],   // red / amber
    [0.80, 0.85, 1.00]    // pale blue
  ];

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------
  function rand(min, max) { return min + Math.random() * (max - min); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // Procedurally draw a soft circular "star" sprite to a canvas so the
  // background renders correctly even before the PNG textures exist.
  function makeStarTexture(size, coreSharp) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var cx = size / 2;
    var g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    if (coreSharp) {
      g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.40, 'rgba(255,255,255,0.25)');
      g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    } else {
      g.addColorStop(0.00, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.30, 'rgba(255,255,255,0.35)');
      g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // Procedural spiral/vortex texture for the far warp backdrop.
  function makeVortexTexture(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var cx = size / 2;
    // Deep space base
    ctx.fillStyle = 'rgba(2,2,10,1)';
    ctx.fillRect(0, 0, size, size);
    // Faint radial arms
    var arms = 4;
    for (var a = 0; a < arms; a++) {
      var base = (a / arms) * Math.PI * 2;
      for (var t = 0; t < 1; t += 0.004) {
        var r = t * cx * 0.95;
        var ang = base + t * 7.5;
        var x = cx + Math.cos(ang) * r;
        var y = cx + Math.sin(ang) * r;
        var alpha = (1 - t) * 0.12;
        ctx.fillStyle = 'rgba(120,150,255,' + alpha + ')';
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Bright core
    var g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.4);
    g.addColorStop(0, 'rgba(180,200,255,0.22)');
    g.addColorStop(0.5, 'rgba(80,100,200,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // Elongated streak texture for shooting stars.
  function makeStreakTexture() {
    var w = 128, h = 32;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, h / 2, w, h / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,0.0)');
    g.addColorStop(0.70, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.95, 'rgba(255,255,255,1.0)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // soft vertical falloff
    var gv = ctx.createLinearGradient(0, 0, 0, h);
    gv.addColorStop(0, 'rgba(0,0,0,1)');
    gv.addColorStop(0.5, 'rgba(0,0,0,0)');
    gv.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = gv;
    ctx.fillRect(0, 0, w, h);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // ------------------------------------------------------------
  // Star layer (THREE.Points with a custom shader for twinkle +
  // perspective size attenuation).
  // ------------------------------------------------------------
  function StarLayer(opts) {
    this.count = opts.count;
    this.speed = opts.speed;          // base scroll speed (units/sec)
    this.sizeMul = opts.sizeMul;     // global size multiplier
    this.opacity = opts.opacity;
    this.z = opts.z;                  // depth plane
    this.streak = !!opts.streak;      // per-star speed variation (streaking)
    this.minSize = opts.minSize;
    this.maxSize = opts.maxSize;

    var positions = new Float32Array(this.count * 3);
    var colors = new Float32Array(this.count * 3);
    var sizes = new Float32Array(this.count);
    var phases = new Float32Array(this.count);
    this.starSpeed = new Float32Array(this.count); // per-star speed mult

    for (var i = 0; i < this.count; i++) {
      positions[i * 3 + 0] = rand(-STAR_SPREAD_X, STAR_SPREAD_X);
      positions[i * 3 + 1] = rand(-STAR_SPREAD_Y, STAR_SPREAD_Y);
      positions[i * 3 + 2] = this.z + rand(-40, 40);

      var col = pick(STAR_COLORS);
      var bright = rand(0.6, 1.0);
      colors[i * 3 + 0] = col[0] * bright;
      colors[i * 3 + 1] = col[1] * bright;
      colors[i * 3 + 2] = col[2] * bright;

      sizes[i] = rand(this.minSize, this.maxSize);
      phases[i] = Math.random() * Math.PI * 2;
      this.starSpeed[i] = this.streak ? rand(1.0, 2.6) : 1.0;
    }

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    this.positions = positions;
    this.baseColors = colors;          // original per-star colours (un-tinted)
    this.currentTint = [1, 1, 1];       // active tint multiplier
    this.geometry = geom;
    this.colorsAttr = geom.attributes.aColor;

    var tex = opts.texture || makeStarTexture(64, true);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTexture: { value: tex },
        uOpacity: { value: this.opacity },
        uSizeMul: { value: this.sizeMul },
        uPixelRatio: { value: window.devicePixelRatio || 1 }
      },
      vertexShader: [
        'attribute float aSize;',
        'attribute float aPhase;',
        'attribute vec3 aColor;',
        'uniform float uTime;',
        'uniform float uSizeMul;',
        'uniform float uPixelRatio;',
        'varying vec3 vColor;',
        'varying float vTwinkle;',
        'void main() {',
        '  vColor = aColor;',
        '  float tw = 0.55 + 0.45 * sin(uTime * 2.2 + aPhase * 6.2831853);',
        '  vTwinkle = tw;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  float dist = max(1.0, -mv.z);',
        '  gl_PointSize = aSize * uSizeMul * uPixelRatio * (300.0 / dist);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uTexture;',
        'uniform float uOpacity;',
        'varying vec3 vColor;',
        'varying float vTwinkle;',
        'void main() {',
        '  vec4 t = texture2D(uTexture, gl_PointCoord);',
        '  float a = t.a * uOpacity * vTwinkle;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(vColor, a);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false;
  }

  StarLayer.prototype.update = function (dt, speedMul, time) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uOpacity.value = this.opacity;
    this.material.uniforms.uSizeMul.value = this.sizeMul;

    var v = this.speed * speedMul * dt;
    var pos = this.positions;

    if (this.streak) {
      // Per-star movement with varying speed — stars "streak past".
      for (var i = 0; i < this.count; i++) {
        var idx = i * 3 + 1;
        pos[idx] -= v * this.starSpeed[i];
        if (pos[idx] < -STAR_SPREAD_Y) {
          pos[idx] += STAR_SPREAD_Y * 2;
          pos[i * 3 + 0] = rand(-STAR_SPREAD_X, STAR_SPREAD_X);
        }
      }
      this.geometry.attributes.position.needsUpdate = true;
    } else {
      // Whole-layer movement — cheap and uniform parallax.
      this.points.position.y -= v;
      if (this.points.position.y < -STAR_SPREAD_Y) {
        this.points.position.y += STAR_SPREAD_Y * 2;
      }
    }
  };

  StarLayer.prototype.setOpacity = function (o) { this.opacity = o; };

  // Tint every star in this layer by multiplying its base colour by `tint`
  // (an [r,g,b] array, 0..1). Lerp toward the new tint if `lerp` is true.
  StarLayer.prototype.setTint = function (tint) {
    var target = tint || [1, 1, 1];
    this._tintTarget = target;
    // Snap first call; subsequent calls lerp via update().
    if (!this._tintActive) {
      this.currentTint = target.slice();
      this._tintActive = true;
      this._applyTint();
    }
  };

  StarLayer.prototype._applyTint = function () {
    var arr = this.colorsAttr.array;
    var base = this.baseColors;
    var t = this.currentTint;
    for (var i = 0; i < this.count; i++) {
      arr[i * 3 + 0] = base[i * 3 + 0] * t[0];
      arr[i * 3 + 1] = base[i * 3 + 1] * t[1];
      arr[i * 3 + 2] = base[i * 3 + 2] * t[2];
    }
    this.colorsAttr.needsUpdate = true;
  };

  StarLayer.prototype.updateTint = function (dt, rate) {
    if (!this._tintActive || !this._tintTarget) return;
    var k = clamp(dt * rate, 0, 1);
    var changed = false;
    for (var c = 0; c < 3; c++) {
      var nv = this.currentTint[c] + (this._tintTarget[c] - this.currentTint[c]) * k;
      if (Math.abs(nv - this.currentTint[c]) > 0.001) changed = true;
      this.currentTint[c] = nv;
    }
    if (changed) this._applyTint();
  };

  // ------------------------------------------------------------
  // Nebula cloud — large transparent plane that drifts/rotates.
  // ------------------------------------------------------------
  function Nebula(scene, loader, name, color, x, y, z, scale, rotSpeed) {
    this.baseX = x;
    this.baseY = y;
    this.z = z;
    this.scale = scale;
    this.rotSpeed = rotSpeed;
    this.driftPhase = Math.random() * Math.PI * 2;
    this.color = color;

    var geo = new THREE.PlaneGeometry(1, 1);
    var mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.55,
      side: THREE.DoubleSide
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, y, z);
    this.mesh.scale.set(scale, scale, 1);
    this.mesh.rotation.z = Math.random() * Math.PI * 2;
    this.mesh.renderOrder = -2;
    this.loaded = false;
    this.currentColor = color.slice(0);   // live tint (lerped)
    this._tintTarget = color.slice(0);    // target tint
    scene.add(this.mesh);

    var self = this;
    var url = 'assets/textures/nebula_' + name + '.png';
    loader.load(url, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      mat.map = tex;
      // Tint by colour so different nebulae read distinctly.
      mat.color = new THREE.Color(color[0], color[1], color[2]);
      mat.needsUpdate = true;
      self.loaded = true;
    }, undefined, function () {
      // Texture missing — draw a procedural fallback cloud.
      var c = document.createElement('canvas');
      c.width = c.height = 256;
      var ctx = c.getContext('2d');
      var cx = 128;
      for (var r = 128; r > 0; r -= 8) {
        var a = (1 - r / 128) * 0.5;
        ctx.fillStyle = 'rgba(' +
          (color[0] * 255 | 0) + ',' +
          (color[1] * 255 | 0) + ',' +
          (color[2] * 255 | 0) + ',' + a + ')';
        ctx.beginPath();
        ctx.arc(cx + rand(-20, 20), cx + rand(-20, 20), r, 0, Math.PI * 2);
        ctx.fill();
      }
      var tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      mat.map = tex;
      mat.needsUpdate = true;
      self.loaded = true;
    });
  }

  Nebula.prototype.update = function (dt, time, speedMul) {
    // Slow parallax drift downward + gentle lateral sway + rotation.
    this.mesh.position.y -= 6 * speedMul * dt;
    this.mesh.position.x = this.baseX + Math.sin(time * 0.07 + this.driftPhase) * 30;
    if (this.mesh.position.y < -STAR_SPREAD_Y) {
      this.mesh.position.y += STAR_SPREAD_Y * 2;
    }
    this.mesh.rotation.z += this.rotSpeed * dt;
    // Subtle opacity breathing (scaled by theme opacity multiplier)
    var mul = (this._opacityMul === undefined) ? 1 : this._opacityMul;
    this.material.opacity = (0.45 + 0.12 * Math.sin(time * 0.25 + this.driftPhase)) * mul;
  };

  Nebula.prototype.resize = function (w, h) {
    var s = Math.max(w, h) * 1.4;
    this.mesh.scale.set(this.scale * (s / 900), this.scale * (s / 900), 1);
  };

  // Set the target tint colour for this nebula (lerped during update).
  Nebula.prototype.setTint = function (color) {
    this._tintTarget = color.slice(0);
  };

  // Per-frame tint lerp + opacity scaling. Called by Background.update.
  Nebula.prototype.updateTint = function (dt, rate, opacityMul) {
    var k = clamp(dt * rate, 0, 1);
    var changed = false;
    for (var c = 0; c < 3; c++) {
      var nv = this.currentColor[c] + (this._tintTarget[c] - this.currentColor[c]) * k;
      if (Math.abs(nv - this.currentColor[c]) > 0.001) changed = true;
      this.currentColor[c] = nv;
    }
    if (changed && this.material && this.loaded) {
      this.material.color.setRGB(this.currentColor[0], this.currentColor[1], this.currentColor[2]);
    }
    this._opacityMul = (opacityMul === undefined) ? 1 : opacityMul;
  };

  // ------------------------------------------------------------
  // Shooting star — a stretched billboard streak with a trail.
  // ------------------------------------------------------------
  function ShootingStar(streakTex) {
    var geo = new THREE.PlaneGeometry(1, 1);
    var mat = new THREE.MeshBasicMaterial({
      map: streakTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 1
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.active = false;
    this.life = 0;
    this.maxLife = 1;
    this.vx = 0;
    this.vy = 0;
    this.length = 0;
  }

  ShootingStar.prototype.spawn = function (w, h) {
    // Start somewhere off the top/side, fly diagonally downward.
    var side = Math.random();
    if (side < 0.5) {
      this.mesh.position.set(rand(-w * 0.6, w * 0.6), h * 0.7 + rand(0, 200), -50);
    } else {
      this.mesh.position.set(rand(-w * 0.8, -w * 0.3), rand(-h * 0.2, h * 0.6), -50);
    }
    var ang = rand(-0.5, 0.5) - Math.PI / 2; // mostly downward
    var speed = rand(900, 1500);
    this.vx = Math.cos(ang) * speed;
    this.vy = Math.sin(ang) * speed;
    this.maxLife = rand(0.7, 1.3);
    this.life = this.maxLife;
    this.length = rand(120, 240);
    var scl = this.length;
    this.mesh.scale.set(scl, scl * 0.18, 1);
    // Orient along velocity
    this.mesh.rotation.z = Math.atan2(this.vy, this.vx);
    this.material.opacity = 1;
    this.mesh.visible = true;
    this.active = true;
  };

  ShootingStar.prototype.update = function (dt) {
    if (!this.active) return;
    this.mesh.position.x += this.vx * dt;
    this.mesh.position.y += this.vy * dt;
    this.life -= dt;
    var t = clamp(this.life / this.maxLife, 0, 1);
    this.material.opacity = t * t;
    if (this.life <= 0) {
      this.active = false;
      this.mesh.visible = false;
    }
  };

  // ------------------------------------------------------------
  // Main Background class
  // ------------------------------------------------------------
  function Background(scene) {
    this.scene = scene;
    this.scene.background = new THREE.Color(0x02020a);

    this.speedMul = 1.0;          // global speed multiplier (warp)
    this.targetSpeedMul = 1.0;
    this.time = 0;
    this.shootTimer = rand(2, 5);
    this.viewportW = PLAYFIELD_W;
    this.viewportH = PLAYFIELD_H;

    // Theme transition state. Colours are stored as [r,g,b] 0..1.
    this._bgCurrent = [0.008, 0.008, 0.039];
    this._bgTarget = this._bgCurrent.slice();
    this._fogCurrent = this._bgCurrent.slice();
    this._fogTarget = this._bgCurrent.slice();
    this._fogDensityCurrent = 0.00018;
    this._fogDensityTarget = 0.00018;
    this._nebulaOpacityMul = 1.0;
    this._nebulaOpacityTarget = 1.0;
    this._themeLerpRate = 3.0;   // ~1s transition (exp approach)
    this._currentTheme = null;

    var loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    this.loader = loader;

    // Shared star sprite (sharp core) for bright layers.
    var sharpTex = makeStarTexture(64, true);
    // Soft halo sprite for far/dim layers.
    var softTex = makeStarTexture(64, false);
    // Larger glowing sprite for the closest streaking layer.
    var glowTex = makeStarTexture(128, true);

    // ---- Layer 1 (far): thousands of tiny dim stars, barely moving
    this.layerFar = new StarLayer({
      count: 2200, speed: 14, z: -120, opacity: 0.5, sizeMul: 0.6,
      minSize: 1.0, maxSize: 2.2, texture: softTex
    });
    scene.add(this.layerFar.points);

    // ---- Layer 2 (mid): medium stars with slight parallax drift
    this.layerMid = new StarLayer({
      count: 900, speed: 34, z: -80, opacity: 0.8, sizeMul: 0.9,
      minSize: 1.8, maxSize: 3.6, texture: sharpTex
    });
    scene.add(this.layerMid.points);

    // ---- Layer 3 (near): bright stars with noticeable movement
    this.layerNear = new StarLayer({
      count: 320, speed: 70, z: -40, opacity: 1.0, sizeMul: 1.1,
      minSize: 3.0, maxSize: 5.5, texture: sharpTex
    });
    scene.add(this.layerNear.points);

    // ---- Layer 4 (closest): occasional large glowing stars that streak past
    this.layerStreak = new StarLayer({
      count: 70, speed: 130, z: -10, opacity: 1.0, sizeMul: 1.4,
      minSize: 5.0, maxSize: 9.0, texture: glowTex, streak: true
    });
    scene.add(this.layerStreak.points);

    // ---- Nebula clouds
    this.nebulae = [
      new Nebula(scene, loader, 'blue',   [0.25, 0.45, 1.0], -260, 180, NEBULA_Z, 900, 0.04),
      new Nebula(scene, loader, 'red',    [1.0, 0.30, 0.30], 280, -120, NEBULA_Z + 30, 820, -0.03),
      new Nebula(scene, loader, 'green',  [0.20, 1.0, 0.45], 120, 420, NEBULA_Z + 60, 760, 0.05),
      new Nebula(scene, loader, 'purple', [0.65, 0.25, 1.0], -340, -360, NEBULA_Z + 15, 880, -0.045)
    ];

    // ---- Distant galaxies (subtle bright spots, points-based)
    this.galaxyTex = makeStarTexture(64, true);
    this.galaxies = this._buildDistantGalaxies();
    scene.add(this.galaxies);

    // ---- Warp / vortex far backdrop
    this.vortex = this._buildVortex();
    scene.add(this.vortex);

    // ---- Shooting stars pool
    this.streakTex = makeStreakTexture();
    this.shootingStars = [];
    for (var i = 0; i < 6; i++) {
      var ss = new ShootingStar(this.streakTex);
      this.shootingStars.push(ss);
      scene.add(ss.mesh);
    }

    // Fog for depth fade (subtle)
    scene.fog = new THREE.FogExp2(0x02020a, 0.00018);

    // Apply the default "Deep Space" theme so everything is tracked from
    // a single source of truth.
    this.setTheme(Background.THEMES[0], true);
  }

  Background.prototype._buildDistantGalaxies = function () {
    var n = 26;
    var positions = new Float32Array(n * 3);
    var colors = new Float32Array(n * 3);
    var sizes = new Float32Array(n);
    var phases = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      positions[i * 3 + 0] = rand(-STAR_SPREAD_X, STAR_SPREAD_X);
      positions[i * 3 + 1] = rand(-STAR_SPREAD_Y, STAR_SPREAD_Y);
      positions[i * 3 + 2] = GALAXY_Z + rand(-30, 30);
      var col = pick(STAR_COLORS);
      colors[i * 3 + 0] = col[0] * 0.8;
      colors[i * 3 + 1] = col[1] * 0.8;
      colors[i * 3 + 2] = col[2] * 0.8;
      sizes[i] = rand(4, 8);
      phases[i] = Math.random() * Math.PI * 2;
    }
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTexture: { value: this.galaxyTex },
        uOpacity: { value: 0.5 },
        uSizeMul: { value: 1.0 },
        uPixelRatio: { value: window.devicePixelRatio || 1 }
      },
      vertexShader: this._starVertexShader(),
      fragmentShader: this._starFragmentShader(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -3;
    this._galaxyMat = mat;
    this._galaxyPos = positions;
    return pts;
  };

  Background.prototype._starVertexShader = function () {
    return [
      'attribute float aSize;',
      'attribute float aPhase;',
      'attribute vec3 aColor;',
      'uniform float uTime;',
      'uniform float uSizeMul;',
      'uniform float uPixelRatio;',
      'varying vec3 vColor;',
      'varying float vTwinkle;',
      'void main() {',
      '  vColor = aColor;',
      '  float tw = 0.55 + 0.45 * sin(uTime * 1.3 + aPhase * 6.2831853);',
      '  vTwinkle = tw;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  float dist = max(1.0, -mv.z);',
      '  gl_PointSize = aSize * uSizeMul * uPixelRatio * (300.0 / dist);',
      '}'
    ].join('\n');
  };

  Background.prototype._starFragmentShader = function () {
    return [
      'uniform sampler2D uTexture;',
      'uniform float uOpacity;',
      'varying vec3 vColor;',
      'varying float vTwinkle;',
      'void main() {',
      '  vec4 t = texture2D(uTexture, gl_PointCoord);',
      '  float a = t.a * uOpacity * vTwinkle;',
      '  if (a < 0.01) discard;',
      '  gl_FragColor = vec4(vColor, a);',
      '}'
    ].join('\n');
  };

  Background.prototype._buildVortex = function () {
    var tex = makeVortexTexture(512);
    var geo = new THREE.PlaneGeometry(1, 1);
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.35,
      side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, VORTEX_Z);
    mesh.scale.set(2600, 2600, 1);
    mesh.renderOrder = -4;
    this._vortexMat = mat;
    return mesh;
  };

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------
  Background.prototype.update = function (dt, playerVelocity) {
    // Smoothly approach target speed multiplier (warp transitions).
    this.speedMul += (this.targetSpeedMul - this.speedMul) * Math.min(1, dt * 3);
    this.time += dt;

    // Parallax influenced slightly by player horizontal velocity.
    var px = 0;
    if (playerVelocity) { px = clamp(playerVelocity.x * 0.02, -1.5, 1.5); }

    this.layerFar.update(dt, this.speedMul, this.time);
    this.layerMid.update(dt, this.speedMul, this.time);
    this.layerNear.update(dt, this.speedMul, this.time);
    this.layerStreak.update(dt, this.speedMul, this.time);

    // Slight lateral parallax shift for depth feedback.
    this.layerFar.points.position.x = px * 4;
    this.layerMid.points.position.x = px * 10;
    this.layerNear.points.position.x = px * 22;
    this.layerStreak.points.position.x = px * 36;

    // Nebulae
    for (var i = 0; i < this.nebulae.length; i++) {
      this.nebulae[i].update(dt, this.time, this.speedMul);
    }

    // Distant galaxies: slow downward drift + twinkle
    if (this._galaxyMat) {
      this._galaxyMat.uniforms.uTime.value = this.time;
      this.galaxies.position.y -= 5 * this.speedMul * dt;
      if (this.galaxies.position.y < -STAR_SPREAD_Y) {
        this.galaxies.position.y += STAR_SPREAD_Y * 2;
      }
    }

    // Vortex: slow rotation + subtle pulse
    if (this._vortexMat) {
      this.vortex.rotation.z += 0.02 * dt;
      this._vortexMat.opacity = 0.30 + 0.06 * Math.sin(this.time * 0.4);
      this.vortex.position.x = px * 8;
    }

    // ---- Theme colour transitions (lerp toward targets) ----
    this._updateTheme(dt);

    // Shooting stars
    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      this._spawnShootingStar();
      this.shootTimer = rand(2.5, 6.5) / Math.max(0.5, this.speedMul);
    }
    for (var s = 0; s < this.shootingStars.length; s++) {
      this.shootingStars[s].update(dt);
    }
  };

  Background.prototype._spawnShootingStar = function () {
    for (var i = 0; i < this.shootingStars.length; i++) {
      if (!this.shootingStars[i].active) {
        this.shootingStars[i].spawn(this.viewportW, this.viewportH);
        return;
      }
    }
  };

  Background.prototype.resize = function (w, h) {
    this.viewportW = w;
    this.viewportH = h;
    for (var i = 0; i < this.nebulae.length; i++) {
      this.nebulae[i].resize(w, h);
    }
    if (this._vortexMat) {
      var s = Math.max(w, h) * 3.0;
      this.vortex.scale.set(s, s, 1);
    }
  };

  Background.prototype.setSpeed = function (multiplier) {
    this.targetSpeedMul = clamp(multiplier, 0.1, 8.0);
  };

  // ----------------------------------------------------------
  // Theme support
  // ----------------------------------------------------------

  // Convert a hex number (0xRRGGBB) or [r,g,b] (0..255 or 0..1) into a
  // normalized [r,g,b] array in 0..1 space.
  Background.prototype._normalizeColor = function (c) {
    if (c === undefined || c === null) return null;
    if (typeof c === 'number') {
      return [
        ((c >> 16) & 0xff) / 255,
        ((c >> 8) & 0xff) / 255,
        (c & 0xff) / 255
      ];
    }
    if (Array.isArray(c)) {
      // Heuristic: if any channel > 1, assume 0..255 range.
      var scale = (c[0] > 1 || c[1] > 1 || c[2] > 1) ? 255 : 1;
      return [c[0] / scale, c[1] / scale, c[2] / scale];
    }
    return null;
  };

  // Apply a theme. If `instant` is true the colours snap instead of lerping.
  Background.prototype.setTheme = function (theme, instant) {
    if (!theme) return;
    var bg = this._normalizeColor(theme.bgColor) || [0, 0, 0];
    var fog = this._normalizeColor(theme.fogColor) || bg.slice();
    var density = (typeof theme.fogDensity === 'number') ? theme.fogDensity : 0.00018;
    var opacityMul = (typeof theme.nebulaOpacity === 'number') ? theme.nebulaOpacity : 1.0;

    this._bgTarget = bg;
    this._fogTarget = fog;
    this._fogDensityTarget = density;
    this._nebulaOpacityTarget = opacityMul;

    // Nebula tints (expect 4; pad/truncate defensively)
    var nCols = theme.nebulaColors || [];
    for (var i = 0; i < this.nebulae.length; i++) {
      var nc = this._normalizeColor(nCols[i]) || this.nebulae[i].currentColor.slice();
      this.nebulae[i].setTint(nc);
      if (instant) {
        this.nebulae[i].currentColor = nc.slice();
        if (this.nebulae[i].material && this.nebulae[i].loaded) {
          this.nebulae[i].material.color.setRGB(nc[0], nc[1], nc[2]);
        }
      }
    }

    // Star tints (optional). Each entry tints a star layer; if fewer are
    // supplied than layers, remaining layers keep their current tint.
    if (theme.starColors && theme.starColors.length) {
      var layers = [this.layerFar, this.layerMid, this.layerNear, this.layerStreak];
      for (var s = 0; s < layers.length; s++) {
        if (s < theme.starColors.length) {
          var sc = this._normalizeColor(theme.starColors[s]);
          if (sc) {
            layers[s].setTint(sc);
            if (instant) {
              layers[s].currentTint = sc.slice();
              layers[s]._applyTint();
            }
          }
        }
      }
    }

    if (instant) {
      this._bgCurrent = bg.slice();
      this._fogCurrent = fog.slice();
      this._fogDensityCurrent = density;
      this._nebulaOpacityMul = opacityMul;
      this.scene.background.setRGB(bg[0], bg[1], bg[2]);
      if (this.scene.fog) {
        this.scene.fog.color.setRGB(fog[0], fog[1], fog[2]);
        this.scene.fog.density = density;
      }
    }

    this._currentTheme = theme;
  };

  // Return the currently active theme config.
  Background.prototype.getTheme = function () {
    return this._currentTheme;
  };

  // Per-frame lerp of all tracked theme colours toward their targets.
  Background.prototype._updateTheme = function (dt) {
    var rate = this._themeLerpRate;
    var k = clamp(dt * rate, 0, 1);

    // Background colour
    var bgChanged = false;
    for (var c = 0; c < 3; c++) {
      var nv = this._bgCurrent[c] + (this._bgTarget[c] - this._bgCurrent[c]) * k;
      if (Math.abs(nv - this._bgCurrent[c]) > 0.0005) bgChanged = true;
      this._bgCurrent[c] = nv;
    }
    if (bgChanged) {
      this.scene.background.setRGB(this._bgCurrent[0], this._bgCurrent[1], this._bgCurrent[2]);
    }

    // Fog colour + density
    if (this.scene.fog) {
      var fogChanged = false;
      for (var f = 0; f < 3; f++) {
        var fv = this._fogCurrent[f] + (this._fogTarget[f] - this._fogCurrent[f]) * k;
        if (Math.abs(fv - this._fogCurrent[f]) > 0.0005) fogChanged = true;
        this._fogCurrent[f] = fv;
      }
      if (fogChanged) {
        this.scene.fog.color.setRGB(this._fogCurrent[0], this._fogCurrent[1], this._fogCurrent[2]);
      }
      this._fogDensityCurrent += (this._fogDensityTarget - this._fogDensityCurrent) * k;
      this.scene.fog.density = this._fogDensityCurrent;
    }

    // Nebula opacity multiplier
    this._nebulaOpacityMul += (this._nebulaOpacityTarget - this._nebulaOpacityMul) * k;

    // Nebula tints
    for (var n = 0; n < this.nebulae.length; n++) {
      this.nebulae[n].updateTint(dt, rate, this._nebulaOpacityMul);
    }

    // Star layer tints
    this.layerFar.updateTint(dt, rate);
    this.layerMid.updateTint(dt, rate);
    this.layerNear.updateTint(dt, rate);
    this.layerStreak.updateTint(dt, rate);
  };

  // ----------------------------------------------------------
  // Predefined themes
  // ----------------------------------------------------------
  Background.THEMES = [
    // 0: Deep Space — dark blue-black, blue nebulae (default)
    {
      name: 'Deep Space',
      bgColor: 0x000510, fogColor: 0x000510, fogDensity: 0.00018,
      nebulaColors: [
        [0.25, 0.45, 1.0],
        [0.30, 0.50, 0.95],
        [0.20, 0.40, 0.90],
        [0.35, 0.55, 1.0]
      ]
    },
    // 1: Crimson Nebula — dark red-black, red/orange nebulae
    {
      name: 'Crimson Nebula',
      bgColor: 0x100005, fogColor: 0x100005, fogDensity: 0.00020,
      nebulaColors: [
        [1.0, 0.20, 0.15],
        [1.0, 0.40, 0.10],
        [0.95, 0.25, 0.20],
        [0.80, 0.30, 0.10]
      ],
      starColors: [[1, 0.85, 0.7], [1, 0.7, 0.5], [1, 0.6, 0.4], [1, 0.5, 0.3]]
    },
    // 2: Emerald Void — dark green-black, green/teal nebulae
    {
      name: 'Emerald Void',
      bgColor: 0x001005, fogColor: 0x001005, fogDensity: 0.00018,
      nebulaColors: [
        [0.20, 1.0, 0.45],
        [0.15, 0.85, 0.55],
        [0.25, 0.95, 0.60],
        [0.10, 0.70, 0.50]
      ],
      starColors: [[0.8, 1, 0.85], [0.7, 1, 0.8], [0.6, 1, 0.75], [0.5, 0.95, 0.7]]
    },
    // 3: Purple Haze — dark purple-black, purple/magenta nebulae
    {
      name: 'Purple Haze',
      bgColor: 0x080018, fogColor: 0x080018, fogDensity: 0.00020,
      nebulaColors: [
        [0.65, 0.25, 1.0],
        [0.85, 0.20, 0.80],
        [0.55, 0.30, 0.95],
        [0.75, 0.15, 0.90]
      ],
      starColors: [[0.85, 0.7, 1], [0.95, 0.6, 0.9], [0.8, 0.65, 1], [0.7, 0.5, 0.95]]
    },
    // 4: Golden Wastes — dark amber-black, gold/orange nebulae
    {
      name: 'Golden Wastes',
      bgColor: 0x100800, fogColor: 0x100800, fogDensity: 0.00020,
      nebulaColors: [
        [1.0, 0.75, 0.20],
        [1.0, 0.60, 0.15],
        [0.95, 0.80, 0.30],
        [0.90, 0.55, 0.10]
      ],
      starColors: [[1, 0.9, 0.6], [1, 0.8, 0.5], [1, 0.7, 0.4], [1, 0.85, 0.55]]
    },
    // 5: Ice Fields — dark cyan-black, cyan/white nebulae
    {
      name: 'Ice Fields',
      bgColor: 0x000810, fogColor: 0x000810, fogDensity: 0.00016,
      nebulaColors: [
        [0.60, 0.90, 1.0],
        [0.75, 0.95, 1.0],
        [0.85, 1.0, 1.0],
        [0.55, 0.85, 0.95]
      ],
      starColors: [[0.85, 0.95, 1], [0.75, 0.9, 1], [0.9, 1, 1], [0.8, 0.95, 1]]
    },
    // 6: Inferno — dark red-orange, red/orange/yellow nebulae
    {
      name: 'Inferno',
      bgColor: 0x180400, fogColor: 0x180400, fogDensity: 0.00022,
      nebulaColors: [
        [1.0, 0.15, 0.05],
        [1.0, 0.45, 0.10],
        [1.0, 0.75, 0.20],
        [0.95, 0.30, 0.05]
      ],
      starColors: [[1, 0.8, 0.5], [1, 0.6, 0.3], [1, 0.9, 0.6], [1, 0.5, 0.2]]
    },
    // 7: Twilight — dark indigo, purple/blue/pink nebulae
    {
      name: 'Twilight',
      bgColor: 0x080020, fogColor: 0x080020, fogDensity: 0.00018,
      nebulaColors: [
        [0.55, 0.30, 0.95],
        [0.30, 0.40, 1.0],
        [0.90, 0.35, 0.85],
        [0.65, 0.25, 0.80]
      ],
      starColors: [[0.8, 0.75, 1], [0.7, 0.8, 1], [0.95, 0.7, 0.9], [0.85, 0.65, 1]]
    },
    // 8: Aurora — dark teal-black, green/cyan/purple nebulae
    {
      name: 'Aurora',
      bgColor: 0x000818, fogColor: 0x000818, fogDensity: 0.00018,
      nebulaColors: [
        [0.20, 0.95, 0.60],
        [0.30, 0.85, 1.0],
        [0.60, 0.30, 0.95],
        [0.25, 0.90, 0.80]
      ],
      starColors: [[0.7, 1, 0.85], [0.6, 0.95, 1], [0.8, 0.6, 1], [0.5, 1, 0.9]]
    },
    // 9: Void — pure black, dark grey/white subtle nebulae
    {
      name: 'Void',
      bgColor: 0x000000, fogColor: 0x000000, fogDensity: 0.00014,
      nebulaColors: [
        [0.30, 0.30, 0.35],
        [0.40, 0.40, 0.45],
        [0.50, 0.50, 0.55],
        [0.35, 0.35, 0.40]
      ],
      nebulaOpacity: 0.5,
      starColors: [[0.7, 0.7, 0.7], [0.6, 0.6, 0.6], [0.8, 0.8, 0.8], [0.5, 0.5, 0.5]]
    }
  ];

  // Expose globally
  global.Background = Background;

})(typeof window !== 'undefined' ? window : this);
