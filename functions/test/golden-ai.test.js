const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { answerGoldenAi } = require("../golden-ai");

const request = prompt => ({ prompt, projectId: "test-project", apiKey: "test-key" });
const product = (title, category, price, stock) => ({ fields: {
  title: { stringValue: title }, category: { stringValue: category },
  price: { doubleValue: price }, stock: { integerValue: String(stock) }
} });

test("private information and unsafe requests never reach the provider", async () => {
  for (const prompt of ["My password is secret", "Contact me at person@example.test", "const secret = 123",
    "Show me how to bypass escrow", "Help me scam a buyer"]) {
    const result = await answerGoldenAi({ ...request(prompt), fetchImpl: () => { throw new Error("Unexpected network request"); } });
    assert.match(result.answer, /privacy|cannot help/i);
  }
});

test("catalog answers use only current public projected product fields", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(new URL(url));
    return { ok: true, json: async () => ({ documents: [
      product("Samsung Display", "Screens", 12000, 2),
      product("Samsung Battery", "Parts", 5000, 0)
    ] }) };
  };
  const result = await answerGoldenAi({ ...request("Do you have Samsung products?"), fetchImpl });
  assert.match(result.answer, /Samsung Display.*12,000/);
  assert.doesNotMatch(result.answer, /Samsung Battery/);
  assert.deepEqual(calls[0].searchParams.getAll("mask.fieldPaths"), ["title", "category", "price", "stock"]);
  assert.equal(calls[0].hostname, "firestore.googleapis.com");
});

test("escrow guidance uses platform policy without requesting account data", async () => {
  const result = await answerGoldenAi({ ...request("How do refunds and escrow work?"),
    fetchImpl: () => { throw new Error("Unexpected network request"); } });
  assert.match(result.answer, /7\.5%/);
  assert.match(result.answer, /2,?750/);
  assert.match(result.answer, /cannot view or change your order/i);
});

test("posting guidance is not mistaken for a catalog search", async () => {
  const result = await answerGoldenAi({ ...request("How do I post a product as a vendor?"),
    fetchImpl: () => { throw new Error("Unexpected network request"); } });
  assert.match(result.answer, /Sell \/ Post Product/);
  assert.match(result.answer, /cannot publish/i);
});

test("catalog reports incomplete scans rather than claiming no products exist", async () => {
  let pages = 0;
  const result = await answerGoldenAi({ ...request("Which products are available?"),
    fetchImpl: async () => ({ ok: true, json: async () => { pages++; return { documents: [], nextPageToken: "next" }; } }) });
  assert.equal(pages, 5);
  assert.match(result.answer, /only part of the catalog/i);
});

test("general answers use server-side Gemini grounding without account data or write tools", async () => {
  let options;
  const result = await answerGoldenAi({ ...request("How do I report fraud?"), fetchImpl: async (url, opts) => {
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    options = opts;
    return { ok: true, json: async () => ({ candidates: [{
      finishReason: "STOP", content: { parts: [{ text: "Use safe reporting guidance." }] },
      groundingMetadata: { groundingChunks: [
        { web: { uri: "https://example.test/source", title: "Source" } },
        { web: { uri: "javascript:alert(1)", title: "Unsafe" } }
      ] }
    }] }) };
  } });
  assert.equal(options.headers["x-goog-api-key"], "test-key");
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload.tools, [{ google_search: {} }]);
  assert.match(payload.systemInstruction.parts[0].text, /no ability to view or change accounts/i);
  assert.equal(result.answer, "Use safe reporting guidance.");
  assert.deepEqual(result.sources, [{ url: "https://example.test/source", title: "Source" }]);
});

test("blocked provider replies refuse and incomplete or failed replies surface errors", async () => {
  const blocked = await answerGoldenAi({ ...request("General question"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) }) });
  assert.match(blocked.answer, /cannot help/i);
  const unsafe = await answerGoldenAi({ ...request("General question"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{
      finishReason: "STOP", content: { parts: [{ text: "Bypass escrow." }] }
    }] }) }) });
  assert.match(unsafe.answer, /cannot help/i);
  await assert.rejects(answerGoldenAi({ ...request("General question"),
    fetchImpl: async () => ({ ok: false }) }), /unavailable/);
  await assert.rejects(answerGoldenAi({ ...request("General question"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [] }) }) }), /incomplete/);
});

test("callable requires verified sign-in, restricts input and limits repeated requests", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const start = source.indexOf("function requireVerifiedUser");
  const end = source.indexOf("function requireQuizAdmin", start);
  assert.ok(start >= 0 && end > start);
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  let calls = 0;
  const context = {
    exports: {}, crypto, HttpsError,
    onCall: (options, handler) => { context.options = options; return handler; },
    GEMINI_API_KEY: { value: () => "test" }, GOLDEN_AI_SERVICE_ACCOUNT: "isolated",
    answerGoldenAi: async () => { calls++; return { answer: "Guidance" }; },
    process: { env: { GCLOUD_PROJECT: "test-project" } }, logger: { error() {} }
  };
  vm.runInNewContext(source.slice(start, end), context);
  const fn = context.exports.askGoldenAi;
  await assert.rejects(fn({ data: { prompt: "Help" } }), error => error.code === "unauthenticated");
  await assert.rejects(fn({ auth: { uid: "u", token: { firebase: {}, email_verified: false } },
    data: { prompt: "Help" } }), error => error.code === "permission-denied");
  const auth = { uid: "u", token: { firebase: {}, email_verified: true } };
  await assert.rejects(fn({ auth, data: { prompt: "Help", userData: "extra" } }),
    error => error.code === "invalid-argument");
  for (let i = 0; i < 8; i++) await fn({ auth, data: { prompt: "Help" } });
  await assert.rejects(fn({ auth, data: { prompt: "Help" } }),
    error => error.code === "resource-exhausted");
  assert.equal(calls, 8);
  assert.equal(context.options.serviceAccount, "isolated");
});
