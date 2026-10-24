/**
 * <pet-avatar> — 零依赖桌宠运行时（Codex Pet v2 图集格式）。
 *
 * 用法（任意项目）：
 *   <script src="/pet-embed/pet.js" defer></script>
 *   <pet-avatar src="/pets/saber/pet.json" size="132"></pet-avatar>
 *
 * 图集规格：1536x2288，8 列 x 11 行，单格 192x208。
 * 0-8 行为动作，9-10 行为 16 个环视方向（0=上，顺时针每 22.5° 一格）。
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.customElements && window.customElements.get("pet-avatar")) return;

  var ATLAS = { cols: 8, cellW: 192, cellH: 208, lookRowA: 9, lookRowB: 10, lookCount: 16 };
  var DEFAULT_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
  // rest：循环节之间的停顿（毫秒），一轮播完保持末帧不动，避免“一直在动”的观感。
  // 业务状态（等待 / 跑动 / 检查）默认停 2s 上下；待机呼吸与拖拽跑动不停。
  var ANIM = {
    idle:            { row: 0, fps: 6,  loop: true,  rest: 0    },
    "running-right": { row: 1, fps: 11, loop: true,  rest: 0    },
    "running-left":  { row: 2, fps: 11, loop: true,  rest: 0    },
    waving:          { row: 3, fps: 9,  loop: false, rest: 0    },
    jumping:         { row: 4, fps: 12, loop: false, rest: 0    },
    failed:          { row: 5, fps: 8,  loop: false, rest: 0    },
    waiting:         { row: 6, fps: 5,  loop: true,  rest: 2400 },
    running:         { row: 7, fps: 10, loop: true,  rest: 2000 },
    review:          { row: 8, fps: 6,  loop: true,  rest: 2200 }
  };
  // 宿主常用的“持久状态” → 图集动作行（working 借用 review 的检查姿态）
  var BASE_ANIM = { idle: "idle", running: "running", waiting: "waiting", working: "review" };
  // 一次性动作编排：success 就是“放大招”（连跳 + 挥手 + 金色爆发）
  var PRESETS = {
    success: ["jumping", "jumping", "waving"],
    error: ["failed"],
    hello: ["waving"],
    jump: ["jumping"]
  };
  // 语义名 → 特效样式（清单 presets[].fx 可覆盖；只认 success / error）
  var PRESET_FX = { success: "success", error: "error" };
  // 特效默认色，经 CSS 变量注入宿主（清单 fx 按角色换色）
  var FX_DEFAULT = { success: "#d9a441", error: "#d95046" };
  var FX_MS = 1000;
  var LOOK_HOLD_MS = 1400;   // 指针停下后，保持环视姿态的时长
  var LOOK_TICK_MS = 140;
  var LOOK_DEADZONE = 18;    // 指针太靠近身体时保持原方向
  var EDGE = 4;

  function num(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) ? n : fallback;
  }

  function builtInPresets() {
    var out = {};
    for (var name in PRESETS) {
      if (Object.prototype.hasOwnProperty.call(PRESETS, name)) {
        out[name] = { sequence: PRESETS[name].slice(), fx: PRESET_FX[name] || null };
      }
    }
    return out;
  }

  /** 特效颜色只收 hex / rgb() 字面量，防 CSS 注入 */
  function safeColor(value) {
    if (typeof value !== "string") return false;
    return /^#[0-9a-fA-F]{3,8}$/.test(value) ||
      /^rgba?\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(value);
  }

  function safeStorage() {
    try {
      var k = "__pet_probe__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function loadImage(url) {
    var img = new Image();
    img.decoding = "async";
    img.src = url;
    function wait() {
      return new Promise(function (resolve, reject) {
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("spritesheet 加载失败")); };
      });
    }
    if (img.decode) {
      return img.decode().then(function () { return img; }, function () {
        if (img.complete && img.naturalWidth) return img;
        if (img.complete) throw new Error("spritesheet 加载失败");
        return wait();
      });
    }
    if (img.complete) {
      return img.naturalWidth ? Promise.resolve(img) : Promise.reject(new Error("spritesheet 加载失败"));
    }
    return wait();
  }

  var STYLE = [
    ":host{position:fixed;left:0;top:0;display:block;z-index:60;cursor:grab;",
    "touch-action:none;-webkit-user-select:none;user-select:none;",
    "filter:drop-shadow(0 12px 20px rgba(0,0,0,.26));}",
    ":host([data-dragging]){cursor:grabbing}",
    ":host([hidden]){display:none}",
    "canvas{display:block;width:100%;height:100%;outline:none}",
    "canvas:focus-visible{outline:1px dashed rgba(217,164,65,.95);outline-offset:5px;border-radius:10px}",
    ".bar{position:absolute;left:50%;top:-30px;transform:translateX(-50%);display:flex;gap:4px;",
    "opacity:0;pointer-events:none;transition:opacity .16s ease}",
    ":host(:hover) .bar,:host(:focus-within) .bar{opacity:1;pointer-events:auto}",
    "@media (hover:none){.bar{opacity:.55;pointer-events:auto}}",
    ".btn{width:22px;height:22px;padding:0;border-radius:999px;display:grid;place-items:center;",
    "font:12px/1 system-ui,sans-serif;cursor:pointer;color:#f4f1e8;",
    "background:rgba(12,12,16,.66);border:1px solid rgba(255,255,255,.22);",
    "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:background .14s,color .14s}",
    ".btn:hover,.btn:focus-visible{background:rgba(217,164,65,.94);color:#141008;border-color:transparent;outline:none}",
    "canvas{position:relative;z-index:1}",
    ".fx{position:absolute;inset:-20% -12%;border-radius:50%;pointer-events:none;opacity:0;z-index:0;",
    "background:radial-gradient(circle at 50% 58%,color-mix(in srgb,var(--pet-fx-success,#d9a441) 55%,transparent) 0%,color-mix(in srgb,var(--pet-fx-success,#d9a441) 18%,transparent) 42%,transparent 68%)}",
    ".fx.on{animation:pet-burst .95s cubic-bezier(.22,1,.36,1) both}",
    ":host([data-fx=error]) .fx{background:radial-gradient(circle at 50% 58%,color-mix(in srgb,var(--pet-fx-error,#d95046) 50%,transparent) 0%,color-mix(in srgb,var(--pet-fx-error,#d95046) 16%,transparent) 42%,transparent 68%)}",
    ":host([data-fx]) canvas{transform-origin:50% 82%;animation:pet-pop .9s cubic-bezier(.22,1,.36,1) both}",
    "@keyframes pet-burst{0%{opacity:.95;transform:scale(.45)}70%{opacity:.45}100%{opacity:0;transform:scale(1.25)}}",
    "@keyframes pet-pop{0%{transform:scale(1)}28%{transform:scale(1.14)}100%{transform:scale(1)}}",
    "@media (prefers-reduced-motion:reduce){.fx.on{animation:none}:host([data-fx]) canvas{animation:none}}"
  ].join("");

  var PetAvatar = function () {
    var el = Reflect.construct(HTMLElement, [], PetAvatar);
    return el;
  };
  PetAvatar.prototype = Object.create(HTMLElement.prototype);
  PetAvatar.prototype.constructor = PetAvatar;

  PetAvatar.observedAttributes = ["src", "size", "motion", "direction-offset", "toolbar", "hidden"];

  PetAvatar.prototype.connectedCallback = function () {
    // 元素被移动到新父节点时会先 disconnect 再 connect，这里重新挂监听并恢复动画
    if (this._built) {
      this._bind();
      this._clampPosition();
      this._applyMotion();
      return;
    }
    this._built = true;
    this._storage = safeStorage();
    this._storageKey = this.getAttribute("storage-key") || "pet-avatar";
    this._stateName = "idle";
    this._baseState = "idle";
    this._queue = [];
    this._pendingAdvance = false;
    this._busy = false;
    this._presets = builtInPresets();
    this._anims = null;
    this._fxTimer = 0;
    this._frame = 0;
    this._curRow = -1;
    this._curCol = -1;
    this._lookIndex = -1;
    this._lookUntil = 0;
    this._still = false;
    this._drag = null;
    this._token = 0;

    this._shadow = this.attachShadow({ mode: "open" });
    this._shadow.innerHTML =
      "<style>" + STYLE + "</style>" +
      '<div class="fx" aria-hidden="true"></div>' +
      '<canvas part="stage" tabindex="0" role="img"></canvas>' +
      '<div class="bar" part="bar">' +
      '<button class="btn" type="button" data-act="picker" title="更换桌宠" aria-label="更换桌宠">⇄</button>' +
      '<button class="btn" type="button" data-act="hide" title="隐藏桌宠" aria-label="隐藏桌宠">×</button>' +
      "</div>";

    this._canvas = this._shadow.querySelector("canvas");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    this._bar = this._shadow.querySelector(".bar");
    this._fxEl = this._shadow.querySelector(".fx");

    this._applySize();
    this._restorePosition();
    this._applyToolbar();
    this._bind();
    this._applyMotion();
    this._load(this.getAttribute("src") || "/pets/saber/pet.json");
  };

  PetAvatar.prototype.disconnectedCallback = function () {
    this._endDrag(true);
    this._stop();
    this._unbind();
  };

  PetAvatar.prototype.attributeChangedCallback = function (name) {
    if (!this._built) return;
    if (name === "src") this._load(this.getAttribute("src") || "");
    else if (name === "size") { this._applySize(); this._clampPosition(); }
    else if (name === "motion" || name === "hidden") this._applyMotion();
    else if (name === "toolbar") this._applyToolbar();
  };

  /* ---------- 对外 API ---------- */

  PetAvatar.prototype.setPet = function (src) {
    if (src) this.setAttribute("src", src);
  };
  PetAvatar.prototype.play = function (name) {
    if (!ANIM[name]) return false;
    this._play(name, true);
    return true;
  };

  /**
   * 设置“持久状态”，会一直循环到下一次调用：
   * idle | running | waiting | working（working 复用 review 行）。
   */
  PetAvatar.prototype.setState = function (name) {
    var logical = Object.prototype.hasOwnProperty.call(BASE_ANIM, name) ? name : "idle";
    var animation = BASE_ANIM[logical];
    var changed = this._baseState !== logical;
    this._baseState = logical;
    // 正在播一次性动作时只记下新基线，等它播完再切，避免“导入成功”被路由跳转打断
    if (this._busy) {
      if (changed) this._emitState();
      return this.getState();
    }
    if (!changed && this._stateName === animation) return this.getState();
    this._enter(animation);
    return this.getState();
  };

  /**
   * 播放一次性语义动作，结束后回到当前持久状态：
   * success（放大招）| error | hello | jump，也可以直接传动作行名；
   * 清单 presets 声明过的自定义语义名同样可播。
   */
  PetAvatar.prototype.pulse = function (name) {
    var preset = this._presets && Object.prototype.hasOwnProperty.call(this._presets, name)
      ? this._presets[name]
      : null;
    var seq, fx;
    if (preset) {
      seq = preset.sequence;
      fx = preset.fx;
    } else {
      // 未编排的名字只接受一次性动作；循环状态请用 setState
      var anim = this._animOf(name);
      if (!anim || anim.loop) return false;
      seq = [name];
      fx = null;
    }
    if (!seq.length || this._still) return false;
    this._queue = seq.slice();
    this._pendingAdvance = false;
    this._busy = true;
    if (fx) this._fx(fx);
    this._advance();
    return true;
  };

  /** 自定义串行动作，例如 ["jumping", "waving"]，结束后回到当前持久状态。 */
  PetAvatar.prototype.sequence = function (list) {
    if (!Array.isArray(list)) return false;
    var seq = [];
    for (var i = 0; i < list.length; i += 1) {
      // 序列只编排一次性动作，循环动作会堵住队列
      var anim = this._animOf(list[i]);
      if (anim && !anim.loop) seq.push(list[i]);
    }
    if (!seq.length || this._still) return false;
    this._queue = seq;
    this._pendingAdvance = false;
    this._busy = true;
    this._advance();
    return true;
  };

  PetAvatar.prototype.getState = function () {
    return {
      base: this._baseState,
      animation: this._stateName,
      busy: this._busy
    };
  };
  PetAvatar.prototype.setMotion = function (mode) {
    this.setAttribute("motion", mode);
  };
  PetAvatar.prototype.resetPosition = function () {
    if (this._storage) this._storage.removeItem(this._storageKey + ":pos");
    this._placeDefault();
    this._savePosition();
  };
  PetAvatar.prototype.pause = function () { this._paused = true; this._stop(); };
  PetAvatar.prototype.resume = function () { this._paused = false; this._start(); };

  /* ---------- 尺寸与位置 ---------- */

  PetAvatar.prototype._applySize = function () {
    var size = Math.max(48, Math.min(360, num(this.getAttribute("size"), 132)));
    var w = Math.round(size * ATLAS.cellW / ATLAS.cellH);
    this._w = w;
    this._h = size;
    this.style.width = w + "px";
    this.style.height = size + "px";

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._canvas.width = Math.max(1, Math.round(w * dpr));
    this._canvas.height = Math.max(1, Math.round(size * dpr));
    this._ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in this._ctx) this._ctx.imageSmoothingQuality = "high";
    this._curRow = -1;
    this._curCol = -1;
    if (this._img) this._draw(this._stateRow(), this._frame);
  };

  PetAvatar.prototype._placeDefault = function () {
    this._x = window.innerWidth - this._w - 24;
    this._y = window.innerHeight - this._h - 20;
    this._clampPosition();
    this._commitPosition();
  };

  PetAvatar.prototype._restorePosition = function () {
    var restored = false;
    if (this._storage) {
      try {
        var raw = this._storage.getItem(this._storageKey + ":pos");
        if (raw) {
          var pos = JSON.parse(raw);
          if (isFinite(pos.x) && isFinite(pos.y)) {
            this._x = pos.x;
            this._y = pos.y;
            restored = true;
          }
        }
      } catch (e) { /* 忽略损坏的存储 */ }
    }
    if (!restored) this._placeDefault();
    else { this._clampPosition(); this._commitPosition(); }
  };

  PetAvatar.prototype._clampPosition = function () {
    var maxX = Math.max(EDGE, window.innerWidth - this._w - EDGE);
    var maxY = Math.max(EDGE, window.innerHeight - this._h - EDGE);
    this._x = Math.min(Math.max(EDGE, this._x), maxX);
    this._y = Math.min(Math.max(EDGE, this._y), maxY);
    this._commitPosition();
  };

  PetAvatar.prototype._commitPosition = function () {
    this.style.left = Math.round(this._x) + "px";
    this.style.top = Math.round(this._y) + "px";
  };

  PetAvatar.prototype._savePosition = function () {
    if (!this._storage) return;
    try {
      this._storage.setItem(this._storageKey + ":pos", JSON.stringify({ x: Math.round(this._x), y: Math.round(this._y) }));
    } catch (e) { /* 隐私模式忽略 */ }
  };

  /* ---------- 加载 ---------- */

  PetAvatar.prototype._load = function (src) {
    var token = ++this._token;
    var self = this;
    if (!src) return;
    this._stop();
    this._setLabel("桌宠加载中");

    fetch(new URL(src, document.baseURI).href, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("pet.json " + res.status);
        return res.json();
      })
      .then(function (manifest) {
        if (token !== self._token) return null;
        self._manifest = manifest;
        self._frames = Array.isArray(manifest.frames) && manifest.frames.length >= 9
          ? manifest.frames.map(function (n) { return Math.max(1, Math.min(ATLAS.cols, n | 0)); })
          : DEFAULT_FRAMES.slice();
        self._applyManifest(manifest);
        var sheet = manifest.spritesheetPath || "spritesheet.webp";
        var url = new URL(sheet, new URL(src, document.baseURI)).href;
        return loadImage(url);
      })
      .then(function (img) {
        if (!img || token !== self._token) return;
        self._img = img;
        self._frame = 0;
        self._curRow = -1;
        self._curCol = -1;
        self._stateName = "";
        self._queue = [];
        self._pendingAdvance = false;
        self._busy = false;
        self._setLabel(self._manifest && self._manifest.displayName
          ? "桌面宠物 " + self._manifest.displayName + "，按回车互动，可拖动"
          : "桌面宠物");
        self._enter(BASE_ANIM[self._baseState] || "idle");
        self.dispatchEvent(new CustomEvent("pet-ready", {
          bubbles: true,
          detail: {
            id: (self._manifest && self._manifest.id) || "",
            displayName: (self._manifest && self._manifest.displayName) || "",
            description: (self._manifest && self._manifest.description) || "",
            src: src
          }
        }));
      })
      .catch(function (err) {
        if (token !== self._token) return;
        self.dispatchEvent(new CustomEvent("pet-error", { bubbles: true, detail: { error: String(err && err.message || err) } }));
      });
  };

  PetAvatar.prototype._setLabel = function (label) {
    this._canvas.setAttribute("aria-label", label);
  };

  /**
   * 清单可选声明覆盖内置编排，全部缺省即旧行为（向后兼容）：
   *   anims   — 动作行 fps/loop/rest 微调，如 { "review": { "rest": 3000 } }
   *   presets — 语义动作编排，如 { "success": { "sequence": ["jumping","waving"], "fx": "success" } }
   *   fx      — 特效颜色，如 { "success": "#d9a441" }
   * sequence 只收一次性动作；fx 只认 success / error / none，未声明沿用语义默认。
   */
  PetAvatar.prototype._applyManifest = function (manifest) {
    var name, entry, i;

    // anims 先合并，presets 校验时才能拿到最新的 loop 语义
    var overrides = null;
    var raw = manifest && manifest.anims;
    if (raw && typeof raw === "object") {
      for (name in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, name) || !ANIM[name]) continue;
        entry = raw[name];
        if (!entry || typeof entry !== "object") continue;
        var fps = parseFloat(entry.fps);
        var rest = parseFloat(entry.rest);
        overrides = overrides || {};
        overrides[name] = {
          fps: isFinite(fps) && fps >= 1 && fps <= 60 ? fps : null,
          loop: typeof entry.loop === "boolean" ? entry.loop : null,
          rest: isFinite(rest) && rest >= 0 && rest <= 20000 ? rest : null
        };
      }
    }
    this._anims = overrides;

    var presets = builtInPresets();
    raw = manifest && manifest.presets;
    if (raw && typeof raw === "object") {
      for (name in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
        entry = raw[name];
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.sequence)) continue;
        var seq = [];
        for (i = 0; i < entry.sequence.length; i += 1) {
          var anim = this._animOf(entry.sequence[i]);
          if (anim && !anim.loop) seq.push(entry.sequence[i]);
        }
        if (!seq.length) continue;
        presets[name] = {
          sequence: seq,
          fx: entry.fx === "success" || entry.fx === "error"
            ? entry.fx
            : entry.fx === "none" ? null : PRESET_FX[name] || null
        };
      }
    }
    this._presets = presets;

    var colors = { success: FX_DEFAULT.success, error: FX_DEFAULT.error };
    raw = manifest && manifest.fx;
    if (raw && typeof raw === "object") {
      var kinds = ["success", "error"];
      for (i = 0; i < kinds.length; i += 1) {
        if (safeColor(raw[kinds[i]])) colors[kinds[i]] = raw[kinds[i]];
      }
    }
    for (var kind in colors) {
      if (Object.prototype.hasOwnProperty.call(colors, kind)) {
        this.style.setProperty("--pet-fx-" + kind, colors[kind]);
      }
    }
  };

  /* ---------- 绘制与播放 ---------- */

  /** 名称 → {row,fps,loop}：叠加清单 anims 的 fps/loop 覆盖后的生效视图 */
  PetAvatar.prototype._animOf = function (name) {
    var base = ANIM[name];
    if (!base) return null;
    var over = this._anims && this._anims[name];
    if (!over) return base;
    return {
      row: base.row,
      fps: typeof over.fps === "number" ? over.fps : base.fps,
      loop: typeof over.loop === "boolean" ? over.loop : base.loop,
      rest: typeof over.rest === "number" ? over.rest : base.rest
    };
  };

  PetAvatar.prototype._stateRow = function () {
    var anim = this._animOf(this._stateName) || ANIM.idle;
    return anim.row;
  };

  PetAvatar.prototype._draw = function (row, col) {
    if (!this._img || !this._ctx) return;
    row = Math.max(0, Math.min(10, row | 0));
    col = Math.max(0, Math.min(ATLAS.cols - 1, col | 0));
    if (row === this._curRow && col === this._curCol) return;
    this._curRow = row;
    this._curCol = col;
    var w = this._canvas.width;
    var h = this._canvas.height;
    this._ctx.clearRect(0, 0, w, h);
    this._ctx.drawImage(
      this._img,
      col * ATLAS.cellW, row * ATLAS.cellH, ATLAS.cellW, ATLAS.cellH,
      0, 0, w, h
    );
  };

  PetAvatar.prototype._enter = function (name) {
    var anim = this._animOf(name);
    if (!anim) return;
    var changed = this._stateName !== name;
    this._stateName = name;
    this._frame = 0;
    this._pendingAdvance = false;
    this._lookUntil = 0;
    this._draw(anim.row, 0);
    if (changed) this._emitState();
    // hidden 时不排定时器，重新显示时由 _applyMotion / _start 恢复
    if (this._still || this.hasAttribute("hidden")) return;
    this._schedule(1000 / anim.fps);
  };

  PetAvatar.prototype._enterBase = function () {
    this._queue = [];
    this._pendingAdvance = false;
    this._busy = false;
    this._enter(BASE_ANIM[this._baseState] || "idle");
  };

  PetAvatar.prototype._advance = function () {
    var next = this._queue.shift();
    if (next) {
      this._enter(next);
      return;
    }
    this._busy = false;
    this._enter(BASE_ANIM[this._baseState] || "idle");
  };

  PetAvatar.prototype._play = function (name, restart) {
    var anim = ANIM[name];
    if (!anim) return;
    if (!restart && this._stateName === name) return;
    this._queue = [];
    this._pendingAdvance = false;
    this._busy = false;
    this._enter(name);
  };

  PetAvatar.prototype._emitState = function () {
    this.dispatchEvent(new CustomEvent("pet-statechange", {
      bubbles: true,
      composed: true,
      detail: {
        base: this._baseState,
        animation: this._stateName,
        busy: this._busy
      }
    }));
  };

  PetAvatar.prototype._fx = function (kind) {
    if (this._still || !this._fxEl) return;
    this.removeAttribute("data-fx");
    void this.offsetWidth;
    this.setAttribute("data-fx", kind === "error" ? "error" : "success");
    this._fxEl.classList.remove("on");
    void this._fxEl.offsetWidth;
    this._fxEl.classList.add("on");
    var self = this;
    if (this._fxTimer) window.clearTimeout(this._fxTimer);
    this._fxTimer = window.setTimeout(function () {
      self._fxEl.classList.remove("on");
      self.removeAttribute("data-fx");
      self._fxTimer = 0;
    }, FX_MS);
  };

  PetAvatar.prototype._schedule = function (delay) {
    var self = this;
    this._stop();
    this._timer = window.setTimeout(function () { self._step(); }, delay);
  };

  PetAvatar.prototype._stop = function () {
    if (this._timer) {
      window.clearTimeout(this._timer);
      this._timer = 0;
    }
  };

  PetAvatar.prototype._start = function () {
    if (this._still || this._paused || this.hasAttribute("hidden") || this.isConnected === false || !this._img) return;
    if (this._timer) return;
    var anim = this._animOf(this._stateName) || ANIM.idle;
    this._schedule(1000 / anim.fps);
  };

  PetAvatar.prototype._step = function () {
    this._timer = 0;
    if (this._still || this._paused || !this._img || document.hidden) return;

    // 上一段一次性动作刚播完，进入队列的下一段（或回到持久状态）
    if (this._pendingAdvance) {
      this._advance();
      return;
    }

    var now = Date.now();
    if (now < this._lookUntil && this._lookIndex >= 0) {
      var row = this._lookIndex < 8 ? ATLAS.lookRowA : ATLAS.lookRowB;
      this._draw(row, this._lookIndex % 8);
      this._schedule(LOOK_TICK_MS);
      return;
    }

    var anim = this._animOf(this._stateName) || ANIM.idle;
    var total = this._frames ? (this._frames[anim.row] || DEFAULT_FRAMES[anim.row]) : DEFAULT_FRAMES[anim.row];
    if (this._frame >= total) this._frame = 0;

    // 先画当前帧，再把游标推到下一帧；这样每帧都有完整的显示时长
    this._draw(anim.row, this._frame);
    this._frame += 1;

    if (this._frame >= total) {
      if (anim.loop) {
        this._frame = 0;
        // 循环节之间留停顿：末帧多停一会儿，别让桌宠一直在动
        this._schedule(anim.rest > 0 ? anim.rest : 1000 / anim.fps);
      } else {
        // 末帧先完整显示一拍，再切下一段，避免最后一帧被瞬间跳过
        this._pendingAdvance = true;
        this._schedule(1000 / anim.fps);
      }
      return;
    }
    this._schedule(1000 / anim.fps);
  };

  /* ---------- 环视 ---------- */

  PetAvatar.prototype._onPointerMove = function (event) {
    if (this._still || !this._img || this._drag) return;
    // 只在待机时环视：一次性动作与业务状态（跑动/等待/处理）不被鼠标视线盖住
    if (this._busy || this._baseState !== "idle") return;
    var cx = this._x + this._w / 2;
    var cy = this._y + this._h * 0.34;
    var dx = event.clientX - cx;
    var dy = event.clientY - cy;
    if (dx * dx + dy * dy < LOOK_DEADZONE * LOOK_DEADZONE) return;

    var angle = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    var offset = num(this.getAttribute("direction-offset"), 0);
    var index = ((Math.round(angle / (360 / ATLAS.lookCount)) + offset) % ATLAS.lookCount + ATLAS.lookCount) % ATLAS.lookCount;

    this._lookUntil = Date.now() + LOOK_HOLD_MS;
    if (index === this._lookIndex) return;
    this._lookIndex = index;
    this._draw(index < 8 ? ATLAS.lookRowA : ATLAS.lookRowB, index % 8);
    this._schedule(LOOK_TICK_MS);
  };

  /* ---------- 交互 ---------- */

  PetAvatar.prototype._bind = function () {
    var self = this;
    this._onDown = function (e) { self._pointerDown(e); };
    this._onMove = function (e) { self._pointerMove(e); };
    this._onUp = function (e) { self._pointerUp(e); };
    this._onCancel = function (e) { self._pointerCancel(e); };
    this._onLostCapture = function (e) { self._pointerCancel(e); };
    this._onKey = function (e) { self._keyDown(e); };
    this._onWindowMove = function (e) {
      self._pointerMove(e);
      self._onPointerMove(e);
    };
    this._onWindowUp = function (e) { self._pointerUp(e); };
    this._onWindowCancel = function (e) { self._pointerCancel(e); };
    this._onBlur = function () { self._endDrag(true); };
    this._onResize = function () { self._clampPosition(); };
    this._onVisibility = function () {
      if (document.hidden) {
        self._endDrag(true);
        self._stop();
      } else {
        self._start();
      }
    };
    this._onMedia = function () { self._applyMotion(); };
    this._onDblClick = function (e) { e.preventDefault(); self._play("jumping", true); };
    this._onContextMenu = function (e) {
      e.preventDefault();
      self._emit("pet-request-picker");
    };
    this._onBarClick = function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "picker") self._emit("pet-request-picker");
      if (act === "hide") self._emit("pet-dismiss");
    };

    this._canvas.addEventListener("pointerdown", this._onDown);
    this._canvas.addEventListener("pointermove", this._onMove);
    this._canvas.addEventListener("pointerup", this._onUp);
    this._canvas.addEventListener("pointercancel", this._onCancel);
    this._canvas.addEventListener("lostpointercapture", this._onLostCapture);
    this._canvas.addEventListener("keydown", this._onKey);
    this._canvas.addEventListener("dblclick", this._onDblClick);
    this._canvas.addEventListener("contextmenu", this._onContextMenu);
    this._bar.addEventListener("click", this._onBarClick);
    window.addEventListener("pointermove", this._onWindowMove, { passive: true });
    // 捕获失败（旧浏览器 / 指针已被别的元素捕获）时的兜底：window 上同样收尾
    window.addEventListener("pointerup", this._onWindowUp);
    window.addEventListener("pointercancel", this._onWindowCancel);
    window.addEventListener("blur", this._onBlur);
    window.addEventListener("resize", this._onResize);
    document.addEventListener("visibilitychange", this._onVisibility);
    if (window.matchMedia) {
      this._media = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (this._media.addEventListener) this._media.addEventListener("change", this._onMedia);
    }
  };

  PetAvatar.prototype._unbind = function () {
    if (this._canvas) {
      this._canvas.removeEventListener("pointerdown", this._onDown);
      this._canvas.removeEventListener("pointermove", this._onMove);
      this._canvas.removeEventListener("pointerup", this._onUp);
      this._canvas.removeEventListener("pointercancel", this._onCancel);
      this._canvas.removeEventListener("lostpointercapture", this._onLostCapture);
      this._canvas.removeEventListener("keydown", this._onKey);
      this._canvas.removeEventListener("dblclick", this._onDblClick);
      this._canvas.removeEventListener("contextmenu", this._onContextMenu);
    }
    if (this._bar) this._bar.removeEventListener("click", this._onBarClick);
    window.removeEventListener("pointermove", this._onWindowMove);
    window.removeEventListener("pointerup", this._onWindowUp);
    window.removeEventListener("pointercancel", this._onWindowCancel);
    window.removeEventListener("blur", this._onBlur);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVisibility);
    if (this._media && this._media.removeEventListener) this._media.removeEventListener("change", this._onMedia);
    this._media = null;
  };

  PetAvatar.prototype._emit = function (name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  };

  PetAvatar.prototype._keyDown = function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this._play("waving", true);
    }
  };

  PetAvatar.prototype._pointerDown = function (event) {
    if (event.isPrimary === false) return;                 // 多指时只认主指针
    if (event.button !== 0 && event.pointerType === "mouse") return;

    var current = this._drag;
    if (current) {
      if (current.id === event.pointerId) return;          // 同一指针重复 down，保持原拖拽
      this._endDrag(true);                                 // 上一次 up 丢失：先按取消收尾
    }

    event.preventDefault();
    this._canvas.focus({ preventScroll: true });
    this._drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this._x,
      originY: this._y,
      moved: false,
      dir: 0
    };
    try { this._canvas.setPointerCapture(event.pointerId); } catch (e) { /* 老浏览器忽略 */ }
    this.setAttribute("data-dragging", "");
    this._enterBase();
  };

  PetAvatar.prototype._pointerMove = function (event) {
    var drag = this._drag;
    if (!drag || event.pointerId !== drag.id) return;
    // 极端情况下 pointerup 丢失（在窗口外松手且浏览器没派发 up/blur）：
    // 后续 move 的 buttons 会变成 0，用它兜底收尾，避免“粘手”。
    if (event.buttons === 0) {
      this._endDrag(true);
      return;
    }
    var dx = event.clientX - drag.startX;
    var dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    this._x = drag.originX + dx;
    this._y = drag.originY + dy;
    this._clampPosition();

    var dir = dx > 0 ? "running-right" : dx < 0 ? "running-left" : "";
    if (dir && dir !== drag.dir) {
      drag.dir = dir;
      this._play(dir, true);
    }
  };

  PetAvatar.prototype._pointerUp = function (event) {
    var drag = this._drag;
    if (!drag || event.pointerId !== drag.id) return;
    this._endDrag(false);
  };

  PetAvatar.prototype._pointerCancel = function (event) {
    var drag = this._drag;
    if (!drag || event.pointerId !== drag.id) return;
    this._endDrag(true);
  };

  /**
   * 结束拖拽。cancelled=true 用于 pointercancel / lostpointercapture / blur /
   * 页面隐藏 / 指针被别的元素抢走：此时只落位，不触发“单击挥手”。
   */
  PetAvatar.prototype._endDrag = function (cancelled) {
    var drag = this._drag;
    if (!drag) return;
    this._drag = null;
    this.removeAttribute("data-dragging");
    try { this._canvas.releasePointerCapture(drag.id); } catch (e) { /* 已释放或未捕获 */ }
    if (drag.moved) {
      this._savePosition();
      this._enterBase();
    } else if (!cancelled) {
      this._play("waving", true);
    } else {
      this._enterBase();
    }
  };

  /* ---------- 动效偏好 ---------- */

  PetAvatar.prototype._applyToolbar = function () {
    if (!this._bar) return;
    this._bar.style.display = (this.getAttribute("toolbar") || "auto") === "none" ? "none" : "";
  };

  PetAvatar.prototype._applyMotion = function () {
    var mode = this.getAttribute("motion") || "auto";
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this._still = mode === "still" || (mode === "auto" && reduce);
    if (this._still || this.hasAttribute("hidden")) {
      this._stop();
      this._queue = [];
      this._pendingAdvance = false;
      this._busy = false;
      if (this._img && this._still) {
        this._stateName = BASE_ANIM[this._baseState] || "idle";
        this._frame = 0;
        this._curRow = -1;
        this._draw(this._stateRow(), 0);
      }
    } else {
      this._start();
    }
  };

  if (!window.customElements || !window.customElements.define) return;
  window.customElements.define("pet-avatar", PetAvatar);

  window.PetAvatar = {
    version: "1.2.0",
    elementName: "pet-avatar",
    atlas: ATLAS,
    baseStates: BASE_ANIM,
    presets: PRESETS,
    ready: window.customElements.whenDefined("pet-avatar"),
    mount: function (options) {
      var opts = options || {};
      var el = document.createElement("pet-avatar");
      if (opts.src) el.setAttribute("src", opts.src);
      if (opts.size) el.setAttribute("size", String(opts.size));
      if (opts.motion) el.setAttribute("motion", opts.motion);
      if (opts.storageKey) el.setAttribute("storage-key", opts.storageKey);
      if (opts.zIndex) el.style.zIndex = String(opts.zIndex);
      document.body.appendChild(el);
      return el;
    }
  };
})();
