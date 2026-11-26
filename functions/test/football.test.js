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
});

test("football client contains no provider key and uses privacy-enhanced embeds", () => {
  assert.doesNotMatch(html, /x-apisports-key|FLWSECK|sk_(live|test)_/i);
  assert.match(html, /https:\/\/www\.youtube-nocookie\.com\/embed\//);
  assert.match(html, /match_chats/);
  assert.match(html, /match_polls/);
  assert.match(html, /OWNER_UID = "LROHsLUXfEPnC6bDmSvy3vcRnNE3"/);
});
