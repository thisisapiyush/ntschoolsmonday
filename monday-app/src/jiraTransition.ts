import { z } from "zod";
import type { JiraClient } from "./jiraClient.js";

const TransitionsResponseSchema = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: z.object({ name: z.string() }),
    })
  ),
});

const CommentResponseSchema = z.object({
  id: z.string(),
});

export interface TransitionSuccess {
  kind: "transitioned";
  transitionId: string;
  transitionName: string;
}

export interface TransitionUnavailable {
  kind: "no_matching_transition";
  availableTargets: string[];
}

export type TransitionResult = TransitionSuccess | TransitionUnavailable;

export async function transitionIssue(
  jira: JiraClient,
  issueKey: string,
  targetStatusName: string
): Promise<TransitionResult> {
  const data = await jira.get(
    `issue/${issueKey}/transitions`,
    TransitionsResponseSchema
  );

  const match = data.transitions.find(
    (t) => t.to.name === targetStatusName
  );

  if (!match) {
    return {
      kind: "no_matching_transition",
      availableTargets: data.transitions.map((t) => t.to.name),
    };
  }

  await jira.postNoContent(`issue/${issueKey}/transitions`, {
    transition: { id: match.id },
  });

  return {
    kind: "transitioned",
    transitionId: match.id,
    transitionName: match.name,
  };
}

export async function addOriginComment(
  jira: JiraClient,
  issueKey: string,
  fromStatus: string | undefined,
  toStatus: string
): Promise<void> {
  const text = fromStatus
    ? `Status changed from ${fromStatus} to ${toStatus} in monday.com`
    : `Status changed to ${toStatus} in monday.com`;

  await jira.post(
    `issue/${issueKey}/comment`,
    {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text }],
          },
        ],
      },
    },
    CommentResponseSchema
  );
}
