# Boof Runner web UI redesign

Status: design, reviewed once with the owner (section 11); not yet approved for building. Nothing in this document has been built.
Date: 2026-10-27. Screenshots of the current UI are in [`2026-10-27-ui-redesign/`](2026-10-27-ui-redesign/).

## 1. Intent

Boof Runner is a control panel for a small crew of coding agents working on your repositories. One person (the owner) uses it for hours at a time: queue work, watch what an agent is doing right now, answer the planner's questions, read the reviewer's verdict, and open the resulting branch. An AI harness uses the same server over the API, so the UI is where the human stays in control.

The current UI works but was grown feature by feature. It is a list of cards with every control on every row, a 900-line settings form, no dark mode, no keyboard model, and a layout that breaks on a phone. The redesign gives it one organising idea and a design system that a builder can extend without reinventing buttons.

The idea: **"Now" comes first.** Whatever is running and whatever is waiting on you is visible on every screen of the project. Everything else (queue, drafts, history, plans, settings) is quiet and dense.

## 2. Goals, non-goals, anti-goals

Goals

- A person can tell in two seconds, on any screen: what is running, what needs them, what is queued.
- Every task row has one obvious action; destructive actions are never one click away.
- Works on a phone (checking on a run from the sofa) and on a wide monitor (reviewing a diff next to the log).
- Light and dark themes from one token set; the desktop app and the browser look the same.
- Keyboard-first for the owner: jump, queue, stop, approve without the mouse.
- Built on a component kit so the backlog's UI items (modals that trap focus, keyboard reorder, error toasts, linkable tabs) come for free instead of as one-off fixes.

Non-goals

- No change to the server, the REST API or the task file format. Where the UI needs something the API lacks, the gap is listed in section 9 and goes to the backlog.
- No new framework. React 19 and Vite stay. The hash router stays (structured, see section 6).
- No multi-user features (presence, comments, roles beyond API keys).

Anti-goals (what would make this a failure even if it ships)

- A generic SaaS dashboard: stat tiles with big numbers, gradient accents, identical rounded cards. Boof is a tool, not a product page.
- Hiding density behind whitespace. The owner wants to see twenty tasks and fifty goals without paging.
- A theme that only looks right in light mode.
- A component kit that pulls in a runtime theme engine and doubles the bundle.

## 3. Current state, what we learned

From screenshots and the 2026-10-27 code review of `packages/web/ui`:

- Hierarchy. The top bar spends its space on the runner state, a project `<select>` and the working directory in monospace, with all-caps labels ("PROJECT", "WORKING DIRECTORY"). The running task's live panel is a card that appears above the list only while something runs.
- Task rows carry five controls each: Review changes, Retry, Archive, a "skip" checkbox and Delete. Priority is shown as `P1000`. Titles still carry markdown (`# Finish resume-builder`).
- Plans: a table with the goal id in monospace, the title duplicated, a `<select>` for status on every row, up/down arrows, Edit and × on every row. No progress summary, no view of dependencies beyond a text cell.
- Task editor: a long form, then reports and log far below. The Changes tab is a bare sentence when there is no branch.
- Settings: one 873-line page mixing global roles, project overrides, budgets and API keys; the form resets while a task runs (backlog `ui-settings-form-keeps-edits`).
- Phone width: the sidebar stays fixed, content is clipped (see `mobile.png`).
- Actions on rows swallow errors (backlog `ui-surface-action-errors`); modals do not trap or restore focus; task reorder is pointer-only.
- Fonts load from Google Fonts at runtime, which a local-first tool should not do.

What is good and stays: hash routing per project, server-sent live updates, the token gate, the diff review with file list and counts, the steering box on a running task, the Actions concept (questions parked for the human).

## 4. Design direction

Subject and tone: a workbench for a developer who delegates to agents. Calm, legible, dense. The memorable element is the **Now lane**: a single horizontal strip at the top of every project screen that shows the running task with a live tail of the agent's output, the items waiting on you, and what runs next. Everything below it is flat lists on one surface with hairline dividers, not stacked cards.

### 4.1 Tokens

Color (light), named by role, not by hue:

| Token       | Value     | Use                                                                                |
| ----------- | --------- | ---------------------------------------------------------------------------------- |
| `page`      | `#F3F5F7` | app background                                                                     |
| `surface`   | `#FFFFFF` | lists, panels, dialogs                                                             |
| `ink`       | `#17212B` | primary text                                                                       |
| `ink-muted` | `#5F6B76` | secondary text, metadata                                                           |
| `line`      | `#DCE3EA` | hairlines, inputs                                                                  |
| `accent`    | `#2F5A75` | primary action, focus ring, active nav (kept from the current steel-blue identity) |
| `running`   | `#1E6FD9` | live dot, running pill                                                             |
| `attention` | `#B5560C` | needs-you pill and count                                                           |
| `done`      | `#2E7D52` | done pill, approve verdict                                                         |
| `failed`    | `#C0392B` | failed pill, reject verdict, destructive confirm                                   |

Dark theme maps the same roles: `page #0F1418`, `surface #161C22`, `ink #E6EBEF`, `ink-muted #97A3AE`, `line #263039`; status colors lightened one step so pills keep 4.5:1 contrast. Status is always shown by a pill with a word, never by color alone.

Type: one superfamily, self-hosted as woff2 in `packages/web/ui/public/fonts`:

- IBM Plex Sans for everything in the interface (400, 500, 600).
- IBM Plex Mono only for real code: task and goal ids, paths, branch names, the log, diffs. Never for labels.
- Scale (px): 12 meta, 13 dense rows, 14 body, 17 section title, 22 page title. Line length under 80 characters in reports and prompts.

Layout: 8 px rhythm; left rail 232 px that collapses to a 56 px icon rail (and to a bottom tab bar under 720 px); content max width 1320 px; detail views are a two-pane split (prompt and metadata left, run/changes right) that stacks on narrow screens. Text is left-aligned; counts and numbers right-aligned in lists.

Principles

1. Now first: the Now lane is on every project screen; the overview is the landing tab.
2. One primary action per row; the rest in an overflow menu; delete only inside the task detail behind a confirm.
3. Structure carries meaning: a divider, a pill or a count exists because the data has that shape. No eyebrow labels, no all-caps.
4. Density by default: 13 px rows, 40 px row height, no card per item.
5. Motion only where something is alive (the running dot, the streaming log) or as feedback to an action (a row moving state). No entrance animations.

Review against generic defaults (per the frontend-design checklist): the first draft of this section was a card grid with stat tiles for spend, queue length and runner state. That is the default admin look and says nothing about agents at work; replaced with the Now lane, which shows the live output itself. Inter was replaced by IBM Plex (sans and mono designed together, so ids inside sentences do not jar). All-caps labels and middle-dot meta strings were removed from the vocabulary.

### 4.2 Screens

Overview (new landing tab per project)

```
┌ rail ───┐┌──────────────────────────────────────────────────────────────┐
│ ● boof ▾ ││ Now                                                          │
│         ││ ┌ running ───────────────────────────────┐ ┌ needs you ───┐ │
│ Overview││ │ Add rate limiting to the webhook sender  │ │ 2 questions  │ │
│ Tasks 12││ │ developer · 4m 12s · claude-code/sonnet  │ │ 1 to review  │ │
│ Plans  3││ │ > editing src/webhooks/send.ts           │ └──────────────┘ │
│ Settings││ │ > npm test ... 42 passed                 │ ┌ up next ─────┐ │
│         ││ │ [steer the agent…            ] [Stop]    │ │ Fix flaky …  │ │
│         ││ └──────────────────────────────────────────┘ │ Write the …  │ │
│         ││                                              └──────────────┘ │
│         ││ Recent                                                        │
│         ││ done    Continue development of resume-builder   2h   branch →│
│         ││ failed  Finish resume-builder — smoke test        3h   retry  │
│ Runner  ││ Spend today  $4.20 of $20 ─────────▌                           │
│ [on ●]  │└──────────────────────────────────────────────────────────────┘
└─────────┘
```

The Now lane is one component reused at the top of Tasks and Plans in a compact one-line form ("running: Add rate limiting · 4m · needs you: 2").

Tasks

```
[ New task ]            search…        state ▾  label ▾         ⌘K
Needs you (2)
  question  Fix flaky SSE reconnect test        planner asks 2     Answer
  review    Continue development of resume…     approved · branch  Open changes
Running (1)
  ● 4m      Add rate limiting to the webhook…   developer          Stop ⋯
Queued (3)   drag to reorder
  ⠿ 1       Write the changelog for the next…   p50 · release      Edit ⋯
Drafts (2)
  ⠿         Prune stale worktrees …             p50                Queue ⋯
Finished  done 14 · failed 1 · archived 6                          show ▾
```

Grouping by state replaces the status pill as the first column. The overflow menu holds archive, skip, duplicate, copy id; Delete lives in the detail view. Rows are keyboard-navigable (j/k, Enter opens, q queues, s stops with confirm).

Task detail (replaces "Edit: <id>")

```
← Tasks     Add rate limiting to the webhook sender          running · 4m   [Stop] ⋯
planner ✓ 1m   refine ✓ 20s   developer ● 4m   observer   reviewer
┌ prompt & settings (left, 40%) ─────┐┌ Run | Changes | Questions (right) ────────┐
│ title, labels, priority, runs,     ││ live log (mono, follows tail, pause on     │
│ command template, prompt (md),     ││ scroll), reports per role under the log    │
│ attachments                        ││ with the verdict line pulled to the top    │
│ [Save]  saved 2 min ago            ││ steer: [ …                      ] [Send]   │
└────────────────────────────────────┘└────────────────────────────────────────────┘
```

The step strip across the top is the pipeline itself and shows verdicts (approve or reject) as the observer and reviewer finish. Changes keeps the current file list and diff, with "no branch yet" as an explained empty state that says what will create one.

Plans

```
Imported from boof        active · 54 goals · 0 done ────────────░░░░░░   Sync  ⋯
order  goal                                  status   depends on        task
1      Real tool adapters surface questions  plan                       –
2      Running-task edits survive the run    plan                       –
6      Orphan agent processes                plan     desktop-graceful… –
…
```

One status pill per row (click to change), one overflow per row, drag or ↑↓ to reorder, and a side panel (not a modal) for the goal's spec, history and linked task. Goal titles come from the plan, ids are shown only in the side panel.

Settings becomes five short pages under one tab: Project (directory, default base, pause, archive), Agents (roles and models, global with per-project override toggles), Budgets, API keys (create, rotate, revoke with every scope listed), Automation (commands, webhooks). Each page has a sticky footer with Save and a "changed elsewhere, reload" notice instead of a silent reset.

Global: the project switcher sits at the top of the rail with the runner switch at the bottom; a command palette (⌘K) jumps to tasks, plans and settings pages and runs new task, queue, stop and approve; the Actions tab becomes a count on the rail and the Needs-you group, not a separate page; empty states say what to do next ("No tasks yet. Add one, or let a harness submit a plan.").

Phone (under 720 px): the rail becomes a bottom bar (Overview, Tasks, Plans, More); the Now lane stacks; task rows drop the metadata column; the detail view stacks prompt above run.

### 4.3 Writing

Sentence case everywhere. Buttons name the result: "Queue", "Stop", "Approve plan", "Save changes", "Rotate key". Errors say what happened and what to do: "Could not queue: the task is already running. Stop it first." Status words are the task states the API uses (draft, pending shown as queued, running, action shown as needs you, done, failed, stopped, archived) so the UI, CLI and docs agree.

## 5. Design kit and tools

Chosen kit: **shadcn/ui on Tailwind v4**, with these companions:

- Primitives: shadcn's default (Base UI since mid-2026; Radix remains selectable). Both give accessible dialogs, menus, popovers, tabs and comboboxes, which fixes the modal focus and keyboard findings at the source.
- `cmdk` through shadcn's Command component for the palette; `sonner` for toasts; `lucide-react` for icons; TanStack Table for the task and goal lists (sorting, grouping, virtual rows); `@dnd-kit` stays for drag reorder.
- Theme: CSS variables in OKLCH generated once with tweakcn from the tokens above, light and dark, imported into `styles.css`; components live in the repo under `packages/web/ui/src/ui/`.

Why this and not the others: shadcn copies components into the codebase, which matches boof's local-first stance (no runtime theme engine, nothing to upgrade blindly), is Tailwind-native so the dense layouts are quick to write, and has the broadest ecosystem and agent tooling (llms.txt and an MCP server, so boof's own agents can build with it). Mantine v8 is the alternative if the owner prefers batteries included (data grids, hooks) at the cost of an opinionated look and a runtime. MUI and Ant Design were rejected for weight and a generic enterprise look. Sources: [shadcn Tailwind v4 guide](https://ui.shadcn.com/docs/tailwind-v4), [shadcn React 19](https://ui.shadcn.com/docs/react-19), [2026 library comparison](https://medium.com/@appstitch.dev/shadcn-ui-vs-radix-ui-vs-mantine-vs-mui-vs-headless-ui-vs-ark-ui-which-react-ui-library-should-7c19ac7adf24), [StackPicks 2026](https://stackpicks.dev/blog/best-open-source-ui-libraries-2026), [HeroUI comparison](https://heroui.com/en/blog/best-react-ui-component-libraries).

Design tool for mockups: **Penpot** (open source, self-hostable, native design tokens, CSS grid and flex layouts, free developer handoff, and an MCP server so an agent can read the file). Figma with the official shadcn/ui kit is the fallback if a Figma account already exists. Sources: [Penpot vs Figma 2026](https://hedrick.io/post/penpot-vs-figma), [Penpot 2.17/2.18](https://artofstyleframe.com/blog/figma-make-vs-penpot-ai-2026/), [using Penpot in 2026](https://whoisryosuke.com/blog/2026/using-penpot-in-2026/).

Recommended working method: skip pixel mockups for most screens. Do a one-day code spike of the app shell and the Now lane with real data (the UI already has an SSE feed), screenshot it, and iterate from there. Use Penpot only for the two screens worth arguing about: the overview and the task detail.

## 6. Architecture notes for the builder

- Routing: keep the hash router but make it a small table: `#/p/<pid>` (overview), `#/p/<pid>/tasks[/<id>[/changes|/questions]]`, `#/p/<pid>/plans[/<planId>[/<goalId>]]`, `#/p/<pid>/settings/<page>`, `#/inbox`. This absorbs backlog `ui-linkable-tabs` and `ui-return-to-plan` (the back link is the previous hash).
- State: one `useProjectData` hook holding tasks, plans and runner state fed by `useLive`; forms keep local dirty state and compare against the last-loaded server value (backlog `ui-settings-form-keeps-edits`); every mutation goes through one `act()` helper that shows a toast on `ApiError` (backlog `ui-surface-action-errors`).
- Live log: a virtualised log view that follows the tail and pauses when the user scrolls up; the steer box posts to `tasks.inject` with the mode toggle kept.
- Relative URLs and the token gate behaviour are unchanged (the UI runs under `/boof/` behind nginx).
- Styling migration: Tailwind v4 is added alongside `styles.css`; each screen is rebuilt in the new shell and its old CSS removed when it is replaced. No big-bang CSS rewrite.

## 7. Phases (plan only, no dates)

1. Foundation: Tailwind v4 and shadcn init, tokens light and dark, self-hosted Plex, app shell with rail, bottom bar and command palette, structured hash router. Old screens render inside the new shell.
2. Overview and the Now lane; live log component; steering moves into it.
3. Tasks list (grouped, keyboard, overflow menus) and task detail (two-pane, step strip, run/changes/questions).
4. Plans (progress header, goal rows, side panel) and the inbox/needs-you group.
5. Settings split into pages, API keys with rotate and full scopes, budgets.
6. Polish: dark mode pass, empty and error states, a11y audit (focus, contrast, reduced motion), remove `styles.css` leftovers, screenshots in the README.

Each phase is a separate PR that keeps the app usable.

## 8. Decisions made in this document (as the designer's calls)

- Keep the steel-blue accent and the "snow owl" light palette as the identity; sharpen rather than replace.
- Overview replaces Tasks as the landing tab.
- Actions tab is folded into the Needs-you group and a rail count.
- IBM Plex Sans and Mono, self-hosted; Google Fonts removed.
- shadcn/ui on Tailwind v4 rather than extending the hand-written CSS.
- The desktop app reuses the same UI unchanged (it loads the same bundle).

## 9. Gaps that need server or API work (to the backlog, not this design)

- Edits to a running task must survive the run (`running-task-edits-survive`), or the detail view must lock those fields while running.
- A per-step timing and verdict summary on the task (for the step strip) is derivable from reports today but a small `steps[]` field on the task would be cleaner.
- Plan import takes the goal title from the id when the goal file has none; the overview and plans screens assume a human title.
- Keyboard reorder and error surfacing are UI-only; optimistic concurrency needs `expectedUpdated` sent from the UI (`ui-optimistic-concurrency`).
- No `startedAt` or per-step timestamps exist on a task today; the runner's `### Role` log headers carry no time, and `updated` moves on every save. Elapsed time and step durations in the mock need a small server addition (`startedAt` plus a timestamp per step header, or a `steps[]` field). See section 11, question 3.
- The current UI detects proposed tasks by an `external:` label that nothing produces any more; the real signal is `origin.kind` (`api`, `mcp`) on a `draft` created by a review-trust client. The new UI reads the origin.

## 10. Left to the builder

Exact spacing and component variants, the icon set mapping, the virtualised log implementation, how the bottom bar surfaces the runner switch on phones, and the order of settings pages. Anything that changes what the user sees on the overview or the task detail comes back to the owner first.

## 11. Builder check: answers and open questions

A fresh frontend engineer read this document and listed what they would still have to guess. Settled here as the designer's calls unless marked "owner":

1. **What counts as "needs you".** Exactly three things: a task in `action` (the planner's questions), a `draft` task proposed by a review-trust client (`origin.kind` is `api` or `mcp` and the creator's trust was review), and a `draft` plan waiting for activation. A finished task with a branch is not "needs you": it sits under Finished with an "Open changes" link, because the API has no reviewed or acknowledged flag and the group must not grow without bound. If the owner wants finished branches to demand attention, that needs a small server flag (owner, see question A below).
2. **Concurrency above one.** The Now lane shows one running card per running task, stacked, each with its own log tail and steer box; the compact form on Tasks and Plans says "running: 2". The live-log component takes a task id, so N cards are N instances.
3. **Timings.** Owner question (B below). Until answered, the step strip shows roles and verdicts only, no durations, and the elapsed time on a running task is counted in the browser from the moment the UI saw it enter `running`.
4. **The pipeline is not linear.** The step strip shows the current run only, with one segment per role; fix rounds collapse into the role segment with a small round counter ("reviewer, round 2"); `runs > 1` shows "run 2 of 3" next to the strip. The Run tab underneath lists every report in order (the full history), so nothing is hidden.
5. **"Approve" in the palette** means two existing operations: set a draft plan to active, and queue a proposed draft task. The palette lists them as "Activate plan…" and "Queue proposed task…"; the word approve is not used in the UI. Tasks gets a "Proposed" group only when such drafts exist.
6. **Global versus per project.** The rail count is global (all projects) and `#/inbox` is the cross-project list of needs-you items, replacing the Actions tab; the Needs-you group on a project's Tasks shows that project only. The data hook therefore has one global feed from `GET /api/v1/actions` beside the per-project feed.

Owner's answers (2026-10-27):

- A. Finished work is history only: no `reviewed` flag, Finished keeps the "Open changes" link.
- B. One small server change is allowed: `startedAt` on the task and a timestamp on each `### Role` log header (or a `steps[]` field), landing before phase 3 so the step strip and the running card show real durations. Section 2's "no server change" non-goal is amended by this one exception.
- C. Component kit: not answered yet. shadcn/ui on Tailwind v4 stands as the designer's proposal until the owner says otherwise; phase 1 does not start before that is confirmed.
- D. Landing tab: Overview.
