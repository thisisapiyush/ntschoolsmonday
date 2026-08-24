import { readFile, writeFile, unlink } from "node:fs/promises";
import type {
  TokenStore,
  StateStore,
  StoredTokens,
  StoredStates,
} from "./types.js";

export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      const data = await readFile(this.filePath, "utf-8");
      return JSON.parse(data) as StoredTokens;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(tokens, null, 2), "utf-8");
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // file doesn't exist
    }
  }
}

function pruneExpired(states: StoredStates): StoredStates {
  const now = Date.now();
  const result: StoredStates = {};
  for (const [key, expiresAt] of Object.entries(states)) {
    if (expiresAt > now) {
      result[key] = expiresAt;
    }
  }
  return result;
}

export class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  private async loadStates(): Promise<StoredStates> {
    try {
      const data = await readFile(this.filePath, "utf-8");
      return JSON.parse(data) as StoredStates;
    } catch {
      return {};
    }
  }

  private async saveStates(states: StoredStates): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(states, null, 2), "utf-8");
  }

  async save(state: string, expiresAt: number): Promise<void> {
    const states = pruneExpired(await this.loadStates());
    states[state] = expiresAt;
    await this.saveStates(states);
  }

  async consume(state: string): Promise<boolean> {
    const states = pruneExpired(await this.loadStates());
    if (!(state in states)) {
      return false;
    }
    delete states[state];
    await this.saveStates(states);
    return true;
  }
}

export { pruneExpired };
