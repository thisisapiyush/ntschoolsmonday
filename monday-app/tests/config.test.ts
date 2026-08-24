import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  ProcessEnvSource,
  MondaySecretsSource,
  type ConfigSource,
} from "../src/config.js";

class MockSource implements ConfigSource {
  readonly name = "mock";
  private data: Record<string, string>;

  constructor(data: Record<string, string>) {
    this.data = data;
  }

  get(key: string): string | undefined {
    return this.data[key];
  }
}

const VALID = {
  JIRA_CLIENT_ID: "client-id",
  JIRA_CLIENT_SECRET: "client-secret",
  JIRA_SITE_URL: "https://test.atlassian.net",
  JIRA_PROJECT_KEY: "TEST",
  JIRA_REDIRECT_URI: "http://localhost:8080/oauth/callback",
};

describe("resolveConfig", () => {
  it("resolves all required values", () => {
    const config = resolveConfig(new MockSource(VALID), false);
    expect(config.JIRA_CLIENT_ID).toBe("client-id");
    expect(config.JIRA_CLIENT_SECRET).toBe("client-secret");
    expect(config.JIRA_SITE_URL).toBe("https://test.atlassian.net");
    expect(config.JIRA_PROJECT_KEY).toBe("TEST");
    expect(config.JIRA_REDIRECT_URI).toBe(
      "http://localhost:8080/oauth/callback"
    );
  });

  it("throws listing all missing keys", () => {
    expect(() => resolveConfig(new MockSource({}), false)).toThrow(
      /Missing required config.*JIRA_CLIENT_ID.*JIRA_CLIENT_SECRET.*JIRA_SITE_URL.*JIRA_PROJECT_KEY.*JIRA_REDIRECT_URI/
    );
  });

  it("throws listing only the missing keys", () => {
    const partial = { JIRA_CLIENT_ID: "id", JIRA_CLIENT_SECRET: "secret" };
    try {
      resolveConfig(new MockSource(partial), false);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("JIRA_SITE_URL");
      expect(msg).toContain("JIRA_PROJECT_KEY");
      expect(msg).toContain("JIRA_REDIRECT_URI");
      expect(msg).not.toContain("JIRA_CLIENT_ID");
      expect(msg).not.toContain("JIRA_CLIENT_SECRET");
    }
  });

  it("error message names the source, not the values", () => {
    try {
      resolveConfig(new MockSource({}), false);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("via mock");
      expect(msg).not.toContain("client-secret");
    }
  });

  it("defaults TOKEN_STORE to file in local mode", () => {
    const config = resolveConfig(new MockSource(VALID), false);
    expect(config.TOKEN_STORE).toBe("file");
  });

  it("defaults TOKEN_STORE to monday on monday code", () => {
    const config = resolveConfig(new MockSource(VALID), true);
    expect(config.TOKEN_STORE).toBe("monday");
  });

  it("explicit TOKEN_STORE=file overrides monday code default", () => {
    const config = resolveConfig(
      new MockSource({ ...VALID, TOKEN_STORE: "file" }),
      true
    );
    expect(config.TOKEN_STORE).toBe("file");
  });

  it("explicit TOKEN_STORE=monday overrides local default", () => {
    const config = resolveConfig(
      new MockSource({ ...VALID, TOKEN_STORE: "monday" }),
      false
    );
    expect(config.TOKEN_STORE).toBe("monday");
  });

  it("ignores invalid TOKEN_STORE values and uses default", () => {
    const config = resolveConfig(
      new MockSource({ ...VALID, TOKEN_STORE: "redis" }),
      false
    );
    expect(config.TOKEN_STORE).toBe("file");
  });

  it("defaults PORT to 8080", () => {
    const config = resolveConfig(new MockSource(VALID), false);
    expect(config.PORT).toBe(8080);
  });

  it("reads PORT from source", () => {
    const config = resolveConfig(
      new MockSource({ ...VALID, PORT: "3000" }),
      false
    );
    expect(config.PORT).toBe(3000);
  });
});

describe("ProcessEnvSource", () => {
  const source = new ProcessEnvSource();

  it("reads from process.env", () => {
    process.env["__CONFIG_TEST_KEY__"] = "test-value";
    expect(source.get("__CONFIG_TEST_KEY__")).toBe("test-value");
    delete process.env["__CONFIG_TEST_KEY__"];
  });

  it("returns undefined for missing keys", () => {
    expect(source.get("__DEFINITELY_UNSET_KEY_42__")).toBeUndefined();
  });

  it("returns undefined for empty string values", () => {
    process.env["__CONFIG_TEST_EMPTY__"] = "";
    expect(source.get("__CONFIG_TEST_EMPTY__")).toBeUndefined();
    delete process.env["__CONFIG_TEST_EMPTY__"];
  });

  it('has name "process.env"', () => {
    expect(source.name).toBe("process.env");
  });
});

describe("MondaySecretsSource", () => {
  it("wraps SDK get() and returns strings", () => {
    const manager = {
      get: (key: string, _options?: { invalidate?: boolean }) =>
        key === "FOO" ? "bar" : undefined,
    };
    const source = new MondaySecretsSource(manager);
    expect(source.get("FOO")).toBe("bar");
    expect(source.get("MISSING")).toBeUndefined();
  });

  it("converts non-string values to strings", () => {
    const manager = {
      get: (_key: string, _options?: { invalidate?: boolean }) =>
        42 as unknown,
    };
    const source = new MondaySecretsSource(manager);
    expect(source.get("NUM")).toBe("42");
  });

  it("returns undefined for null", () => {
    const manager = {
      get: (_key: string, _options?: { invalidate?: boolean }) =>
        null as unknown,
    };
    const source = new MondaySecretsSource(manager);
    expect(source.get("KEY")).toBeUndefined();
  });

  it("passes invalidate: false to the manager", () => {
    let receivedOptions: { invalidate?: boolean } | undefined;
    const manager = {
      get: (_key: string, options?: { invalidate?: boolean }) => {
        receivedOptions = options;
        return "value";
      },
    };
    const source = new MondaySecretsSource(manager);
    source.get("ANY");
    expect(receivedOptions).toEqual({ invalidate: false });
  });

  it('has name "monday SecretsManager"', () => {
    const manager = {
      get: (_key: string, _options?: { invalidate?: boolean }) =>
        undefined as unknown,
    };
    const source = new MondaySecretsSource(manager);
    expect(source.name).toBe("monday SecretsManager");
  });
});
