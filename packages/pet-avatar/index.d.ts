/** 持久状态：会一直循环，直到下一次 setState */
export type PetBaseState = "idle" | "running" | "waiting" | "working";

/** 一次性动作预设 */
export type PetPulse = "success" | "error" | "hello" | "jump";

/** 图集里的 9 个动作行 */
export type PetAnimation =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type PetMotion = "auto" | "still" | "full";

export interface PetState {
  base: PetBaseState;
  animation: PetAnimation | "";
  busy: boolean;
}

export interface PetSignalDetail {
  /** 持久状态，会一直循环到下一次状态变化 */
  state?: PetBaseState;
  /** 一次性动作，播完回到当前持久状态；包清单 presets 声明的自定义语义名同样可播 */
  pulse?: PetPulse | (string & {});
}

export interface MountPetOptions {
  /** pet.json 地址 */
  src?: string;
  /** 高度（CSS px），默认 132 */
  size?: number;
  /** auto 跟随系统 reduced-motion；still 静止；full 强制动画 */
  motion?: PetMotion;
  /** localStorage 命名空间，默认 pet-avatar */
  storageKey?: string;
  /** 层级，默认 60 */
  zIndex?: number;
}

export interface PetAtlas {
  cols: number;
  cellW: number;
  cellH: number;
  lookRowA: number;
  lookRowB: number;
  lookCount: number;
}

export interface PetAvatarStatic {
  version: string;
  elementName: "pet-avatar";
  atlas: PetAtlas;
  baseStates: Record<PetBaseState, PetAnimation>;
  presets: Record<PetPulse, PetAnimation[]>;
  ready: Promise<void>;
  mount(options?: MountPetOptions): PetAvatarElement;
}

export interface PetAvatarElement extends HTMLElement {
  /** 换宠物（pet.json 地址） */
  setPet(src: string): void;
  /** 底层：直接播动作行 */
  play(name: PetAnimation): boolean;
  /** 持久状态 */
  setState(state: PetBaseState): PetState;
  /** 一次性动作，播完回到持久状态；清单 presets 声明过的自定义语义名也可用 */
  pulse(name: PetPulse | PetAnimation | (string & {})): boolean;
  /** 自定义串行动作（只接受一次性动作） */
  sequence(list: Array<PetPulse | PetAnimation>): boolean;
  getState(): PetState;
  setMotion(mode: PetMotion): void;
  resetPosition(): void;
  pause(): void;
  resume(): void;
}

export declare const ELEMENT_NAME: "pet-avatar";
export declare const PET_SIGNAL_EVENT: "v2t:pet-signal";
export declare const BASE_STATES: Readonly<Record<PetBaseState, PetAnimation>>;
export declare const PRESETS: Readonly<Record<PetPulse, PetAnimation[]>>;
/** 特效默认色（pet.json 的 fx 字段可按角色覆盖） */
export declare const FX_COLORS: Readonly<Record<"success" | "error", string>>;

export declare function getPetAvatar(): PetAvatarStatic | null;
export declare function registerPet(): Promise<PetAvatarStatic | null>;
export declare function mountPet(options?: MountPetOptions): PetAvatarElement | null;
export declare function petSignal(detail: PetSignalDetail): void;
export declare function onPetSignal(handler: (detail: PetSignalDetail) => void): () => void;

export declare const petFlow: {
  importStart: () => void;
  importDone: () => void;
  importFailed: () => void;
  parsing: () => void;
  queued: () => void;
  working: () => void;
  done: () => void;
  failed: () => void;
  idle: () => void;
  hello: () => void;
};

declare global {
  interface HTMLElementTagNameMap {
    "pet-avatar": PetAvatarElement;
  }
  interface Window {
    PetAvatar?: PetAvatarStatic;
  }
}

declare const _default: {
  ELEMENT_NAME: typeof ELEMENT_NAME;
  PET_SIGNAL_EVENT: typeof PET_SIGNAL_EVENT;
  getPetAvatar: typeof getPetAvatar;
  registerPet: typeof registerPet;
  mountPet: typeof mountPet;
  petSignal: typeof petSignal;
  onPetSignal: typeof onPetSignal;
  petFlow: typeof petFlow;
  FX_COLORS: typeof FX_COLORS;
};
export default _default;
