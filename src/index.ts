import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, PickRow } from "./db";
import { upsertPick } from "./db";
import { scanOnce, settlePending } from "./odds";

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*" }));

// Global error handler – orice excepție devine JSON clar
app.onError((err, c) =>
  c.json({ ok: false, error: err?.message || String(err) }, 500)
);

// Healthcheck simplu
app.get("/api/health", (c) => c.text("ok"));

// Diagnostic: verifică D1 + The Odds API (fără să expună cheia)
app.get("/api/diag", async (c) => {
  const hasKey = Boolean(c.env.ODDS_API_KEY && c.env.ODDS_API_KEY.length > 10);
  try {
    await c.env.DB.prepare("SELECT 1").all();
  } catch (e: any) {
    return c.json({ ok: false, where: "d1", error: e.message, hasKey }, 500);
  }
  try {
    const r = await fetch(
      "https://api.the-odds-api.com/v4/sports/?all=true&apiKey=" +
        c.env.ODDS_API_KEY
    );
    const body = await (r.ok
      ? Promise.resolve(null)
      : r.text().catch(() => "<no-body>"));
    return c.json({
      ok: true,
      hasKey,
      odds_api: { ok: r.ok, status: r.status, body },
    });
  } catch (e: any) {
    return c.json(
      { ok: false, where: "odds_api", error: e.message, hasKey },
      500
    );
  }
});

// Trigger manual de scan (insertă picks cu EV≥prag)
app.post("/api/scan", async (c) => {
  try {
    const rows = await scanOnce(c.env);
    let inserted = 0;
    for (const r of rows) {
      await upsertPick(c.env, r as PickRow);
      inserted++;
    }
    return c.json({ ok: true, inserted });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || "scan failed" }, 500);
  }
});

// Upcoming picks
app.get("/api/upcoming", async (c) => {
  const rows = await c.env.DB.prepare(
    `
    SELECT * FROM picks
    WHERE status='upcoming'
    ORDER BY datetime(commence_time_utc) ASC
    LIMIT 500
  `
  ).all();
  return c.json(rows.results || []);
});

// Logs (all-time)
app.get("/api/logs", async (c) => {
  const limit = Number(c.req.query("limit") || "500");
  const rows = await c.env.DB.prepare(
    `
    SELECT * FROM picks
    WHERE status!='upcoming'
    ORDER BY datetime(resolved_at) DESC
    LIMIT ?1
  `
  )
    .bind(limit)
    .all();
  return c.json(rows.results || []);
});

// Stats agregate
app.get("/api/stats", async (c) => {
  const t = await c.env.DB.prepare(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) AS won,
      AVG(soft_odds) AS avg_soft_odds
    FROM picks
  `
  ).all();
  const totals = (t.results?.[0] || {
    total: 0,
    won: 0,
    avg_soft_odds: null,
  }) as any;

  const p = await c.env.DB.prepare(
    `
    SELECT COUNT(*) AS n FROM picks WHERE status IN ('won','lost','push')
  `
  ).all();
  const played = (p.results?.[0]?.n || 0) as number;
  const success = played ? (Number(totals.won || 0) / played) * 100 : 0;

  return c.json({
    total_picks: Number(totals.total || 0),
    played,
    won: Number(totals.won || 0),
    success_rate: Number(success.toFixed(2)),
    avg_odds: totals.avg_soft_odds
      ? Number(Number(totals.avg_soft_odds).toFixed(3))
      : null,
  });
});

export default {
  fetch: app.fetch,
  // Cron triggers (setate în wrangler.toml): scan & settle
  scheduled: async (_evt: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      (async () => {
        const rows = await scanOnce(env);
        for (const r of rows) await upsertPick(env, r as PickRow);
      })()
    );
    ctx.waitUntil(settlePending(env));
  },
};
