import { Storage } from "@mondaycom/apps-sdk";
import type {
  TokenStore,
  StateStore,
  StoredTokens,
  StoredStates,
} from "./types.js";

const TOKENS_KEY = "jira_tokens";
const STATES_KEY = "oauth_states";

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

function getMondayToken(): string {
  const token = process.env["MONDAY_API_TOKEN"];
  if (!token) {
    throw new Error(
      "MONDAY_API_TOKEN is required when TOKEN_STORE=monday"
    );
  }
  return token;
}

export class MondayTokenStore implements TokenStore {
  private storage: Storage;

  constructor() {
    this.storage = new Storage(getMondayToken());
  }

  async load(): Promise<StoredTokens | null> {
    const result = await this.storage.get<string>(TOKENS_KEY);
    if (!result.success || result.value == null) return null;
    try {
      return JSON.parse(result.value) as StoredTokens;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    const result = await this.storage.set(TOKENS_KEY, JSON.stringify(tokens));
    if (!result.success) {
      throw new Error(
        `Failed to save tokens to monday storage: ${result.error ?? "unknown error"}`
      );
    }
  }

  async clear(): Promise<void> {
    await this.storage.delete(TOKENS_KEY);
  }
}

export class MondayStateStore implements StateStore {
  private storage: Storage;

  constructor() {
    this.storage = new Storage(getMondayToken());
  }

  private async loadStates(): Promise<StoredStates> {
    const result = await this.storage.get<string>(STATES_KEY);
    if (!result.success || result.value == null) return {};
    try {
      return JSON.parse(result.value) as StoredStates;
    } catch {
      return {};
    }
  }

  private async saveStates(states: StoredStates): Promise<void> {
    await this.storage.set(STATES_KEY, JSON.stringify(states));
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
