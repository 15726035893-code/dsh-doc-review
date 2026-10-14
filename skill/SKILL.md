<!-- doc-review:managed -->
---
name: doc-review
description: 读 DSH 文档批注历史，提炼反复出现的审稿习惯沉淀为规则，并在新文档上做启发式预审。用户在批注页点"交给 AI 改稿"时，agent 应主动检查是否有可提炼共性。
whenToUse: 用户要求「分析审稿习惯」「提炼规则」「预审这篇文档」「看看最近批注有没有共性」「总结反馈模式」，或完成一轮改稿后被动检查共性；也适用于用户询问当前有哪些规则、要激活/停用某条规则、或希望对一篇新文档跑规则预审。
---

# doc-review · 从批注历史提炼规则 + 预审新文档

这是 `@caihua/dsh-doc-review` 插件的官方配套技能。插件把用户在 DSH 批注页写的每一条修改意见落盘到文档旁的 `.dsh-review/*.review.json`（MRSF v1.0 格式，含用户/AI 回复串、状态流转、原文锚点）。本技能读这些历史，提炼反复出现的意见模式沉淀成**规则库**（`~/.dsh/doc-review/rules.json`），再在新文档上用规则做**预审**。

## 核心约束

- **本技能不读文档正文做"主观评审"**。所有判断都来自用户已经写过的批注——技能只是把它们聚类、泛化、复用。规则库初始为空，所有规则都来自用户自己的历史。
- **预审建议必须走 `doc_change_propose`**，由用户在批注页「待审改动」面板逐条 ✓/✗。不直接改文件。
- **不打断用户正常改稿流程**。本技能是异步沉淀 + 可选预审，不是必要步骤。

## 可用工具

| 工具 | 用途 |
|---|---|
| `doc_review_history` | 跨项目聚合所有历史批注（已处理+未处理）|
| `doc_review_mine_candidates` | 从历史里挖出反复出现 ≥3 次 / ≥2 篇文档的意见模式作为**候选规则** |
| `doc_review_rules_list` | 看规则库现状（含 candidate/active/deprecated）+ 自动健康检查 |
| `doc_review_rules_add` | 加规则。detect.kind 支持 regex / line_length / para_lines / heading_level / manual |
| `doc_review_rules_update` | 改规则（status 变更、字段修改）|
| `doc_review_rules_remove` | 删规则（如需保留痕迹改用 status=deprecated）|
| `doc_review_preview_apply` | 用 active 启发式规则扫一篇文档，命中结果挂到待审改动 |

现有改稿工具 `doc_change_propose / doc_change_decide / doc_review_list / doc_review_resolve` 不变，技能复用它们。

## 四种触发场景与建议动作

### A. 用户完成一轮改稿后（被动触发）
用户在批注页点「交给 AI 改稿」时，组装的提示词会附带这段提醒：**本次 N 条批注处理完后，调 `doc_review_mine_candidates`，若发现≥3 条同质，告诉用户是否固化为规则。**

动作顺序：
1. 按已有流程处理批注（`doc_review_list` → `doc_change_propose` → `doc_review_resolve`）
2. **处理完后**调 `doc_review_mine_candidates`
3. 若有候选输出：
   - 列出 2-3 条最高频候选，附证据（命中次数、来源 commentId）
   - 问用户："这几条反复出现的意见，要不要固化为规则？以后打开类似文档会自动给出预审建议。"
   - 用户同意某条 → 调 `doc_review_rules_add`，初始 `status='candidate'`，让用户见过第一次预审效果后再 activate
4. 若没有候选输出：静默，不打扰

### B. 用户主动说"分析我的审稿习惯 / 提炼规则 / 看看最近批注有啥共性"
动作顺序：
1. `doc_review_history { limit:300 }` 看一眼总量和分布
2. `doc_review_mine_candidates { minHits:3, minDocs:2, limit:10 }` 挖候选
3. 产出结构化报告：
   - 高频模式 TopN（trigger + 建议 + 证据）
   - 哪些可以直接用启发式表达（regex/行长/段落长/标题层级），标注推荐的 detect 配置
   - 哪些是语义类的，建议留 `kind=manual`
4. 问用户要先加哪几条进规则库

### C. 用户主动说"预审这篇文档 / 用规则扫一下 / 看看这文档有没有问题"
动作顺序：
1. `doc_review_rules_list { status:'active' }` 看有哪些 active 规则
2. 若无 active 规则：告诉用户规则库为空或都是 candidate，先要 activate 几条
3. `doc_review_preview_apply { doc:<path>, dry_run:true }` 先 dry-run 看命中
4. 若命中合理：确认后 `dry_run:false` 真的挂到待审改动，告诉用户去「批注」页逐条 ✓/✗
5. detect.kind=manual 的规则不走 preview_apply。遇到需要 manual 规则的情况，直接读文档正文，按规则的 trigger/suggest 自己判断，命中后用 `doc_change_propose` 提案

### D. 用户主动说"看规则库 / 哪些规则在用 / 停用某条规则"
1. `doc_review_rules_list` 列全部
2. 根据用户指示调 `doc_review_rules_update` 改状态/字段，或 `doc_review_rules_remove` 删除

## 规则生命周期

- `candidate`：新加的规则默认状态。不参与自动预审。用户可以让 agent 用它跑 dry_run 看看效果，确认后 activate
- `active`：参与预审（启发式规则在 `doc_review_preview_apply` 时跑；manual 规则由本技能读 trigger 后判定）
- `deprecated`：历史保留，不再参与

`doc_review_rules_list` 会跑健康检查：
- active 规则拒绝率 > 50%（样本 > 5）→ 建议降级 candidate
- active 规则修改后接受率 > 30%（样本 > 10）→ 建议细化规则或加例外
- active 规则 90 天没命中 → 建议 deprecated

发现 findings 时主动告诉用户："这几条规则看起来不太准/没用了，要不要调整？"

## 产出报告格式

挖到候选或扫到命中时，按下面格式给用户（简洁、可操作）：

```
挖到 N 个候选规则：

[1] 触发：段落里出现「冗余 / 删除」相关内容
    建议：删掉或精简
    证据：命中 7 次，分布 3 篇文档
    来源批注：c_xxx, c_yyy, c_zzz
    建议 detect：manual（意见偏语义）

[2] 触发：行长超过 80 字符
    建议：拆短
    证据：命中 5 次，分布 2 篇文档
    建议 detect：{ kind:'line_length', max:80 }（可做零延迟预审）

要加 [1] [2] 吗？加了后用 preview_apply 跑一下看看效果。
```

## 禁止

- 不许自己造规则（没有历史批注就说"没有"，不要凭"通用写作建议"自造）
- 不许在 `preview_apply` 的 `after` 字段里猜测用户要改成什么——预审只负责挂待审建议，`after` 默认等于原文，由用户在批注页自己填"改成什么"
- 不许改既有的 `doc_review_* / doc_change_*` 工具行为
