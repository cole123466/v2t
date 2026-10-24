# @v2tai/pet-avatar

零依赖的桌宠运行时 + 状态 API。图集格式为 Codex Pet v2（1536x2288，8 列 x 11 行，
单格 192x208），通过自定义元素 `<pet-avatar>` 渲染，不依赖 React / Vue。

## 安装

```bash
# 来自本仓库
npm i file:../v2tai-0.1.0/packages/pet-avatar

# 或者直接拷贝这个目录
```

运行时没有依赖；素材（pet.json / spritesheet.webp）需要宿主自己提供，
本包不包含角色形象。

## 用法

```js
import { registerPet, mountPet, petFlow } from "@v2tai/pet-avatar";

await registerPet(); // 等待 <pet-avatar> 定义完成

const pet = mountPet({ src: "/pets/saber/pet.json", size: 132 });
pet.setState("running");   // 导入开始
pet.pulse("success");      // 导入完成：放大招，然后回到 running
```

不用打包器时，直接引 IIFE：

```html
<script src="/node_modules/@v2tai/pet-avatar/pet.js" defer></script>
<pet-avatar src="/pets/saber/pet.json" size="132"></pet-avatar>
```

## 业务状态 → 桌宠

`petFlow` 是约定俗成的业务语义，内部派发 `v2t:pet-signal` 事件：

| 调用 | 反应 |
| --- | --- |
| `petFlow.importStart()` | 奔跑 |
| `petFlow.importDone()` | 放大招 → 待机 |
| `petFlow.importFailed()` | 失败动作 |
| `petFlow.queued()` | 等待 |
| `petFlow.working()` | 检查 / 处理 |
| `petFlow.done()` | 放大招 |
| `petFlow.failed()` | 失败动作 |
| `petFlow.idle()` | 待机 |

自己接管事件循环：

```js
import { petSignal, onPetSignal } from "@v2tai/pet-avatar";

onPetSignal(({ state, pulse }) => {
  // 比如同步到自己的 UI 状态
});

petSignal({ state: "working" });
petSignal({ state: "idle", pulse: "success" });
```

## 元素 API

```js
const pet = document.querySelector("pet-avatar");

pet.setState("idle");       // idle | running | waiting | working
pet.getState();             // { base, animation, busy }
pet.pulse("success");       // success | error | hello | jump
pet.sequence(["jumping", "waving"]);
pet.play("waving");         // 底层动作行
pet.setPet("/pets/aoko-aozaki/pet.json");
pet.setMotion("still");
pet.resetPosition();
pet.pause();
pet.resume();
```

`pulse` / `sequence` 只接受一次性动作；循环状态请用 `setState`。
`busy=true` 时调用 `setState` 只更新基线，不打断正在播的一次性动作。

状态映射：`running→行7`、`waiting→行6`、`working→行8 review`；
`success` = 连跳两次 + 挥手 + 金色爆发。

## 清单编排（按角色覆盖，运行时 ≥1.1.0）

上面的编排与特效色都是内置默认值；包的 pet.json 可以按角色声明
`presets`（语义 → 动作序列 + 特效）、`fx`（特效颜色）与 `anims`（fps/loop 微调），
字段全部可选。声明后宿主可直接 `pet.pulse("<自定义语义名>")`。
字段格式见 `docs/pet-embed.md`「清单扩展：编排与特效」。

## 属性

| 属性 | 默认 | 说明 |
| --- | --- | --- |
| `src` | `/pets/saber/pet.json` | 清单地址 |
| `size` | `132` | 高度（px） |
| `motion` | `auto` | auto / still / full |
| `direction-offset` | `0` | 环视方向校准（22.5° 为单位） |
| `storage-key` | `pet-avatar` | 位置存到 `<key>:pos` |
| `toolbar` | `auto` | `none` 隐藏悬停工具条 |

## 事件

| 事件 | detail |
| --- | --- |
| `pet-ready` | `{ id, displayName, description, src }` |
| `pet-error` | `{ error }` |
| `pet-statechange` | `{ base, animation, busy }` |
| `pet-request-picker` | 无（右键/换按钮） |
| `pet-dismiss` | 无（隐藏按钮） |

## 跨域

运行时用 `fetch` 读 pet.json，跨域时 pet.json 需要 CORS 头；图集只做
`drawImage`，不读像素，不需要 CORS。

## 许可

运行时代码 MIT；角色形象版权归各自权利人，本包不附带素材。
