const JIRA_TO_MONDAY: ReadonlyMap<string, string> = new Map([
  ["To Do", "Backlog"],
  ["In Progress", "In progress"],
  ["In Review", "In progress"],
  ["Done", "Done"],
]);

// The reverse is not symmetric: "In progress" maps back to "In Progress",
// not "In Review". Information is lost in the round trip.
const MONDAY_TO_JIRA: ReadonlyMap<string, string> = new Map([
  ["Backlog", "To Do"],
  ["In progress", "In Progress"],
  ["Done", "Done"],
]);

export function jiraStatusToMonday(jiraStatus: string): string | undefined {
  return JIRA_TO_MONDAY.get(jiraStatus);
}

export function mondayStatusToJira(mondayStatus: string): string | undefined {
  return MONDAY_TO_JIRA.get(mondayStatus);
}
