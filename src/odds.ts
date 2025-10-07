import type { Env, PickRow } from "./db";

const API_HOST = "https://api.the-odds-api.com";
const SHARP = [
  "pinnacle",
  "betfair",
  "betfairex",
  "betfair_ex",
  "sbo",
  "sbobet",
  "matchbook",
  "circa",
];

const isSharp = (k = "", t = "") => {
  const s = (k + " " + t).toLowerCase();
  return SHARP.some((h) => s.includes(h));
};
const decToProb = (o: number) => (o <= 1 ? 0 : 1 / o);
const removeVigProportional = (odds: number[]) => {
  const probs = odds.map(decToProb);
  const sum = probs.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return probs.map((p) => p / sum);
};
const round = (x: number | null | undefined, d = 2) =>
  x == null ? null : Number(Number(x).toFixed(d));

const dbg = (env: any, ...args: any[]) => {
  if (env.DEBUG === "1") console.log("[DBG]", ...args);
};

async function apiGet(
  path: string,
  env: Env,
  params: Record<string, string> = {}
) {
  const url = new URL(`${API_HOST}${path}`);
  url.searchParams.set("apiKey", env.ODDS_API_KEY);
  for (const [k, v] of Object.entries(params))
    if (v != null) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Accept: "application/json" } });

  if (!r.ok) {
    const text = await r.text().catch(() => "<no-body>");
    // incluzi status + body în eroare ca să vezi cauza (cheie greșită, limită, etc.)
    throw new Error(`ODDS_API ${path} ${r.status} ${text}`);
  }
  return r.json();
}

export async function listSports(env: Env) {
  const all = await apiGet("/v4/sports/", env, { all: "true" });
  return [
    ...new Set(
      all
        .map((s: any) => s.key)
        .filter(
          (k: string) =>
            k && (k.startsWith("tennis_") || k.startsWith("soccer_"))
        )
    ),
  ];
}

export async function scanOnce(env: Env): Promise<PickRow[]> {
  try {
    const hours = Number(env.HOURS || "4");
    const evMin = Number(env.EV_MIN || "0.03");
    const region = env.REGION || "eu";

    const sports = await listSports(env);
    const rows: PickRow[] = [];

    const isoNoMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

    const now = new Date();
    const commenceFrom = isoNoMs(now);
    const commenceTo = isoNoMs(new Date(now.getTime() + hours * 3600_000));

    for (const sport_key of sports) {
      const events = await apiGet(`/v4/sports/${sport_key}/odds`, env, {
        regions: region,
        markets: "h2h",
        oddsFormat: "decimal",
        dateFormat: "iso",
        commenceTimeFrom: commenceFrom,
        commenceTimeTo: commenceTo,
      });

      for (const ev of events || []) {
        const event_id = ev?.id;
        const home = ev?.home_team;
        const away = ev?.away_team;
        const commence = ev?.commence_time;
        if (!event_id || !home || !away || !commence) continue;

        // 1) fair probs din sharp
        const sharpVecs: { names: string[]; probs: number[] }[] = [];
        const sharpTitles = new Set<string>();

        for (const bk of ev.bookmakers || []) {
          const k = (bk?.key || "").toString();
          const t = (bk?.title || "").toString();
          if (!isSharp(k, t)) continue;
          const m = (bk?.markets || []).find((x: any) => x?.key === "h2h");
          if (!m || !m.outcomes?.length) continue;

          const names = m.outcomes.map((o: any) => o?.name).filter(Boolean);
          const prices = m.outcomes
            .map((o: any) => Number(o?.price))
            .filter((x: number) => Number.isFinite(x));
          if (prices.length !== names.length || !prices.length) continue;

          const probs = removeVigProportional(prices);
          if (!probs) continue;
          sharpVecs.push({ names, probs });
          sharpTitles.add(t || k);
        }
        if (!sharpVecs.length) continue;

        const allNames = Array.from(new Set(sharpVecs.flatMap((v) => v.names)));
        const fairProbs = allNames.map((name) => {
          const vals: number[] = [];
          for (const v of sharpVecs) {
            const i = v.names.indexOf(name);
            if (i >= 0) vals.push(v.probs[i]);
          }
          return vals.length
            ? vals.reduce((a, b) => a + b, 0) / vals.length
            : 0;
        });

        // 2) best soft odds per outcome
        const best = allNames.map((n) => ({
          name: n,
          odds: 0,
          book: null as string | null,
        }));
        for (const bk of ev.bookmakers || []) {
          const m = (bk?.markets || []).find((x: any) => x?.key === "h2h");
          if (!m) continue;
          for (const out of m.outcomes || []) {
            const idx = allNames.indexOf(out?.name);
            const price = Number(out?.price);
            if (
              idx >= 0 &&
              Number.isFinite(price) &&
              price > (best[idx].odds || 0)
            ) {
              best[idx] = {
                name: out.name,
                odds: price,
                book: bk.title || bk.key,
              };
            }
          }
        }

        // 3) păstrează doar EV ≥ prag
        for (let i = 0; i < allNames.length; i++) {
          const pFair = fairProbs[i];
          const so = best[i];
          if (!so.odds || !pFair) continue;
          const evRel = so.odds * pFair - 1;
          if (evRel >= evMin) {
            const fairOdds = pFair > 0 ? 1 / pFair : null;
            rows.push({
              sport_key,
              event_id,
              commence_time_utc: commence,
              home,
              away,
              selection: so.name,
              market: "h2h",
              fair_odds: round(fairOdds, 3) as number | null,
              soft_odds: round(so.odds, 3) as number,
              ev_pct: round(evRel * 100, 2) as number,
              best_book: so.book,
              sharp_sources: Array.from(sharpTitles).sort().join(", "),
            });
          }
        }
      }
    }

    dbg(env, `scanOnce produced ${rows.length} rows`);
    return rows;
  } catch (e: any) {
    console.error("scanOnce error:", e?.message || e);
    throw e;
  }
}

export async function settlePending(env: Env) {
  // evenimente încă 'upcoming' a căror oră a trecut
  const rs = await env.DB.prepare(
    `
    SELECT DISTINCT sport_key, event_id
    FROM picks
    WHERE status='upcoming'
      AND datetime(commence_time_utc) <= datetime('now', '+6 hours')
    LIMIT 200
  `
  ).all();
  const bySport: Record<string, string[]> = {};
  for (const r of (rs.results || []) as any[]) {
    (bySport[r.sport_key] ||= []).push(r.event_id);
  }

  for (const [sport_key, ids] of Object.entries(bySport)) {
    for (let i = 0; i < ids.length; i += 25) {
      const group = ids.slice(i, i + 25);
      const data = await apiGet(`/v4/sports/${sport_key}/scores`, env, {
        dateFormat: "iso",
        eventIds: group.join(","),
        daysFrom: "3",
      });
      for (const ev of data) {
        if (!ev.completed) continue;
        const map = new Map<string, number>();
        for (const s of ev.scores || []) map.set(s.name, Number(s.score));
        const home = map.get(ev.home_team);
        const away = map.get(ev.away_team);
        if (!Number.isFinite(home) || !Number.isFinite(away)) continue;

        await env.DB.prepare(
          `
          UPDATE picks
          SET status = CASE
              WHEN selection = 'Draw' THEN (CASE WHEN ?1 = ?2 THEN 'won' ELSE 'lost' END)
              WHEN selection = ?3 THEN (CASE WHEN ?1 > ?2 THEN 'won' ELSE 'lost' END)
              WHEN selection = ?4 THEN (CASE WHEN ?2 > ?1 THEN 'won' ELSE 'lost' END)
              ELSE status
            END,
            score_home=?1, score_away=?2, resolved_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE event_id=?5 AND status='upcoming'
        `
        )
          .bind(home, away, ev.home_team, ev.away_team, ev.id)
          .run();
      }
    }
  }
}
