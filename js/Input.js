/**
 * Input.js — Input handler for Galaxy Reborn
 *
 * A unified input system handling:
 *   - Keyboard (arrows, space, Z, P, Enter) with held-key tracking and no OS key-repeat issues
 *   - Touch / mobile (virtual joystick on left half, tap-and-hold to fire on right half, swipe-down for special)
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
 *   input.destroy()       -> remove all DOM listeners and release resources
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

    // ─── Tunables ─────────────────────────────────────────────────────────
    const JOYSTICK_MAX_RADIUS = 60;   // px — max travel of the virtual joystick nub
    const DEADZONE_TOUCH = 8;         // px — ignore tiny movements near the touch origin
    const DEADZONE_GAMEPAD = 0.18;    // 0..1 — ignore small stick deflections
    const SWIPE_DOWN_THRESHOLD = 80;  // px — vertical distance to count as a "swipe down" special
    const SWIPE_DOWN_TIME_MS = 500;   // ms — swipe must happen within this window to count

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
            // classified into a "zone" (left = movement joystick, right = fire) when it
            // starts, so a finger never changes role mid-gesture.
            /** @type {Map<number, {identifier:number, startX:number, startY:number, x:number, y:number, zone:'left'|'right', startTime:number}>} */
            this._activeTouches = new Map();

            // The joystick state we render. `null` when no finger is on the left zone.
            this._joystick = {
                active: false,
                originX: 0,
                originY: 0,
                knobX: 0,
                knobY: 0,
                vectorX: 0,
                vectorY: 0
            };

            // Track whether the right-side touch is currently firing.
            this._touchFiring = false;

            // Track a potential swipe-down for special weapon on the right zone.
            this._rightSwipeStart = null; // {x, y, time}

            // ── Gamepad state ─────────────────────────────────────────────
            // Last seen button-pressed booleans, so we can detect *edges* (transitions)
            // rather than re-firing special on every frame the button stays held.
            this._gamepadFireHeld = false;
            this._gamepadSpecialHeld = false;
            this._gamepadStartHeld = false; // for Start/Select edge detection

            // ── Bound handlers (kept as references so we can remove them) ──
            this._onKeyDownBound = this._onKeyDown.bind(this);
            this._onKeyUpBound = this._onKeyUp.bind(this);
            this._onTouchStartBound = this._onTouchStart.bind(this);
            this._onTouchMoveBound = this._onTouchMove.bind(this);
            this._onTouchEndBound = this._onTouchEnd.bind(this);
            this._onBlurBound = this._onBlur.bind(this);
            this._onContextMenuBound = (e) => e.preventDefault();
            this._onGamepadConnectedBound = this._onGamepadConnected.bind(this);

            // ── DOM target ────────────────────────────────────────────────
            // We listen on window for keyboard (so the page always gets input regardless
            // of focus) and on the canvas for touch (so we get the right coordinates and
            // can preventDefault to stop scrolling/zooming).
            this._canvas = document.getElementById('game-canvas');

            this._attachListeners();
        }

        // ─────────────────────────────────────────────────────────────────
        // Listener attach/detach
        // ─────────────────────────────────────────────────────────────────

        _attachListeners() {
            window.addEventListener('keydown', this._onKeyDownBound, { passive: false });
            window.addEventListener('keyup', this._onKeyUpBound, { passive: false });
            window.addEventListener('blur', this._onBlurBound);
            window.addEventListener('gamepadconnected', this._onGamepadConnectedBound);

            if (this._canvas) {
                // touchstart/touchmove must be non-passive so we can call preventDefault()
                // to suppress the browser's scroll/zoom/double-tap-zoom on touch.
                this._canvas.addEventListener('touchstart', this._onTouchStartBound, { passive: false });
                this._canvas.addEventListener('touchmove', this._onTouchMoveBound, { passive: false });
                this._canvas.addEventListener('touchend', this._onTouchEndBound, { passive: false });
                this._canvas.addEventListener('touchcancel', this._onTouchEndBound, { passive: false });
                this._canvas.addEventListener('contextmenu', this._onContextMenuBound);
            } else {
                // Fallback: if the canvas isn't present yet, listen on document.body.
                document.addEventListener('touchstart', this._onTouchStartBound, { passive: false });
                document.addEventListener('touchmove', this._onTouchMoveBound, { passive: false });
                document.addEventListener('touchend', this._onTouchEndBound, { passive: false });
                document.addEventListener('touchcancel', this._onTouchEndBound, { passive: false });
            }
        }

        /**
         * Remove all listeners and clear state. Safe to call multiple times.
         */
        destroy() {
            window.removeEventListener('keydown', this._onKeyDownBound);
            window.removeEventListener('keyup', this._onKeyUpBound);
            window.removeEventListener('blur', this._onBlurBound);
            window.removeEventListener('gamepadconnected', this._onGamepadConnectedBound);

            if (this._canvas) {
                this._canvas.removeEventListener('touchstart', this._onTouchStartBound);
                this._canvas.removeEventListener('touchmove', this._onTouchMoveBound);
                this._canvas.removeEventListener('touchend', this._onTouchEndBound);
                this._canvas.removeEventListener('touchcancel', this._onTouchEndBound);
                this._canvas.removeEventListener('contextmenu', this._onContextMenuBound);
            } else {
                document.removeEventListener('touchstart', this._onTouchStartBound);
                document.removeEventListener('touchmove', this._onTouchMoveBound);
                document.removeEventListener('touchend', this._onTouchEndBound);
                document.removeEventListener('touchcancel', this._onTouchEndBound);
            }

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

            // Fire & special — these are *contributions*; the final booleans are the OR
            // of keyboard + touch + gamepad, recomputed in getFire/getSpecial. We keep
            // `this.fire` / `this.special` as the canonical aggregate so external code
            // can just read them directly.
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
            this._joystick.vectorX = 0;
            this._joystick.vectorY = 0;
            this._touchMove = { x: 0, y: 0 };
            this._touchFiring = false;
            this._rightSwipeStart = null;
            this._gamepadFireHeld = false;
            this._gamepadSpecialHeld = false;
            this._gamepadStartHeld = false;
            this._gamepadMove = { x: 0, y: 0 };
            this._recomputeAggregate();
        }

        // ─────────────────────────────────────────────────────────────────
        // Touch
        // ─────────────────────────────────────────────────────────────────

        _onTouchStart(e) {
            // Always preventDefault on the canvas to stop scroll/zoom/callout gestures.
            e.preventDefault();

            const rect = this._canvas
                ? this._canvas.getBoundingClientRect()
                : { left: 0, top: 0, width: global.innerWidth, height: global.innerHeight };

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                // Convert to canvas-relative coordinates.
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;

                // Decide zone by the *canvas* X midpoint.
                const zone = (x < rect.width / 2) ? 'left' : 'right';

                const record = {
                    identifier: t.identifier,
                    startX: x,
                    startY: y,
                    x: x,
                    y: y,
                    zone: zone,
                    startTime: performance.now()
                };
                this._activeTouches.set(t.identifier, record);

                if (zone === 'left') {
                    // Spawn the joystick at the touch point — players get the stick
                    // wherever they place their thumb, which is the modern mobile idiom.
                    this._joystick.active = true;
                    this._joystick.originX = x;
                    this._joystick.originY = y;
                    this._joystick.knobX = x;
                    this._joystick.knobY = y;
                    this._joystick.vectorX = 0;
                    this._joystick.vectorY = 0;
                } else {
                    // Right zone: start firing immediately.
                    this._touchFiring = true;
                    this._rightSwipeStart = { x: x, y: y, time: performance.now() };
                }
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchStartCallbacks);
        }

        _onTouchMove(e) {
            e.preventDefault();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const record = this._activeTouches.get(t.identifier);
                if (!record) continue;

                const rect = this._canvas
                    ? this._canvas.getBoundingClientRect()
                    : { left: 0, top: 0 };
                const x = t.clientX - rect.left;
                const y = t.clientY - rect.top;
                record.x = x;
                record.y = y;

                if (record.zone === 'left') {
                    this._updateJoystick(record);
                }
                // We intentionally do NOT treat right-zone finger movement as anything
                // other than continued firing — a tap-and-hold stays a hold regardless
                // of small drift. Swipe detection happens on touchend instead, which
                // is more robust than mid-gesture velocity math.
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchMoveCallbacks);
        }

        _onTouchEnd(e) {
            e.preventDefault();

            for (let i = 0; i < e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const record = this._activeTouches.get(t.identifier);
                if (!record) continue;

                if (record.zone === 'left') {
                    // Release the joystick. Only reset if this was *the* joystick finger;
                    // with multi-touch a second left-finger could have taken over, but
                    // we only allow one left-finger at a time (the latest touchstart
                    // overwrites the joystick origin), so resetting is safe.
                    this._joystick.active = false;
                    this._joystick.vectorX = 0;
                    this._joystick.vectorY = 0;
                    this._touchMove = { x: 0, y: 0 };
                } else {
                    // Right finger lifted: stop firing.
                    this._touchFiring = false;

                    // Swipe-down special detection: did the finger end well below where
                    // it started, within the time window?
                    if (this._rightSwipeStart) {
                        const dy = record.y - this._rightSwipeStart.y;
                        const dt = performance.now() - this._rightSwipeStart.time;
                        if (dy > SWIPE_DOWN_THRESHOLD && dt < SWIPE_DOWN_TIME_MS) {
                            // Fire a one-shot special edge. We pulse `special` true for one
                            // frame by setting a brief flag; the game reads this.special
                            // per-frame so we just set it true now and let the next
                            // _recomputeAggregate reset it on the following touchend/move.
                            // Simpler: dispatch a synthetic key-press for Z so the game's
                            // existing special handler runs uniformly.
                            this._dispatchSpecialSwipe();
                        }
                        this._rightSwipeStart = null;
                    }
                }

                this._activeTouches.delete(t.identifier);
            }

            // If no right-zone touches remain, make sure firing is off.
            let anyRight = false;
            this._activeTouches.forEach((r) => { if (r.zone === 'right') anyRight = true; });
            if (!anyRight) this._touchFiring = false;

            // If no left-zone touches remain, make sure the joystick is off.
            let anyLeft = false;
            this._activeTouches.forEach((r) => { if (r.zone === 'left') anyLeft = true; });
            if (!anyLeft) {
                this._joystick.active = false;
                this._joystick.vectorX = 0;
                this._joystick.vectorY = 0;
                this._touchMove = { x: 0, y: 0 };
            }

            this._recomputeAggregate();
            this._dispatchTouch(this._touchEndCallbacks);
        }

        /**
         * Update the virtual joystick from a left-zone touch record.
         * Clamps the knob to a max radius and produces a normalized vector.
         */
        _updateJoystick(record) {
            let dx = record.x - this._joystick.originX;
            let dy = record.y - this._joystick.originY;
            const dist = Math.hypot(dx, dy);

            // Clamp the knob to the max radius.
            if (dist > JOYSTICK_MAX_RADIUS) {
                const scale = JOYSTICK_MAX_RADIUS / dist;
                dx *= scale;
                dy *= scale;
            }
            this._joystick.knobX = this._joystick.originX + dx;
            this._joystick.knobY = this._joystick.originY + dy;

            // Apply a small deadzone at the center so resting fingers don't drift.
            let nx = 0, ny = 0;
            if (dist > DEADZONE_TOUCH) {
                nx = dx / JOYSTICK_MAX_RADIUS;
                ny = dy / JOYSTICK_MAX_RADIUS;
                // Clamp to [-1, 1] precisely.
                if (nx > 1) nx = 1; else if (nx < -1) nx = -1;
                if (ny > 1) ny = 1; else if (ny < -1) ny = -1;
            }
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
                activeCount: this._activeTouches.size
            };
        }

        _dispatchTouch(callbacks) {
            const state = this._buildTouchState();
            for (let i = 0; i < callbacks.length; i++) callbacks[i](state);
        }

        /**
         * Trigger the special weapon from a swipe-down gesture. We synthesise a
         * key-press event so the rest of the game's special-weapon plumbing (which is
         * built around the Z key) handles it uniformly.
         */
        _dispatchSpecialSwipe() {
            const fakeEvent = {
                code: KEY.KEY_Z,
                key: 'z',
                repeat: false,
                synthetic: true,
                preventDefault: () => {}
            };
            for (let i = 0; i < this._keyPressCallbacks.length; i++) {
                this._keyPressCallbacks[i](fakeEvent);
            }
            // Also briefly set special so any code polling this.special catches it.
            this.special = true;
            // Reset on the next frame. We use a microtask + rAF so it survives long
            // enough for the game loop to read it.
            const self = this;
            requestAnimationFrame(function () {
                if (!self._gamepadSpecialHeld && !self.keys[KEY.KEY_Z]) {
                    self.special = false;
                }
            });
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
                const fake = {
                    code: startPressed ? KEY.ENTER : KEY.KEY_P,
                    key: startPressed ? 'Enter' : 'p',
                    repeat: false,
                    synthetic: true,
                    preventDefault: () => {}
                };
                for (let i = 0; i < this._keyPressCallbacks.length; i++) {
                    this._keyPressCallbacks[i](fake);
                }
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
                this._gamepadSpecialHeld;
            // Note: touch swipe-down special is a one-shot pulse handled separately
            // in _dispatchSpecialSwipe(); we don't hold it.
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
         * Get a snapshot of the virtual joystick for rendering on a canvas overlay.
         * Returns null when the joystick is not active.
         * @returns {{originX:number, originY:number, knobX:number, knobY:number, vectorX:number, vectorY:number}|null}
         */
        getJoystick() {
            if (!this._joystick.active) return null;
            return {
                originX: this._joystick.originX,
                originY: this._joystick.originY,
                knobX: this._joystick.knobX,
                knobY: this._joystick.knobY,
                vectorX: this._joystick.vectorX,
                vectorY: this._joystick.vectorY
            };
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

    /**
     * Apply a centered deadzone to an analog axis value in [-1, 1].
     * Values within ±deadzone are zeroed; outside, the range is remapped so the
     * deadzone edge maps to 0 and the full deflection still reaches ±1.
     */
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
