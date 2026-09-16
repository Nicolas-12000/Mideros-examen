"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

const STATIONS = 9;
const CHANNELS_PER_STATION = 3;
const CHANNELS = STATIONS * CHANNELS_PER_STATION;
const SAMPLE_RATE = 200;
const HISTORY_SECONDS = 600;
const HISTORY_SAMPLES = SAMPLE_RATE * HISTORY_SECONDS;
const FRAME_SAMPLES = 50;
const FRAME_BYTES = 216;
const CANVAS_WIDTH = 900;
const TRACK_HEIGHT = 26;
const WINDOW_SECONDS_DEFAULT = 60;
const COINCIDENCE_WINDOW_US = 6_000_000;

type EventInfo = {
  id: number;
  sampleIndex: number;
  tsUs: number;
  stations: number[];
  peak: number;
};

type InpStats = {
  value: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  longTasks: number;
};

function partitionStations(workerCount: number): number[][] {
  const chunks: number[][] = Array.from({ length: workerCount }, () => []);
  for (let station = 1; station <= STATIONS; station += 1) {
    chunks[(station - 1) % workerCount].push(station);
  }
  return chunks;
}

function readStableSample(samples: Int32Array, seq: Int32Array, channel: number, idx: number): number | null {
  const slot = idx % HISTORY_SAMPLES;
  const offset = channel * HISTORY_SAMPLES + slot;
  const before = Atomics.load(seq, offset);
  if (before !== idx) return null;
  const value = samples[offset];
  const after = Atomics.load(seq, offset);
  return before === after && after === idx ? value : null;
}

function buildFrame(stationId: number, channel: number, seq: number, t0Us: number, phase: number): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint16(0, stationId, true);
  view.setUint8(2, channel);
  view.setUint8(3, 0);
  view.setUint32(4, seq, true);
  view.setFloat64(8, t0Us, true);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const base = Math.sin((phase + i) * 0.09 + channel) * 1800;
    const pulse = (seq % 120 === 0 && stationId % 2 === 0) || (seq % 137 === 0 && stationId % 3 === 0) ? 9000 : 0;
    view.setInt32(16 + i * 4, Math.round(base + pulse), true);
  }
  return buffer;
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workersRef = useRef<Worker[]>([]);
  const exportWorkerRef = useRef<Worker | null>(null);
  const sabRef = useRef<{ samples: Int32Array; seq: Int32Array; heads: Int32Array } | null>(null);
  const stationWorkerMap = useRef<Map<number, Worker>>(new Map());
  const stationState = useRef<Map<number, { active: boolean; startUs: number }>>(new Map());
  const channelPeaks = useRef<number[]>(Array(CHANNELS).fill(0));
  const simTimer = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const [crossIso] = useState(() => (typeof window !== "undefined" ? window.crossOriginIsolated : false));
  const [windowSeconds, setWindowSeconds] = useState(WINDOW_SECONDS_DEFAULT);
  const [offsetSamples, setOffsetSamples] = useState(0);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [inp, setInp] = useState<InpStats>({ value: 0, inputDelay: 0, processing: 0, presentation: 0, longTasks: 0 });
  const [bench, setBench] = useState<{ copyMs: number; transferMs: number }>({ copyMs: 0, transferMs: 0 });
  const dragging = useRef<{ active: boolean; x: number; offset: number }>({ active: false, x: 0, offset: 0 });
  const windowSecondsRef = useRef(WINDOW_SECONDS_DEFAULT);
  const offsetSamplesRef = useRef(0);

  const workerCount = useMemo(
    () => Math.max(1, Math.min(STATIONS, ((typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) || 4) - 1)),
    [],
  );

  const evaluateCoincidence = useCallback((atUs: number, sampleIndex: number) => {
    const activeStations: number[] = [];
    for (const [stationId, state] of stationState.current.entries()) {
      if (state.active && atUs - state.startUs <= COINCIDENCE_WINDOW_US) {
        activeStations.push(stationId);
      }
    }
    if (activeStations.length < 4) return;

    setEvents((prev) => {
      if (prev.length > 0 && sampleIndex - prev[prev.length - 1].sampleIndex < SAMPLE_RATE) {
        return prev;
      }
      const stationPeaks = activeStations.map((stationId) => {
        const ch = (stationId - 1) * CHANNELS_PER_STATION;
        return Math.max(channelPeaks.current[ch], channelPeaks.current[ch + 1], channelPeaks.current[ch + 2]);
      });
      return [
        ...prev.slice(-9),
        {
          id: sampleIndex,
          sampleIndex,
          tsUs: atUs,
          stations: activeStations,
          peak: Math.max(...stationPeaks, 0),
        },
      ];
    });
  }, []);

  useEffect(() => {
    const samplesSab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CHANNELS * HISTORY_SAMPLES);
    const seqSab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CHANNELS * HISTORY_SAMPLES);
    const headsSab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CHANNELS);

    const samples = new Int32Array(samplesSab);
    const seq = new Int32Array(seqSab);
    const heads = new Int32Array(headsSab);
    seq.fill(-1);
    sabRef.current = { samples, seq, heads };

    const stationsPerWorker = partitionStations(workerCount);
    workersRef.current = stationsPerWorker.map((stations) => {
      const worker = new Worker(new URL("../workers/signal.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg.type === "trigger-start") {
          stationState.current.set(msg.stationId, { active: true, startUs: msg.tsUs });
          evaluateCoincidence(msg.tsUs, msg.sampleIndex);
        } else if (msg.type === "trigger-end") {
          stationState.current.set(msg.stationId, { active: false, startUs: msg.tsUs });
        } else if (msg.type === "channel-peak") {
          channelPeaks.current[msg.channel] = msg.peak;
        }
      };
      worker.postMessage({
        type: "init",
        stations,
        historySamples: HISTORY_SAMPLES,
        channelsPerStation: CHANNELS_PER_STATION,
        samplesSab,
        seqSab,
        writeHeadsSab: headsSab,
      });
      for (const station of stations) {
        stationWorkerMap.current.set(station, worker);
      }
      return worker;
    });

    exportWorkerRef.current = new Worker(new URL("../workers/export.worker.ts", import.meta.url), { type: "module" });

    const simSeq = Array(CHANNELS).fill(0);
    let tUs = Date.now() * 1000;
    simTimer.current = window.setInterval(() => {
      for (let station = 1; station <= STATIONS; station += 1) {
        for (let channel = 0; channel < CHANNELS_PER_STATION; channel += 1) {
          const globalChannel = (station - 1) * CHANNELS_PER_STATION + channel;
          const buffer = buildFrame(station, channel, simSeq[globalChannel], tUs, simSeq[globalChannel]);
          simSeq[globalChannel] += 1;
          const worker = stationWorkerMap.current.get(station);
          worker?.postMessage({ type: "frame", buffer }, [buffer]);
        }
      }
      tUs += 250_000;
    }, 250);

    const hasEventTiming = PerformanceObserver.supportedEntryTypes.includes("event");
    const hasLongTask = PerformanceObserver.supportedEntryTypes.includes("longtask");

    let inpObserver: PerformanceObserver | null = null;
    let longTaskObserver: PerformanceObserver | null = null;

    if (hasEventTiming) {
      inpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) {
          setInp((prev) => {
            if (entry.duration < prev.value) return prev;
            const inputDelay = entry.processingStart - entry.startTime;
            const processing = entry.processingEnd - entry.processingStart;
            const presentation = Math.max(0, entry.duration - (entry.processingEnd - entry.startTime));
            return { ...prev, value: entry.duration, inputDelay, processing, presentation };
          });
        }
      });
      inpObserver.observe({ type: "event", buffered: true });
    }

    if (hasLongTask) {
      longTaskObserver = new PerformanceObserver((list) => {
        setInp((prev) => ({ ...prev, longTasks: prev.longTasks + list.getEntries().length }));
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }

    const draw = () => {
      const canvas = canvasRef.current;
      const sab = sabRef.current;
      if (!canvas || !sab) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const width = canvas.width;
      const height = canvas.height;
      ctx.fillStyle = "#02060c";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#65b4ff";
      ctx.lineWidth = 1;

      let latest = 0;
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        latest = Math.max(latest, Atomics.load(sab.heads, ch));
      }

      const windowSamples = Math.max(SAMPLE_RATE * 10, Math.floor(windowSecondsRef.current * SAMPLE_RATE));
      const endSample = Math.max(0, latest - offsetSamplesRef.current);
      const startSample = Math.max(0, endSample - windowSamples);
      const spp = Math.max(1, Math.floor(windowSamples / width));

      for (let ch = 0; ch < CHANNELS; ch += 1) {
        const yMid = ch * TRACK_HEIGHT + TRACK_HEIGHT / 2;
        const scale = 0.0018;
        for (let x = 0; x < width; x += 1) {
          let min = Number.POSITIVE_INFINITY;
          let max = Number.NEGATIVE_INFINITY;
          const from = startSample + x * spp;
          const to = Math.min(endSample, from + spp);

          for (let idx = from; idx < to; idx += 1) {
            const value = readStableSample(sab.samples, sab.seq, ch, idx);
            if (value === null) {
              min = Number.POSITIVE_INFINITY;
              max = Number.NEGATIVE_INFINITY;
              break;
            }
            if (value < min) min = value;
            if (value > max) max = value;
          }

          if (min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) continue;
          ctx.beginPath();
          ctx.moveTo(x, yMid - max * scale);
          ctx.lineTo(x, yMid - min * scale);
          ctx.stroke();
        }

        ctx.fillStyle = "#93aac6";
        ctx.font = "10px Arial";
        ctx.fillText(`E${Math.floor(ch / 3) + 1}-${ch % 3}`, 4, ch * TRACK_HEIGHT + 10);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (simTimer.current) window.clearInterval(simTimer.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      inpObserver?.disconnect();
      longTaskObserver?.disconnect();
      workersRef.current.forEach((w) => w.terminate());
      workersRef.current = [];
      exportWorkerRef.current?.terminate();
      exportWorkerRef.current = null;
    };
  }, [evaluateCoincidence, workerCount]);

  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? 1.1 : 0.9;
    setWindowSeconds((prev) => {
      const next = Math.min(120, Math.max(10, prev * delta));
      windowSecondsRef.current = next;
      return next;
    });
  }, []);

  const onMouseDown = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    dragging.current = { active: true, x: event.clientX, offset: offsetSamples };
  }, [offsetSamples]);

  const onMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging.current.active) return;
    const dx = event.clientX - dragging.current.x;
    const deltaSamples = Math.round((dx / CANVAS_WIDTH) * windowSeconds * SAMPLE_RATE);
    const next = Math.max(0, dragging.current.offset + deltaSamples);
    offsetSamplesRef.current = next;
    setOffsetSamples(next);
  }, [windowSeconds]);

  const onMouseUp = useCallback(() => {
    dragging.current.active = false;
  }, []);

  const runBenchmark = useCallback(() => {
    const worker = exportWorkerRef.current;
    if (!worker) return;

    const copyPayload = new Float32Array(250_000).fill(1.234);
    const transferPayload = new Float32Array(250_000).fill(1.234);

    const copyStart = performance.now();
    const onCopy = (ev: MessageEvent) => {
      if (ev.data?.type !== "benchmark-copy-done") return;
      const copyMs = performance.now() - copyStart;
      const transferStart = performance.now();
      const onTransfer = (ev2: MessageEvent) => {
        if (ev2.data?.type !== "benchmark-transfer-done") return;
        const transferMs = performance.now() - transferStart;
        setBench({ copyMs, transferMs });
      };
      worker.addEventListener("message", onTransfer, { once: true });
      worker.postMessage({ type: "benchmark-transfer", payload: transferPayload, t0: performance.now() }, [transferPayload.buffer]);
    };
    worker.addEventListener("message", onCopy, { once: true });
    worker.postMessage({ type: "benchmark-copy", payload: copyPayload, t0: performance.now() });
  }, []);

  const exportEvent = useCallback((evt: EventInfo) => {
    const sab = sabRef.current;
    const worker = exportWorkerRef.current;
    if (!sab || !worker) return;

    const pad = 90 * SAMPLE_RATE;
    const startSample = Math.max(0, evt.sampleIndex - pad);
    const endSample = evt.sampleIndex + pad;

    const channels = Array.from({ length: CHANNELS }, (_, channelId) => {
      const values = new Int32Array(Math.max(0, endSample - startSample));
      for (let i = 0; i < values.length; i += 1) {
        const value = readStableSample(sab.samples, sab.seq, channelId, startSample + i);
        values[i] = value ?? 0;
      }
      return { channelId, samples: values };
    });

    const transfers = channels.map((c) => c.samples.buffer);
    const onExport = (ev: MessageEvent) => {
      if (ev.data.type !== "export-done") return;
      const blob = new Blob([ev.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `evento-${evt.id}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    };
    worker.addEventListener("message", onExport, { once: true });
    worker.postMessage({ type: "export", startSample, endSample, sampleRate: SAMPLE_RATE, channels }, transfers);
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1>Consola vulcanológica (Next.js + Workers + SAB)</h1>
        <span className={styles.kpi}>crossOriginIsolated: {String(crossIso)}</span>
        <span className={styles.kpi}>INP máx: {inp.value.toFixed(1)} ms</span>
        <span className={styles.kpi}>Long Tasks: {inp.longTasks}</span>
      </div>

      <div className={styles.controls}>
        <label>
          Ventana (s)
          <input
            type="range"
            min={10}
            max={120}
            value={Math.round(windowSeconds)}
            onChange={(e) => {
              const next = Number(e.target.value);
              windowSecondsRef.current = next;
              setWindowSeconds(next);
            }}
          />
          {windowSeconds.toFixed(0)}
        </label>
        <label>
          Retardo (muestras)
          <input
            type="number"
            value={offsetSamples}
            onChange={(e) => {
              const next = Math.max(0, Number(e.target.value) || 0);
              offsetSamplesRef.current = next;
              setOffsetSamples(next);
            }}
          />
        </label>
        <button
          onClick={() => {
            offsetSamplesRef.current = 0;
            setOffsetSamples(0);
          }}
        >
          Volver a tiempo real
        </button>
        <button onClick={runBenchmark}>Medir copy vs transferible</button>
      </div>

      <div className={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CHANNELS * TRACK_HEIGHT}
          className={styles.canvas}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Métrica</th>
            <th>Valor (ms)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>INP - input delay</td>
            <td>{inp.inputDelay.toFixed(1)}</td>
          </tr>
          <tr>
            <td>INP - processing</td>
            <td>{inp.processing.toFixed(1)}</td>
          </tr>
          <tr>
            <td>INP - presentation</td>
            <td>{inp.presentation.toFixed(1)}</td>
          </tr>
          <tr>
            <td>postMessage copy</td>
            <td>{bench.copyMs.toFixed(2)}</td>
          </tr>
          <tr>
            <td>postMessage transferible</td>
            <td>{bench.transferMs.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      <div className={styles.events}>
        {events.map((evt) => (
          <div key={evt.id} className={styles.event}>
            <span>
              Evento {new Date(evt.tsUs / 1000).toISOString()} | Estaciones: {evt.stations.join(",")} | Pico: {evt.peak}
            </span>
            <button onClick={() => exportEvent(evt)}>Exportar ±90s CSV</button>
          </div>
        ))}
      </div>
    </div>
  );
}
