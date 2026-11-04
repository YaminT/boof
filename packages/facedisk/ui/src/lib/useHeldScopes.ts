import { useEffect, useState } from "react";
import type { Scope } from "@boof/heart/schema";
import { api } from "../api.js";
import { heldScopes } from "./clients.js";

/**
 * The scopes this browser's key holds, from whoami; "all" until known or when the key is local or
 * admin. Only for hiding what the key cannot do: the server stays the judge.
 */
export function useHeldScopes(): ReadonlySet<Scope> | "all" {
  const [held, setHeld] = useState<ReadonlySet<Scope> | "all">("all");
  useEffect(() => {
    let live = true;
    api.whoami().then(
      (w) => live && setHeld(heldScopes(w)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return held;
}
