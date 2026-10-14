# DSH 宿主设计 Token（dsh-doc-review 采用的正本）

> 来源：本机 DSH Electron 应用 `app.asar` 内的运行时源码，逐字抄录，非推测。
> 抽取命令见文末「复现方式」。任何数值与宿主不一致时，以宿主源码为准并更新本文件。

本文件是 `lib/client.js` 里 `.dr-*` 样式的唯一依据。改样式前先在这里找 token；这里没有的值，
不要自创，先确认宿主是否真有对应档位。

---

## 1. 字体（Typography）

宿主把每个字号档位做成**复合 token**：一条 `font` 简写 + 四条拆解变量（`-font-family` /
`-font-weight` / `-font-size` / `-line-height` / `-font-style`）。消费时用简写即可。

| Token | 值（weight / size / line-height） | 用途 |
| --- | --- | --- |
| `--dsw-font-xl-24` | `600 24px/32px` | 页面大标题 |
| `--dsw-font-l-20` | `500 20px/28px` | 区块标题 |
| `--dsw-font-m-18` | `500 16px/28px` | 次级标题 |
| `--dsw-font-base-16` | `400 16px/24px` | 大正文 |
| `--dsw-font-base-strong-16` | `500 16px/24px` | 大正文加粗 |
| `--dsw-font-s-14` | `400 14px/22px` | **正文默认** |
| `--dsw-font-s-strong-14` | `500 14px/22px` | 正文强调 |
| `--dsw-font-xs-13` | `400 13px/20px` | **紧凑行默认** |
| `--dsw-font-xs-strong-13` | `500 13px/20px` | 紧凑行强调 |
| `--dsw-font-xxs-12` | `400 12px/18px` | 次要信息 |
| `--dsw-font-xxs-strong-12` | `500 12px/18px` | 次要信息强调 |
| `--dsw-font-xxxs-11` | `400 11px/14px` | 极小的标签 |
| `--dsw-font-xxxs-strong-11` | `500 11px/14px` | 极小的标签强调 |

Markdown 专用档位（正文渲染用，随 `--dsh-content-font-size` 缩放）：

| Token | 值 |
| --- | --- |
| `--dsw-font-markdown-h1` | `700 calc(21px + Δ)/calc(30px + Δ)` |
| `--dsw-font-markdown-h2` | `700 calc(19px + Δ)/calc(28px + Δ)` |
| `--dsw-font-markdown-h3` | `700 calc(18px + Δ)/calc(26px + Δ)` |
| `--dsw-font-markdown-h4` | `600 var(--dsh-content-font-size)/calc(24px + Δ)` |
| `--dsw-font-markdown-base` | `var(--dsh-content-font-size)/calc(24px + Δ)` |
| `--dsw-font-markdown-table` | `var(--dsh-content-font-size-secondary)/calc(22px + Δ₂)` |
| `--dsw-font-markdown-small` | `12px/20px` |
| `--dsw-font-markdown-code` | `12px/19px`（code 栈） |
| `--dsw-font-markdown-code-block` | `11px/19px` |

其中 `Δ = calc(var(--dsh-content-font-size,14px) - 14px)`，即用户设置的正文号相对 14px 的偏移。

### 字体栈

```
--dsw-font-family:      -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                         "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
                         Helvetica, Arial, sans-serif
--ds-font-family-code:   "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
                         "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"
--dsw-font-family-brand: "Montserrat", var(--dsw-font-family)
```

### 可调正文号

宿主主题设置暴露 `fontSize`，范围 **10–22px，默认 14px**，写入 `--dsh-content-font-size`；
派生 `--dsh-content-font-size-secondary: min(calc(size - 1px), max(13px, calc(size - 2px)))`。
组件里想跟随用户设置就用这两个变量，不要写死 px。

---

## 2. 圆角（Radius）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--dsw-radius-xs` | `4px` | 行内小标记 |
| `--dsw-radius-sm` | `8px` | 按钮、小控件、附件卡 |
| `--dsw-radius-md` | `12px` | **列表行、输入框、菜单行**（最高频） |
| `--dsw-radius-lg` | `16px` | 面板、卡片 |
| `--dsw-radius-xl` | `20px` | 引导入口 |
| `--dsw-radius-panel` | `28px` | 输入大卡、模态 |

---

## 3. 动效（Motion）

| Token | 值 |
| --- | --- |
| `--ds-ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` |
| `--ds-transition-duration-fast` | `.1s` |
| `--ds-transition-duration` | `.2s` |
| `--ds-transition-duration-slow` | `.3s` |

宿主的动画普遍带 `@media (prefers-reduced-motion: reduce)` 兜底，本插件同样要写。

---

## 4. 阴影与高度（Elevation）

| Token | 值 |
| --- | --- |
| `--dsw-shadow-lv1` | `0 2px 4px 0 #0000000d` |
| `--dsw-shadow-lv1-blur` | `0 4px 12px 0 #00000005` |
| `--dsw-shadow-lv2` | `0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a` |
| `--dsw-shadow-lv3` | `0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014` |
| `--dsw-elevation-stroke` | `0 0 0 .5px var(--dsw-elevation-stroke-color)` |
| `--dsw-elevation-panel` | stroke + `0 3px 8px 0 #00000008, 0 0 16px 0 #00000005` |
| `--dsw-elevation-prominent` | stroke + `0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d` |
| `--dsw-elevation-soft` | stroke + `0 4px 16px 0 #00000008, 0 0 24px 0 #00000008` |

高度色默认 `--dsw-alias-border-l4`（浅色）/ 菜单材质下 `--dsw-alias-border-l3`（深色）。

---

## 5. 间距与尺寸（实测自宿主组件 CSS）

这是最关键的一节。以下全部是从宿主 `SidebarRoot` / `FilesBody` / `InputBar` / `TodoPanel` /
`QueueDock` / `Menu` 等真实 CSS 里抄出的值。

### 5.1 侧栏骨架

| 位置 | 属性 | 值 |
| --- | --- | --- |
| 侧栏根 | `--dsh-sidebar-inline-padding` | `12px` |
| 侧栏根 | `padding` | `6px var(--dsh-sidebar-inline-padding)` |
| 顶栏条 `.topStrip` | `height` / `padding` | `52px` / `0 12px 2px` |
| 品牌行 `.logoRow` | `height` / `margin-bottom` / `padding` / `gap` | `60px` / `4px` / `8px 0 8px 4px` / `8px` |
| 折叠态根 | `padding` | `18px 10px 6px` |
| 折叠态品牌行 | `height` / `margin-bottom` | `36px` / `12px` |
| 图标按钮 `.iconButton` | `width` / `height` / `border-radius` | `28px` / `28px` / `var(--dsw-radius-sm)` |
| 折叠态图标按钮 | `width` / `height` / `border-radius` | `36px` / `36px` / `var(--dsw-radius-md)` |
| 新建按钮 `.newSession` | `height` / `padding` / `margin` / `border-radius` | `38px` / `8px 12px` / `0 2px 12px` / `var(--dsw-radius-md)` |
| 新建按钮字号 | `font-size` / `line-height` / `font-weight` | `14px` / `22px` / `500` |
| 面板列表 `.panelList` | `gap` / `margin-bottom` | `4px` / `8px` |
| **面板行 `.panelRow`** | `min-height` | **`36px`** |
| **面板行** | `padding` | **`7px 8px`** |
| **面板行** | `gap` / `margin` / `border-radius` | `8px` / `0 2px` / `var(--dsw-radius-md)` |
| **面板行** | `line-height` | **`22px`** |
| 折叠态面板列表 | `gap` / `margin-bottom` | `12px` / `12px` |
| 折叠态面板行 | `width` / `height` | `36px` / `36px` |
| 区域区 `.regionArea` | `margin-left` / `padding-left` | `-4px` / `4px` |

**关键规律**：面板行是**内容撑高**，不是固定高度。`padding:7px` × 2 + `line-height:22px` = 36px，
`min-height:36px` 只是下限。宿主从不把行高写死成 `height`。

### 5.2 文件树（`.dr-list` 对齐的基准）

| 位置 | 属性 | 值 |
| --- | --- | --- |
| 根 | `font-size` / `line-height` | `var(--dsh-content-font-size-secondary,13px)` / `1.5` |
| 头 `.header` | `height` / `padding` / `border-bottom` | `38px` / `0 6px 0 16px` / `.5px solid var(--dsw-alias-border-l3)` |
| 体 `.body` | `padding` / `margin-right` | `8px 0 8px 8px` / `2px` |
| 层级缩进 | `padding-left` | **`18px`**（每级） |
| **行 `.row`** | `padding` | **`5px 10px`** |
| **行 `.row`** | `gap` / `border-radius` | `6px` / `var(--dsw-radius-md)` |
| 注脚 `.note` | `padding` / `font-size` | `3px 10px` / `12px` |
| 工具栏按钮 `.tool` | `width` / `height` / `padding` / `border-radius` | `28px` / `28px` / `6px` / `var(--dsw-radius-sm)` |
| 工具栏图标 `.tool svg` | `width` / `height` | `15px` / `15px` |

### 5.3 输入区（`InputBar`）

| 位置 | 属性 | 值 |
| --- | --- | --- |
| 根 | `padding` | `0 var(--dsh-composer-side-clearance) 4px` |
| 卡 `.card` | `border-radius` / `gap` / `padding-top` | `var(--dsw-radius-panel)` / `12px` / `8px` |
| 附件行 `.accessory` | `gap` / `padding` | `8px` / `10px 12px 0` |
| 输入 `.input` | `min-height` / `padding` | `36px` / `4px 8px 0 14px` |
| 底部行 `.row` | `gap` / `padding` | `12px` / `2px 8px 6px` |
| 圆形加号 `.add` | `width` / `height` | `28px` / `28px` |
| 下拉 `.select` | `height` / `padding` / `font-size` | `28px` / `0 20px 0 8px` / `13px` |
| 主发送 `.primary` | `width` / `height` | `34px` / `34px` |

### 5.4 待办与队列面板

| 位置 | 属性 | 值 |
| --- | --- | --- |
| `TodoPanel.body` | `gap` / `padding` | `8px` / `6px 12px` |
| `TodoPanel.item` | `gap` / `font-size` / `line-height` | `10px` / `13px` / `20px` |
| `TodoPanel.list` | `gap` / `max-height` | `8px` / `180px` |
| `QueueDock.header` | `height` / `padding` / `gap` | `36px` / `4px 12px` / `10px` |
| `QueueDock.row` | `min-height` / `padding` / `gap` | `36px` / `4px 5px 4px 12px` / `10px` |
| `QueueDock.action` | `width` / `height` | `28px` / `28px` |
| `QueueDock.editor` | `min-height` / `padding` / `border-radius` | `28px` / `3px 8px` / `var(--dsw-radius-sm)` |

### 5.5 基础组件

| 组件 | 属性 | 值 |
| --- | --- | --- |
| Menu `.list` | `padding` / `min-width` / `max-width` | `4px` / `144px` / `360px` |
| Menu `.item` | `min-height` / `padding` / `gap` / `border-radius` | `34px` / `6px 8px` / `6px` / `var(--dsw-radius-md)` |
| Menu `.item` 字号 | `font-size` / `line-height` | `13px` / `20px` |
| Menu 密集态 `.denseList .item` | `min-height` / `padding-block` | `30px` / `4px` |
| Menu 紧凑态 `.compactList .item` | `min-height` / `padding` / `gap` / `font-size` | `24px` / `2px 6px` / `5px` / `11px` |
| Menu 紧凑态 `.label` | `padding` / `font-size` | `3px 6px` / `10px` |
| Menu `.itemIcon` | `width` / `height` | `14px` |
| Menu `.label` | `padding` / `font-size` / `line-height` | `6px 8px` / `11px` / `15px` |
| Menu `.separator` | `margin` / `height` | `3px 2px` / `0.5px` |
| Menu `.footer` | `margin-top` / `padding-top` | `3px` / `3px` |

### 5.6 控件尺寸（宿主 `Button` / `Input` / `Toast` 原始值）

这三个是插件里按钮与输入框应当照抄的目标。

| 控件 | 档位 | 属性 | 值 |
| --- | --- | --- | --- |
| Button | 基准 `.button` | `border-radius` / `gap` / `padding` | `var(--dsw-radius-md)` / `4px` / `0 14px` |
| Button | 基准 | `font-size` / `line-height` | `14px` / `22px` |
| Button | 中号 `.md` | `height` | `36px` |
| Button | 小号 `.sm` | `height` / `padding` / `border-radius` | `28px` / `0 10px` / `var(--dsw-radius-sm)` |
| Button | 小号 | `font-size` / `line-height` | **`12px` / `18px`** |
| Button | 图标 `.icon` | `width` / `height` | `16px` / `16px` |
| Button | 禁用 | `opacity` | `0.4` |
| Input | 外壳 `.wrap` | `height` / `padding` / `gap` | **`32px`** / `0 8px` / `6px` |
| Input | 外壳 | `border` / `border-radius` / `background` | `.5px solid var(--dsw-alias-border-l4)` / `var(--dsw-radius-md)` / `var(--dsw-alias-bg-layer-1)` |
| Input | 聚焦 | `border-color` | `var(--dsw-alias-state-business-primary)` |
| Input | 图标 | `width` / `height` / `color` | `16px` / `16px` / `var(--dsw-alias-label-tertiary)` |
| Input | 文本 | `font-size` / `line-height` | `14px` / `22px` |
| Input | 占位符 | `color` | `var(--dsw-alias-label-dimmed)` |
| Toast | 容器 | `padding` / `border-radius` / `gap` | `12px 16px` / `var(--dsw-radius-lg)` / `10px` |
| Toast | 容器 | `top` / `max-width` / `z-index` | `40px` / `min(640px, calc(100vw - 48px))` / `1100` |

**注意**：宿主的输入框是 **32px 高、14px 字号**（不是 28px / 13px），
小号按钮是 **28px / 12px / 18px**，中号按钮是 **36px / 14px / 22px**。
本插件原先自造的 `28px + 13px` 与 `24px + 13px` 两档在宿主里都不存在。

### 5.7 焦点环

```
--dsw-focus-ring-width: 2px（宿主写作 var(--dsw-focus-ring-width)，回退 2px）
--dsw-focus-ring-color: var(--dsw-alias-state-business-primary)
```

菜单与侧栏行的写法统一为 `outline: var(--dsw-focus-ring-width) solid
var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px;`

---

## 6. 间距栅格（从上述实测值归纳）

宿主实际用到的间距值，按出现频次：

| 值 | 出现处 |
| --- | --- |
| **2px** | 面板行左右外边距、分隔线垂直留白 |
| **3px** | 菜单 footer、注脚 padding-block |
| **4px** | 菜单卡 padding、面板列表 gap、logoRow margin-bottom、输入行合 |
| **6px** | 树行 gap、菜单卡 padding、菜单行 padding-block、注脚 padding |
| **7px** | 面板行 padding-block |
| **8px** | 侧栏折叠 padding、树体 padding、面板行 padding-inline、图标 gap、列表 margin-bottom |
| **10px** | 树行 padding-inline、QueueDock row/header gap |
| **12px** | 侧栏 inline padding、菜单卡在面板里的 padding、输入行 gap |
| **14px** | 输入框左 padding、引导入口 padding-inline |
| **16px** | 文件头左 padding |
| **18px** | 树层级缩进步长 |

**结论**：宿主走 **2px 基准的偶数栅格**，步长主要是 `2 / 4 / 6 / 8 / 10 / 12`，
14/16/18 只在明确的容器内边距或层级缩进上出现。**没有 5px、7px（除了面板行）、9px 这类碎值**，
也没有 20px 以上的常规 padding。

**行高与 padding 的关系**：行高一律是 `20px`（13 号）或 `22px`（14 号）这类**整值**，
padding-block 取 `5 / 6 / 7px` 让总高落在 `30 / 32 / 34 / 36px`。

---

## 7. 本插件的采用规则

1. **字号只许三档**：`13px/20px`（正文与行）、`12px/18px`（次要）、`11px/14px`（标签）。
   不再出现 10px / 14px / 16px 混用。
2. **行不写死高度**：用 `padding` + 整值 `line-height` 撑，必要时加 `min-height` 下限。
3. **间距只取 2/4/6/8/10/12**，容器 padding 用 12，行内 gap 用 6 或 8。
4. **圆角只用 `sm/md/lg`**：按钮与输入 `sm`，行与菜单项 `md`，卡片与面板 `lg`。
5. **颜色只走 `--dsw-alias-*`**，不为深色模式写特例。
6. **动效走 `--ds-*`**，并带 `prefers-reduced-motion` 兜底。

---

## 复现方式

```bash
A="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
# 列文件
npx --yes asar list "$A" | grep dsh-client-ui
# 抽主题（全部 --dsw-* 变量在此）
cd /tmp && npx --yes asar extract-file "$A" \
  "dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"
# 抽未编译的组件 CSS
cd /tmp && npx --yes asar extract-file "$A" \
  "dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Menu.module.css"
# 抽打包进 bundle 的 CSS（sidebar / files / conversation 等）
#   bundle 内形如： //#region \0dsh-css:.../X.module.css.mjs
#                  const css$N = "...";
#   用 python 按 region 标记抓取后 .encode().decode('unicode_escape') 还原
```
