const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'Markertplace.html'), 'utf8');
const start = html.indexOf('async function renderGoldenChatMessages(');
const end = html.indexOf('function acknowledgeGoldenChatRead(', start);

function node() {
  return {
    children: [],
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    textContent: '',
    scrollTop: 0,
    scrollHeight: 100
  };
}

function doc(id, data) {
  return { id, data: () => data };
}

function renderContext(calls, error = false) {
  const container = node();
  const acknowledgements = [];
  const context = {
    document: {
      getElementById: () => container,
      createElement: node
    },
    activeGoldenChatId: 'chat',
    activeGoldenChatLatestMessageId: null,
    currentUser: { uid: 'user' },
    goldenChatCallHistory: calls,
    goldenChatCallHistoryError: error,
    goldenCalls: { describeCall: call => call.label },
    acknowledgeGoldenChatRead: (...args) => acknowledgements.push(args),
    Date,
    Number
  };
  vm.runInNewContext(html.slice(start, end), context);
  return { context, container, acknowledgements };
}

test('conversation interleaves call records with messages without acknowledging calls as messages', async () => {
  const time = value => ({ toMillis: () => value });
  const calls = [
    doc('call1', { label: 'Incoming voice call · Missed', createdAt: time(2000) }),
    doc('call2', { label: 'Outgoing video call · Answered', createdAt: time(4000) })
  ];
  const messages = [
    doc('msg2', { text: 'Later', senderUid: 'user', senderName: 'Member', coinCost: 1, createdAt: time(3000) }),
    doc('msg1', { text: 'Earlier', senderUid: 'other', senderName: 'Other', coinCost: 1, createdAt: time(1000) })
  ];
  const { context, container, acknowledgements } = renderContext(calls);
  await context.renderGoldenChatMessages({ docs: messages, empty: false }, 'chat');
  const text = container.children.map(row => row.children[0].children?.[0]?.textContent || row.children[0].textContent);
  assert.equal(text[0], 'Earlier');
  assert.match(text[1], /^Incoming voice call · Missed/);
  assert.equal(text[2], 'Later');
  assert.match(text[3], /^Outgoing video call · Answered/);
  assert.deepEqual(acknowledgements, [['chat', 'msg2']]);
});

test('a chat with only calls renders them and reports call history errors separately', async () => {
  const { context, container, acknowledgements } = renderContext([
    doc('call', { label: 'Incoming voice call · Missed', createdAt: { toMillis: () => 1000 } })
  ], true);
  await context.renderGoldenChatMessages({ docs: [], empty: true }, 'chat');
  assert.match(container.children[0].textContent, /Call history could not load/);
  assert.match(container.children[1].children[0].textContent, /Missed/);
  assert.equal(acknowledgements.length, 0);
});
