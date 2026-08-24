import "dotenv/config";

export interface AppConfig {
  JIRA_CLIENT_ID: string;
  JIRA_CLIENT_SECRET: string;
  JIRA_SITE_URL: string;
  JIRA_PROJECT_KEY: string;
  JIRA_REDIRECT_URI: string;
  PORT: number;
  TOKEN_STORE: "file" | "monday";
}

export interface ConfigSource {
  get(key: string): string | undefined;
  readonly name: string;
}

export class ProcessEnvSource implements ConfigSource {
  readonly name = "process.env";

  get(key: string): string | undefined {
    return process.env[key] || undefined;
  }
}

export class MondaySecretsSource implements ConfigSource {
  readonly name = "monday SecretsManager";
  private manager: {
    get(key: string, options?: { invalidate?: boolean }): unknown;
  };

  constructor(manager: {
    get(key: string, options?: { invalidate?: boolean }): unknown;
  }) {
    this.manager = manager;
  }

  get(key: string): string | undefined {
    const value = this.manager.get(key, { invalidate: false });
    if (value == null) return undefined;
    return String(value);
  }
}

const REQUIRED_KEYS = [
  "JIRA_CLIENT_ID",
  "JIRA_CLIENT_SECRET",
  "JIRA_SITE_URL",
  "JIRA_PROJECT_KEY",
  "JIRA_REDIRECT_URI",
] as const;

export function isMondayCodeEnvironment(): boolean {
  return !!process.env["K_SERVICE"];
}

export function resolveConfig(
  source: ConfigSource,
  isMondayCode: boolean
): AppConfig {
  const missing: string[] = [];
  const values = new Map<string, string>();

  for (const key of REQUIRED_KEYS) {
    const value = source.get(key);
    if (!value) {
      missing.push(key);
    } else {
      values.set(key, value);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required config (via ${source.name}): ${missing.join(", ")}`
    );
  }

  const explicitStore = source.get("TOKEN_STORE");
  let tokenStore: "file" | "monday";
  if (explicitStore === "file" || explicitStore === "monday") {
    tokenStore = explicitStore;
  } else {
    tokenStore = isMondayCode ? "monday" : "file";
  }

  return {
    JIRA_CLIENT_ID: values.get("JIRA_CLIENT_ID")!,
    JIRA_CLIENT_SECRET: values.get("JIRA_CLIENT_SECRET")!,
    JIRA_SITE_URL: values.get("JIRA_SITE_URL")!,
    JIRA_PROJECT_KEY: values.get("JIRA_PROJECT_KEY")!,
    JIRA_REDIRECT_URI: values.get("JIRA_REDIRECT_URI")!,
    PORT: parseInt(source.get("PORT") ?? "8080", 10),
    TOKEN_STORE: tokenStore,
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const isMondayCode = isMondayCodeEnvironment();
  let source: ConfigSource;

  if (isMondayCode) {
    const { SecretsManager } = await import("@mondaycom/apps-sdk");
    source = new MondaySecretsSource(new SecretsManager());
  } else {
    source = new ProcessEnvSource();
  }

  console.log(`Config source: ${source.name} (monday code: ${isMondayCode})`);

  return resolveConfig(source, isMondayCode);
}
