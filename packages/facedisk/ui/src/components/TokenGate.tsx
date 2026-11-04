import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { clearToken, setToken } from "../token.js";

/**
 * Shown when the API answers 401: the server requires an API key. The key is
 * pasted (created with `boof-runner auth add`) and kept in sessionStorage only.
 */
export function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto my-[12vh] max-w-[440px] rounded-[10px] border border-line bg-surface p-6 shadow-md">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setToken(value);
          onSubmit();
        }}
      >
        <h2 className="m-0">API key required</h2>
        <p className="m-0 text-ink-muted">
          This Boof Runner server requires authentication. Paste an API key created with{" "}
          <code>boof-runner auth add</code>. It is kept for this browser tab only.
        </p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          API key
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="boof_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              clearToken();
              setValue("");
            }}
          >
            Clear
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            Continue
          </Button>
        </div>
      </form>
    </div>
  );
}
