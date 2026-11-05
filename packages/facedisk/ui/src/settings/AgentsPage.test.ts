import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RoleAssignment } from "@boof/heart/schema";
import { RoleSelects } from "./RoleSelects.js";

type ElementWithChildren = ReactElement<{ children?: ReactElement[] | ReactElement }>;
type SelectElement = ReactElement<{
  value: string;
  children: ReactElement<{ value: string; children: string }>[];
  onChange: (event: { target: { value: string } }) => void;
}>;

function selects(
  value: RoleAssignment,
  models: Record<string, string[]>,
  onChange: (a: RoleAssignment | undefined) => void,
) {
  const root = RoleSelects({
    role: "developer",
    value,
    tools: ["codex", "claude-code"],
    models,
    allowNone: false,
    onChange,
    onAddModel: () => {},
  }) as ElementWithChildren;
  const [tool, modelWrap] = root.props.children as [SelectElement, ElementWithChildren];
  const [model] = modelWrap.props.children as [SelectElement, ReactElement];
  return { tool, model };
}

describe("RoleSelects", () => {
  it("lets a saved Codex model switch back to the CLI default", () => {
    let saved: RoleAssignment | undefined;
    const { model } = selects(
      { tool: "codex", model: "gpt-5.5" },
      { codex: ["gpt-5.5"] },
      (next) => (saved = next),
    );

    expect(model.props.children.map((option) => option.props.value)).toEqual(["", "gpt-5.5"]);
    expect(model.props.children[0]?.props.children).toBe("Codex default (from the codex CLI)");
    model.props.onChange({ target: { value: "" } });
    expect(saved).toEqual({ tool: "codex", model: "" });
  });

  it("switches empty Codex to Claude with a model and back to the Codex default", () => {
    let saved: RoleAssignment | undefined;
    const models = { codex: ["gpt-5.5"], "claude-code": ["opus", "sonnet"] };
    const { tool } = selects({ tool: "codex", model: "" }, models, (next) => (saved = next));

    tool.props.onChange({ target: { value: "claude-code" } });
    expect(saved).toEqual({ tool: "claude-code", model: "opus" });
    const switchedBack = selects(saved!, models, (next) => (saved = next));
    switchedBack.tool.props.onChange({ target: { value: "codex" } });
    expect(saved).toEqual({ tool: "codex", model: "" });
    const codexAgain = selects(saved!, models, (next) => (saved = next));
    expect(codexAgain.model.props.children.map((option) => option.props.value)).toContain("");
  });
});

describe("inheritedRoleLabel", () => {
  it("includes the inherited tool alongside the model label", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./AgentsPage.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("return `${tool}, ${roleModelLabel(tool, model)}`;");
    expect(source).toContain("inheritedRoleLabel(g.roles[role]!.tool, g.roles[role]!.model)");
  });
});
