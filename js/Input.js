/**
 * Input.js — Input handler for Galaxy Reborn (Nebula Strike)
 *
 * A unified input system handling:
 *   - Keyboard (arrows, space, Z, P, Enter) with held-key tracking and no OS key-repeat issues
 *   - Touch / mobile: a AAA-style floating virtual joystick (left half) + dedicated
 *     fire / special / pause buttons (right half), all rendered on a high-DPI canvas
 *     overlay with glow, trails, spring-back, 8-directional snap, charge indicators and
 *     haptic feedback. Multi-touch is fully supported (move + fire + special simultaneously).
 *   - Gamepad via the standard Gamepad API (polled each frame in update())
 *   - An event callback system that Game.js registers for (key press, touch start/move/end)
 *
 * Public surface (instance properties/methods):
 *   input.keys            -> object of currently-held key codes (e.g. input.keys.Space === true)
 *   input.fire            -> boolean (true while fire is held, any source)
 *   input.special         -> boolean (true while special is held, any source)
 *   input.getMovement()   -> {x, y} normalized movement vector, each component in [-1, 1]
 *   input.onKeyPress(cb)  -> register a one-shot key-press callback (fires once per physical press)
 *   input.onTouchStart/Move/End(cb) -> register touch callbacks
 *   input.update()        -> poll gamepad state (call once per frame)
 *   input.destroy()       -> remove all DOM listeners, stop the render loop and release resources
 *
 * The class is attached to `window.Input` so it can be referenced globally (matches the
 * non-module script loading order in index.html: Game.js is loaded before Input.js, but
 * Game.js only constructs `new Input()` at runtime after window load, so the global is
 * available by then).
 */
(function (global) {
    'use strict';

    // ─── Key code constants ───────────────────────────────────────────────
    // We use event.code (physical key) rather than event.key (layout-dependent) so the
    // game behaves consistently across keyboard layouts (QWERTY, AZERTY, Dvorak, …).
    const KEY = {
        ARROW_LEFT: 'ArrowLeft',
        ARROW_RIGHT: 'ArrowRight',
        ARROW_UP: 'ArrowUp',
        ARROW_DOWN: 'ArrowDown',
        SPACE: 'Space',
        KEY_Z: 'KeyZ',
        KEY_P: 'KeyP',
        ENTER: 'Enter'
    };

    // Set of physical key codes we care about, for fast `includes` checks during
    // preventDefault. Kept as an array of strings.
    const GAME_KEY_CODES = [
        KEY.ARROW_LEFT, KEY.ARROW_RIGHT, KEY.ARROW_UP, KEY.ARROW_DOWN,
        KEY.SPACE, KEY.KEY_Z, KEY.KEY_P, KEY.ENTER
    ];

    // ─── Touch UI tunables ────────────────────────────────────────────────
    // All sizes are in CSS pixels (the render context is scaled by devicePixelRatio for
    // crisp rendering on retina displays).
    const JOYSTICK_OUTER_RADIUS = 60;   // px — outer ring radius (120px diameter)
    const JOYSTICK_KNOB_RADIUS  = 25;   // px — inner knob radius (50px diameter)
    const JOYSTICK_DEADZONE     = 0.20; // fraction of outer radius (20%) — ignore tiny moves
    const JOYSTICK_SNAP_8       = true; // snap the stick to 8 directions for arcade feel
    const JOYSTICK_TRAIL_LEN    = 10;   // number of trail samples
    const JOYSTICK_SPRING       = 14;   // spring-back lerp speed (higher = snappier)
    const JOYSTICK_FADE_SPEED   = 5;    // fade-out speed when released

    const FIRE_BUTTON_RADIUS    = 40;   // px (80px diameter)
    const SPECIAL_BUTTON_RADIUS = 30;   // px (60px diameter)
    const PAUSE_BUTTON_RADIUS   = 20;   // px (40px diameter)
    const BUTTON_TOUCH_PADDING  = 20;   // px — extra touch radius beyond visual radius
    const BUTTON_MARGIN         = 34;   // px — margin from screen edges
    const BUTTON_GAP            = 14;   // px — gap between fire and special buttons

    // Charge time for the special weapon. Mirrors Player.js SPECIAL_CHARGE_TIME so the
    // circular charge indicator stays in sync with the actual hyperbeam charge.
    const SPECIAL_CHARGE_TIME = 2.0;    // seconds
    const FIRE_RATE_VISUAL    = 0.15;   // seconds — fire cooldown pulse rate (matches Player.js)

    // Visual style — colors for each control.
    const COLOR_CYAN    = '#00E5FF'; // joystick
    const COLOR_MAGENTA = '#FF00AA'; // fire button
    const COLOR_GOLD    = '#FFD700'; // special button
    const COLOR_PAUSE   = '#00E5FF'; // pause button

    /**
     * Input — single global input manager.
     */
    class Input {
        constructor() {
            // ── Public state ──────────────────────────────────────────────
            /** Currently held keys, keyed by event.code. e.g. this.keys.Space === true */
            this.keys = Object.create(null);

            /** True while the fire control is held (keyboard, touch, or gamepad). */
            this.fire = false;
            /** True while the special control is held (keyboard, touch, or gamepad). */
            this.special = false;

            // ── Movement vectors from each source, combined in getMovement() ──
            this._keyboardMove = { x: 0, y: 0 };
            this._touchMove = { x: 0, y: 0 };
            this._gamepadMove = { x: 0, y: 0 };

            // ── Callback registries ───────────────────────────────────────
            /** @type {Array<Function>} fires once per physical key press (not auto-repeat). */
            this._keyPressCallbacks = [];
            /** @type {Array<Function>} */
            this._touchStartCallbacks = [];
            /** @type {Array<Function>} */
            this._touchMoveCallbacks = [];
            /** @type {Array<Function>} */
            this._touchEndCallbacks = [];

            // ── Touch tracking ────────────────────────────────────────────
            // Multi-touch: we track every active touch by its identifier. Each touch is
            // classified into a "zone" (left = movement joystick, right = buttons) when it
            // starts, so a finger never changes role mid-gesture. Right-zone touches are
            // further assigned to a specific button ('fire' | 'special' | 'pause').
            /** @type {Map<number, {identifier:number, startX:number, startY:number, x:number, y:number, zone:'left'|'right', button:string|null, startTime:number}>} */
            this._activeTouches = new Map();

            // The joystick state we render. `active` is true while a finger is on the left
            // zone; `releasing` is true during the spring-back animation after release.
            this._joystick = {
                active: false,
                releasing: false,
                originX: 0,
                originY: 0,
                knobX: 0,
                knobY: 0,
                vectorX: 0,
                vectorY: 0,
                alpha: 0,        // fade-in / fade-out alpha (0..1)
                trail: []        // recent knob positions for motion-blur trail
            };

            // Touch button states (visual + input). The buttons are always laid out and
            // rendered (semi-transparent when idle); they brighten when pressed.
            this._touchFiring = false;       // a right-zone touch is holding the fire button
            this._touchSpecialHeld = false;   // a right-zone touch is holding the special button

            // ── Gamepad state ─────────────────────────────────────────────
            // Last seen button-pressed booleans, so we can detect *edges* (transitions)
            // rather than re-firing special on every frame the button stays held.
            this._gamepadFireHeld = false;
            this._gamepadSpecialHeld = false;
            this._gamepadStartHeld = false; // for Start/Select edge detection

            // ── Touch overlay (canvas) ────────────────────────────────────
            this._container = document.getElementById('game-container') || document.body;
            this._canvas = document.getElementById('game-canvas');
            this._dpr = Math.min(global.devicePixelRatio || 1, 3);
            this._overlay = null;
            this._octx = null;
            this._rafId = null;
            this._lastRender = 0;

            // Button layout (computed on resize). Each entry: {x, y, r, tr} where r is the
            // visual radius and tr is the touch radius (r + padding).
            this._layout = {
                fire:    { x: 0, y: 0, r: FIRE_BUTTON_RADIUS,    tr: FIRE_BUTTON_RADIUS + BUTTON_TOUCH_PADDING },
                special: { x: 0, y: 0, r: SPECIAL_BUTTON_RADIUS, tr: SPECIAL_BUTTON_RADIUS + BUTTON_TOUCH_PADDING },
                pause:   { x: 0, y: 0, r: PAUSE_BUTTON_RADIUS,   tr: PAUSE_BUTTON_RADIUS + BUTTON_TOUCH_PADDING }
            };

            // Button visual state.
            this._fireState    = { pressed: false, alpha: 0.5, glow: 0 };
            this._specialState = { pressed: false, alpha: 0.5, charge: 0, cooldown: 0, glow: 0, flash: 0 };
            this._pauseState   = { pressed: false, alpha: 0.5 };
            this._fireCooldown = 0;   // visual pulse timer for the fire button

            this._createOverlay();
            this._onResize();         // initial layout + canvas sizing
            this._attachListeners();
            this._lastRender = performance.now();
            this._rafId = requestAnimationFrame(this._renderLoopBound = this._renderLoop.bind(this));
        }

        // ─────────────────────────────────────────────────────────────────
        // Touch overlay setup
        // ─────────────────────────────────────────────────────────────────

        /**
         * Create a second <canvas> stacked on top of the game canvas. It has
         * pointer-events:none so it never intercepts touches (the container handles
         * those); it is purely a render surface for the touch controls.
         */
        _createOverlay() {
            const c = document.createElement('canvas');
            c.id = 'touch-overlay';
            c.style.cssText =
                'display:block;position:fixed;inset:0;width:100vw;height:100vh;' +
                'pointer-events:none;z-index:10;touch-action:none;';
            // Insert into the container so it shares the stacking context. Place it
            // right after the game canvas so the HUD (z-index 20) still draws on top.
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.insertBefore(c, this._canvas.nextSibling);
            } else {
                this._container.appendChild(c);
            }
            this._overlay = c;
            this._octx = c.getContext('2d');
        }

        /** Recompute the overlay canvas size (high-DPI) and the button layout. */
        _onResize() {
            const w = global.innerWidth;
            const h = global.innerHeight;
            this._dpr = Math.min(global.devicePixelRatio || 1, 3);
            if (this._overlay) {
                this._overlay.width = Math.round(w * this._dpr);
                this._overlay.height = Math.round(h * this._dpr);
                this._overlay.style.width = w + 'px';
                this._overlay.style.height = h + 'px';
            }
            this._vw = w;
            this._vh = h;
            this._layoutButtons();
        }

        /**
         * Position the fire, special and pause buttons. Sizes scale down on very small
         * screens and the layout adapts to landscape orientation.
         */
        _layoutButtons() {
            const w = this._vw || global.innerWidth;
            const h = this._vh || global.innerHeight;
            const portrait = h >= w;

            // Scale factor: clamp so controls are usable on small phones but not huge on
            // tablets. Based on the smaller screen dimension.
            const minDim = Math.min(w, h);
            let scale = 1;
            if (minDim < 380) scale = 0.72;
            else if (minDim < 480) scale = 0.82;
            else if (minDim < 640) scale = 0.9;
            else if (minDim > 900) scale = 1.1;
            scale = Math.max(0.7, Math.min(1.2, scale));

            const fireR = FIRE_BUTTON_RADIUS * scale;
            const specR = SPECIAL_BUTTON_RADIUS * scale;
            const pauseR = PAUSE_BUTTON_RADIUS * scale;
            const pad = BUTTON_TOUCH_PADDING * scale;
            const margin = BUTTON_MARGIN * scale;
            const gap = BUTTON_GAP * scale;

            // Fire button: bottom-right.
            const fireX = w - margin - fireR;
            const fireY = h - margin - fireR;

            // Special button: above-left of the fire button (diagonal).
            const specX = fireX - fireR - specR - gap;
            const specY = fireY - fireR - specR - gap;

            // Pause button: top-right, just below the HUD bar.
            const hudH = 56; // approximate HUD top bar height
            const pauseX = w - margin - pauseR;
            const pauseY = (portrait ? hudH + margin : margin) + pauseR;

            this._layout.fire    = { x: fireX,   y: fireY,   r: fireR,   tr: fireR + pad };
            this._layout.special = { x: specX,   y: specY,   r: specR,   tr: specR + pad };
            this._layout.pause  = { x: pauseX,  y: pauseY,   r: pauseR,  tr: pauseR + pad };
        }

        // ─────────────────────────────────────────────────────────────────
        // Listener attach/detach
        // ─────────────────────────────────────────────────────────────────

        _attachListeners() {
            window.addEventListener('keydown', this._onKeyDownBound = this._onKeyDown.bind(this), { passive: false });
            window.addEventListener('keyup', this._onKeyUpBound = this._onKeyUp.bind(this), { passive: false });
            window.addEventListener('blur', this._onBlurBound = this._onBlur.bind(this));
            window.addEventListener('resize', this._onResizeBound = this._onResize.bind(this), { passive: true });
            window.addEventListener('orientationchange', this._onResizeBound);
            window.addEventListener('gamepadconnected', this._onGamepadConnectedBound = this._onGamepadConnected.bind(this));

            // Touch events are attached to the game container. The overlay canvas has
            // pointer-events:none, so touches pass straight through it to the container,
            // which covers the full viewport. We preventDefault to stop scroll/zoom.
            this._onTouchStartBound = this._onTouchStart.bind(this);
            this._onTouchMoveBound = this._onTouchMove.bind(this);
            this._onTouchEndBound = this._onTouchEnd.bind(this);
            this._onContextMenuBound = (e) => e.preventDefault();

            const target = this._container;
            target.addEventListener('touchstart', this._onTouchStartBound, { passive: false });
            target.addEventListener('touchmove', this._onTouchMoveBound, { passive: false });
            target.addEventListener('touchend', this._onTouchEndBound, { passive: false });
            target.addEventListener('touchcancel', this._onTouchEndBound, { passive: false });
            target.addEventListener('contextmenu', this._onContextMenuBound);
        }

        /**
         * Remove all listeners, stop the render loop and release the overlay canvas.
         * Safe to call multiple times.
         */
        destroy() {
            window.removeEventListener('keydown', this._onKeyDownBound);
            window.removeEventListener('keyup', this._onKeyUpBound);
            window.removeEventListener('blur', this._onBlurBound);
            window.removeEventListener('resize', this._onResizeBound);
            window.removeEventListener('orientationchange', this._onResizeBound);
            window.removeEventListener('gamepadconnected', this._onGamepadConnectedBound);

            const target = this._container;
            target.removeEventListener('touchstart', this._onTouchStartBound);
            target.removeEventListener('touchmove', this._onTouchMoveBound);
            target.removeEventListener('touchend', this._onTouchEndBound);
            target.removeEventListener('touchcancel', this._onTouchEndBound);
            target.removeEventListener('contextmenu', this._onContextMenuBound);

            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
            if (this._overlay && this._overlay.parentNode) {
                this._overlay.parentNode.removeChild(this._overlay);
            }
            this._overlay = null;
            this._octx = null;

            this._keyPressCallbacks.length = 0;
            this._touchStartCallbacks.length = 0;
            this._touchMoveCallbacks.length = 0;
            this._touchEndCallbacks.length = 0;
            this._activeTouches.clear();
            this.keys = Object.create(null);
            this.fire = false;
            this.special = false;
        }

        // ─────────────────────────────────────────────────────────────────
        // Callback registration
        // ─────────────────────────────────────────────────────────────────

        /**
         * Register a callback fired exactly once per physical key press (no auto-repeat).
         * Callback receives the KeyboardEvent (with .code, .key, etc.).
         * @param {(e: KeyboardEvent) => void} callback
         */
        onKeyPress(callback) {
            if (typeof callback === 'function') {
                this._keyPressCallbacks.push(callback);
            }
            return this;
        }

        /** Register a touchstart callback. Receives (touchState). */
        onTouchStart(callback) {
            if (typeof callback === 'function') this._touchStartCallbacks.push(callback);
            return this;
        }

        /** Register a touchmove callback. Receives (touchState). */
        onTouchMove(callback) {
            if (typeof callback === 'function') this._touchMoveCallbacks.push(callback);
            return this;
        }

        /** Register a touchend callback. Receives (touchState). */
        onTouchEnd(callback) {
            if (typeof callback === 'function') this._touchEndCallbacks.push(callback);
            return this;
        }

        // ─────────────────────────────────────────────────────────────────
        // Keyboard
        // ─────────────────────────────────────────────────────────────────

        _onKeyDown(e) {
            // Prevent default browser behavior on game keys (arrow scrolling, space
            // page-scroll, etc.). This is why the listener is registered non-passive.
            if (GAME_KEY_CODES.indexOf(e.code) !== -1) {
                e.preventDefault();
            }

            // Ignore the auto-repeat keydown events the OS fires while a key is held.
            // `e.repeat` is true for the synthetic repeats. We already track the held
            // state ourselves in `this.keys`, so we don't need the repeats — and
            // acting on them would cause jittery fire rates and doubled movement.
            if (e.repeat) return;

            // First physical press of this key.
            this.keys[e.code] = true;

            // Dispatch one-shot key-press callbacks (UI, pause toggle, start, etc.).
            for (let i = 0; i < this._keyPressCallbacks.length; i++) {
                this._keyPressCallbacks[i](e);
            }

            this._syncKeyboardState();
        }

        _onKeyUp(e) {
            if (GAME_KEY_CODES.indexOf(e.code) !== -1) {
                e.preventDefault();
            }
            this.keys[e.code] = false;
            this._syncKeyboardState();
        }

        /**
         * Recompute the keyboard-derived movement/fire/special booleans from `this.keys`.
         * Called whenever a key transitions.
         */
        _syncKeyboardState() {
            // Movement: arrows. X axis and Y axis are independent so diagonal works.
            let x = 0, y = 0;
            if (this.keys[KEY.ARROW_LEFT])  x -= 1;
            if (this.keys[KEY.ARROW_RIGHT]) x += 1;
            if (this.keys[KEY.ARROW_UP])    y -= 1; // screen-up = negative Y (matches canvas coords)
            if (this.keys[KEY.ARROW_DOWN]) y += 1;

            // Normalize diagonal so the vector magnitude never exceeds 1.
            this._keyboardMove = normalize2D(x, y);

            this._recomputeAggregate();
        }

        // ─────────────────────────────────────────────────────────────────
        // Window blur — clear all held state so keys don't "stick" when focus is lost
        // ─────────────────────────────────────────────────────────────────

        _onBlur() {
            // If the user alt-tabs while holding a key, the keyup may never arrive.
            // Wipe everything on blur to avoid the ship drifting forever.
            this.keys = Object.create(null);
            this._keyboardMove = { x: 0, y: 0 };
            this._activeTouches.clear();
            this._joystick.active = false;
            this._joystick.releasing = false;
            this._joystick.vectorX = 0;
            this._joystick.vectorY = 0;
            this._joystick.alpha = 0;
            this._joystick.trail.length = 0;
            this._touchMove = { x: 0, y: 0 };
            this._touchFiring = false;
            this._touchSpecialHeld = false;
            this._fireState.pressed = false;
            this._specialState.pressed = false;
            this._pauseState.pressed = false;
            this._gamepadFireHeld = false;
            this._gamepadSpecialHeld = false;
            this._gamepadStartHeld = false;
            this._gamepadMove = { x: 0, y: 0 };
            this._recomputeAggregate();
        }

        // ─────────────────────────────────────────────────────────────────
        // Touch
        // ─────────────────────────────────────────────────────────────────

        /** Convert a Touch clientX/clientY to container-local coordinates. */
        _toLocal(clientX, clientY) {
            const rect = this._container.getBoundingClientRect();
            return { x: clientX - rect.left, y: clientY - rect.top, w: rect.width, h: rect.height };
        }

        /**
         * Decide which right-side button (if any) a touch lands on. Returns
         * 'fire' | 'special' | 'pause' | null. A touch that hits no specific button
         * defaults to 'fire' so the right side keeps the familiar "tap to shoot" feel.
         */
        _hitTestButton(x, y) {
            const L = this._layout;
            let best = null;
            let bestDist = Infinity;
            const candidates = ['special', 'pause', 'fire'];
            for (let i = 0; i < candidates.length; i++) {
                const name = candidates[i];
                const b = L[name];
                const d = Math.hypot(x - b.x, y - b.y);
                if (d <= b.tr && d < bestDist) {
                    bestDist = d;
                    best = name;
                }
            }
            // Fallback: any right-zone touch not on a specific button fires.
            return best || 'fire';
        }

        _onTouchStart(e) {
            // Don't intercept touches on UI elements (buttons, screens).
            // On iOS, preventDefault() on touchstart cancels the click event,
            // which means the START button, sound toggle, etc. won't fire.
            if (e.target && (e.target.closest('.screen') || e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
                return;
            }

            // For game-area touches, preventDefault to stop scroll/zoom/callout gestures.
            e.preventDefault();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const p = this._toLocal(t.clientX, t.clientY);

                // Decide zone by the container X midpoint.
                const zone = (p.x < p.w / 2) ? 'left' : 'right';

                const record = {
                    identifier: t.identifier,
                    startX: p.x,
                    startY: p.y,
                    x: p.x,
                    y: p.y,
                    zone: zone,
                    button: null,
                    startTime: performance.now()
                };
                this._activeTouches.set(t.identifier, record);

                if (zone === 'left') {
                    // Spawn the floating joystick at the touch point — players get the
                    // stick wherever they place their thumb, the modern mobile idiom.
                    this._joystick.active = true;
                    this._joystick.releasing = false;
                    this._joystick.originX = p.x;
                    this._joystick.originY = p.y;
                    this._joystick.knobX = p.x;
                    this._joystick.knobY = p.y;
                    this._joystick.vectorX = 0;
                    this._joystick.vectorY = 0;
                    this._joystick.alpha = 1;
                    this._joystick.trail.length = 0;
                } else {
                    // Right zone: hit-test against the buttons.
                    const btn = this._hitTestButton(p.x, p.y);
                    record.button = btn;
                    this._pressButton(btn, true);
                }
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchStartCallbacks);
        }

        _onTouchMove(e) {
            if (e.target && (e.target.closest('.screen') || e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
                return;
            }
            e.preventDefault();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const record = this._activeTouches.get(t.identifier);
                if (!record) continue;

                const p = this._toLocal(t.clientX, t.clientY);
                record.x = p.x;
                record.y = p.y;

                if (record.zone === 'left') {
                    this._updateJoystick(record);
                }
                // Button touches don't need to track movement — once a finger is assigned
                // to a button it stays on that button until lift, regardless of drift.
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchMoveCallbacks);
        }

        _onTouchEnd(e) {
            if (e.target && (e.target.closest('.screen') || e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
                return;
            }
            e.preventDefault();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const record = this._activeTouches.get(t.identifier);
                if (!record) continue;

                if (record.zone === 'left') {
                    // Release the joystick: start the spring-back animation rather than
                    // hiding instantly. The render loop lerps the knob back to the origin
                    // and fades out, then clears `active`.
                    if (this._joystick.active) {
                        this._joystick.releasing = true;
                        this._joystick.active = false;
                    }
                    this._joystick.vectorX = 0;
                    this._joystick.vectorY = 0;
                    this._touchMove = { x: 0, y: 0 };
                } else {
                    // Button released.
                    this._pressButton(record.button, false);
                }

                this._activeTouches.delete(t.identifier);
            }

            // Reconcile button pressed states with remaining touches (multi-touch safety).
            let anyFire = false, anySpecial = false;
            this._activeTouches.forEach((r) => {
                if (r.zone === 'right') {
                    if (r.button === 'fire') anyFire = true;
                    else if (r.button === 'special') anySpecial = true;
                }
            });
            if (!anyFire) { this._touchFiring = false; this._fireState.pressed = false; }
            if (!anySpecial) { this._touchSpecialHeld = false; this._specialState.pressed = false; }

            // If no left-zone touches remain, ensure the joystick begins releasing.
            let anyLeft = false;
            this._activeTouches.forEach((r) => { if (r.zone === 'left') anyLeft = true; });
            if (!anyLeft && this._joystick.active) {
                this._joystick.releasing = true;
                this._joystick.active = false;
                this._joystick.vectorX = 0;
                this._joystick.vectorY = 0;
                this._touchMove = { x: 0, y: 0 };
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchEndCallbacks);
        }

        /**
         * Apply/clear a button press and fire haptics / one-shot actions.
         */
        _pressButton(name, pressed) {
            if (name === 'fire') {
                this._touchFiring = pressed;
                this._fireState.pressed = pressed;
                if (pressed) {
                    this._vibrate(10);
                    this._fireState.alpha = 1;
                }
            } else if (name === 'special') {
                this._touchSpecialHeld = pressed;
                this._specialState.pressed = pressed;
                if (pressed) {
                    this._vibrate(10);
                    this._specialState.alpha = 1;
                    // Reset the visual charge when a new charge begins.
                    if (this._specialState.charge >= 1) this._specialState.charge = 0;
                    this._specialState.cooldown = 0;
                } else {
                    // Released: if it was fully charged, trigger the fire flash/cooldown.
                    if (this._specialState.charge >= 1) {
                        this._specialState.flash = 1;
                        this._specialState.cooldown = 0.45;
                        this._vibrate(30);
                    }
                    this._specialState.charge = 0;
                }
            } else if (name === 'pause') {
                this._pauseState.pressed = pressed;
                if (pressed) {
                    this._vibrate(10);
                    // Dispatch a synthetic KeyP press so the game's pause toggle handles it
                    // uniformly (same path as the keyboard and gamepad start button).
                    this._dispatchSyntheticKey(KEY.KEY_P, 'p');
                }
            }
        }

        /**
         * Update the virtual joystick from a left-zone touch record.
         * Applies a centered dead zone, clamps the knob to the outer ring, optionally
         * snaps to 8 directions, and produces a normalized analog vector.
         */
        _updateJoystick(record) {
            let dx = record.x - this._joystick.originX;
            let dy = record.y - this._joystick.originY;
            let dist = Math.hypot(dx, dy);

            const R = JOYSTICK_OUTER_RADIUS;
            const deadPx = JOYSTICK_DEADZONE * R;

            // Inside the dead zone: zero output, knob rests at the center.
            if (dist < deadPx) {
                this._joystick.knobX = this._joystick.originX;
                this._joystick.knobY = this._joystick.originY;
                this._joystick.vectorX = 0;
                this._joystick.vectorY = 0;
                this._touchMove = { x: 0, y: 0 };
                return;
            }

            // Clamp the knob to the outer ring.
            if (dist > R) {
                const s = R / dist;
                dx *= s;
                dy *= s;
                dist = R;
            }

            // 8-directional snap: project the deflection onto the nearest of 8 axes so
            // the stick (and the resulting movement) locks to cardinal/diagonal dirs.
            if (JOYSTICK_SNAP_8) {
                const step = Math.PI / 4;
                const angle = Math.atan2(dy, dx);
                const snapped = Math.round(angle / step) * step;
                dx = Math.cos(snapped) * dist;
                dy = Math.sin(snapped) * dist;
            }

            this._joystick.knobX = this._joystick.originX + dx;
            this._joystick.knobY = this._joystick.originY + dy;

            // Remap the magnitude so the dead-zone edge -> 0 and the outer ring -> 1.
            let mag = (dist / R - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE);
            if (mag < 0) mag = 0; else if (mag > 1) mag = 1;

            const nx = (dx / dist) * mag;
            const ny = (dy / dist) * mag;
            this._joystick.vectorX = nx;
            this._joystick.vectorY = ny;
            this._touchMove = { x: nx, y: ny };
        }

        /**
         * Build a serializable snapshot of the current touch state for callbacks.
         */
        _buildTouchState() {
            return {
                joystick: {
                    active: this._joystick.active,
                    originX: this._joystick.originX,
                    originY: this._joystick.originY,
                    knobX: this._joystick.knobX,
                    knobY: this._joystick.knobY,
                    vectorX: this._joystick.vectorX,
                    vectorY: this._joystick.vectorY
                },
                firing: this._touchFiring,
                special: this._touchSpecialHeld,
                activeCount: this._activeTouches.size
            };
        }

        _dispatchTouch(callbacks) {
            const state = this._buildTouchState();
            for (let i = 0; i < callbacks.length; i++) callbacks[i](state);
        }

        /**
         * Synthesise a key-press event and dispatch it to all registered one-shot
         * key-press callbacks. Used by touch buttons (pause) so the game's existing
         * keyboard plumbing handles them uniformly.
         */
        _dispatchSyntheticKey(code, key) {
            const fakeEvent = {
                code: code,
                key: key,
                repeat: false,
                synthetic: true,
                preventDefault: () => {}
            };
            for (let i = 0; i < this._keyPressCallbacks.length; i++) {
                this._keyPressCallbacks[i](fakeEvent);
            }
        }

        /** Trigger haptic feedback if the platform supports it. */
        _vibrate(ms) {
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
                try { navigator.vibrate(ms); } catch (e) { /* not supported — ignore */ }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Gamepad
        // ─────────────────────────────────────────────────────────────────

        _onGamepadConnected(e) {
            // Intentionally minimal — we just log. Polling in update() handles the rest.
            if (global.console) {
                console.log('[Input] Gamepad connected: ' + (e.gamepad && e.gamepad.id));
            }
        }

        /**
         * Poll gamepads once per frame. The Gamepad API is poll-based: there are no
         * events for button/axis changes, so the game loop must call this.
         */
        update() {
            const pads = (navigator.getGamepads && navigator.getGamepads())
                ? navigator.getGamepads()
                : [];
            let pad = null;
            for (let i = 0; i < pads.length; i++) {
                if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
            }
            if (!pad) {
                // No gamepad — clear gamepad contributions so they don't linger.
                if (this._gamepadMove.x !== 0 || this._gamepadMove.y !== 0 ||
                    this._gamepadFireHeld || this._gamepadSpecialHeld) {
                    this._gamepadMove = { x: 0, y: 0 };
                    this._gamepadFireHeld = false;
                    this._gamepadSpecialHeld = false;
                    this._recomputeAggregate();
                }
                return;
            }

            // ── Left analog stick (movement) ──
            // Standard mapping: axes[0] = horizontal, axes[1] = vertical.
            let lx = 0, ly = 0;
            if (pad.axes.length >= 2) {
                lx = applyDeadzone(pad.axes[0], DEADZONE_GAMEPAD);
                ly = applyDeadzone(pad.axes[1], DEADZONE_GAMEPAD);
            }
            // Also honor the D-pad for movement (buttons 12-15 in the standard mapping).
            if (pad.buttons[12] && pad.buttons[12].pressed) ly = -1; // up
            if (pad.buttons[13] && pad.buttons[13].pressed) ly = 1;  // down
            if (pad.buttons[14] && pad.buttons[14].pressed) lx = -1; // left
            if (pad.buttons[15] && pad.buttons[15].pressed) lx = 1;  // right
            this._gamepadMove = normalize2D(lx, ly);

            // ── Fire (button 0 = A / face bottom) ──
            const firePressed = !!(pad.buttons[0] && pad.buttons[0].pressed);
            this._gamepadFireHeld = firePressed;

            // ── Special (button 1 = B / face right, or button 2 = X / face left) ──
            const specialPressed =
                (pad.buttons[1] && pad.buttons[1].pressed) ||
                (pad.buttons[2] && pad.buttons[2].pressed);
            this._gamepadSpecialHeld = specialPressed;

            // ── Start / Pause (button 9 = Start, or button 8 = Select/Back) ──
            // Fire as a one-shot key press so the game's pause toggle works.
            const startPressed = !!(pad.buttons[9] && pad.buttons[9].pressed);
            const selectPressed = !!(pad.buttons[8] && pad.buttons[8].pressed);
            if ((startPressed || selectPressed) && !this._gamepadStartHeld) {
                this._dispatchSyntheticKey(
                    startPressed ? KEY.ENTER : KEY.KEY_P,
                    startPressed ? 'Enter' : 'p'
                );
            }
            this._gamepadStartHeld = startPressed || selectPressed;

            this._recomputeAggregate();
        }

        // ─────────────────────────────────────────────────────────────────
        // Aggregate state computation
        // ─────────────────────────────────────────────────────────────────

        /**
         * Combine all input sources into the public `this.fire` / `this.special`
         * booleans. (Movement is combined on the fly in getMovement() so each source
         * can contribute independently without one zeroing the other.)
         */
        _recomputeAggregate() {
            this.fire =
                !!this.keys[KEY.SPACE] ||
                this._touchFiring ||
                this._gamepadFireHeld;

            this.special =
                !!this.keys[KEY.KEY_Z] ||
                this._touchSpecialHeld ||
                this._gamepadSpecialHeld;
        }

        // ─────────────────────────────────────────────────────────────────
        // Public query API
        // ─────────────────────────────────────────────────────────────────

        /**
         * Return the combined movement vector from keyboard + touch + gamepad.
         * Each component is in [-1, 1]. Sources are summed and then clamped, so
         * holding left on the keyboard and right on the stick results in net-zero
         * rather than one source silently overriding the other.
         * @returns {{x:number, y:number}}
         */
        getMovement() {
            let x = this._keyboardMove.x + this._touchMove.x + this._gamepadMove.x;
            let y = this._keyboardMove.y + this._touchMove.y + this._gamepadMove.y;
            // Clamp each axis to [-1, 1].
            if (x > 1) x = 1; else if (x < -1) x = -1;
            if (y > 1) y = 1; else if (y < -1) y = -1;
            return { x: x, y: y };
        }

        /**
         * Get a snapshot of the virtual joystick for external rendering.
         * Returns null when the joystick is not active (and not in release animation).
         * @returns {{originX:number, originY:number, knobX:number, knobY:number, vectorX:number, vectorY:number, alpha:number}|null}
         */
        getJoystick() {
            if (!this._joystick.active && !this._joystick.releasing) return null;
            return {
                originX: this._joystick.originX,
                originY: this._joystick.originY,
                knobX: this._joystick.knobX,
                knobY: this._joystick.knobY,
                vectorX: this._joystick.vectorX,
                vectorY: this._joystick.vectorY,
                alpha: this._joystick.alpha
            };
        }

        /**
         * Get the current special-weapon charge progress (0..1) for the touch UI.
         * This mirrors the player's charge by tracking how long `this.special` has
         * been continuously held.
         * @returns {number}
         */
        getSpecialCharge() {
            return this._specialState.charge;
        }

        // ─────────────────────────────────────────────────────────────────
        // Touch overlay render loop
        // ─────────────────────────────────────────────────────────────────

        _renderLoop() {
            this._rafId = requestAnimationFrame(this._renderLoopBound);
            const now = performance.now();
            const dt = Math.min(0.05, (now - this._lastRender) / 1000);
            this._lastRender = now;

            this._updateAnimations(dt);
            this._draw();
        }

        /**
         * Advance all touch-UI animations: joystick spring-back + trail, button alpha
         * easing, fire cooldown pulse, special charge accumulation / flash.
         */
        _updateAnimations(dt) {
            const j = this._joystick;

            // ── Joystick fade / spring-back ──
            if (j.active) {
                // Fade in to full.
                if (j.alpha < 1) j.alpha = Math.min(1, j.alpha + dt * JOYSTICK_FADE_SPEED * 2);
                // Record a trail sample.
                j.trail.push({ x: j.knobX, y: j.knobY });
                if (j.trail.length > JOYSTICK_TRAIL_LEN) j.trail.shift();
            } else if (j.releasing) {
                // Spring the knob back to the origin.
                const kx = j.knobX, ky = j.knobY;
                j.knobX += (j.originX - kx) * Math.min(1, dt * JOYSTICK_SPRING);
                j.knobY += (j.originY - ky) * Math.min(1, dt * JOYSTICK_SPRING);
                // Fade out.
                j.alpha -= dt * JOYSTICK_FADE_SPEED;
                if (j.alpha <= 0 || Math.hypot(j.knobX - j.originX, j.knobY - j.originY) < 0.5) {
                    j.releasing = false;
                    j.alpha = 0;
                    j.trail.length = 0;
                }
            } else {
                j.alpha = 0;
                if (j.trail.length) j.trail.length = 0;
            }

            // ── Special charge (mirrors Player.js: charge while this.special is held) ──
            if (this.special && this._specialState.cooldown <= 0) {
                this._specialState.charge += dt / SPECIAL_CHARGE_TIME;
                if (this._specialState.charge > 1) this._specialState.charge = 1;
            } else if (!this.special && this._specialState.charge > 0 && this._specialState.cooldown <= 0) {
                // Released without full charge (e.g. keyboard Z tap) — reset the visual.
                if (this._specialState.charge < 1) this._specialState.charge = 0;
            }
            if (this._specialState.cooldown > 0) {
                this._specialState.cooldown = Math.max(0, this._specialState.cooldown - dt);
            }
            if (this._specialState.flash > 0) {
                this._specialState.flash = Math.max(0, this._specialState.flash - dt * 2.5);
            }

            // ── Button alpha easing (idle 0.5, pressed 1.0) ──
            const easeAlpha = (state, target, speed) => {
                const dir = target - state.alpha;
                if (Math.abs(dir) < 0.01) state.alpha = target;
                else state.alpha += dir * Math.min(1, dt * speed);
            };
            easeAlpha(this._fireState, this._fireState.pressed ? 1.0 : 0.5, 10);
            easeAlpha(this._specialState, this._specialState.pressed ? 1.0 :
                (this._specialState.charge >= 1 ? 0.85 : 0.5), 10);
            easeAlpha(this._pauseState, this._pauseState.pressed ? 1.0 : 0.5, 12);

            // ── Glow phase oscillators ──
            this._fireState.glow += dt * 3;
            this._specialState.glow += dt * (this._specialState.charge >= 1 ? 6 : 2);

            // ── Fire cooldown pulse ──
            if (this.fire) {
                this._fireCooldown += dt;
                if (this._fireCooldown > FIRE_RATE_VISUAL) this._fireCooldown -= FIRE_RATE_VISUAL;
            } else {
                this._fireCooldown = 0;
            }
        }

        /** Draw the entire touch UI for this frame. */
        _draw() {
            const ctx = this._octx;
            if (!ctx) return;
            const dpr = this._dpr;
            const W = this._vw;
            const H = this._vh;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);

            // Joystick (only when active or releasing).
            this._drawJoystick(ctx);

            // Buttons.
            this._drawFireButton(ctx);
            this._drawSpecialButton(ctx);
            this._drawPauseButton(ctx);
        }

        _drawJoystick(ctx) {
            const j = this._joystick;
            if (j.alpha <= 0.01) return;
            const a = j.alpha;

            // ── Motion-blur trail ──
            const trail = j.trail;
            for (let i = 0; i < trail.length; i++) {
                const p = trail[i];
                const f = (i + 1) / trail.length; // 0..1, newest brightest
                const ta = a * f * 0.35;
                const tr = JOYSTICK_KNOB_RADIUS * (0.5 + 0.5 * f);
                ctx.save();
                ctx.globalAlpha = ta;
                ctx.fillStyle = COLOR_CYAN;
                ctx.shadowColor = COLOR_CYAN;
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(p.x, p.y, tr, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // ── Outer ring ──
            ctx.save();
            ctx.globalAlpha = a * 0.5;
            ctx.strokeStyle = COLOR_CYAN;
            ctx.lineWidth = 3;
            ctx.shadowColor = COLOR_CYAN;
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.arc(j.originX, j.originY, JOYSTICK_OUTER_RADIUS, 0, Math.PI * 2);
            ctx.stroke();
            // Inner dead-zone ring (subtle).
            ctx.globalAlpha = a * 0.18;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(j.originX, j.originY, JOYSTICK_OUTER_RADIUS * JOYSTICK_DEADZONE, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            // ── Knob ──
            ctx.save();
            ctx.globalAlpha = a;
            ctx.shadowColor = COLOR_CYAN;
            ctx.shadowBlur = 22;
            // Glow gradient fill.
            const grad = ctx.createRadialGradient(j.knobX, j.knobY, 2, j.knobX, j.knobY, JOYSTICK_KNOB_RADIUS);
            grad.addColorStop(0, 'rgba(0,229,255,1)');
            grad.addColorStop(0.6, 'rgba(0,229,255,0.85)');
            grad.addColorStop(1, 'rgba(0,180,230,0.4)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(j.knobX, j.knobY, JOYSTICK_KNOB_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            // Bright rim.
            ctx.globalAlpha = a * 0.9;
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1.5;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(j.knobX, j.knobY, JOYSTICK_KNOB_RADIUS, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        _drawFireButton(ctx) {
            const b = this._layout.fire;
            const s = this._fireState;
            const pulse = 0.5 + 0.5 * Math.sin(s.glow);

            ctx.save();
            // Pulsing glow ring (always, stronger when pressed).
            ctx.globalAlpha = s.alpha * (0.35 + 0.25 * pulse);
            ctx.strokeStyle = COLOR_MAGENTA;
            ctx.lineWidth = 3;
            ctx.shadowColor = COLOR_MAGENTA;
            ctx.shadowBlur = s.pressed ? 30 : 16;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r + 6 + (s.pressed ? 4 * pulse : 0), 0, Math.PI * 2);
            ctx.stroke();

            // Main button body.
            ctx.globalAlpha = s.alpha;
            const grad = ctx.createRadialGradient(b.x, b.y, 2, b.x, b.y, b.r);
            if (s.pressed) {
                grad.addColorStop(0, 'rgba(255,0,170,0.9)');
                grad.addColorStop(1, 'rgba(255,0,170,0.35)');
            } else {
                grad.addColorStop(0, 'rgba(255,0,170,0.4)');
                grad.addColorStop(1, 'rgba(255,0,170,0.15)');
            }
            ctx.fillStyle = grad;
            ctx.shadowColor = COLOR_MAGENTA;
            ctx.shadowBlur = s.pressed ? 26 : 10;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();

            // Rim.
            ctx.globalAlpha = s.alpha * 0.9;
            ctx.strokeStyle = s.pressed ? '#FFFFFF' : COLOR_MAGENTA;
            ctx.lineWidth = 2;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.stroke();

            // Cooldown pulse: an arc that sweeps with the fire rate while firing.
            if (this.fire) {
                const frac = this._fireCooldown / FIRE_RATE_VISUAL;
                ctx.globalAlpha = 0.5;
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 3;
                ctx.shadowColor = COLOR_MAGENTA;
                ctx.shadowBlur = 14;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r - 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
                ctx.stroke();
            }

            // FIRE label.
            ctx.globalAlpha = s.alpha * 0.9;
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold ' + Math.round(b.r * 0.42) + "px 'Trebuchet MS', sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowBlur = 0;
            ctx.fillText('FIRE', b.x, b.y);
            ctx.restore();
        }

        _drawSpecialButton(ctx) {
            const b = this._layout.special;
            const s = this._specialState;
            const charged = s.charge >= 1 && s.cooldown <= 0;
            const pulse = 0.5 + 0.5 * Math.sin(s.glow);

            ctx.save();

            // Ready glow when fully charged.
            if (charged) {
                ctx.globalAlpha = 0.4 + 0.4 * pulse;
                ctx.strokeStyle = COLOR_GOLD;
                ctx.lineWidth = 4;
                ctx.shadowColor = COLOR_GOLD;
                ctx.shadowBlur = 28 + 10 * pulse;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r + 8 + 4 * pulse, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Main button body.
            ctx.globalAlpha = s.alpha;
            const grad = ctx.createRadialGradient(b.x, b.y, 2, b.x, b.y, b.r);
            if (s.pressed) {
                grad.addColorStop(0, 'rgba(255,215,0,0.95)');
                grad.addColorStop(1, 'rgba(255,215,0,0.35)');
            } else if (charged) {
                grad.addColorStop(0, 'rgba(255,235,120,0.7)');
                grad.addColorStop(1, 'rgba(255,215,0,0.25)');
            } else {
                grad.addColorStop(0, 'rgba(255,215,0,0.4)');
                grad.addColorStop(1, 'rgba(255,215,0,0.12)');
            }
            ctx.fillStyle = grad;
            ctx.shadowColor = COLOR_GOLD;
            ctx.shadowBlur = charged ? 24 : (s.pressed ? 26 : 10);
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();

            // Charge progress ring (clockwise).
            if (!charged && s.cooldown <= 0) {
                ctx.globalAlpha = s.alpha;
                ctx.strokeStyle = COLOR_GOLD;
                ctx.lineWidth = 4;
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r - 3, -Math.PI / 2,
                        -Math.PI / 2 + Math.PI * 2 * s.charge);
                ctx.stroke();
            }

            // Cooldown sweep after firing.
            if (s.cooldown > 0) {
                const frac = s.cooldown / 0.45;
                ctx.globalAlpha = 0.6;
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 3;
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r - 3, -Math.PI / 2,
                        -Math.PI / 2 + Math.PI * 2 * (1 - frac));
                ctx.stroke();
            }

            // Flash on fire.
            if (s.flash > 0) {
                ctx.globalAlpha = s.flash * 0.6;
                ctx.fillStyle = '#FFFFFF';
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
                ctx.fill();
            }

            // Rim.
            ctx.globalAlpha = s.alpha * 0.9;
            ctx.strokeStyle = s.pressed ? '#FFFFFF' : COLOR_GOLD;
            ctx.lineWidth = 2;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.stroke();

            // SPECIAL label / icon.
            ctx.globalAlpha = s.alpha * 0.95;
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold ' + Math.round(b.r * 0.30) + "px 'Trebuchet MS', sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SPECIAL', b.x, b.y);
            ctx.restore();
        }

        _drawPauseButton(ctx) {
            const b = this._layout.pause;
            const s = this._pauseState;

            ctx.save();
            ctx.globalAlpha = s.alpha;
            ctx.fillStyle = 'rgba(0,229,255,0.25)';
            ctx.strokeStyle = s.pressed ? '#FFFFFF' : COLOR_PAUSE;
            ctx.lineWidth = 2;
            ctx.shadowColor = COLOR_PAUSE;
            ctx.shadowBlur = s.pressed ? 18 : 8;
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Two-bar pause icon.
            ctx.globalAlpha = s.alpha;
            ctx.fillStyle = s.pressed ? '#FFFFFF' : COLOR_PAUSE;
            ctx.shadowBlur = 0;
            const bw = Math.max(3, b.r * 0.18);
            const bh = b.r * 0.5;
            const gap = bw * 0.8;
            ctx.fillRect(b.x - gap / 2 - bw, b.y - bh / 2, bw, bh);
            ctx.fillRect(b.x + gap / 2, b.y - bh / 2, bw, bh);
            ctx.restore();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Small math helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Normalize a 2D vector so its magnitude never exceeds 1, but leave small
     * vectors alone (so a single-axis press yields exactly 1.0 on that axis and
     * 0.0 on the other, rather than a tiny diagonal). If both components are zero,
     * returns {0, 0}.
     */
    function normalize2D(x, y) {
        const mag = Math.hypot(x, y);
        if (mag === 0) return { x: 0, y: 0 };
        if (mag <= 1) {
            // Sub-unit vector — keep it as-is so the joystick's analog range works.
            return { x: x, y: y };
        }
        return { x: x / mag, y: y / mag };
    }

    /** Apply a centered deadzone to an analog axis value in [-1, 1]. */
    function applyDeadzone(value, deadzone) {
        if (value > -deadzone && value < deadzone) return 0;
        const sign = value < 0 ? -1 : 1;
        const magnitude = Math.abs(value);
        // Remap [deadzone, 1] -> [0, 1].
        return sign * (magnitude - deadzone) / (1 - deadzone);
    }

    // Expose globally.
    global.Input = Input;
})(typeof window !== 'undefined' ? window : this);
