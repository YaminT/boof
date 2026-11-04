import { toast } from "sonner";
import { ApiError } from "../api.js";

export interface Notifier {
  success(msg: string): void;
  error(msg: string): void;
}

export interface ActOptions {
  success?: string;
  failure?: string;
  /** Handles an error itself; return true to suppress the error toast. */
  onError?: (err: unknown) => boolean;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your API key was rejected. Enter a new one.";
    if (err.status === 400 && Array.isArray(err.details)) {
      const details = err.details as { path?: string; message: string }[];
      if (details.length)
        return `${err.message}: ${details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; ")}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Run `fn`, report the outcome through `notify`, and never throw. */
export async function runAction<T>(
  fn: () => Promise<T>,
  notify: Notifier,
  opts: ActOptions = {},
): Promise<T | undefined> {
  try {
    const value = await fn();
    if (opts.success) notify.success(opts.success);
    return value;
  } catch (err) {
    // A request refused because the key was replaced or is being rotated: nothing to report.
    if (err instanceof ApiError && err.quiet) return undefined;
    if (opts.onError?.(err)) return undefined;
    notify.error(opts.failure ? `${opts.failure}: ${errorMessage(err)}` : errorMessage(err));
    return undefined;
  }
}

/** `runAction` reporting through sonner toasts. */
export const act = <T>(fn: () => Promise<T>, opts?: ActOptions): Promise<T | undefined> =>
  runAction(fn, { success: (m) => void toast.success(m), error: (m) => void toast.error(m) }, opts);
