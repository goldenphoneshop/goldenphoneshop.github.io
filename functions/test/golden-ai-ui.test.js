const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const start = html.indexOf("        function toggleAiDrawer");
const end = html.indexOf("        function showToast", start);
assert.ok(start >= 0 && end > start);

function setup(callable) {
  function node() {
    return {
      children: [], dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); child.parent = this; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      setAttribute(name, value) { this[name] = value; }
    };
  }
  const nodes = { aiChatBox: node(), aiInput: { value: "" }, aiSendBtn: { disabled: false } };
  const context = {
    document: { getElementById: id => nodes[id], createElement: node },
    currentUser: { uid: "u" }, firebaseAuth: { currentUser: { uid: "u" } },
    firebaseFunctions: { httpsCallable: () => callable },
    console: { error() {} }, URL
  };
  vm.runInNewContext(html.slice(start, end), context);
  return { context, nodes };
}

test("assistant displays loading and renders provider text safely", async () => {
  let resolve;
  const { context, nodes } = setup(() => new Promise(done => { resolve = done; }));
  nodes.aiInput.value = "Help me";
  const pending = context.handleAiSendMessage({ preventDefault() {} });
  assert.equal(nodes.aiSendBtn.disabled, true);
  assert.equal(nodes.aiChatBox.children.length, 2);
  resolve({ data: { answer: "<img src=x onerror=alert(1)>", sources: [] } });
  await pending;
  assert.equal(nodes.aiSendBtn.disabled, false);
  assert.equal(nodes.aiChatBox.children.length, 2);
  const bubble = nodes.aiChatBox.children[1].children[1];
  assert.equal(bubble.children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(bubble.innerHTML, undefined);
});

test("assistant reports failures and requires sign-in without calling the backend", async () => {
  let calls = 0;
  const { context, nodes } = setup(async () => { calls++; throw Object.assign(new Error("offline"), { code: "functions/unavailable" }); });
  context.firebaseAuth.currentUser = null;
  nodes.aiInput.value = "Help";
  await context.handleAiSendMessage({ preventDefault() {} });
  assert.equal(calls, 0);
  assert.match(nodes.aiChatBox.children[0].children[1].children[0].textContent, /sign in/i);
  context.firebaseAuth.currentUser = { uid: "u" };
  await context.handleAiSendMessage({ preventDefault() {} });
  assert.equal(calls, 1);
  assert.equal(nodes.aiSendBtn.disabled, false);
  assert.match(nodes.aiChatBox.children.at(-1).children[1].children[0].textContent, /unavailable/i);
});
