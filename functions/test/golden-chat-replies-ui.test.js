const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
function extract(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
}

function fakeElement() {
  const handlers = {};
  const classes = new Set(['hidden']);
  return {
    handlers,
    style: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    setPointerCapture() {},
    focus() { this.focused = true; },
    textContent: ''
  };
}

function contextForReplies() {
  const nodes = new Map();
  const messages = [];
  const context = {
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, fakeElement());
      return nodes.get(id);
    } },
    goldenChatReplyTarget: null,
    activeGoldenChatId: 'chat',
    chatSending: false,
    chatSendRetry: null,
    showToast: message => messages.push(message)
  };
  vm.runInNewContext(extract('function resetGoldenChatReply()', 'async function renderGoldenChatMessages('), context);
  return { context, nodes, messages };
}

function pointer(x, y, overrides = {}) {
  return { isPrimary: true, pointerType: 'touch', button: 0, pointerId: 1,
    clientX: x, clientY: y, target: { closest: () => null }, ...overrides };
}

test('right swipe selects a message as reply; vertical motion and cancellation do not', () => {
  const { context, nodes } = contextForReplies();
  const bubble = fakeElement();
  context.enableGoldenChatSwipeReply(bubble, 'message', { senderName: 'Ada', type: 'text', text: 'Hello' }, 'chat');
  bubble.handlers.pointerdown(pointer(0, 0));
  bubble.handlers.pointermove(pointer(80, 5));
  bubble.handlers.pointerup(pointer(80, 5));
  assert.equal(context.goldenChatReplyTarget.messageId, 'message');
  assert.equal(nodes.get('chatReplyText').textContent, 'Hello');
  assert.equal(nodes.get('chatReplyPreview').classList.contains('hidden'), false);
  context.cancelGoldenChatReply();
  bubble.handlers.pointerdown(pointer(0, 0));
  bubble.handlers.pointerup(pointer(80, 100));
  assert.equal(context.goldenChatReplyTarget, null);
  bubble.handlers.pointerdown(pointer(0, 0));
  bubble.handlers.pointercancel(pointer(100, 0));
  assert.equal(context.goldenChatReplyTarget, null);
});

test('reply control is available without swiping and cannot change an uncertain retry', () => {
  const { context, nodes, messages } = contextForReplies();
  context.setGoldenChatReply('id', { senderName: 'Member', type: 'image', text: '' }, 'chat');
  assert.equal(nodes.get('chatReplyText').textContent, 'Photo');
  context.chatSendRetry = { messageId: 'pending' };
  context.setGoldenChatReply('different', { type: 'text', text: 'new' }, 'chat');
  context.cancelGoldenChatReply();
  assert.equal(context.goldenChatReplyTarget.messageId, 'id');
  assert.ok(messages.some(text => /retry/i.test(text)));
  context.chatSendRetry = null;
  context.cancelGoldenChatReply();
  assert.equal(context.goldenChatReplyTarget, null);
});

test('uncertain send retries preserve the reply target and original message ID', async () => {
  const { context, nodes } = contextForReplies();
  const calls = [];
  const input = context.document.getElementById('chatMessageInput');
  input.value = 'Answer';
  const submit = { disabled: false, textContent: 'Send' };
  context.document.querySelector = () => submit;
  context.currentUser = { uid: 'user' };
  context.goldenChatReplyTarget = { chatId: 'chat', messageId: 'parent' };
  context.pendingChatFiles = [];
  context.pendingChatVoiceBlob = null;
  context.firebaseFirestore = { collection: () => ({ doc: () => ({ collection: () => ({
    doc: () => ({ id: 'new-message' })
  }) }) }) };
  context.firebaseFunctions = { httpsCallable: () => async payload => {
    calls.push(payload);
    if (calls.length === 1) throw Object.assign(new Error('timeout'), { code: 'functions/deadline-exceeded' });
    return { data: { coinsRemaining: 3 } };
  } };
  context.firebaseStorage = {};
  context.renderPendingChatFiles = () => {};
  context.updateChatSendButtonCost = () => {};
  context.openChatCoinStore = () => {};
  context.URL = { revokeObjectURL() {} };
  context.console = { error() {} };
  vm.runInNewContext(extract('async function sendGoldenChatMessage(event)', 'let chatSending = false;'), context);
  await context.sendGoldenChatMessage({ preventDefault() {} });
  assert.equal(context.chatSendRetry.replyToMessageId, 'parent');
  assert.equal(context.goldenChatReplyTarget.messageId, 'parent');
  await context.sendGoldenChatMessage({ preventDefault() {} });
  assert.equal(calls[0].messageId, calls[1].messageId);
  assert.equal(calls[1].replyToMessageId, 'parent');
  assert.equal(context.goldenChatReplyTarget, null);
  assert.equal(nodes.get('chatReplyPreview').classList.contains('hidden'), true);
});
