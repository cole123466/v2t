# 桌宠嵌入（pet-avatar）

把 Codex Pet v2 图集包装成一个**零依赖、框架无关**的悬浮桌宠。运行时只有
`public/pet-embed/pet.js`（无外部依赖、无构建步骤），任何项目引一个
`<script>` 就能用；本仓库的 React 层只是在它外面套了选择面板与偏好存储。

## 1. 快速接入

```html
<script src="http://<host>:4317/pet-embed/pet.js" defer></script>
<pet-avatar src="http://<host>:4317/pets/saber/pet.json" size="132"></pet-avatar>
```

或者命令式挂载：

```js
PetAvatar.ready.then(function () {
  PetAvatar.mount({ src: "/pets/saber/pet.json", size: 132 });
});
```

运行时用 `fetch` 读 pet.json，所以**跨域时 pet.json 必须带 CORS 头**；
本项目的 `next.config.ts` 已给 `/pets/*` 和 `/pet-embed/*` 加上
`Access-Control-Allow-Origin: *`。图集只做 `drawImage`，不读像素，不会污染 canvas。

可运行示例：`/pet-embed/demo.html`。

## 2. 素材结构

```
public/pets/
  index.json                 # 本项目清单（可选，运行时不需要）
  saber/
    pet.json                 # 原包清单
    spritesheet.webp         # 1536x2288，8 列 x 11 行，单格 192x208
    thumb.webp               # 192x208 首帧，选择面板缩略图
```

图集行定义（Codex Pet v2）：

| 行 | 状态 | 帧数 |
| --- | --- | --- |
| 0 | idle | 6 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting | 6 |
| 7 | running | 6 |
| 8 | review | 6 |
| 9-10 | 16 个环视方向 | 每行 8 |

行尾空单元格会被跳过，播放只在非空帧内循环。若某个包的帧数不同，可以在
pet.json 里加 `"frames": [6,8,8,4,5,8,6,6,6]` 覆盖。

### 清单扩展：编排与特效（可选，运行时 ≥1.1.0）

图集行语义是固定标准，但「动作怎么串成庆祝、配什么特效」可以在 pet.json 按角色
覆盖，字段全部缺省即内置行为：

```json
{
  "id": "saber",
  "spritesheetPath": "spritesheet.webp",
  "frames": [6, 8, 8, 4, 5, 8, 6, 6, 6],
  "presets": {
    "success": { "sequence": ["jumping", "jumping", "waving"], "fx": "success" },
    "error": { "sequence": ["failed"], "fx": "error" },
    "level-up": { "sequence": ["jumping", "waving"], "fx": "success" }
  },
  "fx": { "success": "#d9a441", "error": "#d95046" },
  "anims": { "idle": { "fps": 5 }, "review": { "rest": 3000 } }
}
```

| 字段 | 说明 |
| --- | --- |
| `presets.<名>.sequence` | 动作行名数组，只收一次性动作（循环动作会被剔除）；过滤后为空则该条忽略 |
| `presets.<名>.fx` | `success` / `error` / `none`；缺省沿用语义默认（success→金、error→红，其余无特效） |
| `fx.<kind>` | 特效颜色，hex 或 `rgb()/rgba()`，注入 CSS 变量 `--pet-fx-<kind>`；非法值忽略 |
| `anims.<行名>` | `fps`（1-60）、`loop` 与 `rest`（0-20000ms）微调；`loop` 同时决定该动作能否被 pulse / sequence 编排 |

`rest` 是**循环节之间的停顿**：一轮播完保持末帧不动那么久，再从头播。业务循环
（`waiting` / `running` / `review`）内置 2400 / 2000 / 2200ms，所以任务跑起来
桌宠是「动一下、停两秒」，不是一直动；`idle` 呼吸与拖拽用的 `running-left/right`
默认不停顿，写 `rest: 0` 即恢复连续循环。

宿主侧 `pet.pulse("<自定义语义名>")` 即可播放包里声明过的编排（如上例的 `level-up`）。

## 3. 元素属性

| 属性 | 默认 | 说明 |
| --- | --- | --- |
| `src` | `/pets/saber/pet.json` | 清单地址，相对路径按页面 URL 解析 |
| `size` | `132` | 高度（CSS px），宽度按 192:208 自动计算 |
| `motion` | `auto` | `auto` 跟随系统 reduced-motion；`still` 强制静止；`full` 忽略系统偏好 |
| `direction-offset` | `0` | 环视序号偏移（单位 22.5°），用于校准方向顺序 |
| `storage-key` | `pet-avatar` | 位置存到 `<key>:pos` |
| `z-index` | `60` | 也可直接改 `element.style.zIndex` |

元素自身是 `position: fixed`，位置会写进 localStorage，刷新后保持。

## 4. 事件

| 事件 | 时机 | detail |
| --- | --- | --- |
| `pet-ready` | 清单与图集就绪 | `{ id, displayName, description, src }` |
| `pet-error` | 清单/图集加载失败 | `{ error }` |
| `pet-request-picker` | 点击「换」或右键 | 无 |
| `pet-dismiss` | 点击「×」 | 无 |
| `pet-statechange` | 持久状态或当前动作切换 | `{ base, animation, busy }` |

宿主收到 `pet-request-picker` 后自己决定弹什么面板；本项目由 `PetLayer` 渲染。


## 5. JS API

```js
var pet = document.querySelector("pet-avatar");

// 持久状态：一直循环，直到下一次调用
pet.setState("idle");      // idle | running | waiting | working
pet.getState();            // { base, animation, busy }

// 一次性动作：播完自动回到当前持久状态
pet.pulse("success");      // success（放大招）| error | hello | jump
pet.sequence(["jumping", "waving"]);

// 底层：直接播图集动作行
pet.play("waving");        // idle | running-right | running-left | waving |
                           // jumping | failed | waiting | running | review

// 其他
pet.setPet("/pets/aoko-aozaki/pet.json");
pet.setMotion("still");
pet.resetPosition();
pet.pause();
pet.resume();
```

持久状态映射：

| state | 图集行 | 用途 |
| --- | --- | --- |
| `idle` | 0 idle | 待机 |
| `running` | 7 running | 上传 / 长任务进行中 |
| `waiting` | 6 waiting | 排队 |
| `working` | 8 review | 转录 / 生成 / 检查 |

一次性动作预设：

| pulse | 编排 | 用途 |
| --- | --- | --- |
| `success` | jumping ×2 → waving + 金色爆发 | 导入 / 生成完成（“放大招”） |
| `error` | failed + 红色闪光 | 失败 |
| `hello` | waving | 打招呼 |
| `jump` | jumping | 轻量反馈 |

`pulse` 与 `sequence` 只接受一次性动作（waving / jumping / failed 等）；循环状态请用 `setState`。

`busy=true` 时调用 `setState` 只更新基线，不会打断正在播的一次性动作；
动作播完自动进入新基线，避免“导入成功”被紧接着的路由跳转打断。

新增事件 `pet-statechange`，detail 为 `{ base, animation, busy }`。

`window.PetAvatar` 另外暴露 `version`、`atlas`、`baseStates`、`presets`、
`ready`（Promise）、`mount(options)`。

## 6. 网页状态 → 桌宠状态（本仓库示例）

`src/components/pet/pet-flow.ts` 提供 `petFlow`，页面只表达业务事件：

| 调用 | 桌宠反应 |
| --- | --- |
| `petFlow.importStart()` | 奔跑 |
| `petFlow.importDone()` | 放大招 → 待机 |
| `petFlow.importFailed()` | 失败动作 |
| `petFlow.parsing()` | 奔跑（链接解析中） |
| `petFlow.queued()` | 等待 |
| `petFlow.working()` | 检查 / 处理姿态 |
| `petFlow.done()` | 放大招 |
| `petFlow.failed()` | 失败动作 |
| `petFlow.idle()` | 回到待机 |

```ts
import { petFlow } from "@/components/pet/pet-flow";

petFlow.importStart();
const ok = await upload();
if (ok) petFlow.importDone();
else petFlow.importFailed();
```

内部派发 `window` 事件 `v2t:pet-signal`（detail 为 `{ state?, pulse? }`），
由 `PetLayer` 转给 `<pet-avatar>`。其他项目可以照抄 `petFlow`，也可以直接
调用元素的 `setState / pulse`。

当前接线位置：

| 位置 | 信号 |
| --- | --- |
| 工作台文件上传 / 链接导入 | `importStart` / `importDone` / `importFailed` |
| 任务页状态跃迁 | `queued` / `working` / `done` / `failed` |
| 文案生成 | `working` → `done` / `failed` |

### akiha 的红发状态怎么触发

红发**不是独立的状态键**，而是 akiha 图集里 `running` 动作行（第 7 行）的帧：
其余行（`idle` 行 0、`waiting` 行 6、`review` 行 8 等）都是黑发。所以"触发红发"
等价于"让桌宠进入 `running` 持久状态"。

完整链路：

```
petFlow.importStart() / petFlow.parsing()
  → window 派发 v2t:pet-signal { state: "running" }
  → PetLayer 的监听器调用 element.setState("running")
  → BASE_ANIM.running = "running" → ANIM.running.row = 7
  → 画布逐帧绘制第 7 行（红发）
```

能触发红发的入口：

| 入口 | 用户操作 | 何时变回黑发 |
| --- | --- | --- |
| `petFlow.parsing()` | 工作台粘贴链接后点「解析」 | 解析结束（成功或失败）时 `petFlow.idle()` |
| `petFlow.importStart()` | 工作台上传文件，或「创建链接任务」提交期间 | 创建成功后 `importDone()` / 失败后 `importFailed()` |
| 直接调用 | `petSignal({ state: "running" })` 或 `document.querySelector("pet-avatar").setState("running")` | 下一次 `setState` 非 `running` |

复现步骤（本仓库）：在桌宠设置里选中 **Akiha Tohno**，进入 `/studio`，
粘贴一个链接点「解析」（或拖入文件上传），解析期间桌宠即切到红发；请求结束
回到黑发的待机状态。

注意两点：

- 任务页 `/task/<id>` 的 `downloading` / `transcribing` 等状态走的是
  `petFlow.working()` → `review` 行（行 8），**仍是黑发**；真正播红发的是
  `running` 行。`pet.json` 里 "hair turns crimson while working and thinking"
  的描述只对应这张图集的美术，不对应 `working` 状态。
- 红发这一轮按 6 帧 @10fps 循环，轮间停 2000ms（`ANIM.running.rest`）；
  需要更长 / 更短可在该包 `pet.json` 用 `"anims": { "running": { "rest": 0 } }` 覆盖。
- 角色素材不入库（`public/pets/*/` 被 `.gitignore` 忽略），本机需已有
  `public/pets/akiha-tohno/` 才能在选择面板里选到 akiha。

## 7. 交互

- 光标移动 → 16 方向环视；指针静止 1.4s 后回到 idle 呼吸动画。
- 等待 / 跑动 / 检查这类循环动作一轮播完会停 2s 左右再续（`anims.<行名>.rest` 可调）。
- 单击 → 挥手；双击 → 跳跃；回车 / 空格 → 挥手。
- 按住拖动 → 位置跟随并播放左右跑动，松手后写入 localStorage；位置始终钳制在视口内。
- 拖拽基于 pointer capture：`pointercancel`、`lostpointercapture`、窗口失焦、
  页面隐藏、捕获失败（旧浏览器）、多指触摸都会正确收尾，不会卡在「粘手」状态；
  被取消的拖拽不会误触发单击挥手。
- 悬停或聚焦 → 出现「换 / 隐藏」两个按钮。
- 页面切到后台 → 停掉定时器，不占 CPU。
- 系统开启「减少动态效果」→ 只显示静态首帧。

## 8. 环视方向映射（已核对）

规范：0°=上、90°=右、180°=下、270°=左，每 22.5° 一格顺时针；
第 9 行放 0-157.5°（8 格），第 10 行放 180-337.5°（8 格）。

已对 `public/pets/` 里 5 套图集做过像素核对（头部肤色区域质心）：

- 90° 的质心比 270° 偏右 8-30px，5 套全部一致；
- 180° 的质心比 0° 偏下 4-27px，5 套全部一致。

所以默认 `direction-offset=0` 对这 5 套是正确的。只有第三方包顺序不同时，
才需要用 4 / 8 / 12 校准。

## 9. 新增宠物

1. 图集缩到 1536x2288，转 lossy WebP（q80 约 0.5-0.9MB），连同 pet.json 放进
   `public/pets/<id>/`。
2. 裁第一格 192x208 存成 `thumb.webp`。
3. 在 `public/pets/index.json` 追加 `{ id, displayName, description, src, thumb }`。
4. 刷新页面，选择面板里就会出现。

## 10. 作为独立包使用

包在 `packages/pet-avatar/`，零依赖、无构建步骤：

| 文件 | 作用 |
| --- | --- |
| `pet.js` | 图集运行时（IIFE），可 `<script src>` 直接引 |
| `index.js` | ESM 封装：`registerPet / mountPet / petSignal / onPetSignal / petFlow` |
| `index.d.ts` | 元素、状态、事件、`petFlow` 的完整类型 |

```bash
npm i file:/path/to/repo/packages/pet-avatar
```

```js
import { registerPet, mountPet, petFlow } from "@v2tai/pet-avatar";

await registerPet();
const pet = mountPet({ src: "/pets/saber/pet.json", size: 132 });

pet.setState("running");
pet.pulse("success");
petFlow.importFailed();
```

包不附带角色素材，`src` 指向宿主自己的 pet.json 即可。

`public/pet-embed/pet.js` 是 `packages/pet-avatar/pet.js` 的同步副本，仅供
`demo.html` 和 `<script>` 接入；修改运行时后运行 `npm run pet:sync`，
`npm run pet:check` 用于校验是否漂移。应用内的
`src/components/pet/pet-flow.ts` 也只是对包的再导出。

## 11. 本仓库内的分工

| 文件 | 职责 |
| --- | --- |
| `packages/pet-avatar/` | 可独立安装的包：运行时 + ESM 封装 + 类型（唯一源） |
| `public/pet-embed/pet.js` | 同步副本，给 demo 与 `<script>` 接入 |
| `src/components/pet/pet-layer.tsx` | 引入包、创建元素、选择面板 |
| `src/components/pet/pet-flow.ts` | 对包内 `petFlow` 的再导出 |
| `src/components/pet/pet-store.ts` | 偏好（显示 / 宠物 / 动效）与 `usePetPrefs` |
| `src/components/pet/pet-toggle.tsx` | 各页 header 的入口按钮 |
| `src/app/layout.tsx` | 全局挂载 `<PetLayer />` |

其他项目不想引 React 的话，装 `packages/pet-avatar`（或只拷一份 `pet.js`），
再准备自己的 `public/pets/<id>/` 即可，不依赖本仓库任何代码。

## 12. 版权

角色形象版权归各自权利人，素材仅用于本地 / 内部演示，不要在公开站点分发。

