# Issue tracker：GitHub

本仓库的 issues 与规格（specs）记录为 GitHub issues（`andimial/dsh-codegraph`）。所有操作用 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论并同时取标签。
- **列 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`。
- **打 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：`gh issue close <number> --comment "..."`。

仓库从 `git remote -v` 推断——在 clone 内运行 `gh` 自动识别。

## 本会话的等价工具

本仓库装的是 `dsh-mattpocock-skills-deck` 插件，后端同为 GitHub。`deck_context` / `deck_issue_*` / `deck_map_*` 走的就是同一个仓库的 issues 与 label，是 `gh` 命令的等价面，不是第二套 tracker。用哪边都行：脚本化、要精确命令时用 `gh`；在会话里读票、打标签、挂 map 时用 deck 工具。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（若本仓库把外部 PR 当功能请求处理，改为 `yes`；`/triage` 读此开关。）_

设为 `yes` 时，PR 走与 issue 相同的标签与状态机，用 `gh pr` 等价命令：

- **读 PR**：`gh pr view <number> --comments` 与 `gh pr diff <number>`。
- **列待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（去掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个号码空间，裸 `#42` 可能是两者——用 `gh pr view 42` 解析，失败再 `gh issue view 42`。

## 技能说「发布到 issue tracker」时

创建 GitHub issue。

## 技能说「取相关工单」时

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

`/wayfinder` 使用。**Map** 是单个 issue，**child** issues 为工单。

- **Map**：单个 issue，打 `wayfinder:map` 标签，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub sub-issue 挂到 map（`gh api` 的 sub-issues 端点）。sub-issue 不可用时，把子项加进 map 正文的 task list，并在子工单正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后把工单 assign 给驱动的 dev。
- **阻塞关系**：GitHub **原生 issue dependencies**——规范且 UI 可见的表达。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`），不是 `#number` 也不是 `node_id`。GitHub 通过 `issue_dependencies_summary.blocked_by` 汇报（仅开着的阻塞方——活门）。dependencies 不可用时退回子工单正文顶部的 `Blocked by: #<n>, #<n>` 行。所有阻塞方关闭即解锁。
- **Frontier 查询**：列 map 开着的子工单（`gh issue list --state open`，按 map 的 sub-issues / task list 收窄），去掉带开着阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有开着的 issue）或有 assignee 的；map 顺序第一个胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`——会话的第一个写操作。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加进 map 的 Decisions-so-far。
