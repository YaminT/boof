import { toast } from "sonner";
import { ApiError } from "../api.js";

export interface Notifier {
  success(msg: string): void;
  error(msg: string): void;
}

export interface ActOptions {
  success?: string;
  failure?: string;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status === 401 ? "Your API key was rejected. Enter a new one." : err.message;
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
    notify.error(opts.failure ? `${opts.failure}: ${errorMessage(err)}` : errorMessage(err));
    return undefined;
  }
}

/** `runAction` reporting through sonner toasts. */
export const act = <T>(fn: () => Promise<T>, opts?: ActOptions): Promise<T | undefined> =>
  runAction(fn, { success: (m) => void toast.success(m), error: (m) => void toast.error(m) }, opts);
