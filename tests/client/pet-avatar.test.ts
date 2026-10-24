/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";

/**
 * pet-avatar 运行时回归测试。
 *
 * pet.js 是零依赖 IIFE，假定浏览器全局；这里用最小 DOM 桩在 node 里驱动真实运行时，
 * 锁定「清单声明覆盖内置编排」（presets / fx / anims）的合并与校验规则，
 * 以及 pulse 的查找顺序：清单编排 → 单动作行。
 *
 * 桩必须在 import pet.js 之前就位，且 window 用独立对象而非 globalThis，
 * 避免覆盖 vitest 自身的定时器。
 */

type Timer = { fn: () => void; delay: number };
const timers = new Map<number, Timer>();
let nextTimerId = 1;
let manifestPayload: Record<string, unknown> = {};

class ElementStub {
  [key: string]: any;

  constructor() {
    this._attrs = new Map<string, string>();
    this._listeners = new Map<string, Array<(e: unknown) => void>>();
    this.isConnected = true;
    const style: any = {};
    style.setProperty = (k: string, v: string) => {
      style[k] = v;
    };
    style.getPropertyValue = (k: string) => style[k] ?? "";
    this.style = style;
    this._canvasStub = {
      width: 0,
      height: 0,
      setAttribute() {},
      addEventListener() {},
      focus() {},
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    };
    this._barStub = { style: {}, addEventListener() {} };
    this._fxStub = { classList: { add() {}, remove() {} } };
  }

  setAttribute(k: string, v: string) {
    this._attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k: string) {
    return this._attrs.has(k);
  }
  removeAttribute(k: string) {
    this._attrs.delete(k);
  }
  addEventListener(t: string, fn: (e: unknown) => void) {
    const list = this._listeners.get(t) ?? [];
    list.push(fn);
    this._listeners.set(t, list);
  }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    const kept = (this._listeners.get(t) ?? []).filter((f: (e: unknown) => void) => f !== fn);
    this._listeners.set(t, kept);
  }
  dispatchEvent(ev: { type: string }) {
    for (const fn of this._listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }
  get offsetWidth() {
    return 100;
  }
  attachShadow() {
    return {
      querySelector: (sel: string) => {
        if (sel === "canvas") return this._canvasStub;
        if (sel === ".bar") return this._barStub;
        if (sel === ".fx") return this._fxStub;
        return null;
      },
    };
  }
}

const win: any = {
  setTimeout(fn: () => void, delay = 0) {
    const id = nextTimerId++;
    timers.set(id, { fn, delay });
    return id;
  },
  clearTimeout(id: number) {
    timers.delete(id);
  },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: (() => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  })(),
  devicePixelRatio: 1,
  innerWidth: 1920,
  innerHeight: 1080,
};

const defs = new Map<string, any>();
const g = globalThis as any;
g.window = win;
win.customElements = {
  define: (name: string, ctor: any) => void defs.set(name, ctor),
  get: (name: string) => defs.get(name),
  whenDefined: () => Promise.resolve(),
};
g.HTMLElement = ElementStub;
g.Image = class {
  naturalWidth = 1536;
  naturalHeight = 2288;
  decode() {
    return Promise.resolve(this);
  }
};
g.CustomEvent = class {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
};
g.document = {
  baseURI: "http://localhost/",
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  createElement(tag: string) {
    const Ctor = defs.get(tag) ?? ElementStub;
    return new Ctor();
  },
  body: { appendChild() {} },
};
g.fetch = async () => ({ ok: true, json: async () => manifestPayload });

// pet.js 是无导出的 IIFE 脚本，用变量路径动态导入以绕开 TS 的模块检查
const PET_RUNTIME = "../../packages/pet-avatar/pet.js";
await import(PET_RUNTIME);

/* ---------- 测试工具 ---------- */

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makePet(manifest: Record<string, unknown>) {
  manifestPayload = manifest;
  const el = new (defs.get("pet-avatar") ?? ElementStub)();
  el.connectedCallback();
  return el as any;
}

/** 手动推进帧时钟，直到一次性动作队列播完、回到持久基线 */
function runOut(el: any, max = 200) {
  for (let i = 0; i < max && (el._busy || el._pendingAdvance); i += 1) el._step();
}

const BASE_MANIFEST = { id: "t", displayName: "T", spritesheetPath: "s.webp" };

beforeEach(() => {
  timers.clear();
  manifestPayload = BASE_MANIFEST;
});

describe("pet-avatar 清单编排", () => {
  it("未声明清单字段时保持内置默认：success 大招带特效，播完回基线", async () => {
    const el = makePet(BASE_MANIFEST);
    await flush();
    await flush();

    // 特效色默认值注入 CSS 变量
    expect(el.style.getPropertyValue("--pet-fx-success")).toBe("#d9a441");
    expect(el.style.getPropertyValue("--pet-fx-error")).toBe("#d95046");

    expect(el.pulse("success")).toBe(true);
    expect(el._stateName).toBe("jumping");
    expect(el._queue).toEqual(["jumping", "waving"]);
    expect(el.getAttribute("data-fx")).toBe("success");
    runOut(el);
    expect(el.getState()).toEqual({ base: "idle", animation: "idle", busy: false });

    expect(el.pulse("waiting")).toBe(false); // 循环状态不可 pulse
    expect(el.pulse("nope")).toBe(false); // 未知名字拒绝
  });

  it("pulse 查找顺序：清单编排优先，未编排名回退单动作行", async () => {
    const el = makePet({
      ...BASE_MANIFEST,
      presets: {
        success: { sequence: ["waving", "jumping"], fx: "none" },
        "level-up": { sequence: ["jumping", "waving"], fx: "success" },
        bad: { sequence: ["waiting"] }, // 循环动作被剔空 → 整条忽略
      },
    });
    await flush();
    await flush();

    expect(el.pulse("success")).toBe(true);
    expect(el._stateName).toBe("waving");
    expect(el._queue).toEqual(["jumping"]);
    expect(el.getAttribute("data-fx")).toBeNull(); // fx: none 不触发特效
    runOut(el);

    expect(el.pulse("level-up")).toBe(true); // 自定义语义名
    expect(el._stateName).toBe("jumping");
    expect(el.getAttribute("data-fx")).toBe("success");
    runOut(el);

    expect(el.pulse("bad")).toBe(false); // 无效编排且不是动作名
    expect(el.pulse("hello")).toBe(true); // 未覆盖的内置编排保持原样
    expect(el._stateName).toBe("waving"); // 单条编排在 _advance 后即进入播放
  });

  it("fx 颜色注入 CSS 变量，非法值回退默认", async () => {
    const el = makePet({
      ...BASE_MANIFEST,
      fx: { success: "#ff0000", error: "url(javascript:x)" },
    });
    await flush();
    await flush();

    expect(el.style.getPropertyValue("--pet-fx-success")).toBe("#ff0000");
    expect(el.style.getPropertyValue("--pet-fx-error")).toBe("#d95046");
  });

  it("anims 覆盖 fps/loop：影响节奏与可编排性，越界值回退", async () => {
    const el = makePet({
      ...BASE_MANIFEST,
      anims: { idle: { fps: 3 }, waving: { loop: true } },
    });
    await flush();
    await flush();

    expect(el._animOf("idle").fps).toBe(3);
    expect(el._animOf("waving")).toEqual({ row: 3, fps: 9, loop: true, rest: 0 });
    expect(el.pulse("waving")).toBe(false); // 变成循环动作后不可 pulse
    el.sequence(["waving", "jumping"]);
    expect(el._queue).toEqual([]); // waving 被剔除
    expect(el._stateName).toBe("jumping");
    runOut(el);

    const el2 = makePet({ ...BASE_MANIFEST, anims: { idle: { fps: 999 } } });
    await flush();
    await flush();
    expect(el2._animOf("idle").fps).toBe(6); // 越界回退内置值
  });

  it("自定义编排播完回到当前持久基线", async () => {
    const el = makePet({
      ...BASE_MANIFEST,
      presets: { "level-up": { sequence: ["jumping", "waving"], fx: "success" } },
    });
    await flush();
    await flush();

    el.setState("working");
    expect(el.pulse("level-up")).toBe(true);
    runOut(el);
    expect(el.getState()).toEqual({ base: "working", animation: "review", busy: false });
  });

  it("业务循环一轮播完留停顿，待机呼吸与拖拽跑动不停", async () => {
    const el = makePet(BASE_MANIFEST);
    await flush();
    await flush();

    // 业务状态默认停顿；待机呼吸、拖拽跑动保持连续
    expect(el._animOf("review").rest).toBe(2200);
    expect(el._animOf("running").rest).toBe(2000);
    expect(el._animOf("waiting").rest).toBe(2400);
    expect(el._animOf("idle").rest).toBe(0);
    expect(el._animOf("running-right").rest).toBe(0);

    el.setState("working");
    for (let i = 0; i < el._frames[8]; i += 1) el._step(); // 播完一整轮
    expect(el._frame).toBe(0);
    expect(timers.get(el._timer)?.delay).toBe(2200); // 末帧停住，等停顿结束再续

    el._step(); // 停顿结束后照常逐帧推进
    expect(timers.get(el._timer)?.delay).toBeCloseTo(1000 / 6);

    // 清单可调：0 表示不停顿，越界回退内置值
    const el2 = makePet({ ...BASE_MANIFEST, anims: { review: { rest: 0 } } });
    await flush();
    await flush();
    expect(el2._animOf("review").rest).toBe(0);
    el2.setState("working");
    for (let i = 0; i < el2._frames[8]; i += 1) el2._step();
    expect(timers.get(el2._timer)?.delay).toBeCloseTo(1000 / 6);

    const el3 = makePet({ ...BASE_MANIFEST, anims: { review: { rest: 99999 } } });
    await flush();
    await flush();
    expect(el3._animOf("review").rest).toBe(2200);
  });
});
