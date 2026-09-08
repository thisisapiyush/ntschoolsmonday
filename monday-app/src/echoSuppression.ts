const ECHO_MARKERS_KEY = "echo_markers";

interface EchoMarkers {
  [key: string]: number;
}

export interface EchoStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
}

export function createEchoStore(opts: {
  storage: EchoStorage;
  windowMs: number;
}) {
  function markerKey(jiraKey: string, field: string, value: string): string {
    return `${jiraKey}:${field}:${value}`;
  }

  async function loadMarkers(): Promise<EchoMarkers> {
    const raw = await opts.storage.get(ECHO_MARKERS_KEY);
    if (raw == null) return {};
    try {
      return JSON.parse(raw) as EchoMarkers;
    } catch {
      return {};
    }
  }

  async function saveMarkers(markers: EchoMarkers): Promise<void> {
    await opts.storage.set(ECHO_MARKERS_KEY, JSON.stringify(markers));
  }

  function pruneExpired(markers: EchoMarkers, now: number): EchoMarkers {
    const pruned: EchoMarkers = {};
    for (const [key, ts] of Object.entries(markers)) {
      if (now - ts < opts.windowMs) {
        pruned[key] = ts;
      }
    }
    return pruned;
  }

  async function check(
    jiraKey: string,
    field: string,
    value: string
  ): Promise<boolean> {
    const key = markerKey(jiraKey, field, value);
    const markers = await loadMarkers();
    const ts = markers[key];
    if (ts === undefined) return false;
    return Date.now() - ts < opts.windowMs;
  }

  async function record(
    jiraKey: string,
    field: string,
    value: string
  ): Promise<void> {
    const now = Date.now();
    const key = markerKey(jiraKey, field, value);
    const markers = pruneExpired(await loadMarkers(), now);
    markers[key] = now;
    await saveMarkers(markers);
  }

  return { check, record, markerKey };
}

export type EchoStore = ReturnType<typeof createEchoStore>;
