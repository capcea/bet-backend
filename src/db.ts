export type Env = {
  DB: D1Database
  ODDS_API_KEY: string
  REGION: string
  SPORTS: string
  EV_MIN: string
  HOURS: string
}

export type PickRow = {
  sport_key: string
  event_id: string
  commence_time_utc: string
  home: string
  away: string
  selection: string
  market: string
  fair_odds: number | null
  soft_odds: number
  ev_pct: number
  best_book: string | null
  sharp_sources: string
}

export async function upsertPick(env: Env, p: PickRow) {
  const exists = await env.DB.prepare(
    "SELECT id FROM picks WHERE event_id=?1 AND selection=?2"
  ).bind(p.event_id, p.selection).first()
  if (exists) return exists.id

  const res = await env.DB.prepare(`
    INSERT INTO picks
      (sport_key,event_id,commence_time_utc,home,away,selection,market,
       fair_odds,soft_odds,ev_pct,best_book,sharp_sources)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
  `).bind(
    p.sport_key, p.event_id, p.commence_time_utc, p.home, p.away, p.selection, p.market,
    p.fair_odds, p.soft_odds, p.ev_pct, p.best_book, p.sharp_sources
  ).run()

  return res.lastRowId
}
