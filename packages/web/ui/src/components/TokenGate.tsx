import { useState } from "react";
import { clearToken, setToken } from "../token.js";

/**
 * Shown when the API answers 401: the server requires an API key. The key is
 * pasted (created with `boof-runner auth add`) and kept in sessionStorage only.
 */
export function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="token-gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setToken(value);
          onSubmit();
        }}
      >
        <h2>API key required</h2>
        <p className="muted">
          This Boof Runner server requires authentication. Paste an API key created with{" "}
          <code>boof-runner auth add</code>. It is kept for this browser tab only.
        </p>
        <label>
          API key
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="boof_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="editor-actions">
          <button
            type="button"
            onClick={() => {
              clearToken();
              setValue("");
            }}
          >
            Clear
          </button>
          <button type="submit" className="primary" disabled={!value.trim()}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
