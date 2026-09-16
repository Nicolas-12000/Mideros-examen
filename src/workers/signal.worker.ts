type Frame = {
  stationId: number;
  channel: number;
  seq: number;
  t0Us: number;
  samples: Int32Array;
};

type ChannelState = {
  expectedSeq: number | null;
  pending: Frame[];
  staRing: Float64Array;
  ltaRing: Float64Array;
  staPos: number;
  ltaPos: number;
  staCount: number;
  ltaCount: number;
  staSum: number;
  ltaSum: number;
  trigOn: boolean;
  deque: { idx: number; val: number }[];
};

const STA_N = 40;
const LTA_N = 1000;
const MAX_N = 1000;
const OFF_RATIO = 2.6;

let historySamples = 120_000;
let channelsPerStation = 3;
let samplesView: Int32Array;
let seqView: Int32Array;
let writeHeads: Int32Array;
let assignedStations: number[] = [];
let ratioOn = 3.2;
let ampThreshold = 5000;

const states = new Map<number, ChannelState>();
const stationActiveChannels = new Map<number, number>();

function ensureState(globalChannel: number): ChannelState {
  const cached = states.get(globalChannel);
  if (cached) return cached;
  const created: ChannelState = {
    expectedSeq: null,
    pending: [],
    staRing: new Float64Array(STA_N),
    ltaRing: new Float64Array(LTA_N),
    staPos: 0,
    ltaPos: 0,
    staCount: 0,
    ltaCount: 0,
    staSum: 0,
    ltaSum: 0,
    trigOn: false,
    deque: [],
  };
  states.set(globalChannel, created);
  return created;
}

function pushOrdered(list: Frame[], frame: Frame) {
  let i = list.length;
  while (i > 0 && (list[i - 1].t0Us > frame.t0Us || (list[i - 1].t0Us === frame.t0Us && list[i - 1].seq > frame.seq))) {
    i -= 1;
  }
  list.splice(i, 0, frame);
}

function updateTrigger(stationId: number, channelState: ChannelState, on: boolean, tsUs: number, sampleIndex: number) {
  if (channelState.trigOn === on) return;
  channelState.trigOn = on;
  const current = stationActiveChannels.get(stationId) ?? 0;
  if (on) {
    const next = current + 1;
    stationActiveChannels.set(stationId, next);
    if (current === 0) {
      postMessage({ type: "trigger-start", stationId, tsUs, sampleIndex });
    }
  } else {
    const next = Math.max(0, current - 1);
    stationActiveChannels.set(stationId, next);
    if (current > 0 && next === 0) {
      postMessage({ type: "trigger-end", stationId, tsUs, sampleIndex });
    }
  }
}

function processSample(globalChannel: number, stationId: number, value: number, sampleTimeUs: number) {
  const channelState = ensureState(globalChannel);
  const abs = Math.abs(value);

  const idx = Atomics.add(writeHeads, globalChannel, 1);
  const slot = idx % historySamples;
  const offset = globalChannel * historySamples + slot;

  Atomics.store(seqView, offset, -idx - 1);
  samplesView[offset] = value;
  Atomics.store(seqView, offset, idx);

  channelState.staSum -= channelState.staRing[channelState.staPos];
  channelState.staRing[channelState.staPos] = abs;
  channelState.staSum += abs;
  channelState.staPos = (channelState.staPos + 1) % STA_N;
  if (channelState.staCount < STA_N) channelState.staCount += 1;

  channelState.ltaSum -= channelState.ltaRing[channelState.ltaPos];
  channelState.ltaRing[channelState.ltaPos] = abs;
  channelState.ltaSum += abs;
  channelState.ltaPos = (channelState.ltaPos + 1) % LTA_N;
  if (channelState.ltaCount < LTA_N) channelState.ltaCount += 1;

  while (channelState.deque.length > 0 && channelState.deque[channelState.deque.length - 1].val <= abs) {
    channelState.deque.pop();
  }
  channelState.deque.push({ idx, val: abs });
  while (channelState.deque.length > 0 && channelState.deque[0].idx <= idx - MAX_N) {
    channelState.deque.shift();
  }

  const staMean = channelState.staCount === 0 ? 0 : channelState.staSum / channelState.staCount;
  const ltaMean = channelState.ltaCount === 0 ? 1 : channelState.ltaSum / channelState.ltaCount;
  const ratio = staMean / Math.max(ltaMean, 1e-6);

  if (!channelState.trigOn && ratio >= ratioOn && abs >= ampThreshold) {
    updateTrigger(stationId, channelState, true, sampleTimeUs, idx);
  } else if (channelState.trigOn && (ratio < OFF_RATIO || abs < ampThreshold * 0.8)) {
    updateTrigger(stationId, channelState, false, sampleTimeUs, idx);
  }

  if ((idx & 63) === 0) {
    postMessage({
      type: "channel-peak",
      channel: globalChannel,
      peak: channelState.deque.length === 0 ? abs : channelState.deque[0].val,
      sampleIndex: idx,
    });
  }
}

function processFrame(frame: Frame) {
  const globalChannel = (frame.stationId - 1) * channelsPerStation + frame.channel;
  const state = ensureState(globalChannel);

  pushOrdered(state.pending, frame);
  if (state.expectedSeq === null && state.pending.length > 0) {
    state.expectedSeq = state.pending[0].seq;
  }

  while (state.pending.length > 0) {
    const next = state.pending[0];
    if (state.expectedSeq !== null && next.seq !== state.expectedSeq) break;
    state.pending.shift();

    for (let i = 0; i < next.samples.length; i += 1) {
      const ts = next.t0Us + i * 5000;
      processSample(globalChannel, next.stationId, next.samples[i], ts);
    }
    if (state.expectedSeq !== null) state.expectedSeq += 1;
  }

  if (state.pending.length > 128) {
    state.pending.splice(0, state.pending.length - 32);
    state.expectedSeq = state.pending[0]?.seq ?? state.expectedSeq;
  }
}

function parseFrame(buffer: ArrayBuffer): Frame {
  const view = new DataView(buffer);
  const stationId = view.getUint16(0, true);
  const channel = view.getUint8(2);
  const seq = view.getUint32(4, true);
  const t0Us = view.getFloat64(8, true);
  const samples = new Int32Array(50);
  for (let i = 0; i < 50; i += 1) {
    samples[i] = view.getInt32(16 + i * 4, true);
  }
  return { stationId, channel, seq, t0Us, samples };
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.type === "init") {
    historySamples = message.historySamples;
    channelsPerStation = message.channelsPerStation;
    assignedStations = message.stations as number[];
    ratioOn = message.ratioOn ?? ratioOn;
    ampThreshold = message.ampThreshold ?? ampThreshold;
    samplesView = new Int32Array(message.samplesSab);
    seqView = new Int32Array(message.seqSab);
    writeHeads = new Int32Array(message.writeHeadsSab);
    for (const stationId of assignedStations) {
      stationActiveChannels.set(stationId, 0);
    }
    postMessage({ type: "ready" });
    return;
  }

  if (message.type === "control") {
    ratioOn = message.ratioOn ?? ratioOn;
    ampThreshold = message.ampThreshold ?? ampThreshold;
    return;
  }

  if (message.type === "frame") {
    processFrame(parseFrame(message.buffer as ArrayBuffer));
  }
};
