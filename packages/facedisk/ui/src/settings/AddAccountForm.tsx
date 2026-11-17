import { useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Alert } from "../ui/alert.js";
import { GatewayKeyField } from "./GatewayKeyField.js";
import { inputErrorLines } from "../lib/automation.js";
import { addAccountProblem } from "../lib/gateway-mode.js";

const inputClass = "min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ink";
const labelClass = "flex min-w-0 flex-col gap-1 text-sm text-ink-muted";

/** Adds an Anthropic API-key account to the internal pool. The key field is write-only and is cleared after use. */
export function AddAccountForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (input: { name: string; apiKey: string; priority?: number }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const problem = addAccountProblem(name, apiKey, priority);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onAdd({
        name: name.trim(),
        apiKey: apiKey.trim(),
        ...(priority.trim() !== "" ? { priority: Number(priority) } : {}),
      });
      setName("");
      setPriority("");
      setApiKey("");
    } catch (e) {
      setError(inputErrorLines(e).join("; "));
      setApiKey("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={labelClass}>
        Account name
        <Input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || busy}
        />
      </label>
      <label className={labelClass}>
        Priority (0 to 100, lower is used first)
        <Input
          className={inputClass}
          type="number"
          min="0"
          max="100"
          placeholder="Optional"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          disabled={disabled || busy}
        />
      </label>
      <GatewayKeyField
        label="Anthropic API key"
        noun="API key"
        source={null}
        value={apiKey}
        onChange={setApiKey}
        disabled={disabled || busy}
        placeholder="sk-ant-api..."
      />
      <div className="flex items-end">
        <Button className="" type="submit" disabled={disabled || busy}>
          Add account
        </Button>
      </div>
      {error && <Alert className="m-0 sm:col-span-2">{error}</Alert>}
    </form>
  );
}
