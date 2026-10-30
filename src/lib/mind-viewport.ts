/**
 * 导图阅读器视口数学（对齐 vid-lens mindViewport）：
 * 缩放范围、世界坐标系（内容居中于视口）、内容点→滚动位置、minimap 坐标换算。
 */
export type Point = { x: number; y: number };
export type ViewSize = { width: number; height: number };

export const MIND_PADDING = 40;
export const MIN_MIND_ZOOM = 0.5;
export const MAX_MIND_ZOOM = 2;

export function mindZoom(value: number): number {
  return Math.max(MIN_MIND_ZOOM, Math.min(MAX_MIND_ZOOM, value));
}

/** 缩放后的世界尺寸与内容左上角偏移（内容在世界中居中） */
export function mindWorld(content: ViewSize, viewport: ViewSize, scale: number) {
  const width = Math.max(viewport.width, content.width * scale + MIND_PADDING * 2);
  const height = Math.max(viewport.height, content.height * scale + MIND_PADDING * 2);
  return { width, height, x: (width - content.width * scale) / 2, y: (height - content.height * scale) / 2 };
}

/** 让内容的 point 落到视口的 client 处所需的滚动位置 */
export function mindScroll(point: Point, client: Point, content: ViewSize, viewport: ViewSize, scale: number) {
  const world = mindWorld(content, viewport, scale);
  return {
    x: Math.max(0, Math.min(world.width - viewport.width, world.x + point.x * scale - client.x)),
    y: Math.max(0, Math.min(world.height - viewport.height, world.y + point.y * scale - client.y)),
  };
}

/** minimap 上的点击坐标 → 画布坐标（minimap 等比居中缩放） */
export function minimapPoint(point: Point, surface: ViewSize, map: ViewSize): Point {
  const ratio = Math.min(surface.width / map.width, surface.height / map.height);
  return {
    x: Math.max(0, Math.min(map.width, (point.x - (surface.width - map.width * ratio) / 2) / ratio)),
    y: Math.max(0, Math.min(map.height, (point.y - (surface.height - map.height * ratio) / 2) / ratio)),
  };
}
