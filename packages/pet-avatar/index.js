import "./pet.js";

/** 自定义元素名 */
export const ELEMENT_NAME = "pet-avatar";
/** 业务状态信号事件名（window 上派发） */
export const PET_SIGNAL_EVENT = "v2t:pet-signal";

/** 持久状态 → 图集动作行 */
export const BASE_STATES = Object.freeze({
  idle: "idle",
  running: "running",
  waiting: "waiting",
  working: "review",
});

/** 一次性动作预设 */
export const PRESETS = Object.freeze({
  success: ["jumping", "jumping", "waving"],
  error: ["failed"],
  hello: ["waving"],
  jump: ["jumping"],
});

export function getPetAvatar() {
  if (typeof window === "undefined") return null;
  return window.PetAvatar || null;
}

export function registerPet() {
  if (typeof window === "undefined" || !window.customElements) return Promise.resolve(null);
  return window.customElements.whenDefined(ELEMENT_NAME).then(
    () => window.PetAvatar || null,
    () => null,
  );
}

function applyOptions(el, options) {
  if (options.src) el.setAttribute("src", options.src);
  if (options.size) el.setAttribute("size", String(options.size));
  if (options.motion) el.setAttribute("motion", options.motion);
  if (options.storageKey) el.setAttribute("storage-key", options.storageKey);
  if (options.zIndex) el.style.zIndex = String(options.zIndex);
  return el;
}

/** 挂到 body；运行时缺失时仍会创建元素（属性齐全，等运行时到位即升级） */
export function mountPet(options = {}) {
  if (typeof document === "undefined") return null;
  const api = getPetAvatar();
  if (api && typeof api.mount === "function") return api.mount(options);
  const el = document.createElement(ELEMENT_NAME);
  applyOptions(el, options);
  document.body.appendChild(el);
  return el;
}

/** 派发业务信号：{ state?, pulse? } */
export function petSignal(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PET_SIGNAL_EVENT, { detail }));
}

/** 订阅业务信号，返回取消函数 */
export function onPetSignal(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => handler(event.detail);
  window.addEventListener(PET_SIGNAL_EVENT, listener);
  return () => window.removeEventListener(PET_SIGNAL_EVENT, listener);
}

/** 业务语义封装：页面只表达“发生了什么” */
export const petFlow = {
  importStart: () => petSignal({ state: "running" }),
  importDone: () => petSignal({ state: "idle", pulse: "success" }),
  importFailed: () => petSignal({ state: "idle", pulse: "error" }),
  queued: () => petSignal({ state: "waiting" }),
  working: () => petSignal({ state: "working" }),
  done: () => petSignal({ state: "idle", pulse: "success" }),
  failed: () => petSignal({ state: "idle", pulse: "error" }),
  idle: () => petSignal({ state: "idle" }),
  hello: () => petSignal({ pulse: "hello" }),
};

export default {
  ELEMENT_NAME,
  PET_SIGNAL_EVENT,
  getPetAvatar,
  registerPet,
  mountPet,
  petSignal,
  onPetSignal,
  petFlow,
};
