# 技术方案：DSH Web UI 猫娘皮肤与装饰插件（`@yg/dsh-client-ui-cat-skin`）

> **冷审范围声明**：本文档仅用于**技术架构、Cordis 插槽协议、CSS 变量作用域与优先级、生命周期清理、与现有私有插件兼容性**审查。视觉配色方案与装饰美术风格由项目方自主决定，不在技术审查范围内。

---

## 1. 目标与边界

- **目标**：在不修改任何 `@deepseek-ai/*` 官方包与 `dsh-web-frontend/dist/index.html` 的前提下，通过独立 Cordis 客户端插件为 DSH Web UI 提供三层可开关的皮肤与装饰扩展：
  1. **Layer 1（主题变量层）**：成组覆写 `--dsw-alias-*` 与 `--dsw-specific-*` CSS 变量、圆角与滚动条细节，支持深/浅模式自适应与一键还原。
  2. **Layer 2（原生插槽装饰层）**：通过官方已声明的 `root` 级 Slot 挂载独立装饰组件（品牌徽标/名称、欢迎页徽标、全屏无交互覆盖层、输入框 Dock 挂件）。
  3. **Layer 3（轻量交互与设置层）**：纯 CSS 状态过渡（hover/focus-within）+ 原生设置页开关行，不改动会话状态机、输入框编辑器（Lexical）或布局网格逻辑。
- **非目标**：不重写侧边栏/消息流/输入框主组件；不劫持 React 根节点；不注入第三方 CDN 或外部字体；不引入需要后端持久化接口的逻辑（状态纯本地 `localStorage`）。

---

## 2. 包结构与部署方式

放置于 `C:\Users\KonomiHasu\dsh-private\packages\dsh-client-ui-cat-skin\`，遵循现有 `@yg/dsh-client-ui-*` 包约定：

```
dsh-client-ui-cat-skin/
  package.json
  lib/
    index.js       # Node 侧空插件（满足 Cordis 行解析）
    client.js      # Browser 侧 __ModuleLoader__.load() 自包含工厂
```

### `package.json` 关键字段

```json
{
  "name": "@yg/dsh-client-ui-cat-skin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "files": ["lib/index.js", "lib/client.js"],
  "engines": { "dsh": "0.2.1-rc.2" },
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-settings-general"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5"
  }
}
```

### 安装与启用链路

- 在 `C:\Users\KonomiHasu\.dsh\profiles\web\package.json`（或通过 `plugin_manager` / workspace 链接）注册 `@yg/dsh-client-ui-cat-skin`，并在 `profiles/web/cordis.patch.yml` 的 `dsh-private` 区块新增一行：
  ```yaml
  - id: ui-cat-skin
    name: '@yg/dsh-client-ui-cat-skin'
  ```
- **回滚策略**：在 `cordis.patch.yml` 将 `ui-cat-skin` 设 `disabled: true` 或移除该行即可 100% 复原，不留任何对官方包的修改。

---

## 3. 架构分层与技术实现

### 3.1 Layer 1：CSS 变量与选择器优先级策略

#### 已知冲突点（核心技术风险）
经核实，当前 profile 已启用两个会影响 CSS 变量的机制：
1. 官方 `@deepseek-ai/dsh-client-ui-theme` 在 `body` 和 `body[data-ds-dark-theme]` 上定义 `--dsw-alias-*` 与 11 个 `--dsw-specific-*` 变量。
2. 现有私有插件 `@yg/dsh-client-ui-private-settings`（`lib/client.js:193-201`）采用 **`document.documentElement.style.setProperty()` + `document.body.style.setProperty()` 内联样式写入** 11 个 `--dsw-alias-*` 变量（但不写 `--dsw-specific-*`）。

#### 解决方案
- **互斥与协同策略（核实 `ui-private-settings/lib/client.js:198-201`）**：
  - 已核实 `ui-private-settings` 使用无第三参的 `t.style.setProperty(k, v)` 写入普通内联声明（非 `!important`），且仅在启动 `restore()` 与点击设置行按钮时写入，无定时器或监听器重写。
  - **两阶段优先级策略（避免滥用 `!important`）**：
    1. **优先协同**：当猫娘皮肤预设为开启状态时，设置行提示当前是否与 `ui-private-settings`（`localStorage["lcs-ui-preset"]`）同时激活；提供一键将 `lcs-ui-preset` 归位 `"默认"` 并清理 `html`/`body` 上残留的 11 个 `--dsw-alias-*` 内联属性。
    2. **样式表作用域**：本插件所有变量写入 `<style data-yg-cat-skin>`，作用域为 `body[data-yg-cat-skin="..."]` 与 `body[data-ds-dark-theme][data-yg-cat-skin="..."]`，覆盖完整 `--dsw-alias-*` 与 11 个 `--dsw-specific-*`。在 `lcs-ui-preset === "默认"`（即无内联 `--dsw-alias-*` 覆盖）时**完全无需 `!important`**，彻底规避级联污染风险；仅在用户刻意叠加且不切回默认时，由设置页显式提示冲突源，不静默使用 `!important` 压制。
  - **状态残留说明**：禁用本插件仅移除 DOM 与样式表，`localStorage["yg-cat-skin-v1"]` 留存但无消费者；重新启用会恢复上次选择。
- **深浅模式切换响应**：
  - 官方通过切换 `body[data-ds-dark-theme]` 属性切深浅色，因此 CSS 规则天然按 `body[data-yg-cat-skin="X"]`（浅色）与 `body[data-ds-dark-theme][data-yg-cat-skin="X"]`（深色）双套声明，无需 `MutationObserver` 轮询。

### 3.2 Layer 2：官方 UI Slot 挂载清单（全部核实源码）

已逐一核对 `dsh-client-ui-sidebar`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`、`dsh-client-ui-settings-general` 的 `lib/client.js` 源码声明：

| 挂载点（Slot Name） | Kind | Scope | 实测渲染位置与传入 Props | 拟挂内容与安全约束 |
|---|---|---|---|---|
| `sidebar.brand.mark` | `single` | `root` | 侧边栏左上角品牌图标位（24px），props: `{ size: 24 }`，无注册时 fallback 为 `FishLogo` | 内联 SVG 徽标；当装饰开关为 `off` 时组件返回 `null` 或按需动态注销（**注意：见下方 single 槽卸载陷阱**） |
| `sidebar.brand.name` | `single` | `root` | 侧边栏展开时品牌名称位，props: `{}`，无注册时 fallback 为本地版本名 | 轻量品牌文字节点 |
| `conversation.hero.brand.mark` | `single` | `root` | 新会话空白首页正中 Hero 图标位，无注册时 fallback 为官方动画鱼 | 内联 SVG 徽标 + `prefers-reduced-motion` 守卫的轻量 CSS 动画 |
| `shell.overlay` | `list` | `root` | `AppFrame` 全局覆盖层（已核实 `dsh-client-ui-layout/lib/client.js:73`：`.pI_x6G_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}` 且 `.pI_x6G_overlayLayer>*{pointer-events:auto}`） | **直接根节点必须内联 `style={{ pointerEvents: "none" }}`** 以压过宿主的 `>* { pointer-events: auto }`；且不覆写外部 `z-index`，仅作用于宿主给定层级 |
| `conversation.input.overlay` | `list` | `session` | 输入框卡片正顶部锚点（已核实 `dsh-client-ui-conversation/lib/client.js:19050-19054`：`height: 0; position: absolute; inset: 0 0 auto`） | 输入框上沿贴合装饰（替代 CSS 伪元素 + `:has()`），根节点 `pointerEvents: "none"`，几何限定在左右角落且高度 `<= 14px`，不挡上方 `QueueDock` |
| `conversation.composer.dock` | `list` | `session` | 输入框下方 Dock 条（与 `ContextMeter` 同行），仅 `variant === "composer"` 时渲染 | 可选轻量状态小徽章（单行、限高、不撑开输入区高度） |
| `settings.general.item` | `list` | `root` | 设置 → 通用设置列表 | 控制行：皮肤预设切换、装饰等级（完整 / 轻度 / 关闭）、冲突提示与开关即时生效 |

#### 关键技术细节：`single` Slot 的开关与卸载
- 已核实 `dsh-client-ui-renderer/lib/client.js:1173-1176`：
  ```js
  if (spec.kind === "single") {
    const entry = host.entriesOfSlot(slotKey)[0];
    if (!entry) return entries.length > 0 ? deadCell() : fallback;
    return guarded(entry, entryKeyOf(entry));
  }
  ```
  `entriesOfSlot` 只筛选已注册条目、不预执行组件判断返回值，因此组件返回 `null` 时 `entry` 仍为真值，宿主渲染该组件结果（空白）而**不会**走 `fallback`。
- **正确做法**：当用户关闭品牌替换或关闭整套皮肤时，必须**调用 `ctx.slots.register(...)` 返回的 `dispose()` 函数注销槽位条目**，重新开启时再 `register()` 挂回（且固定图标容器尺寸 `24x24` 防止切回时布局跳动）。这样关闭后官方 `FishLogo` 与品牌名能 100% 恢复原样。

#### 关键技术细节：输入框贴合装饰的定位方式
- 放弃原稿的 `[data-composer-card]::before` + `:has([data-queue-dock])` 方案，改用官方已提供的 `conversation.input.overlay` 槽（`[data-composer-overlay]`，`height: 0; position: absolute; inset: 0 0 auto`）。
- 装饰元素固定在卡片上沿左右两角、向外突出高度不超过 `14px`、设置 `pointer-events: none`，既不依赖 `:has()`，也天然随输入框宽度和高度变化移动，且不与居中/铺满的 `QueueDock` 产生交互遮挡。

### 3.3 Layer 3：生命周期、清理与降级

1. **零副作用工厂**：`__ModuleLoader__.load({ id, factory })` 的 `factory` 内不操作 DOM、不读取 `localStorage`、不创建定时器（严格遵守 `ui-plugin.md` 规范，修正老插件 `ui-private-settings` 在顶层 `restore()` 的遗留毛病）。
2. **集中式状态管理**：
   - 在 `apply(ctx)` 内部创建轻量内存 store（`skin`、`decorLevel`、`replaceBrand` 三个字段，从 `localStorage` 单一 key `yg-cat-skin-v1` 的 JSON 读取并做白名单校验，解析失败自动回退默认值）。
   - 使用订阅者 `Set` 同步 React 设置行组件与 Slot 注册管理器。
3. **完整 `ctx.effect` 清理**：
   - `<style data-yg-cat-skin>` 节点的创建与移除挂在 `ctx.effect`。
   - `document.body.dataset.ygCatSkin` / `document.body.dataset.ygCatDecor` 的设置与清理挂在 `ctx.effect`。
   - 所有 `ctx.slots.inject(...)` 与动态 `register()` 的 disposer 统一在 `ctx.effect` 返回的清理函数中释放，保证热重载或禁用插件时无残留节点、无残留样式、无内存泄漏。
4. **动画与无障碍**：
   - 所有动效包裹在 `@media (prefers-reduced-motion: no-preference)` 内，禁用任何 `setInterval` 帧动画。
   - 所有装饰 SVG 标注 `aria-hidden="true"`。
5. **与现有插件兼容性检查**：
   - `@yg/dsh-client-locale-cat`：只改文案，不冲突；本插件 `sidebar.brand.name` 需与中文/猫娘语境协调。
   - `@yg/dsh-client-ui-private-settings`：通过上文 3.1 的自定义属性覆写策略兼容，且 `settings.general.item` 的 `order` 设为 `13`（紧跟现有 `10/11/12`，不撞 id、不撞 order）。
   - `dsh-plugin-wallpaper-engine`：挂载在 `sidebar.right.pane.tab` 与 `settings.section`，不占用本插件的 7 个 Slot；由于宿主 `.pI_x6G_overlayLayer` 已固定 `z-index: 20`，本插件不额外抬高 `z-index`。
   - `dsh-whale-widget-bowl` / `lcs-ball.js`：右下角可能有悬浮球，角落挂件统一避开右下角（仅放左下角或输入框上角），防止遮挡点击。

---

## 4. 验证计划

1. **首要冲突验证（阻塞项）**：
   - 验证与 `@yg/dsh-client-ui-private-settings` 交叉切换：开启 `cat-skin` 时检测 `lcs-ui-preset` 非 `"默认"` 的提示与一键归位；关闭 `cat-skin` 后确认原配色恢复且无内联样式污染。
2. **静态与加载检查**：
   - `node --check lib/index.js`、`node --check lib/client.js`。
   - 核实浏览器控制台无模块加载错误、无 Slot 冲突警告、`style[data-yg-cat-skin]` 存在且唯一。
   - 核实 `shell.overlay` 直接根节点 `pointer-events: none` 生效，页面所有按钮与输入框点击无阻断。
3. **功能与回归验证**：
   - 切换深色/浅色模式：确认所有 `--dsw-specific-*`（侧边栏、输入框、气泡、菜单）同步切换，无白块/黑块割裂。
   - 切换装饰等级（完整 → 轻度 → 关闭）：确认 `sidebar.brand.mark` 等 `single` 槽在 `dispose()` 注销后**正确恢复官方 `FishLogo`**（非空白），且无布局跳动。
   - 存在 `QueueDock` / `TodoDock` 时：确认 `conversation.input.overlay` 挂件不遮挡队列或待办折叠条。
   - 禁用插件后刷新：确认 DOM 与样式零残留。
