import "dotenv/config";
import express from "express";
import db from "./db.js";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

const API_HOST = "https://api.the-odds-api.com";
const APIKEY = process.env.ODDS_API_KEY;
const REGION = process.env.REGION || "eu";
const SPORTS = (process.env.SPORTS || "tennis,soccer").split(",").map(s => s.trim().toLowerCase());
const EV_MIN = Number(process.env.EV_MIN || 0.03);
const HOURS = Number(process.env.HOURS || 4);

const SHARP_HINTS = ["pinnacle","betfair","betfair_ex","sbo","sbobet","matchbook","circa"];
const decToProb = o => (o <= 1 ? 0 : 1 / o);

function removeVigProportional(decimalOdds) {
  const probs = decimalOdds.map(decToProb);
  const sum = probs.reduce((a,b)=>a+b,0);
  if (sum <= 0) return null;
  return probs.map(p => p / sum);
}
const isSharp = (key="", title="") => {
  const s = `${key} ${title}`.toLowerCase();
  return SHARP_HINTS.some(h => s.includes(h));
};

const insertPick = db.prepare(`
  INSERT INTO picks
  (sport_key,event_id,commence_time_utc,home,away,selection,market,fair_odds,soft_odds,ev_pct,best_book,sharp_sources)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);
const upsertPick = (p) => {
  const exists = db.prepare(`SELECT id FROM picks WHERE event_id=? AND selection=?`).get(p.event_id, p.selection);
  if (exists) return exists.id;
  const info = insertPick.run(
    p.sport_key, p.event_id, p.commence_time_utc, p.home, p.away, p.selection, p.market,
    p.fair_odds, p.soft_odds, p.ev_pct, p.best_book, p.sharp_sources
  );
  return info.lastInsertRowid;
};

async function apiGet(path, params={}) {
  const url = new URL(`${API_HOST}${path}`);
  url.searchParams.set("apiKey", APIKEY);
  Object.entries(params).forEach(([k,v]) => {
    if (v !== undefined && v !== null && `${v}`.length) url.searchParams.set(k, v);
  });
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`API ${path} ${r.status}: ${body}`);
  }
  return r.json();
}

async function listSports() {
  const all = await apiGet("/v4/sports/", { all: "true" });
  const keys = all
    .map(s => s.key)
    .filter(k => k && (k.startsWith("tennis_") || k.startsWith("soccer_")));
  return [...new Set(keys)];
}

const round = (x, d=2) => Number.parseFloat(x).toFixed(d) * 1;
const chunk = (arr, n) => arr.reduce((acc,_,i) => (i%n?acc:acc.concat([arr.slice(i,i+n)])),[]);
function interpretScores(homeName, awayName, scores) {
  const map = new Map();
  for (const s of scores || []) {
    map.set(s.name, Number(s.score));
  }
  const home = Number(map.get(homeName));
  const away = Number(map.get(awayName));
  if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  return null;
}

async function scanOnce({hours=HOURS, evMin=EV_MIN} = {}) {
  const sports = await listSports();
  if (!sports.length) return { inserted: 0 };

  const commenceFrom = DateTime.utc().toISO();
  const commenceTo = DateTime.utc().plus({ hours }).toISO();

  let inserted = 0;

  for (const sport_key of sports) {
    const events = await apiGet(`/v4/sports/${sport_key}/odds`, {
      regions: REGION,
      markets: "h2h",
      oddsFormat: "decimal",
      dateFormat: "iso",
      commenceTimeFrom: commenceFrom,
      commenceTimeTo: commenceTo
    });

    for (const ev of events) {
      const event_id = ev.id;
      const home = ev.home_team;
      const away = ev.away_team;
      const commence = ev.commence_time;

      const sharpProbVectors = [];
      const sharpTitles = new Set();

      for (const bk of ev.bookmakers || []) {
        if (!isSharp(bk.key, bk.title)) continue;
        const market = (bk.markets || []).find(m => m.key === "h2h");
        if (!market) continue;

        const names = market.outcomes?.map(o => o.name) || [];
        const prices = market.outcomes?.map(o => Number(o.price)) || [];
        if (!prices.length || prices.some(isNaN)) continue;

        const probs = removeVigProportional(prices);
        if (!probs) continue;

        sharpProbVectors.push({ names, probs });
        sharpTitles.add(bk.title || bk.key);
      }

      if (!sharpProbVectors.length) continue;

      const allNames = Array.from(new Set(sharpProbVectors.flatMap(v => v.names)));

      const fairProbs = allNames.map(name => {
        const vals = [];
        for (const v of sharpProbVectors) {
          const idx = v.names.findIndex(n => n === name);
          if (idx >= 0) vals.push(v.probs[idx]);
        }
        if (!vals.length) return 0;
        return vals.reduce((a,b)=>a+b,0) / vals.length;
      });

      const bestSoft = allNames.map(name => ({ name, odds: 0, book: null }));
      for (const bk of ev.bookmakers || []) {
        const market = (bk.markets || []).find(m => m.key === "h2h");
        if (!market) continue;
        for (const out of market.outcomes || []) {
          const idx = allNames.findIndex(n => n === out.name);
          const price = Number(out.price);
          if (idx >= 0 && price > (bestSoft[idx].odds || 0)) {
            bestSoft[idx] = { name: out.name, odds: price, book: bk.title || bk.key };
          }
        }
      }

      for (let i=0; i<allNames.length; i++) {
        const pFair = fairProbs[i];
        const soft = bestSoft[i];
        if (!soft.odds || !pFair) continue;
        const evRel = soft.odds * pFair - 1;
        if (evRel >= evMin) {
          const fairOdds = pFair > 0 ? (1 / pFair) : null;
          upsertPick({
            sport_key,
            event_id,
            commence_time_utc: commence,
            home, away,
            selection: soft.name,
            market: "h2h",
            fair_odds: round(fairOdds,3),
            soft_odds: round(soft.odds,3),
            ev_pct: round(evRel * 100, 2),
            best_book: soft.book,
            sharp_sources: Array.from(sharpTitles).sort().join(", ")
          });
          inserted++;
        }
      }
    }
  }

  return { inserted };
}

async function settlePending() {
  const rows = db.prepare(`
    SELECT DISTINCT sport_key, event_id
    FROM picks
    WHERE status='upcoming'
      AND datetime(commence_time_utc) <= datetime('now', '+6 hours')
    LIMIT 200
  `).all();

  const bySport = new Map();
  for (const r of rows) {
    if (!bySport.has(r.sport_key)) bySport.set(r.sport_key, []);
    bySport.get(r.sport_key).push(r.event_id);
  }

  for (const [sport_key, ids] of bySport.entries()) {
    const batches = chunk(ids, 25);
    for (const group of batches) {
      const data = await apiGet(`/v4/sports/${sport_key}/scores`, {
        dateFormat: "iso",
        eventIds: group.join(","),
        daysFrom: "3"
      });
      for (const ev of data) {
        if (!ev.completed) continue;
        const rec = interpretScores(ev.home_team, ev.away_team, ev.scores);
        if (!rec) continue;

        db.prepare(`
          UPDATE picks
          SET status = CASE
              WHEN selection = 'Draw' THEN (CASE WHEN @home = @away THEN 'won' ELSE 'lost' END)
              WHEN selection = @home_name THEN (CASE WHEN @home > @away THEN 'won' ELSE 'lost' END)
              WHEN selection = @away_name THEN (CASE WHEN @away > @home THEN 'won' ELSE 'lost' END)
              ELSE status
            END,
            score_home=@home, score_away=@away, resolved_at=datetime('now')
          WHERE event_id=@eid AND status='upcoming'
        `).run({
          eid: ev.id,
          home: rec.home,
          away: rec.away,
          home_name: ev.home_team,
          away_name: ev.away_team
        });
      }
    }
  }
}

// -------- API routes --------
app.post("/api/scan", async (req, res) => {
  try {
    const { hours, evMin } = req.body || {};
    const out = await scanOnce({ hours, evMin });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/upcoming", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM picks
    WHERE status='upcoming'
    ORDER BY datetime(commence_time_utc) ASC
    LIMIT 500
  `).all();
  res.json(rows);
});

app.get("/api/logs", (req, res) => {
  const limit = Number(req.query.limit || 500);
  const rows = db.prepare(`
    SELECT * FROM picks
    WHERE status!='upcoming'
    ORDER BY datetime(resolved_at) DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

app.get("/api/stats", (req, res) => {
  const totals = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) AS won,
      AVG(soft_odds) AS avg_soft_odds
    FROM picks
  `).get();
  const played = db.prepare(`SELECT COUNT(*) AS n FROM picks WHERE status IN ('won','lost','push')`).get().n || 0;
  const success = played ? (totals.won || 0) / played : 0;
  res.json({
    total_picks: totals.total || 0,
    played,
    won: totals.won || 0,
    success_rate: Number((success * 100).toFixed(2)),
    avg_odds: totals.avg_soft_odds ? Number(totals.avg_soft_odds.toFixed(3)) : null
  });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, async () => {
  if (!APIKEY) {
    console.error("ERROR: Set ODDS_API_KEY in .env");
    process.exit(1);
  }
  console.log("Bet engine API on http://localhost:" + PORT);
  try { await scanOnce({}); } catch(e){ console.error("scan error:", e.message); }
  setInterval(async () => { try { await scanOnce({}); } catch(e){ console.error("scan error:", e.message); } }, 10 * 60 * 1000);
  setInterval(async () => { try { await settlePending(); } catch(e){ console.error("settle error:", e.message); } }, 5 * 60 * 1000);
});
