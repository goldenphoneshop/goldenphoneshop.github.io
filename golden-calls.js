(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = { createGoldenCalls: factory };
  } else {
    root.createGoldenCalls = factory;
  }
})(typeof globalThis === "object" ? globalThis : this, function createGoldenCalls(options) {
  "use strict";

  const { db, document, getUser, getChat, serverTimestamp, notify, mediaDevices,
    RTCPeerConnection, AudioContext, isSecureContext, timers = globalThis } = options;
  const calls = db.collection("calls");
  const element = id => document.getElementById(id);
  let session = null;
  let incoming = null;
  let incomingDocs = [];
  let incomingUnsubscribe = null;
  let listenerUid = null;
  let incomingTimer = null;

  function show(id, visible) {
    element(id).classList.toggle("hidden", !visible);
  }

  function callError(error) {
    if (!isSecureContext || !mediaDevices?.getUserMedia || !RTCPeerConnection) {
      return "Calls require HTTPS and a browser that supports WebRTC.";
    }
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name)) {
      return "Microphone or camera access was blocked. Allow access in your browser settings and try again.";
    }
    if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) {
      return "The required microphone or camera was not found.";
    }
    return "The call could not connect. Check your connection and try again; some networks require a TURN relay.";
  }

  function releaseAudioProcessing(s) {
    if (s.audioSource) s.audioSource.disconnect();
    if (s.audioOutput) s.audioOutput.stream.getTracks().forEach(track => track.stop());
    if (s.audioContext) {
      s.audioContext.close().catch(error => console.error("Unable to close call audio processing.", error));
    }
    s.audioSource = null;
    s.audioOutput = null;
    s.audioContext = null;
    s.audioGain = null;
    s.boosted = false;
  }

  function closeSession(s) {
    if (!s || session !== s) return;
    session = null;
    s.closed = true;
    s.unsubscribers.forEach(unsubscribe => unsubscribe());
    if (s.ringTimer) timers.clearTimeout(s.ringTimer);
    if (s.connectionTimer) timers.clearTimeout(s.connectionTimer);
    if (s.timer) timers.clearInterval(s.timer);
    releaseAudioProcessing(s);
    if (s.pc) {
      s.pc.onicecandidate = null;
      s.pc.ontrack = null;
      s.pc.onconnectionstatechange = null;
      s.pc.close();
    }
    for (const stream of [s.stream, s.remoteStream]) {
      stream?.getTracks().forEach(track => track.stop());
    }
    for (const id of ["goldenCallLocalVideo", "goldenCallRemoteVideo", "goldenCallRemoteAudio"]) {
      element(id).srcObject = null;
    }
    show("goldenCallModal", false);
    showIncoming();
  }

  async function endRemote(s) {
    if (!s.created) return;
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(s.ref);
        if (snapshot.exists && (snapshot.data().status === "ringing" ||
            (snapshot.data().status === "accepted" && (s.caller || s.accepted)))) {
          transaction.update(s.ref, { status: "ended" });
        }
      });
    } catch (error) {
      console.error("Unable to end call signaling.", error);
      notify("The call ended locally, but the other participant may not have been notified.", "error");
    }
  }

  async function hangup() {
    const s = session;
    if (!s) return;
    closeSession(s);
    await endRemote(s);
  }

  function updateTimer(s) {
    const seconds = Math.floor((Date.now() - s.connectedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    element("goldenCallTimer").textContent =
      `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function displaySession(s, label) {
    show("goldenIncomingCallModal", false);
    show("goldenCallModal", true);
    element("goldenCallTitle").textContent = `${s.type === "video" ? "Video" : "Voice"} call`;
    element("goldenCallStatus").textContent = label;
    element("goldenCallTimer").textContent = "00:00";
    element("goldenCallMute").textContent = "Mute mic";
    element("goldenCallCamera").textContent = "Turn camera off";
    element("goldenCallBoost").textContent = "Boost audio";
    element("goldenCallBoost").setAttribute("aria-pressed", "false");
    show("goldenCallOutputPicker", false);
    show("goldenCallCamera", s.type === "video");
    show("goldenCallVideoArea", s.type === "video");
    show("goldenCallVoiceArea", s.type === "voice");
    show("goldenCallEnableAudio", false);
  }

  async function chooseSpeaker() {
    const audio = element("goldenCallRemoteAudio");
    if (typeof audio.setSinkId !== "function" ||
        (!mediaDevices?.selectAudioOutput && !mediaDevices?.enumerateDevices)) {
      notify("This browser cannot switch speakers. Use your device's audio output settings and volume buttons.", "info");
      return;
    }
    const s = session;
    if (!s) return;
    try {
      if (mediaDevices.selectAudioOutput) {
        const device = await mediaDevices.selectAudioOutput();
        if (session === s) await setSpeaker(device.deviceId);
      } else {
        const devices = (await mediaDevices.enumerateDevices()).filter(device => device.kind === "audiooutput");
        if (session !== s) return;
        if (!devices.length) {
          notify("No selectable audio outputs were found. Use your device's audio settings.", "info");
          return;
        }
        const select = element("goldenCallOutputSelect");
        select.replaceChildren();
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "System default";
        select.appendChild(defaultOption);
        devices.forEach((device, index) => {
          const option = document.createElement("option");
          option.value = device.deviceId;
          option.textContent = device.label || `Audio output ${index + 1}`;
          select.appendChild(option);
        });
        select.value = audio.sinkId || "";
        show("goldenCallOutputPicker", true);
      }
    } catch (error) {
      console.error("Unable to select call audio output.", error);
      if (session === s) {
        notify("Audio output was not changed. Select a speaker in your device settings.", "error");
      }
    }
  }

  async function setSpeaker(deviceId) {
    const s = session;
    if (!s) return;
    try {
      await element("goldenCallRemoteAudio").setSinkId(deviceId);
      if (session === s) notify("Audio output selected. Adjust your device volume if needed.", "info");
    } catch (error) {
      console.error("Unable to set call audio output.", error);
      if (session === s) notify("Audio output was not changed. Select a speaker in your device settings.", "error");
    }
  }

  async function toggleBoost() {
    const s = session;
    if (!s?.remoteStream) {
      notify("Audio boost is available after the other person joins.", "info");
      return;
    }
    if (!AudioContext) {
      notify("Audio boost is not supported in this browser. Use your device volume controls.", "info");
      return;
    }
    if (s.boostPending) return;
    if (s.audioGain) {
      s.boosted = !s.boosted;
      s.audioGain.gain.value = s.boosted ? 1.5 : 1;
      element("goldenCallBoost").textContent = s.boosted ? "Turn boost off" : "Boost audio";
      element("goldenCallBoost").setAttribute("aria-pressed", String(s.boosted));
      return;
    }
    s.boostPending = true;
    try {
      s.audioContext = new AudioContext();
      s.audioSource = s.audioContext.createMediaStreamSource(s.remoteStream);
      s.audioGain = s.audioContext.createGain();
      s.audioOutput = s.audioContext.createMediaStreamDestination();
      s.audioGain.gain.value = 1.5;
      s.audioSource.connect(s.audioGain);
      s.audioGain.connect(s.audioOutput);
      await s.audioContext.resume();
      if (session !== s) return;
      element("goldenCallRemoteAudio").srcObject = s.audioOutput.stream;
      await element("goldenCallRemoteAudio").play();
      if (session !== s) return;
      s.boosted = true;
      element("goldenCallBoost").textContent = "Turn boost off";
      element("goldenCallBoost").setAttribute("aria-pressed", "true");
      notify("Audio boost is on. Lower your device volume if it sounds too loud.", "info");
    } catch (error) {
      console.error("Unable to boost call audio.", error);
      if (session === s) {
        releaseAudioProcessing(s);
        element("goldenCallRemoteAudio").srcObject = s.remoteStream;
        notify("Audio boost could not be enabled. Use your device volume controls.", "error");
        await enableAudio();
      }
    } finally {
      s.boostPending = false;
    }
  }

  async function enableAudio() {
    try {
      await element("goldenCallRemoteAudio").play();
      show("goldenCallEnableAudio", false);
    } catch (error) {
      console.error("Unable to play call audio.", error);
      notify("Audio playback was blocked. Check your browser audio settings.", "error");
    }
  }

  function setupPeer(s) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    s.pc = pc;
    s.stream.getTracks().forEach(track => pc.addTrack(track, s.stream));
    pc.onicecandidate = event => {
      if (!event.candidate || session !== s) return;
      const value = event.candidate.toJSON();
      s.localCandidates.push({
        candidate: value.candidate,
        sdpMid: value.sdpMid ?? null,
        sdpMLineIndex: value.sdpMLineIndex ?? null
      });
      flushLocalCandidates(s);
    };
    pc.ontrack = event => {
      if (session !== s || !event.streams[0]) return;
      if (s.audioContext && s.remoteStream !== event.streams[0]) {
        try {
          const source = s.audioContext.createMediaStreamSource(event.streams[0]);
          source.connect(s.audioGain);
          s.audioSource.disconnect();
          s.audioSource = source;
        } catch (error) {
          console.error("Unable to apply audio boost to the new stream.", error);
          releaseAudioProcessing(s);
          element("goldenCallBoost").textContent = "Boost audio";
          element("goldenCallBoost").setAttribute("aria-pressed", "false");
          notify("Audio boost stopped. Use your device volume controls.", "error");
        }
      }
      s.remoteStream = event.streams[0];
      element("goldenCallRemoteVideo").srcObject = s.remoteStream;
      element("goldenCallRemoteAudio").srcObject = s.audioOutput ? s.audioOutput.stream : s.remoteStream;
      element("goldenCallRemoteAudio").play().catch(() => {
        if (session === s) {
          element("goldenCallStatus").textContent = "Tap Enable audio to hear the other person.";
          show("goldenCallEnableAudio", true);
        }
      });
    };
    pc.onconnectionstatechange = () => {
      if (session !== s) return;
      if (pc.connectionState === "connected") {
        if (s.connectionTimer) timers.clearTimeout(s.connectionTimer);
        s.connectionTimer = null;
        if (!s.connectedAt) {
          s.connectedAt = Date.now();
          updateTimer(s);
          s.timer = timers.setInterval(() => updateTimer(s), 1000);
        }
        element("goldenCallStatus").textContent = "Connected";
      } else if (pc.connectionState === "failed") {
        notify("Call connection failed. Some networks require a TURN relay.", "error");
        hangup();
      } else if (pc.connectionState === "disconnected") {
        element("goldenCallStatus").textContent = "Connection interrupted…";
        if (!s.connectionTimer) {
          s.connectionTimer = timers.setTimeout(() => {
            if (session === s && pc.connectionState === "disconnected") {
              notify("Call connection was lost.", "error");
              hangup();
            }
          }, 30000);
        }
      }
    };
    element("goldenCallLocalVideo").srcObject = s.stream;
    return pc;
  }

  function flushLocalCandidates(s) {
    if (!s.created || !s.canWriteCandidates || s.flushing || session !== s) return;
    s.flushing = true;
    (async () => {
      while (s.localCandidates.length && session === s) {
        const candidate = s.localCandidates.shift();
        await s.ref.collection(s.caller ? "callerCandidates" : "calleeCandidates").add(candidate);
      }
    })().catch(error => {
      console.error("Unable to send call connection details.", error);
      if (session === s) {
        notify("Call signaling failed. Check your connection.", "error");
        hangup();
      }
    }).finally(() => {
      s.flushing = false;
      if (s.localCandidates.length) flushLocalCandidates(s);
    });
  }

  function flushRemoteCandidates(s) {
    if (!s.remoteReady || s.processing || session !== s) return;
    s.processing = true;
    (async () => {
      while (s.remoteCandidates.length && session === s) {
        await s.pc.addIceCandidate(s.remoteCandidates.shift());
      }
    })().catch(error => {
      console.error("Unable to apply call connection details.", error);
      if (session === s) {
        notify("Call signaling failed. Please try again.", "error");
        hangup();
      }
    }).finally(() => {
      s.processing = false;
      if (s.remoteCandidates.length) flushRemoteCandidates(s);
    });
  }

  function watchCandidates(s) {
    s.unsubscribers.push(s.ref.collection(s.caller ? "calleeCandidates" : "callerCandidates")
      .onSnapshot(snapshot => {
        if (session !== s) return;
        for (const change of snapshot.docChanges()) {
          if (change.type === "added") s.remoteCandidates.push(change.doc.data());
        }
        flushRemoteCandidates(s);
      }, error => {
        console.error("Unable to listen for call connection details.", error);
        if (session === s) {
          notify("Call signaling was interrupted.", "error");
          hangup();
        }
      }));
  }

  function watchCall(s) {
    s.unsubscribers.push(s.ref.onSnapshot(snapshot => {
      if (session !== s || !snapshot.exists) return;
      const data = snapshot.data();
      if (["ended", "declined"].includes(data.status)) {
        closeSession(s);
        notify(data.status === "declined" ? "Call declined." : "Call ended.", "info");
        return;
      }
      if (s.caller && data.status === "accepted" && data.answer && !s.settingRemote) {
        s.settingRemote = true;
        if (s.ringTimer) timers.clearTimeout(s.ringTimer);
        element("goldenCallStatus").textContent = "Connecting…";
        s.pc.setRemoteDescription(data.answer).then(() => {
          if (session !== s) return;
          s.remoteReady = true;
          flushRemoteCandidates(s);
        }).catch(error => {
          console.error("Unable to accept call answer.", error);
          if (session === s) {
            notify("The call answer could not be applied.", "error");
            hangup();
          }
        });
      }
    }, error => {
      console.error("Unable to listen for call status.", error);
      if (session === s) {
        notify("Call signaling was interrupted.", "error");
        hangup();
      }
    }));
  }

  function newSession(ref, type, caller) {
    return { ref, type, caller, pc: null, stream: null, remoteStream: null,
      created: !caller, accepted: false, canWriteCandidates: false, localCandidates: [], remoteCandidates: [],
      remoteReady: false, settingRemote: false, flushing: false, processing: false,
      unsubscribers: [], closed: false };
  }

  async function acquireMedia(s) {
    if (!isSecureContext || !mediaDevices?.getUserMedia || !RTCPeerConnection) {
      throw new Error("WebRTC unavailable");
    }
    const stream = await mediaDevices.getUserMedia({ audio: true, video: s.type === "video" });
    if (session !== s) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    s.stream = stream;
    return true;
  }

  async function start(type) {
    const user = getUser();
    const chat = getChat();
    if (!user || !chat?.id || !Array.isArray(chat.data?.participantIds) ||
        chat.data.participantIds.length !== 2 || !chat.data.participantIds.includes(user.uid) ||
        !["voice", "video"].includes(type)) {
      notify("Choose a conversation before starting a call.", "error");
      return;
    }
    if (session || incoming) {
      notify("Finish or decline the current call first.", "info");
      return;
    }
    const calleeUid = chat.data.participantIds.find(uid => uid !== user.uid);
    if (!calleeUid) return;
    const ref = calls.doc();
    const s = newSession(ref, type, true);
    session = s;
    displaySession(s, "Requesting device permission…");
    try {
      if (!await acquireMedia(s)) return;
      const pc = setupPeer(s);
      const offer = await pc.createOffer();
      if (session !== s) return;
      await pc.setLocalDescription(offer);
      if (session !== s) return;
      element("goldenCallStatus").textContent = "Connecting to call service…";
      await ref.set({ chatId: chat.id, callerUid: user.uid, calleeUid, type,
        status: "ringing", offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        createdAt: serverTimestamp() });
      s.created = true;
      if (session !== s) {
        await endRemote(s);
        return;
      }
      s.canWriteCandidates = true;
      watchCall(s);
      watchCandidates(s);
      flushLocalCandidates(s);
      element("goldenCallStatus").textContent = "Calling…";
      s.ringTimer = timers.setTimeout(() => {
        if (session === s && !s.settingRemote) {
          notify("No answer. The call ended.", "info");
          hangup();
        }
      }, 60000);
      s.connectionTimer = timers.setTimeout(() => {
        if (session === s && !s.connectedAt) {
          notify("Call connection timed out. Some networks require a TURN relay.", "error");
          hangup();
        }
      }, 90000);
    } catch (error) {
      console.error("Unable to start call.", error);
      if (session === s) {
        notify(callError(error), "error");
        await hangup();
      }
    }
  }

  function showIncoming() {
    if (incomingTimer) timers.clearTimeout(incomingTimer);
    incomingTimer = null;
    if (session) return;
    const user = getUser();
    incoming = incomingDocs.find(doc => {
      const data = doc.data();
      const created = data.createdAt?.toMillis?.();
      return user && data.calleeUid === user.uid && data.status === "ringing" &&
        Number.isFinite(created) && Date.now() - created < 60000;
    }) || null;
    show("goldenIncomingCallModal", Boolean(incoming));
    if (incoming) {
      element("goldenIncomingCallText").textContent =
        `Incoming ${incoming.data().type === "video" ? "video" : "voice"} call from a chat participant.`;
      const age = Date.now() - incoming.data().createdAt.toMillis();
      incomingTimer = timers.setTimeout(showIncoming, Math.max(1, 60000 - age));
    }
  }

  function subscribe(uid) {
    if (listenerUid === uid && incomingUnsubscribe) return;
    stop();
    if (!uid) return;
    listenerUid = uid;
    incomingUnsubscribe = calls.where("calleeUid", "==", uid).where("status", "==", "ringing")
      .orderBy("createdAt", "desc")
      .limit(10).onSnapshot(snapshot => {
        if (getUser()?.uid !== uid) return;
        incomingDocs = snapshot.docs;
        showIncoming();
      }, error => {
        console.error("Unable to listen for incoming calls.", error);
        notify("Incoming calls could not be loaded. Check your connection and Firestore rules.", "error");
      });
  }

  function watchHistory(chatId, uid, onChange, onError) {
    let active = true;
    const groups = { callerUid: [], calleeUid: [] };
    const unsubscribers = ["callerUid", "calleeUid"].map(role =>
      calls.where("chatId", "==", chatId).where(role, "==", uid)
        .orderBy("createdAt", "desc").limit(100)
        .onSnapshot(snapshot => {
          if (!active) return;
          groups[role] = snapshot.docs;
          onChange([...groups.callerUid, ...groups.calleeUid]);
        }, error => {
          if (active) onError(error);
        }));
    return () => {
      active = false;
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }

  function describeCall(data, uid, now = Date.now()) {
    const outgoing = data.callerUid === uid;
    const direction = outgoing ? "Outgoing" : "Incoming";
    const type = data.type === "video" ? "video" : "voice";
    let status;
    if (data.status === "declined") {
      status = "Declined";
    } else if (data.answer || data.status === "accepted") {
      status = "Answered";
    } else {
      const created = data.createdAt?.toMillis?.();
      const ringing = data.status === "ringing" &&
        (!Number.isFinite(created) || now - created < 60000);
      status = ringing ? "Ringing" : outgoing ? "No answer" : "Missed";
    }
    return `${direction} ${type} call · ${status}`;
  }

  async function answer() {
    if (!incoming || session) return;
    const call = incoming;
    const data = call.data();
    const user = getUser();
    if (!user || data.calleeUid !== user.uid) return;
    incoming = null;
    const s = newSession(call.ref, data.type, false);
    session = s;
    displaySession(s, "Requesting device permission…");
    watchCall(s);
    try {
      if (!await acquireMedia(s)) return;
      const pc = setupPeer(s);
      await pc.setRemoteDescription(data.offer);
      if (session !== s) return;
      s.remoteReady = true;
      watchCandidates(s);
      const answerDescription = await pc.createAnswer();
      if (session !== s) return;
      await pc.setLocalDescription(answerDescription);
      if (session !== s) return;
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(s.ref);
        if (!snapshot.exists || snapshot.data().calleeUid !== user.uid ||
            snapshot.data().status !== "ringing") {
          throw new Error("The call is no longer ringing.");
        }
        transaction.update(s.ref, { status: "accepted",
          answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      });
      s.accepted = true;
      if (session !== s) {
        await endRemote(s);
        return;
      }
      s.canWriteCandidates = true;
      flushLocalCandidates(s);
      element("goldenCallStatus").textContent = "Connecting…";
      s.connectionTimer = timers.setTimeout(() => {
        if (session === s && !s.connectedAt) {
          notify("Call connection timed out. Some networks require a TURN relay.", "error");
          hangup();
        }
      }, 30000);
    } catch (error) {
      console.error("Unable to answer call.", error);
      if (session === s) {
        notify(callError(error), "error");
        await hangup();
      }
    }
  }

  async function decline() {
    if (!incoming || session) return;
    const call = incoming;
    incoming = null;
    show("goldenIncomingCallModal", false);
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(call.ref);
        if (snapshot.exists && snapshot.data().calleeUid === getUser()?.uid &&
            snapshot.data().status === "ringing") {
          transaction.update(call.ref, { status: "declined" });
        }
      });
    } catch (error) {
      console.error("Unable to decline call.", error);
      notify("Could not decline the call. Check your connection.", "error");
    }
  }

  function mute() {
    const track = session?.stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    element("goldenCallMute").textContent = track.enabled ? "Mute mic" : "Unmute mic";
  }

  function toggleCamera() {
    const track = session?.stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    element("goldenCallCamera").textContent = track.enabled ? "Turn camera off" : "Turn camera on";
  }

  function stop() {
    if (incomingUnsubscribe) incomingUnsubscribe();
    incomingUnsubscribe = null;
    listenerUid = null;
    incomingDocs = [];
    incoming = null;
    if (incomingTimer) timers.clearTimeout(incomingTimer);
    incomingTimer = null;
    show("goldenIncomingCallModal", false);
    hangup();
  }

  return { start, subscribe, answer, decline, hangup, mute, toggleCamera, enableAudio,
    chooseSpeaker, setSpeaker, toggleBoost, watchHistory, describeCall, stop };
});
