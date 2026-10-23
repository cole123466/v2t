"use client";

/**
 * 业务状态 → 桌宠状态。
 *
 * 实现与类型都在 packages/pet-avatar（独立包）里，本文件只做应用内别名，
 * 让页面保持 import { petFlow } from "@/components/pet/pet-flow" 的写法。
 */
export {
  PET_SIGNAL_EVENT,
  petFlow,
  petSignal,
  type PetBaseState,
  type PetPulse,
  type PetSignalDetail,
} from "../../../packages/pet-avatar/index.js";
