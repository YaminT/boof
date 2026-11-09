/**
 * What the web UI does for each operation of the registry, in registry order. `where` names the
 * UI client method (`api.ts`) and the screen that calls it; `none` says why the UI does not do it.
 * Data only: nothing in the app imports this file. `packages/heart-server/src/server/op-coverage.test.ts` checks it
 * against the registry, so a new operation must be listed here (a reviewed decision).
 */
export const OP_COVERAGE: Record<string, { where: string } | { none: string }> = {
  "auth.whoami": {
    where:
      "whoami \u2014 AutomationPage, KeysPage, useHeldScopes (who the key is, what it may do; the console and Manage epics use it)",
  },
  "projects.list": {
    where:
      "listProjects \u2014 useProjects, ArchivedProjects (the project switcher, archived list)",
  },
  "projects.create": { where: "createProject \u2014 Projects (the new-project dialog)" },
  "projects.get": { where: "getProject \u2014 ChangesPanel (the current branch)" },
  "projects.update": {
    where: "updateProject \u2014 useSettingsPage (project settings, name, pause)",
  },
  "projects.archive": { where: "archiveProject \u2014 ProjectPage (archive the project)" },
  "projects.unarchive": {
    where: "unarchiveProject \u2014 ArchivedProjects (restore an archived project)",
  },
  "projects.pause": { none: "the project settings page sets `paused` through projects.update" },
  "projects.resume": { none: "the project settings page sets `paused` through projects.update" },
  "projects.delete": { where: "deleteProject \u2014 ArchivedProjects (purge an archived project)" },
  "projects.usage": { where: "projectUsage \u2014 BudgetsPage (project usage)" },
  "plans.list": { where: "listPlans \u2014 useAppData (the Plans list)" },
  "plans.create": { where: "createPlan \u2014 PlansPage (new plan)" },
  "plans.get": { where: "getPlan \u2014 usePlan, GoalEditor (the plan screen)" },
  "plans.update": {
    where: "updatePlan \u2014 PlanPage, InboxPage, useCommandActions (approve, draft, archive)",
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
    where: "updateTask \u2014 TaskForm, NeedsYouList, useCommandActions, InboxPage (edit a task)",
  },
  "tasks.move": {
    where:
      "moveTask \u2014 useTaskActions, useCommandActions (detach, move to an epic, make a subtask)",
  },
  "tasks.queue": {
    where:
      "updateTask {status: pending} \u2014 useTaskActions, NeedsYouList, InboxPage, useCommandActions (queue buttons)",
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
    where: "stopTask \u2014 RunningCard, useCommandActions, useTaskActions (stop a running task)",
  },
  "tasks.inject": { where: "injectPrompt \u2014 SteerBox (steer a running task)" },
  "tasks.liveLog": { where: "liveLog \u2014 NowStrip, useLiveLog (the live output)" },
  "tasks.wait": { none: "the UI follows changes through the event stream" },
  "tasks.attachments.add": { where: "uploadAttachment \u2014 TaskAttachments (attach a file)" },
  "tasks.attachments.remove": { where: "deleteAttachment \u2014 TaskAttachments (remove a file)" },
  "tasks.attachments.get": {
    where: "attachmentBlobUrl \u2014 TaskAttachments (show an attachment)",
  },
  "epics.list": { where: "listEpics \u2014 useEpics (epic names on task rows and task pages)" },
  "epics.get": { none: "the hierarchy UI is not built yet" },
  "epics.create": { where: "createEpic \u2014 ManageEpicsSheet, useCommandActions (add an epic)" },
  "epics.update": {
    where: "updateEpic \u2014 ManageEpicsSheet (rename, priority, archive, restore)",
  },
  "epics.delete": { where: "deleteEpic \u2014 ManageEpicsSheet (delete, or delete and detach)" },
  "settings.get": { where: "getSettings \u2014 useAppData (global settings)" },
  "settings.update": {
    where:
      "updateSettings \u2014 useSettingsPage, Projects, RunnerSwitch, useCommandActions (change settings)",
  },
  "settings.health": {
    none: "the UI runs the check itself (settings.checkHealth) and shows its result",
  },
  "settings.checkHealth": { where: "health \u2014 AgentsPage (tool health check on open)" },
  "settings.models": {
    none: "the UI refreshes the lists itself (settings.refreshModels) and reads the details",
  },
  "settings.refreshModels": { where: "models \u2014 AgentsPage (model lists on open)" },
  "models.details": {
    where: "modelDetails \u2014 AgentsPage (models with their source and health)",
  },
  "usage.global": { where: "usage \u2014 BudgetsPage (token usage)" },
  "usage.budget": {
    where: "budget \u2014 useAppData (budget status for the banner and spend bar)",
  },
  "runner.status": {
    where:
      "runnerStatus \u2014 AgentsPage, useAgentAuth (the claude-agent ready or refused line; the shell still reads the runner state from settings.get)",
  },
  "runner.overview": {
    none: "the shell reads the runner state from settings.get and usage.budget",
  },
  "runner.setEnabled": {
    where: "updateSettings {runner.enabled} \u2014 RunnerSwitch (the runner switch)",
  },
  "actions.list": { where: "actions \u2014 useAppData (tasks that need an answer)" },
  "commands.list": { where: "listCommands \u2014 CommandTemplates, TaskForm (command templates)" },
  "commands.create": { where: "upsertCommand \u2014 CommandTemplates (create a template)" },
  "commands.update": { where: "renameCommand \u2014 CommandTemplates (rename or edit a template)" },
  "commands.delete": { where: "deleteCommand \u2014 CommandTemplates (delete a template)" },
  "auth.clients.list": { where: "listClients \u2014 KeysPage (API clients)" },
  "auth.clients.create": { where: "createClient \u2014 KeysPage (new API client)" },
  "auth.clients.revoke": { where: "revokeClient \u2014 KeysPage (revoke a client)" },
  "auth.clients.rotate": { where: "rotateClient \u2014 KeysPage (rotate a client's key)" },
  "accounts.list": { where: "listAccounts — AccountsPage (pool account list)" },
  "accounts.agentSdk": {
    where:
      "agentSdkEligibility \u2014 AccountsPage, ProjectPage (Agent SDK badges and the eligibility line)",
  },
  "accounts.health": { where: "accountsHealth — AccountsPage (pool status and gate)" },
  "accounts.pause": { where: "accountAction — AccountsPage (pause an account)" },
  "accounts.resume": { where: "accountAction — AccountsPage (resume an account)" },
  "accounts.priority": { where: "accountPriority — AccountsPage (routing priority)" },
  "accounts.thresholds": { where: "accountThresholds — AccountsPage (usage pause thresholds)" },
  "webhooks.list": { where: "listWebhooks \u2014 Webhooks (the webhook list)" },
  "webhooks.create": {
    where: "createWebhook \u2014 Webhooks (new webhook; the secret is shown once)",
  },
  "webhooks.update": { where: "updateWebhook \u2014 Webhooks (enable, disable, edit)" },
  "webhooks.delete": { where: "deleteWebhook \u2014 Webhooks (delete a webhook)" },
  "n8n.get": { none: "UI arrives in the n8n UI task" },
  "n8n.update": { none: "UI arrives in the n8n UI task" },
  "n8n.delete": { none: "UI arrives in the n8n UI task" },
  "n8n.workflows.list": { none: "UI arrives in the n8n UI task" },
  "n8n.workflows.refresh": { none: "UI arrives in the n8n UI task" },
  "concierge.status": {
    where:
      "conciergeStatus \u2014 useConcierge (reloads when the project changes and after each message)",
  },
  "concierge.ask": {
    where: "conciergeStream \u2014 useConcierge (streams one message; refusals arrive as JSON)",
  },
  "concierge.apply": {
    where: "conciergeApply \u2014 useConcierge (applies a pending change with the caller's rights)",
  },
  "concierge.discard": {
    where: "conciergeDiscard \u2014 useConcierge (discards a pending change)",
  },
  "concierge.reset": {
    where: "conciergeReset \u2014 useConcierge (ends the current conversation)",
  },
};
