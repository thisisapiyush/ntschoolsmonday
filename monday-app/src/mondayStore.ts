import { SecureStorage } from "@mondaycom/apps-sdk";
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

export class MondayTokenStore implements TokenStore {
  private storage: InstanceType<typeof SecureStorage>;

  constructor() {
    this.storage = new SecureStorage();
    console.log(
      `[MondayTokenStore] Constructed with storage: ${this.storage.constructor.name}`
    );
  }

  async load(): Promise<StoredTokens | null> {
    const value = await this.storage.get<string>(TOKENS_KEY);
    if (value == null) {
      console.log(`[MondayTokenStore] load: key "${TOKENS_KEY}" not found`);
      return null;
    }
    try {
      const tokens = JSON.parse(value) as StoredTokens;
      console.log(
        `[MondayTokenStore] load: found token for cloudId=${tokens.cloudId}, ` +
          `expiresAt=${new Date(tokens.expiresAt).toISOString()}`
      );
      return tokens;
    } catch {
      console.error(
        `[MondayTokenStore] load: failed to parse stored value (length=${value.length})`
      );
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    const payload = JSON.stringify(tokens);
    console.log(
      `[MondayTokenStore] save: writing token for cloudId=${tokens.cloudId} ` +
        `(payload ${payload.length} bytes)`
    );
    await this.storage.set(TOKENS_KEY, payload);
    console.log(`[MondayTokenStore] save: set() returned`);

    const readBack = await this.storage.get<string>(TOKENS_KEY);
    if (readBack == null) {
      console.error(
        `[MondayTokenStore] VERIFY FAILED: immediate read-back returned null. ` +
          `Token was NOT persisted.`
      );
    } else {
      console.log(
        `[MondayTokenStore] save: verified, read-back ${readBack.length} bytes`
      );
    }
  }

  async clear(): Promise<void> {
    await this.storage.delete(TOKENS_KEY);
    console.log(`[MondayTokenStore] clear: deleted key "${TOKENS_KEY}"`);
  }
}

export class MondayStateStore implements StateStore {
  private storage: InstanceType<typeof SecureStorage>;

  constructor() {
    this.storage = new SecureStorage();
  }

  private async loadStates(): Promise<StoredStates> {
    const value = await this.storage.get<string>(STATES_KEY);
    if (value == null) return {};
    try {
      return JSON.parse(value) as StoredStates;
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
