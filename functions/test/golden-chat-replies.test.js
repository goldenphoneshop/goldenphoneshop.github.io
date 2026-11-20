const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('exports.sendGoldenChatMessage =');
const end = source.indexOf('exports.markGoldenChatRead =', start);
const chatId = `chat_${'a'.repeat(40)}`;
const parentId = 'a'.repeat(20);
const messageId = 'b'.repeat(20);

function setup() {
  const docs = new Map();
  class Ref {
    constructor(key) { this.key = key; }
    collection(name) { return new Collection(`${this.key}/${name}`); }
    async get() {
      const data = docs.get(this.key);
      return { exists: data !== undefined, data: () => data };
    }
  }
  class Collection {
    constructor(key) { this.key = key; }
    doc(id) { return new Ref(`${this.key}/${id}`); }
  }
  const db = {
    collection: name => new Collection(name),
    async runTransaction(handler) {
      const writes = [];
      const tx = {
        get: ref => ref.get(),
        create: (ref, value) => writes.push(() => {
          assert.equal(docs.has(ref.key), false);
          docs.set(ref.key, value);
        }),
        set: (ref, value, options) => writes.push(() => {
          docs.set(ref.key, options?.merge ? { ...docs.get(ref.key), ...value } : value);
        }),
        update: (ref, value) => writes.push(() => docs.set(ref.key, { ...docs.get(ref.key), ...value })),
        delete: ref => writes.push(() => docs.delete(ref.key))
      };
      await handler(tx);
      writes.forEach(write => write());
    }
  };
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const context = {
    exports: {}, db, HttpsError,
    requireVerifiedUser: request => {
      if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in.');
      return request.auth;
    },
    onCall: handler => handler,
    CHAT_ACTION_COSTS: { text: 1, image: 2, video: 4, voice: 3 },
    MAX_CHAT_IMAGE_BYTES: 5 * 1024 * 1024,
    MAX_CHAT_VIDEO_BYTES: 50 * 1024 * 1024,
    MAX_CHAT_VOICE_BYTES: 25 * 1024 * 1024,
    getStorage: () => ({ bucket: () => ({ file: () => ({
      getMetadata: async () => [{ size: 12, contentType: 'image/png' }]
    }) }) }),
    goldenChatMediaReservationRef: (chat, id) => db.collection('reservations').doc(`${chat}_${id}`),
    accountWalletRef: uid => db.collection('wallets').doc(uid),
    normalizedWallet: data => ({ coins: data?.coins || 0 }),
    FieldValue: { serverTimestamp: () => 'server time' },
    logger: { warn() {} },
    Date,
    Promise
  };
  vm.runInNewContext(source.slice(start, end), context);
  docs.set(`goldenChats/${chatId}`, {
    participantIds: ['alice', 'bob'],
    participants: { alice: { name: 'Alice' }, bob: { name: 'Bob' } }
  });
  docs.set('users/alice', { role: 'Buyer' });
  docs.set('users/bob', { role: 'Vendor' });
  docs.set('wallets/alice', { coins: 10 });
  docs.set('wallets/bob', { coins: 0 });
  docs.set(`goldenChats/${chatId}/messages/${parentId}`, {
    senderUid: 'bob', senderName: 'Bob', type: 'text', text: 'Original message'
  });
  return { docs, send: context.exports.sendGoldenChatMessage };
}

function request(data = {}, uid = 'alice') {
  return { auth: { uid }, data: { chatId, messageId, type: 'text', text: 'My reply', ...data } };
}

test('reply uses the same-chat server message and charges once even after retry', async () => {
  const { docs, send } = setup();
  const result = await send(request({ replyToMessageId: parentId, replyTo: { senderName: 'Spoof', preview: 'Fake' } }));
  const reply = docs.get(`goldenChats/${chatId}/messages/${messageId}`);
  assert.equal(result.sent, true);
  assert.equal(reply.replyTo.messageId, parentId);
  assert.equal(reply.replyTo.senderName, 'Bob');
  assert.equal(reply.replyTo.preview, 'Original message');
  assert.equal(docs.get('wallets/alice').coins, 9);
  assert.equal(docs.get('wallets/bob').coins, 0.5);
  assert.equal((await send(request({ replyToMessageId: parentId }))).duplicate, true);
  assert.equal(docs.get('wallets/alice').coins, 9);
  assert.equal(docs.get('wallets/bob').coins, 0.5);
});

test('rejects missing, cross-chat, self and unauthorized reply targets without charging', async () => {
  const { docs, send } = setup();
  docs.delete(`goldenChats/${chatId}/messages/${parentId}`);
  docs.set(`goldenChats/chat_${'c'.repeat(40)}/messages/${parentId}`, { text: 'Other chat' });
  await assert.rejects(send(request({ replyToMessageId: parentId })), error => error.code === 'not-found');
  await assert.rejects(send(request({ replyToMessageId: messageId })), error => error.code === 'invalid-argument');
  await assert.rejects(send(request({ replyToMessageId: 'bad/id' })), error => error.code === 'invalid-argument');
  await assert.rejects(send(request({ replyToMessageId: parentId }, 'outsider')), error => error.code === 'permission-denied');
  assert.equal(docs.get('wallets/alice').coins, 10);
  assert.equal(docs.has(`goldenChats/${chatId}/messages/${messageId}`), false);
});

test('media messages can reply while preserving existing reservation and fee behavior', async () => {
  const { docs, send } = setup();
  docs.set(`goldenChats/${chatId}/messages/${parentId}`, { senderName: 'Bob', type: 'voice', text: '' });
  docs.set(`reservations/${chatId}_${messageId}`, {
    uid: 'alice', chatId, messageId, type: 'image', status: 'pending', expiresAtMs: Date.now() + 60000
  });
  await send(request({ type: 'image', text: '', replyToMessageId: parentId,
    mediaPath: `golden-chat-media/${chatId}/alice/${messageId}` }));
  const saved = docs.get(`goldenChats/${chatId}/messages/${messageId}`);
  assert.equal(saved.replyTo.preview, 'Voice note');
  assert.equal(saved.coinCost, 2);
  assert.equal(docs.has(`reservations/${chatId}_${messageId}`), false);
  assert.equal(docs.get('wallets/alice').coins, 10);
});
