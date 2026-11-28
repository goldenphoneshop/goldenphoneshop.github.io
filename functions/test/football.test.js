const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "..", "football.html"), "utf8");

test("football fixtures use sanitized fallback and provider fields", () => {
  const start = source.indexOf("function fallbackFootballMatches");
  const end = source.indexOf("function containsPhoneNumber", start);
  const context = { Date, fetch: async () => { throw new Error("unexpected"); }, AbortSignal, Number, String };
  vm.runInNewContext(source.slice(start, end), context);
  const fallback = context.fallbackFootballMatches();
  assert.equal(fallback.length, 1);
  const match = context.cleanFootballFixture({
    fixture: { id: 42, date: "2026-11-25T18:00:00Z", status: { short: "1H", elapsed: 12 },
      venue: { name: "Stadium" } },
    league: { name: "League", country: "Country", logo: "https://example.test/league.png" },
    teams: {
      home: { id: 1, name: "Home", logo: "https://example.test/home.png" },
      away: { id: 2, name: "Away", logo: "https://example.test/away.png" }
    },
    goals: { home: 1, away: 0 }
  });
  assert.equal(match.id, 42);
  assert.equal(match.status.elapsed, 12);
  assert.equal(match.goals.home, 1);
});

test("football fixture sync requests one daily feed and logs provider errors", async () => {
  const start = source.indexOf("function fallbackFootballMatches");
  const end = source.indexOf("function containsPhoneNumber", start);
  const urls = [];
  const errors = [];
  const context = {
    Date, Intl, Number, String, Object, Map, Array, AbortSignal,
    logger: { error: (message, fields) => errors.push({ message, fields }) },
    fetch: async url => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          errors: { plan: "limited" },
          response: []
        })
      };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  const fixtures = await context.fetchFootballFixtures("server-only-key");
  assert.equal(fixtures.length, 0);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /date=\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(urls[0], /live=all/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fields.errors.plan, "limited");
});

test("football quota fallback merges full public league feeds", async () => {
  const start = source.indexOf("function fallbackFootballMatches");
  const end = source.indexOf("function containsPhoneNumber", start);
  const urls = [];
  const context = {
    Date, Intl, Number, String, Object, Array, AbortSignal,
    logger: { error: () => {}, warn: () => {} },
    fetch: async url => {
      urls.push(url);
      if (url.includes("site.api.espn.com")) {
        return {
          ok: true,
          json: async () => ({
            events: url.includes("/eng.1/") ? [{
              id: "9001", date: "2026-11-27T18:30:00Z",
              competitions: [{
                status: { type: { state: "pre", description: "Scheduled" } },
                venue: { fullName: "Emirates Stadium" },
                competitors: [
                  { homeAway: "home", score: "0",
                    team: { id: "10", displayName: "Arsenal", logo: "arsenal.png" } },
                  { homeAway: "away", score: "0",
                    team: { id: "20", displayName: "Chelsea", logo: "chelsea.png" } }
                ]
              }]
            }] : []
          })
        };
      }
      const events = url.includes("eventsnextleague")
        ? []
        : [
          {
            idEvent: "777", idHomeTeam: "10", idAwayTeam: "20",
            strHomeTeam: "Arsenal", strAwayTeam: "Chelsea",
            strHomeTeamBadge: "https://example.test/arsenal.png",
            strAwayTeamBadge: "https://example.test/chelsea.png",
            strLeague: "English Premier League",
            strCountry: "England", strVenue: "Emirates Stadium",
            dateEvent: "2026-11-27", strTime: "17:30:00",
            strTimestamp: "2026-11-27T17:30:00", strStatus: "Not Started",
            intHomeScore: null, intAwayScore: null
          },
          {
            idEvent: "778", strHomeTeam: "Other", strAwayTeam: "Other FC",
            strLeague: "Community Sunday League",
            dateEvent: "2026-11-27", strTime: "20:00:00"
          }
        ];
      return {
        ok: true,
        json: async () => ({ events })
      };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  const fixtures = await context.fetchPublicFootballFixtures("2026-11-27");
  assert.equal(fixtures.length, 2);
  const premierLeague = fixtures.find(fixture => fixture.id === 777);
  assert.equal(premierLeague.league.name, "English Premier League");
  assert.equal(premierLeague.goals.home, 0);
  assert.equal(premierLeague.espnEventId, 9001);
  assert.equal(premierLeague.espnLeagueCode, "eng.1");
  assert.equal(fixtures.find(fixture => fixture.id === 778).league.name,
    "Community Sunday League");
  assert.equal(urls.filter(url => url.includes("eventsnextleague.php")).length, 6);
  assert.equal(urls.filter(url => url.includes("site.api.espn.com")).length, 8);
  assert.match(urls.find(url => url.includes("eventsday.php")),
    /eventsday\.php\?d=2026-11-27&s=Soccer$/);
});

test("football timestamps use explicit UTC and bypass stale kickoff entries", () => {
  const start = source.indexOf("function fallbackFootballMatches");
  const end = source.indexOf("function containsPhoneNumber", start);
  const context = {
    Date, Intl, Number, String, Object, Map, Array, Set, AbortSignal
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.normalizeFootballTimestamp("2026-11-27 18:30:00"),
    "2026-11-27T18:30:00.000Z");
  assert.equal(context.hasStaleKickoffMatch([{
    date: "2026-11-27T12:00:00Z", status: { short: "NS" }
  }], Date.parse("2026-11-27T12:30:00Z")), true);
  assert.equal(context.hasStaleKickoffMatch([{
    date: "2026-11-27T12:00:00Z", status: { short: "1H" }
  }], Date.parse("2026-11-27T12:30:00Z")), false);
  const event = context.cleanEspnEvent({
    clock: { displayValue: "63'" },
    text: "Goal for the home team",
    team: { displayName: "Arsenal" },
    participant: { athlete: { displayName: "Saka" } }
  });
  assert.equal(event.time, 63);
  assert.equal(event.player, "Saka");
  assert.equal(event.team, "Arsenal");
});

test("football detail fallback requests ESPN summary timeline", async () => {
  const start = source.indexOf("function fallbackFootballMatches");
  const end = source.indexOf("function containsPhoneNumber", start);
  const urls = [];
  const context = {
    Date, Intl, Number, String, Object, Array, AbortSignal,
    fetch: async url => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          keyEvents: [{
            clock: { displayValue: "72'" },
            type: { text: "Goal" },
            text: "Goal — Arsenal",
            team: { displayName: "Arsenal" },
            participant: { athlete: { displayName: "Bukayo Saka" } }
          }],
          boxscore: { teams: [] }
        })
      };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  const summary = await context.fetchEspnMatchSummary({
    espnEventId: 9001, espnLeagueCode: "eng.1"
  });
  assert.equal(summary.events.length, 1);
  assert.equal(summary.events[0].type, "Goal");
  assert.equal(summary.events[0].time, 72);
  assert.match(urls[0], /\/eng\.1\/summary\?event=9001$/);
});

test("football client contains no provider key and uses privacy-enhanced embeds", () => {
  assert.doesNotMatch(html, /x-apisports-key|FLWSECK|sk_(live|test)_/i);
  assert.match(html, /https:\/\/www\.youtube-nocookie\.com\/embed\//);
  assert.match(html, /match_chats/);
  assert.match(html, /match_polls/);
  assert.match(html, /OWNER_UID = "LROHsLUXfEPnC6bDmSvy3vcRnNE3"/);
  assert.equal((html.match(/id="livePitch"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="officialVideo"/);
  assert.match(html, /id="livePitch" class="pitch stage-pitch hidden"/);
  assert.doesNotMatch(html,
    /No official stream or highlight is linked to this fixture/);
  assert.match(html, /animateLiveBall/);
  assert.match(html, /id="prematchCard"/);
  assert.match(html,
    /Kickoff upcoming — live goals, cards, and stats will appear here once play starts\./);
  assert.match(html,
    /Match underway — waiting for first key event\./);
  assert.match(html, /data-stage-tab="video"/);
});
