const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoldenCalls } = require('../../golden-calls');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

function fakeDatabase() {
  const docs = new Map();
  const watchers = new Set();
  let sequence = 0;
  let transactionQueue = Promise.resolve();
  const snapshot = (path) => ({
    id: path.split('/').pop(),
    ref: ref(path),
    exists: docs.has(path),
    data: () => docs.get(path)
  });
  const emit = () => {
    for (const watcher of watchers) queueMicrotask(watcher);
  };
  function ref(path) {
    return {
      id: path.split('/').pop(),
      set: async data => { docs.set(path, data); emit(); },
      collection: name => collection(`${path}/${name}`),
      onSnapshot: callback => {
        const watcher = () => callback(snapshot(path));
        watchers.add(watcher);
        queueMicrotask(watcher);
        return () => watchers.delete(watcher);
      }
    };
  }
  function collection(path, filters = [], maximum = Infinity) {
    return {
      doc: () => ref(`${path}/id${++sequence}`),
      add: async data => {
        const child = ref(`${path}/id${++sequence}`);
        await child.set(data);
        return child;
      },
      where: (field, op, value) => collection(path, [...filters, [field, value]], maximum),
      orderBy: () => collection(path, filters, maximum),
      limit: value => collection(path, filters, value),
      onSnapshot: callback => {
        const seen = new Set();
        const watcher = () => {
          const found = [...docs.keys()].filter(key => key.startsWith(`${path}/`) &&
            key.slice(path.length + 1).indexOf('/') === -1 &&
            filters.every(([keyName, value]) => docs.get(key)[keyName] === value))
            .slice(0, maximum).map(snapshot);
          const changes = found.filter(item => !seen.has(item.id));
          found.forEach(item => seen.add(item.id));
          callback({ docs: found, docChanges: () => changes.map(doc => ({ type: 'added', doc })) });
        };
        watchers.add(watcher);
        queueMicrotask(watcher);
        return () => watchers.delete(watcher);
      }
    };
  }
  return {
    docs,
    collection,
    runTransaction(handler) {
      const run = async () => {
        const writes = [];
        await handler({
          get: async document => snapshot(`calls/${document.id}`),
          update: (document, data) => writes.push([`calls/${document.id}`, data])
        });
        for (const [path, data] of writes) docs.set(path, { ...docs.get(path), ...data });
        emit();
      };
      const result = transactionQueue.then(run);
      transactionQueue = result.catch(() => {});
      return result;
    }
  };
}

function fakeStream(video) {
  const audio = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
  const camera = { kind: 'video', enabled: true, stopped: false, stop() { this.stopped = true; } };
  const tracks = video ? [audio, camera] : [audio];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => [audio],
    getVideoTracks: () => video ? [camera] : []
  };
}

class FakePeer {
  static instances = [];
  constructor() {
    this.addedCandidates = [];
    this.closed = false;
    FakePeer.instances.push(this);
  }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'offer sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer sdp' }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate(candidate) { this.addedCandidates.push(candidate); }
  close() { this.closed = true; }
  candidate(value) {
    this.onicecandidate({ candidate: { toJSON: () => ({ candidate: value, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
}

function client(db, uid, mediaOverride, extra = {}) {
  const elements = new Map();
  const messages = [];
  const streams = [];
  const requested = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name),
          contains: name => classes.has(name) },
        play: async () => {}, setAttribute(name, value) { this[name] = value; },
        replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
        textContent: '', srcObject: null
      });
    }
    return elements.get(id);
  }, createElement: () => ({}) };
  const timers = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} };
  const controller = createGoldenCalls({
    db, document, getUser: () => ({ uid }),
    getChat: () => ({ id: 'chat', data: { participantIds: ['caller', 'callee'] } }),
    serverTimestamp: () => ({ toMillis: () => Date.now() }),
    notify: (message, type) => messages.push({ message, type }),
    mediaDevices: { getUserMedia: async constraints => {
      requested.push(constraints);
      if (mediaOverride) return mediaOverride(constraints);
      const stream = fakeStream(constraints.video);
      streams.push(stream);
      return stream;
    }, ...extra.mediaDevices },
    AudioContext: extra.AudioContext,
    RTCPeerConnection: FakePeer, isSecureContext: true, timers
  });
  return { controller, document, elements, messages, streams, requested };
}

test('voice and video calls exchange descriptions and candidates, control tracks and clean up', async () => {
  for (const type of ['voice', 'video']) {
    FakePeer.instances = [];
    const db = fakeDatabase();
    const caller = client(db, 'caller');
    const callee = client(db, 'callee');
    callee.controller.subscribe('callee');
    await caller.controller.start(type);
    await settle();
    assert.deepEqual(caller.requested[0], { audio: true, video: type === 'video' });
    assert.equal(callee.elements.get('goldenIncomingCallModal').classList.contains('hidden'), false);
    FakePeer.instances[0].candidate('caller candidate');
    await settle();
    await callee.controller.answer();
    await settle();
    assert.deepEqual(callee.requested[0], { audio: true, video: type === 'video' });
    assert.equal(FakePeer.instances[0].remoteDescription.type, 'answer');
    assert.equal(FakePeer.instances[1].remoteDescription.type, 'offer');
    assert.equal(FakePeer.instances[1].addedCandidates[0].candidate, 'caller candidate');
    FakePeer.instances[1].candidate('callee candidate');
    await settle();
    assert.equal(FakePeer.instances[0].addedCandidates[0].candidate, 'callee candidate');
    caller.controller.mute();
    assert.equal(caller.streams[0].getAudioTracks()[0].enabled, false);
    if (type === 'video') {
      caller.controller.toggleCamera();
      assert.equal(caller.streams[0].getVideoTracks()[0].enabled, false);
    }
    await caller.controller.hangup();
    await settle();
    assert.equal([...db.docs.values()].find(data => data.status)?.status, 'ended');
    for (const peer of FakePeer.instances) assert.equal(peer.closed, true);
    for (const stream of [...caller.streams, ...callee.streams]) {
      assert.ok(stream.getTracks().every(track => track.stopped));
    }
    caller.controller.stop();
    callee.controller.stop();
  }
});

test('denied permission reports an actionable error without creating a call', async () => {
  const db = fakeDatabase();
  const caller = client(db, 'caller', async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await caller.controller.start('voice');
  assert.equal(db.docs.size, 0);
  assert.match(caller.messages[0].message, /blocked.*browser settings/i);
  assert.equal(caller.elements.get('goldenCallModal').classList.contains('hidden'), true);
});

test('hanging up while permission is pending stops tracks when permission resolves', async () => {
  const db = fakeDatabase();
  let resolveMedia;
  const pending = new Promise(resolve => { resolveMedia = resolve; });
  const caller = client(db, 'caller', () => pending);
  const starting = caller.controller.start('video');
  await caller.controller.hangup();
  const stream = fakeStream(true);
  resolveMedia(stream);
  await starting;
  assert.ok(stream.getTracks().every(track => track.stopped));
  assert.equal(db.docs.size, 0);
});

test('competing answers cannot end the successful call', async () => {
  FakePeer.instances = [];
  const db = fakeDatabase();
  const caller = client(db, 'caller');
  const first = client(db, 'callee');
  const second = client(db, 'callee');
  first.controller.subscribe('callee');
  second.controller.subscribe('callee');
  await caller.controller.start('voice');
  await settle();
  await Promise.all([first.controller.answer(), second.controller.answer()]);
  await settle();
  assert.equal([...db.docs.values()].find(data => data.status)?.status, 'accepted');
  assert.equal([first, second].filter(person => person.messages.some(message => message.type === 'error')).length, 1);
  await caller.controller.hangup();
  first.controller.stop();
  second.controller.stop();
});

test('declining a ringing call closes the caller connection without requesting media', async () => {
  FakePeer.instances = [];
  const db = fakeDatabase();
  const caller = client(db, 'caller');
  const callee = client(db, 'callee');
  callee.controller.subscribe('callee');
  await caller.controller.start('voice');
  await settle();
  await callee.controller.decline();
  await settle();
  assert.equal([...db.docs.values()].find(data => data.status)?.status, 'declined');
  assert.equal(callee.requested.length, 0);
  assert.equal(FakePeer.instances[0].closed, true);
  assert.ok(caller.streams[0].getTracks().every(track => track.stopped));
  assert.ok(caller.messages.some(message => /declined/i.test(message.message)));
  callee.controller.stop();
});

test('speaker selection uses the browser picker and reports unsupported devices', async () => {
  const db = fakeDatabase();
  const chosen = client(db, 'caller', null, { mediaDevices: {
    selectAudioOutput: async () => ({ deviceId: 'speaker' })
  } });
  await chosen.controller.start('voice');
  const audio = chosen.document.getElementById('goldenCallRemoteAudio');
  audio.setSinkId = async id => { audio.sinkId = id; };
  await chosen.controller.chooseSpeaker();
  assert.equal(audio.sinkId, 'speaker');
  assert.match(chosen.messages.at(-1).message, /output selected/i);
  await chosen.controller.hangup();

  const unsupported = client(fakeDatabase(), 'caller');
  await unsupported.controller.start('voice');
  await unsupported.controller.chooseSpeaker();
  assert.match(unsupported.messages.at(-1).message, /device's audio output settings/i);
  await unsupported.controller.hangup();
});

test('audio boost amplifies the remote stream and releases its audio context on hangup', async () => {
  FakePeer.instances = [];
  const output = fakeStream(false);
  let context;
  class FakeAudioContext {
    constructor() { context = this; }
    createMediaStreamSource(stream) {
      this.sourceStream = stream;
      return { connect() {}, disconnect() {} };
    }
    createGain() { this.gain = { gain: { value: 1 }, connect() {} }; return this.gain; }
    createMediaStreamDestination() { return { stream: output }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  const caller = client(fakeDatabase(), 'caller', null, { AudioContext: FakeAudioContext });
  await caller.controller.start('voice');
  const remote = fakeStream(false);
  FakePeer.instances[0].ontrack({ streams: [remote] });
  await caller.controller.toggleBoost();
  assert.equal(context.sourceStream, remote);
  assert.equal(context.gain.gain.value, 1.5);
  assert.equal(caller.elements.get('goldenCallRemoteAudio').srcObject, output);
  assert.equal(caller.elements.get('goldenCallBoost')['aria-pressed'], 'true');
  await caller.controller.toggleBoost();
  assert.equal(context.gain.gain.value, 1);
  assert.equal(caller.elements.get('goldenCallBoost')['aria-pressed'], 'false');
  await caller.controller.hangup();
  assert.equal(context.closed, true);
  assert.ok(output.getTracks().every(track => track.stopped));
  assert.ok(remote.getTracks().every(track => track.stopped));
});

test('audio boost failure restores normal playback and reports the error', async () => {
  FakePeer.instances = [];
  const output = fakeStream(false);
  let context;
  class FailingAudioContext {
    constructor() { context = this; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createMediaStreamDestination() { return { stream: output }; }
    async resume() { throw new Error('Audio unavailable'); }
    async close() { this.closed = true; }
  }
  const person = client(fakeDatabase(), 'caller', null, { AudioContext: FailingAudioContext });
  await person.controller.start('voice');
  const remote = fakeStream(false);
  FakePeer.instances[0].ontrack({ streams: [remote] });
  await person.controller.toggleBoost();
  assert.equal(person.elements.get('goldenCallRemoteAudio').srcObject, remote);
  assert.equal(context.closed, true);
  assert.ok(output.getTracks().every(track => track.stopped));
  assert.ok(person.messages.some(message => /boost could not be enabled/i.test(message.message)));
  await person.controller.hangup();
});

test('speaker selection lists available outputs when the browser has no device picker', async () => {
  const person = client(fakeDatabase(), 'caller', null, { mediaDevices: {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
      { kind: 'audiooutput', deviceId: 'speaker', label: 'External speaker' }
    ]
  } });
  await person.controller.start('voice');
  const audio = person.document.getElementById('goldenCallRemoteAudio');
  audio.setSinkId = async id => { audio.sinkId = id; };
  await person.controller.chooseSpeaker();
  const select = person.elements.get('goldenCallOutputSelect');
  assert.deepEqual(select.children.map(option => option.value), ['', 'speaker']);
  assert.equal(person.elements.get('goldenCallOutputPicker').classList.contains('hidden'), false);
  await person.controller.setSpeaker('speaker');
  assert.equal(audio.sinkId, 'speaker');
  await person.controller.hangup();
});

test('history subscriptions show only the selected chat and viewer and stop on unsubscribe', async () => {
  const db = fakeDatabase();
  const person = client(db, 'caller');
  const observed = [];
  const errors = [];
  const stop = person.controller.watchHistory('chat', 'caller', docs => observed.push(docs.map(doc => doc.data())), error => errors.push(error));
  await db.collection('calls').doc().set({ chatId: 'chat', callerUid: 'caller', calleeUid: 'callee' });
  await db.collection('calls').doc().set({ chatId: 'chat', callerUid: 'callee', calleeUid: 'caller' });
  await db.collection('calls').doc().set({ chatId: 'other', callerUid: 'caller', calleeUid: 'callee' });
  await db.collection('calls').doc().set({ chatId: 'chat', callerUid: 'other', calleeUid: 'callee' });
  await settle();
  assert.equal(observed.at(-1).length, 2);
  assert.equal(errors.length, 0);
  stop();
  const count = observed.length;
  await db.collection('calls').doc().set({ chatId: 'chat', callerUid: 'caller', calleeUid: 'callee' });
  await settle();
  assert.equal(observed.length, count);
});

test('history distinguishes direction, declined, answered and expired unanswered calls', () => {
  const person = client(fakeDatabase(), 'caller');
  const now = 100000;
  const call = { callerUid: 'caller', calleeUid: 'callee', type: 'video',
    status: 'ringing', createdAt: { toMillis: () => 50000 } };
  assert.equal(person.controller.describeCall(call, 'caller', now), 'Outgoing video call · Ringing');
  assert.equal(person.controller.describeCall(call, 'callee', now + 10000), 'Incoming video call · Missed');
  assert.equal(person.controller.describeCall({ ...call, status: 'ended' }, 'caller', now), 'Outgoing video call · No answer');
  assert.equal(person.controller.describeCall({ ...call, status: 'declined' }, 'callee', now), 'Incoming video call · Declined');
  assert.equal(person.controller.describeCall({ ...call, status: 'ended', answer: { type: 'answer' } }, 'callee', now), 'Incoming video call · Answered');
});
