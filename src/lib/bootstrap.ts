// Lazy bootstrap: starts the queue dispatcher on the first request so we
// don't need a separate worker process for the assignment.
//
// In a real deployment you'd run the worker as its own process / pod and
// keep the API stateless. The flag here is global per-process; the
// assignment runs everything in one Next.js server, so this is enough.
import { startQueueDispatcher } from "@/lib/queue";

let started = false;
export function ensureBootstrapped() {
  if (started) return;
  started = true;
  startQueueDispatcher();
}
