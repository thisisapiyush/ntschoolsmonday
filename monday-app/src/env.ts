import "dotenv/config";

export interface Env {
  JIRA_CLIENT_ID: string;
  JIRA_CLIENT_SECRET: string;
  JIRA_SITE_URL: string;
  JIRA_PROJECT_KEY: string;
  JIRA_REDIRECT_URI: string;
  PORT: number;
  TOKEN_STORE: "file" | "monday";
}

const REQUIRED = [
  "JIRA_CLIENT_ID",
  "JIRA_CLIENT_SECRET",
  "JIRA_SITE_URL",
  "JIRA_PROJECT_KEY",
  "JIRA_REDIRECT_URI",
] as const;

export function loadEnv(): Env {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const storeValue = process.env["TOKEN_STORE"] ?? "file";
  if (storeValue !== "file" && storeValue !== "monday") {
    throw new Error(
      `TOKEN_STORE must be "file" or "monday", got "${storeValue}"`
    );
  }

  return {
    JIRA_CLIENT_ID: process.env["JIRA_CLIENT_ID"]!,
    JIRA_CLIENT_SECRET: process.env["JIRA_CLIENT_SECRET"]!,
    JIRA_SITE_URL: process.env["JIRA_SITE_URL"]!,
    JIRA_PROJECT_KEY: process.env["JIRA_PROJECT_KEY"]!,
    JIRA_REDIRECT_URI: process.env["JIRA_REDIRECT_URI"]!,
    PORT: parseInt(process.env["PORT"] ?? "8080", 10),
    TOKEN_STORE: storeValue,
  };
}
