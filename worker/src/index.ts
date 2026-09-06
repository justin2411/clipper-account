// Einstieg: fetch → HTTP-API, scheduled → Cron-Funktion nach Cron-Ausdruck (siehe wrangler.toml).
import { Env, logEvent } from "./shared";
import { handleRequest, FUNCTIONS } from "./api";

const CRON_TO_FN: Record<string, keyof typeof FUNCTIONS> = {
  "*/10 * * * *": "scout",
  "*/30 * * * *": "publisher",
  "0 */6 * * *": "tracker",
  "0 19 * * *": "notify",
};

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleRequest(req, env, ctx),

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const name = CRON_TO_FN[event.cron];
    if (!name) { console.log("[cron] unbekannter Cron", event.cron); return; }
    const t0 = Date.now();
    try {
      const result = await FUNCTIONS[name](env);
      console.log(`[cron] ${name} ok ${Date.now() - t0}ms`, JSON.stringify(result));
      await logEvent(env, `cron ${name} ok ${JSON.stringify(result ?? {}).slice(0, 120)}`);   // Heartbeat fürs Dashboard (Pipeline-Stufen)
    } catch (e: any) {
      console.log(`[cron] ${name} FEHLER`, e?.message ?? e);
      await logEvent(env, `cron ${name} error ${String(e?.message ?? e).slice(0, 120)}`).catch(() => {});
    }
  },
} satisfies ExportedHandler<Env>;
