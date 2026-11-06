# Task hierarchy design

Date: 2026-10-30. Status: draft for the owner. Implements goal `goals/task-hierarchy` under decision D3 (roadmap, 2026-10-29): subtasks carry `parentId`; epics are a small record per project; priority stays on each task (epic priority a tiebreak at most); progress is derived; the scheduler is unchanged.

Shape: **project → epic (optional) → task → subtask (optional)**, every item with an integer priority.

## 1. The model

### Epic

An epic is a named bucket of tasks inside one project. It is not a task: it never runs, has no prompt, no worktree and no status directory.

Stored in `projects/<id>/epics.json` (next to `project.json`), written atomically like the other JSON files and read by a small `EpicStore` (same shape as `ProjectStore`: load, list, create, update, remove, one file lock). Record:

```
{ id, title, description?, priority, archived, created, updated }
```

- `id`: kebab, unique within the project, derived from the title on create (`createUnique` style; a client may pass one).
- `priority`: integer, default 0. Orders epics in lists and in the UI; see section 2 for what it does _not_ do.
- `archived`: hides the epic from pickers and collapses its group; tasks are untouched.
- No `order` field: priority plus title is enough ordering for a per-project list of a handful of epics.

There is no epic status and no stored progress. Progress is computed on read: `done / total` over the epic's tasks, where `total` counts the epic's top-level tasks that are not archived and `done` counts those with status `done`. Subtasks do not count in an epic's progress (they roll up into their task).

### Task fields

Two optional frontmatter keys, both kebab ids resolved inside the task's own project:

- `epicId`: the epic this top-level task belongs to.
- `parentId`: the task this subtask belongs to.

A subtask is a task with `parentId`. It is a full task: own prompt, own priority, own status directory, own branch and worktree. A subtask has **no `epicId` of its own**; its epic is its parent's (derived in views, so there is one source of truth and moving the parent moves the children).

**One level only: a subtask cannot have subtasks.** Reasons: the UI has one indent to spend at 420 px; progress and "move" rules stay trivial (no cycles, no recursion); nobody asked for deeper. The store rejects `parentId` pointing at a task that itself has a `parentId`.

### Priority and ordering within a parent

Every item keeps its own integer `priority` (the existing field). Siblings under a parent, tasks within an epic and epics within a project are listed by priority descending, then `updated` ascending, then id, which is exactly the scheduler's order, so what the list shows is what runs next. `tasks.reorder` already rewrites priorities of a list of ids; dragging within a parent calls it with the siblings' ids. Nothing new is stored.

### Task progress

A task with subtasks reports `subtasks: { total, done }` in its view: `total` is its non-archived subtasks, `done` those with status `done`. Nothing is written to the parent's file.

### Delete, archive, move of a parent

- **Delete a task that has subtasks**: refused with `409 has_children` unless `detach: true`, in which case its subtasks become top-level tasks in the parent's epic (`parentId` cleared, `epicId` set to the parent's). Nothing is deleted in cascade.
- **Archive a task**: a status change like today; subtasks keep their `parentId` and their own status. The UI shows them under the parent in Finished.
- **Delete an epic**: refused with `409 has_tasks` unless `detach: true`, which clears `epicId` on its tasks. Prefer `archived: true`, which changes nothing on the tasks.
- **Move a parent task to another epic**: its subtasks follow (derived).
- **Dangling references** (a file edited by hand, an epic removed by an older version): the task loads and is treated as top-level; the view sets `parentMissing` / `epicMissing` so the UI can show a hint instead of hiding the task. Nothing is auto-repaired.

### Epics and plans

Plan → goal → task already groups tasks (`planRef`, `tasks.list?plan=`). To avoid two overlapping groupings, the rule is:

- A **goal** is the plan's unit of specification and sync. It always materialises exactly one task, as today. Sync never sets or clears `parentId`.
- An **epic** is the display and priority grouping. A goal may carry an optional `epicId`; sync copies it to the task it creates or updates (and preserves any `epicId`/`parentId` a human set when the goal has none). A plan is **not** an epic and is not turned into one automatically; the owner can create an epic per plan when that is what they want.
- Subtasks are made by people and agents under a task, never by sync.

## 2. Scheduling

The scheduler is unchanged: it picks the highest-priority eligible `pending` task across projects, oldest `updated` first, one in flight per project. It does not look at `parentId`, `epicId` or epic priority.

What that means for a parent whose subtasks are not done: **nothing waits for anything.** A pending parent runs when its priority says so, even while its subtasks are pending, running or failed; a pending subtask runs regardless of its parent's status. If the owner wants "parent after children", they queue the parent later (or keep it a draft until the subtasks are done; the detail view shows `2/5 done`). The only nudge in phase 1: queuing a parent that still has non-done subtasks returns a `Boof-Warning: subtasks_open` entry, not a refusal.

Epic priority is not a scheduler input in this design. If the owner wants it as the tiebreak between tasks of equal priority (D3 allows "at most" that), it is a five-line change to `compareSelection` and listed as question 1.

Prompt impact: a subtask's prompt gets a short context line in the existing Provenance section: the parent's title and the sibling titles with their status (not their prompts), so an agent knows what the sibling work is. A parent's prompt lists its subtasks the same way.

## 3. File format and migration

`TaskFrontmatterSchema` gains:

```
epicId: kebab.optional(),
parentId: kebab.optional(),
```

Both absent on every existing file, so **no migration**: a task without them is a top-level task without an epic, which is what it was. `epics.json` is created on first `epics.create`; a project without the file has no epics. `GoalSchema` gains `epicId: kebab.optional()`.

Older boof versions reading the files: unknown frontmatter keys parse fine (zod strips them), `epics.json` is ignored, and a goal `epicId` is dropped by the old `GoalSchema`. One caveat: an old version that _writes_ a task file (store `modify`, `transition`) drops the two keys silently, because it serialises the stripped frontmatter. That only happens with two boof versions on one data root, which is unsupported already; documented, not mitigated.

## 4. Interfaces

All through the operations registry, so REST, MCP and OpenAPI follow from one definition. No new scope: epics are a task-grouping record, so `tasks:read` / `tasks:write` apply.

### Operations

| Op             | Scope       | REST                                         | MCP                |
| -------------- | ----------- | -------------------------------------------- | ------------------ |
| `epics.list`   | tasks:read  | `GET /projects/{p}/epics`                    | `boof_list_epics`  |
| `epics.get`    | tasks:read  | `GET /projects/{p}/epics/{e}` (ETag)         | `boof_get_epic`    |
| `epics.create` | tasks:write | `POST /projects/{p}/epics` (201, idempotent) | `boof_create_epic` |
| `epics.update` | tasks:write | `PATCH /projects/{p}/epics/{e}` (If-Match)   | `boof_update_epic` |
| `epics.delete` | tasks:write | `DELETE /projects/{p}/epics/{e}?detach=`     | not exposed        |
| `tasks.move`   | tasks:write | `POST /projects/{p}/tasks/{t}/move`          | `boof_move_task`   |

Changes to existing ops:

- `tasks.list`: filters `epic=<id|none>` and `parent=<id|none>`; views carry `epicId` (derived for subtasks), `parentId`, `subtasks: {total, done}` and the `*Missing` flags.
- `tasks.create`: optional `epicId`, `parentId` (mutually exclusive: a subtask has no epic of its own).
- `tasks.move`: body `{ parentId?: id|null, epicId?: id|null }`; validates same project, parent exists and is not a subtask, not self, parent not deleted. Appends a `task.moved` event.
- `tasks.delete` and `epics.delete`: `detach` flag as in section 1.
- `epics.*` views include `progress: {total, done}`. Epic writes append an `epic.updated` event (SSE drives the UI).
- `plans.*`: goal input accepts `epicId`.

OpenAPI: regenerated from the registry; the `v1` contract test snapshot and `docs/api.md` (Operations and MCP sections) are updated in the same change, per the goal's rule.

### CLI

The CLI has no `task` group today (only `run`). Add, working on the data root like `project` and `plan`:

```
boof-runner epic <add|list|archive|remove> [--project <id>] [--priority <n>]
boof-runner task list [--project <id>] [--epic <id>|none] [--parent <id>|none]
boof-runner task move <task> [--epic <id>|none] [--parent <id>|none]
boof-runner run ... --epic <id> | --parent <id>
boof-runner plan sync            (copies goal epicId; no new flag)
```

### Security

- Project restriction: every op is `projectScoped`; parent and epic ids are resolved inside the target project only, so a cross-project reference is a plain `404`, never a leak.
- Review-trust clients: may create subtasks and `tasks.move` only for tasks they created (`origin.client` matches, same rule as stop/inject; otherwise `403 forbidden_trust`); the parent or epic they attach to may be anyone's. They may create and update epics (no execution effect) but not delete one. Created tasks stay drafts with `status_downgraded`, as now.
- `detach` is a write to other tasks: review-trust clients cannot pass it.

## 5. UI

The Tasks page keeps its state groups (Needs you / Proposed / Running / Queued / Drafts / Finished). The hierarchy appears inside them:

- **Row chips**: an epic chip next to the labels (`p50 · release · epic: Webhooks`); a subtask row shows `↳ <parent title>` instead when its parent is in another group.
- **Subtasks indented** under their parent when both are in the same group (the common case in Queued and Drafts); the parent row shows `2/5` when it has subtasks.
- **Epic headers** inside Queued and Drafts when the toolbar's `group by epic` toggle is on (default off until the list has an epic): one line per epic with title, priority and `3/7`, "No epic" last; collapsible, remembered per project in `localStorage`. Drag-to-reorder keeps working on the flat priority list; dropping between epics does not move a task's epic (that is a menu action), it only sets priority.
- **Toolbar**: an `epic ▾` filter beside `label ▾`, with "Manage epics…" opening a small sheet (list, add, rename, priority, archive). Palette gets "New epic", "Move to epic…", "Make subtask of…", "Detach from parent".
- **Task detail**: a hierarchy line under the title (epic chip → filters the list; parent link); a "Subtasks" block in the left pane listing children with status, progress and `Add subtask` (creates a draft with `parentId`). Missing parent or epic shows a one-line hint with "Detach".
- Desktop app and the chat console reuse the palette actions; nothing desktop-specific.

## 6. Phasing, risks, open questions

### Phasing

1. **Data** (S): schema fields, `EpicStore`, store validation for `parentId`/`epicId`, derived progress helpers, dangling-ref tolerance. Tests: old files load unchanged, create/move/list by parent, sibling ordering by priority.
2. **Surfaces** (M): `epics.*` and `tasks.move` ops, list filters, view fields, events, OpenAPI and `docs/api.md`, MCP exposure, CLI `epic` and `task` commands, `run --epic/--parent`. Tests: API and MCP contract snapshots.
3. **Plans** (S): goal `epicId`, sync copies and preserves it. Closes the data half of the goal.
4. **UI, minimal** (S): row chips, subtask indent, detail hierarchy line and Subtasks block, palette actions.
5. **UI, grouping** (M): epic headers with progress, `group by epic`, Manage epics sheet, 420 px check. Lands with roadmap step 11. Closes the UI half.

Steps 1-3 wait for the shared-store group to land on `store.ts`.

### Risks

- `store.ts` conflicts with the in-flight shared-store fixes: keep step 1 to additive validation in `create`/`modify`, no reshaping.
- Plan sync rewrites title and priority of goal tasks; it must preserve `epicId`/`parentId` a human set, otherwise hierarchy silently disappears on the next sync (test for it).
- Listing cost: `subtasks` counts and derived epic ids need the whole task list in memory; `tasks.list` already loads it, so this is fine for the sizes boof sees, but it is O(n) per request and not cached.
- Two boof versions on one data root drop the fields on write (section 3).
- Grouped headers plus indent can crowd the 420 px layout; step 5 ships behind the toggle so the flat list stays the default.

### Open questions for the owner

1. **Epic priority as scheduler tiebreak?** Recommend no: epic priority only orders lists. Yes means a small `compareSelection` change in step 1 and a doc line.
2. **Should a parent task react when its last subtask finishes?** Options: nothing (recommend; the detail shows `5/5`), or auto-queue a draft parent. Auto-queue adds a runner hook and a setting.
3. **Should subtask and parent prompts include each other's titles and statuses** (section 2, prompt impact)? Recommend yes; it costs a few tokens per run and touches the prompt builder in step 2. No means the hierarchy is bookkeeping only.
