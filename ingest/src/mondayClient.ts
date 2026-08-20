const MONDAY_API_URL = "https://api.monday.com/v2";
const API_VERSION = "2026-07";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;

interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  error_code?: string;
}

function isComplexityExhausted(
  response: GraphQLResponse<unknown>
): boolean {
  if (response.error_code === "ComplexityException") return true;
  return (
    response.errors?.some(
      (e) => e.extensions?.code === "COMPLEXITY_BUDGET_EXHAUSTED"
    ) ?? false
  );
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = exponential * (0.5 + Math.random());
  return Math.min(jitter, MAX_DELAY_MS);
}

export function createMondayClient(token: string) {
  async function query<T = Record<string, unknown>>(
    gql: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": API_VERSION,
        },
        body: JSON.stringify({ query: gql, variables }),
      });

      if (!response.ok) {
        throw new Error(
          `monday API returned ${response.status} ${response.statusText}`
        );
      }

      const result = (await response.json()) as GraphQLResponse<T>;

      if (isComplexityExhausted(result)) {
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `monday API complexity budget exhausted after ${MAX_RETRIES + 1} attempts`
          );
        }
        const delay = backoffDelay(attempt);
        console.log(
          `Complexity budget exhausted, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastError = new Error("COMPLEXITY_BUDGET_EXHAUSTED");
        continue;
      }

      if (result.errors?.length) {
        const messages = result.errors.map((e) => e.message).join("; ");
        throw new Error(`monday API error: ${messages}`);
      }

      if (!result.data) {
        throw new Error("monday API returned no data and no errors");
      }

      return result.data;
    }

    throw lastError ?? new Error("Unexpected retry loop exit");
  }

  return { query };
}

export type MondayClient = ReturnType<typeof createMondayClient>;
