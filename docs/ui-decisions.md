# UI / 工程决策（项目规格）

> 跨产品可复用的原则进 Echo 全局规则；本文件只记**本插件**的具体尺寸、坐标策略与回归约定。
> 来源：2026-10-13 前后批注页调整（含 `scopeMenuOpen` 崩溃修复、圆角行留缝、相对时间粒度、双栏锚定）。

## 1. 左栏文档列表行间距

- **决策**：`.dr-list>*+*{margin-top:2px}`，行间必须留缝。
- **原因**：行带 `border-radius: var(--dr-row-radius)`（宿主 `radius-md`），悬停与选中共用 `--dr-fill`；缝为 0 时相邻圆角贴死融成一块。
- **全局规则**：`UX.LIST.002`（只要求非零缝；像素值在此定）。
- **不要**：为了「紧凑」把行间 margin/gap 改回 0。

## 2. 列表相对时间粒度

- **决策**：`刚刚 → N分钟 → N小时 → 昨天 → MM-DD → YYYY-MM-DD`，**不写钟点**（不要「今天 16:20」）。
- **原因**：对齐宿主会话侧栏；找文件场景钟点无价值，只把行撑宽。
- **范围**：仅左栏文档/会话时间列。评论卡片内若需要精确编辑时间，可另定，不套本条。
- **门禁**：全局入库置信度不足 → **仅项目规格**，不进 Echo 全局库。

## 3. 双栏锚定与同步滚动

- **文档坐标**：选区捕获时换算并保存 `docTop`（相对滚动容器内容高度），右栏锚定优先用 `docTop`；视口 `getBoundingClientRect` 会随正文滚动过期。
- **等布局完成再量**：激活联动用**双 `requestAnimationFrame`**，避免读到碰撞防重叠重排前的旧 `top`。
- **高度变化**：锚定卡片用 `ResizeObserver` 测真实高度（窄屏换行、回复展开等），高度变了再触发防重叠重排；只在 mount effect 里量一次不够。
- **门禁**：`project_only` → 留在本文件，不进全局。

## 4. 组件作用域与全局 overlay

- **事故**：`scopeMenuOpen` 等 state 在 `DocReviewView`，关闭 effect / 下拉节点被粘进 `ChatAnnotator`（`shell.overlay`，每页挂载）→ `ReferenceError`，整页「批注页渲染出错」。
- **约定**：局部 state/effect/依赖该 state 的 JSX 只留在拥有者组件；全局规则 `ENG.SCOPE.001`。
- **回归**：`test/component-scope.mjs` —— 在假 React 环境执行整模块 factory，真实渲染各槽位组件；`node --check` 抓不到运行期作用域错误。此类守卫留在本仓库，不上升为「所有前端都必须假 React」的全局硬规（门禁 `project_only`）。

## 5. 已入库的全局规则（本轮相关）

| ID | 摘要 |
| --- | --- |
| `UX.LIST.002` | 圆角列表行必须留非零行间缝 |
| `ENG.SCOPE.001` | 局部 state/effect 不得粘进全局挂载组件 |

案例：`~/.local/share/echo/decision-cases/CASE.20261013.rounded-list-row-gap.json`、`CASE.20261013.component-scope-overlay.json`。
