import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { clearToken, setToken, type UnauthorizedReason } from "../token.js";

/**
 * Shown when the API answers 401: the server requires an API key. The key is
 * pasted (created with `boof-runner auth add`) and kept in sessionStorage only.
 */
export function TokenGate({
  onSubmit,
  reason = "key",
}: {
  onSubmit: () => void;
  reason?: UnauthorizedReason;
}) {
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
        {reason === "signin" ? (
          <>
            <h2 className="m-0">Sign in to Boof Runner</h2>
            <p className="m-0 text-ink-muted">
              This browser is not signed in. On this machine, run <code>boof-runner open</code> and
              open the link it prints. If you started <code>boof-runner serve</code>, its sign-in
              link works too. Or paste an API key below.
            </p>
          </>
        ) : (
          <>
            <h2 className="m-0">API key required</h2>
            <p className="m-0 text-ink-muted">
              This Boof Runner server requires authentication. Paste an API key created with{" "}
              <code>boof-runner auth add</code>. It is kept for this browser tab only.
            </p>
          </>
        )}
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

/**
 * Shown in place of the sign-in gate when the server cannot keep browser sign-ins (its folder has
 * unsafe permissions). `message` is the server's text, rendered as plain text. The event stream
 * stays paused until the page is reloaded.
 */
export function SignInStorageError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mx-auto my-[12vh] max-w-[440px] rounded-[10px] border border-line bg-surface p-6 shadow-md"
    >
      <div className="flex flex-col gap-3.5">
        <h2 className="m-0">Sign-in storage needs fixing</h2>
        <p className="m-0 text-ink-muted">
          This Boof Runner server cannot keep browser sign-ins. Fix the item below, then reload this
          page.
        </p>
        <p className="m-0 break-words font-mono text-sm">{message}</p>
      </div>
    </div>
  );
}
