import { useEffect, useState } from "react";
import { api } from "../api.js";

const titles = new Map<string, string | null>();

/** Titles of the given `pid/taskId` keys, each fetched once (the overview lists only ids). */
export function useTaskTitles(keys: readonly string[]): (key: string) => string | null {
  const [, bump] = useState(0);
  const joined = keys.join("\n");
  useEffect(() => {
    let live = true;
    for (const key of joined ? joined.split("\n") : []) {
      if (titles.has(key)) continue;
      titles.set(key, null);
      const [pid, taskId] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
      api.getTask(pid, taskId).then(
        (task) => {
          titles.set(key, task.frontmatter.title);
          if (live) bump((n) => n + 1);
        },
        () => titles.delete(key),
      );
    }
    return () => {
      live = false;
    };
  }, [joined]);
  return (key) => titles.get(key) ?? null;
}
