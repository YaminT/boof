/**
 * What the web UI does for each operation of the registry, in registry order. `where` names the
 * UI client method (`api.ts`) and the screen that calls it; `none` says why the UI does not do it.
 * Data only: nothing in the app imports this file. `packages/web/src/op-coverage.test.ts` checks it
 * against the registry, so a new operation must be listed here (a reviewed decision).
 */
export const OP_COVERAGE: Record<string, { where: string } | { none: string }> = {
  "auth.whoami": {
    none: "no identity screen; the UI acts as the local principal or its stored token",
  },
  "projects.list": { where: "listProjects \u2014 useProjects (the project switcher)" },
  "projects.create": { where: "createProject \u2014 Projects (the new-project dialog)" },
  "projects.get": { where: "getProject \u2014 ChangesPanel (the current branch)" },
  "projects.update": { where: "updateProject \u2014 SettingsPage (project settings, name, pause)" },
  "projects.archive": { where: "archiveProject \u2014 SettingsPage (archive the project)" },
  "projects.unarchive": {
    none: "no control restores an archived project; use REST, MCP or the CLI",
  },
  "projects.pause": { none: "the project settings page sets `paused` through projects.update" },
  "projects.resume": { none: "the project settings page sets `paused` through projects.update" },
  "projects.delete": {
    none: "the UI archives a project (projects.archive); purge is REST, MCP or CLI only",
  },
  "projects.usage": { where: "projectUsage \u2014 SettingsPage (project usage)" },
  "plans.list": { where: "listPlans \u2014 useAppData (the Plans list)" },
  "plans.create": { where: "createPlan \u2014 PlansPage (new plan)" },
  "plans.get": { where: "getPlan \u2014 usePlan, GoalEditor (the plan screen)" },
  "plans.update": {
    where: "updatePlan \u2014 PlanPage, InboxPage, CommandPalette (approve, draft, archive)",
  },
  "plans.replaceGoals": {
    none: "goals are edited one at a time (plans.upsertGoal, plans.removeGoal)",
  },
  "plans.upsertGoal": { where: "putGoal \u2014 GoalEditor (add or edit a goal)" },
  "plans.removeGoal": { where: "deleteGoal \u2014 PlanPage (remove a goal)" },
  "plans.reorderGoals": { where: "reorderGoals \u2014 PlanPage (drag a goal)" },
  "plans.setGoalStatus": { where: "setGoalStatus \u2014 PlanPage (set a goal's status)" },
  "plans.import": { where: "importPlan \u2014 PlansPage (import goal files)" },
  "plans.export": { where: "exportPlan \u2014 PlanPage (export XML)" },
  "plans.sync": { where: "syncPlan \u2014 PlanPage (sync a plan to tasks)" },
  "plans.wait": { none: "the UI follows changes through the event stream" },
  "tasks.list": { where: "listTasks \u2014 useAppData (the Tasks list)" },
  "tasks.get": { where: "getTask \u2014 useTask, TaskForm, useTaskActions (the task screen)" },
  "tasks.diff": { where: "getTaskDiff \u2014 ChangesPanel (what a task changed)" },
  "tasks.create": { where: "createTask \u2014 TaskForm, useTaskActions (new task)" },
  "tasks.update": {
    where: "updateTask \u2014 TaskForm, NeedsYouList, CommandPalette (edit a task)",
  },
  "tasks.move": { none: "the hierarchy UI is not built yet" },
  "tasks.queue": {
    where:
      "updateTask {status: pending} \u2014 Queue buttons (useTaskActions, NeedsYouList, InboxPage, CommandPalette)",
  },
  "tasks.skip": { where: "setSkip \u2014 TaskRowMenu, useTaskActions (skip or unskip)" },
  "tasks.reorder": { where: "reorder \u2014 TasksPage (drag a task)" },
  "tasks.retry": { where: "retry \u2014 TaskDetailPage, TaskRow, useTaskActions (retry a task)" },
  "tasks.archive": {
    where: "archive \u2014 TaskHeader, TaskRowMenu, useTaskActions (archive a task)",
  },
  "tasks.unarchive": {
    where: "unarchive \u2014 TaskHeader, TaskRowMenu, useTaskActions (restore a task)",
  },
  "tasks.delete": { where: "deleteTask \u2014 TaskDetailPage (delete a task)" },
  "tasks.answers": { where: "submitAnswers \u2014 AnswerBox (answer the planner's questions)" },
  "tasks.stop": {
    where: "stopTask \u2014 RunningCard, CommandPalette, useTaskActions (stop a running task)",
  },
  "tasks.inject": { where: "injectPrompt \u2014 SteerBox (steer a running task)" },
  "tasks.liveLog": { where: "liveLog \u2014 NowStrip, useLiveLog (the live output)" },
  "tasks.wait": { none: "the UI follows changes through the event stream" },
  "tasks.attachments.add": { where: "uploadAttachment \u2014 TaskAttachments (attach a file)" },
  "tasks.attachments.remove": { where: "deleteAttachment \u2014 TaskAttachments (remove a file)" },
  "tasks.attachments.get": {
    where: "attachmentBlobUrl \u2014 TaskAttachments (show an attachment)",
  },
  "epics.list": { none: "the hierarchy UI is not built yet" },
  "epics.get": { none: "the hierarchy UI is not built yet" },
  "epics.create": { none: "the hierarchy UI is not built yet" },
  "epics.update": { none: "the hierarchy UI is not built yet" },
  "epics.delete": { none: "the hierarchy UI is not built yet" },
  "settings.get": { where: "getSettings \u2014 useAppData (global settings)" },
  "settings.update": { where: "updateSettings \u2014 SettingsPage, Projects (change settings)" },
  "settings.health": {
    none: "the UI runs the check itself (settings.checkHealth) and shows its result",
  },
  "settings.checkHealth": {
    where: "health (POST) \u2014 SettingsPage (tool health check on open)",
  },
  "settings.models": {
    none: "the UI refreshes the lists itself (settings.refreshModels) and reads the details",
  },
  "settings.refreshModels": { where: "models (POST) \u2014 SettingsPage (model lists on open)" },
  "models.details": {
    where: "modelDetails \u2014 SettingsPage (models with their source and health)",
  },
  "usage.global": { where: "usage \u2014 SettingsPage (token usage)" },
  "usage.budget": { where: "budget \u2014 SettingsPage, useAppData (budget status)" },
  "runner.status": { none: "the shell reads the runner state from settings.get and usage.budget" },
  "runner.overview": {
    none: "the shell reads the runner state from settings.get and usage.budget",
  },
  "runner.setEnabled": {
    where: "updateSettings {runner.enabled} \u2014 RunnerSwitch, RunnerToggle",
  },
  "actions.list": { where: "actions \u2014 useAppData (tasks that need an answer)" },
  "commands.list": { where: "listCommands \u2014 CommandsTab, TaskForm (command templates)" },
  "commands.create": { where: "upsertCommand \u2014 CommandsTab (create a template)" },
  "commands.update": { where: "renameCommand \u2014 CommandsTab (rename or edit a template)" },
  "commands.delete": { where: "deleteCommand \u2014 CommandsTab (delete a template)" },
  "auth.clients.list": { where: "listClients \u2014 ClientsSection (API clients)" },
  "auth.clients.create": { where: "createClient \u2014 ClientsSection (new API client)" },
  "auth.clients.revoke": { where: "revokeClient \u2014 ClientsSection (revoke a client)" },
  "auth.clients.rotate": {
    none: "the clients screen can create and revoke, not rotate; use REST, MCP or the CLI",
  },
  "webhooks.list": { none: "no webhook screen; use REST, MCP or the CLI" },
  "webhooks.create": { none: "no webhook screen; use REST, MCP or the CLI" },
  "webhooks.delete": { none: "no webhook screen; use REST, MCP or the CLI" },
};
