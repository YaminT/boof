import { act } from "./act.js";
import { clearStopPending } from "./stop-request.js";

/** Report a palette stop through a toast and release its latch if the request fails. */
export async function requestPaletteStop(
  pid: string,
  id: string,
  request: () => Promise<unknown>,
): Promise<unknown | undefined> {
  const result = await act(request, { success: "Stop requested", failure: "Could not stop" });
  if (result === undefined) clearStopPending(pid, id);
  return result;
}
