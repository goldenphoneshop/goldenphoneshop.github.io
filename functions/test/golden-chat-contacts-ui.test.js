const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'Markertplace.html'), 'utf8');
function extract(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
}
function node() {
  return {
    children: [], events: {}, textContent: '', value: '', scrollTop: 0,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    setAttribute() {},
    addEventListener(event, callback) { this.events[event] = callback; }
  };
}

test('opening a contact leaves the searchable people list open and at its scroll position', () => {
  const nodes = {
    chatContactsList: node(), chatContactsSearch: node(), chatContactsStatus: node()
  };
  const opened = [];
  let closed = false;
  const context = {
    document: { getElementById: id => nodes[id], createElement: node },
    goldenChatContacts: { following: [{ uid: 'member', name: 'Ada', role: 'Buyer' }], followers: [] },
    activeChatContactsTab: 'following',
    startGoldenChat: uid => opened.push(uid),
    closeChatContactsModal: () => { closed = true; }
  };
  vm.runInNewContext(extract('function renderChatContacts()', 'function openChatPage('), context);
  context.renderChatContacts();
  nodes.chatContactsList.scrollTop = 123;
  nodes.chatContactsList.children[0].children[2].events.click();
  assert.deepEqual(opened, ['member']);
  assert.equal(closed, false);
  assert.equal(nodes.chatContactsList.scrollTop, 123);
});

test('the most recently chosen contact wins if requests finish out of order', async () => {
  const pending = new Map();
  const selected = [];
  const context = {
    currentUser: { uid: 'self' },
    chatSending: false,
    goldenChatOpenRevision: 0,
    firebaseFunctions: { httpsCallable: () => ({ otherUid }) => new Promise(resolve => pending.set(otherUid, resolve)) },
    firebaseFirestore: { collection: () => ({ doc: id => ({ get: async () => ({
      exists: true, id, data: () => ({ participantIds: ['self', id] })
    }) }) }) },
    document: { getElementById: () => ({ classList: { contains: () => false } }) },
    selectGoldenChat: id => selected.push(id),
    showToast: message => { throw new Error(message); },
    console
  };
  vm.runInNewContext(extract('async function startGoldenChat(', 'function getGoldenChatUnreadCount('), context);
  const first = context.startGoldenChat('first');
  const second = context.startGoldenChat('second');
  pending.get('second')({ data: { chatId: 'second' } });
  await second;
  pending.get('first')({ data: { chatId: 'first' } });
  await first;
  assert.deepEqual(selected, ['second']);
});
