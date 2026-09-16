self.onmessage = (event: MessageEvent) => {
  const message = event.data;

  if (message.type === "benchmark-copy") {
    const payload = message.payload as Float32Array;
    postMessage({ type: "benchmark-copy-done", length: payload.length, t0: message.t0 });
    return;
  }

  if (message.type === "benchmark-transfer") {
    const payload = message.payload as Float32Array;
    postMessage({ type: "benchmark-transfer-done", length: payload.length, t0: message.t0 });
    return;
  }

  if (message.type !== "export") return;

  const { startSample, endSample, sampleRate, channels } = message as {
    startSample: number;
    endSample: number;
    sampleRate: number;
    channels: Array<{ channelId: number; samples: Int32Array }>;
  };

  const rows: string[] = [];
  const header = ["sample", "time_s", ...channels.map((c) => `ch_${c.channelId}`)].join(",");
  rows.push(header);

  const count = Math.max(0, endSample - startSample);
  for (let i = 0; i < count; i += 1) {
    const sampleIndex = startSample + i;
    const row = [sampleIndex.toString(), (sampleIndex / sampleRate).toFixed(3)];
    for (const channel of channels) {
      row.push((channel.samples[i] ?? 0).toString());
    }
    rows.push(row.join(","));
  }

  postMessage({ type: "export-done", csv: rows.join("\n") });
};
