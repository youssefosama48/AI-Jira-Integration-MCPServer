#!/usr/bin/env node

/**
 * Jira + Zephyr Scale MCP Server
 *
 * A Model Context Protocol server for Jira Cloud + Zephyr Scale (TM4J).
 *
 * Setup:
 *   npm install @modelcontextprotocol/sdk node-fetch
 *
 * Environment variables (required):
 *   JIRA_BASE_URL        - e.g. https://yourcompany.atlassian.net
 *   JIRA_EMAIL           - your Atlassian account email
 *   JIRA_API_TOKEN       - your Atlassian API token
 *                          (generate at https://id.atlassian.com/manage-profile/security/api-tokens)
 *   ZEPHYR_API_TOKEN     - your Zephyr Scale API token
 *                          (generate inside Jira → Zephyr Scale → API Keys)
 *   ANTHROPIC_API_KEY    - your Anthropic API key (used by create_test_cases)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

// ─── Config ───────────────────────────────────────────────────────────────────

const JIRA_BASE_URL     = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
const JIRA_EMAIL        = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN    = process.env.JIRA_API_TOKEN;
const ZEPHYR_API_TOKEN  = process.env.ZEPHYR_API_TOKEN;


if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  process.exit(1);
}

const JIRA_AUTH_HEADER =
  "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

// Zephyr Scale SmartBear hosted API
const ZEPHYR_BASE_URL = "https://api.zephyrscale.smartbear.com/v2";

// ─── Jira API helper ──────────────────────────────────────────────────────────

async function jiraRequest(method, path, body) {
  const url = `${JIRA_BASE_URL}/rest/api/3${path}`;
  const options = {
    method,
    headers: {
      Authorization: JIRA_AUTH_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── Zephyr Scale API helper ──────────────────────────────────────────────────

async function zephyrRequest(method, path, body) {
  if (!ZEPHYR_API_TOKEN) {
    throw new Error("ZEPHYR_API_TOKEN environment variable is not set.");
  }

  const url = `${ZEPHYR_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${ZEPHYR_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`Zephyr API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── Claude AI helper ─────────────────────────────────────────────────────────



// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // ── Search / Get ─────────────────────────────────────────────────────────────
  {
    name: "jira_search_issues",
    description:
      "Search Jira issues using JQL (Jira Query Language). Returns key, summary, status, assignee, and priority for each result.",
    inputSchema: {
      type: "object",
      properties: {
        jql: {
          type: "string",
          description: 'JQL query string. Example: "project = MYPROJ AND status = Open ORDER BY created DESC"',
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 20, max: 100)",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: 'Extra fields to include, e.g. ["description", "labels", "reporter"]',
        },
      },
      required: ["jql"],
    },
  },
  {
    name: "jira_get_issue",
    description: "Get full details of a single Jira issue by its key (e.g. PROJ-123).",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
      },
      required: ["issueKey"],
    },
  },

  // ── Create Issue ─────────────────────────────────────────────────────────────
  {
    name: "jira_create_issue",
    description: "Create a new Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey:        { type: "string", description: "The project key, e.g. PROJ" },
        summary:           { type: "string", description: "Issue summary / title" },
        issueType:         { type: "string", description: 'Issue type name, e.g. "Bug", "Task", "Story" (default: Task)' },
        description:       { type: "string", description: "Issue description (plain text)" },
        priority:          { type: "string", description: 'Priority name, e.g. "High", "Medium", "Low"' },
        assigneeAccountId: { type: "string", description: "Atlassian account ID of the assignee" },
        labels:            { type: "array", items: { type: "string" }, description: "Labels to attach to the issue" },
      },
      required: ["projectKey", "summary"],
    },
  },

  // ── Update Issue ─────────────────────────────────────────────────────────────
  {
    name: "jira_update_issue",
    description: "Update fields of an existing Jira issue. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey:          { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
        summary:           { type: "string", description: "New summary / title" },
        description:       { type: "string", description: "New description (plain text)" },
        priority:          { type: "string", description: 'New priority name, e.g. "High", "Medium", "Low"' },
        assigneeAccountId: { type: "string", description: "Atlassian account ID of the new assignee (null to unassign)" },
        labels:            { type: "array", items: { type: "string" }, description: "Replace labels with this list" },
        status:            { type: "string", description: 'Transition issue to this status name, e.g. "In Progress", "Done"' },
      },
      required: ["issueKey"],
    },
  },

  // ── Comments ─────────────────────────────────────────────────────────────────
  {
    name: "jira_add_comment",
    description: "Add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
        comment:  { type: "string", description: "The comment text (plain text)" },
      },
      required: ["issueKey", "comment"],
    },
  },
  {
    name: "jira_get_comments",
    description: "Get all comments on a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "The Jira issue key, e.g. PROJ-123" },
      },
      required: ["issueKey"],
    },
  },

  // ── NEW: create_test_cases ────────────────────────────────────────────────────
  {
    name: "create_test_cases",
    description:
      "Fetch a Jira story by key or name, read its description and acceptance criteria, " +
      "then use AI to generate positive, negative, and edge test cases ready for Zephyr.",
    inputSchema: {
      type: "object",
      properties: {
        issueKeyOrName: {
          type: "string",
          description:
            "Jira issue key (e.g. PROJ-123) OR a story/feature name to search for.",
        },
        additionalContext: {
          type: "string",
          description:
            "Optional extra instructions for test generation, e.g. 'Focus on mobile scenarios'.",
        },
      },
      required: ["issueKeyOrName"],
    },
  },

  // ── NEW: generate_in_zephyr ───────────────────────────────────────────────────
  {
    name: "generate_in_zephyr",
    description:
      "Take test cases (from create_test_cases) and create them as real test cases " +
      "inside Zephyr Scale under the same Jira project. Optionally links them to a story.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description: "Jira project key, e.g. PROJ (same project as the story).",
        },
        testCases: {
          type: "array",
          description: "Test cases array returned by create_test_cases.",
          items: {
            type: "object",
            properties: {
              title:         { type: "string" },
              type:          { type: "string", description: "positive | negative | edge" },
              objective:     { type: "string" },
              preconditions: { type: "string" },
              priority:      { type: "string" },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    step:           { type: "string" },
                    expectedResult: { type: "string" },
                  },
                },
              },
            },
            required: ["title", "type", "steps"],
          },
        },
        issueKey: {
          type: "string",
          description: "Optional Jira story key — if provided, all created TCs are linked immediately.",
        },
      },
      required: ["projectKey", "testCases"],
    },
  },

  // ── NEW: create_bug ──────────────────────────────────────────────────────────
  {
    name: "create_bug",
    description:
      "Takes a failed Zephyr test case (by key or name), fetches its steps and details, " +
      "creates a Bug in Jira with steps to reproduce auto-filled from the TC, " +
      "then links the bug to both the Jira story and the Zephyr TC. " +
      "When you open the story you will see both the linked TCs and bugs in one place.",
    inputSchema: {
      type: "object",
      properties: {
        zephyrTcKeyOrName: {
          type: "string",
          description:
            "The Zephyr TC key (e.g. PROJ-T5) or the test case name that failed.",
        },
        storyKey: {
          type: "string",
          description:
            "The Jira story key to link the bug to, e.g. PROJ-123.",
        },
        storyKeyOrName: {
          type: "string",
          description:
            "Alternative to storyKey — pass a story name and it resolves automatically.",
        },
        actualResult: {
          type: "string",
          description:
            "What actually happened when the test failed. Included in the bug description.",
        },
        severity: {
          type: "string",
          description: 'Bug priority/severity: "Critical", "High", "Medium", "Low" (default: High)',
        },
        additionalNotes: {
          type: "string",
          description: "Any extra notes, environment details, or context to include in the bug.",
        },
      },
      required: ["zephyrTcKeyOrName"],
    },
  },

  // ── NEW: link_zephyr_tcs_to_story ────────────────────────────────────────────
  {
    name: "link_zephyr_tcs_to_story",
    description:
      "Link Zephyr Scale test cases to a Jira story (Coverage section). " +
      "Mode 1 — bulk link: pass issueKey + zephyrTcKeys (array of TC keys from generate_in_zephyr). " +
      "Mode 2 — single/named: pass issueKeyOrName + zephyrTcKeys to resolve story by name then link.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira story key to link to, e.g. PROJ-123.",
        },
        issueKeyOrName: {
          type: "string",
          description: "Alternative to issueKey — story name to search for automatically.",
        },
        zephyrTcKeys: {
          type: "array",
          items: { type: "string" },
          description: 'Zephyr TC keys to link, e.g. ["PROJ-T1", "PROJ-T2"]. Returned by generate_in_zephyr.',
        },
      },
      required: ["zephyrTcKeys"],
    },
  },
];

// ─── Existing Tool Handlers ───────────────────────────────────────────────────

async function handleSearchIssues({ jql, maxResults = 20, fields = [] }) {
  const defaultFields = ["summary", "status", "assignee", "priority", "issuetype", "created", "updated"];
  const allFields = [...new Set([...defaultFields, ...fields])];

  const data = await jiraRequest("POST", "/search", {
    jql,
    maxResults: Math.min(maxResults, 100),
    fields: allFields,
  });

  const issues = (data.issues || []).map((issue) => ({
    key:       issue.key,
    summary:   issue.fields.summary,
    status:    issue.fields.status?.name,
    assignee:  issue.fields.assignee?.displayName ?? "Unassigned",
    priority:  issue.fields.priority?.name,
    issueType: issue.fields.issuetype?.name,
    created:   issue.fields.created,
    updated:   issue.fields.updated,
    url:       `${JIRA_BASE_URL}/browse/${issue.key}`,
    ...Object.fromEntries(fields.map((f) => [f, issue.fields[f]])),
  }));

  return { total: data.total, returned: issues.length, issues };
}

async function handleGetIssue({ issueKey }) {
  const issue = await jiraRequest("GET", `/issue/${issueKey}`);
  const f = issue.fields;

  return {
    key:         issue.key,
    url:         `${JIRA_BASE_URL}/browse/${issue.key}`,
    summary:     f.summary,
    status:      f.status?.name,
    issueType:   f.issuetype?.name,
    priority:    f.priority?.name,
    assignee:    f.assignee?.displayName ?? "Unassigned",
    reporter:    f.reporter?.displayName,
    created:     f.created,
    updated:     f.updated,
    description: extractTextFromADF(f.description),
    labels:      f.labels,
    components:  (f.components || []).map((c) => c.name),
    fixVersions: (f.fixVersions || []).map((v) => v.name),
  };
}

async function handleCreateIssue({ projectKey, summary, issueType = "Task", description, priority, assigneeAccountId, labels }) {
  const fields = {
    project:   { key: projectKey },
    summary,
    issuetype: { name: issueType },
  };

  if (description)       fields.description = textToADF(description);
  if (priority)          fields.priority    = { name: priority };
  if (assigneeAccountId) fields.assignee    = { accountId: assigneeAccountId };
  if (labels?.length)    fields.labels      = labels;

  const result = await jiraRequest("POST", "/issue", { fields });

  return {
    key:     result.key,
    id:      result.id,
    url:     `${JIRA_BASE_URL}/browse/${result.key}`,
    message: `Issue ${result.key} created successfully.`,
  };
}

async function handleUpdateIssue({ issueKey, summary, description, priority, assigneeAccountId, labels, status }) {
  const fields = {};

  if (summary)     fields.summary     = summary;
  if (description) fields.description = textToADF(description);
  if (priority)    fields.priority    = { name: priority };
  if (labels)      fields.labels      = labels;
  if (assigneeAccountId !== undefined)
    fields.assignee = assigneeAccountId ? { accountId: assigneeAccountId } : null;

  if (Object.keys(fields).length > 0) {
    await jiraRequest("PUT", `/issue/${issueKey}`, { fields });
  }

  if (status) {
    const { transitions } = await jiraRequest("GET", `/issue/${issueKey}/transitions`);
    const transition = transitions.find((t) => t.name.toLowerCase() === status.toLowerCase());
    if (!transition) {
      const names = transitions.map((t) => t.name).join(", ");
      throw new Error(`Status "${status}" not found. Available transitions: ${names}`);
    }
    await jiraRequest("POST", `/issue/${issueKey}/transitions`, { transition: { id: transition.id } });
  }

  return {
    key:     issueKey,
    url:     `${JIRA_BASE_URL}/browse/${issueKey}`,
    message: `Issue ${issueKey} updated successfully.`,
  };
}

async function handleAddComment({ issueKey, comment }) {
  const result = await jiraRequest("POST", `/issue/${issueKey}/comment`, {
    body: textToADF(comment),
  });

  return {
    commentId: result.id,
    author:    result.author?.displayName,
    created:   result.created,
    message:   `Comment added to ${issueKey}.`,
  };
}

async function handleGetComments({ issueKey }) {
  const data = await jiraRequest("GET", `/issue/${issueKey}/comment?orderBy=created`);

  const comments = (data.comments || []).map((c) => ({
    id:      c.id,
    author:  c.author?.displayName,
    created: c.created,
    updated: c.updated,
    body:    extractTextFromADF(c.body),
  }));

  return { issueKey, total: data.total, comments };
}

// ─── NEW Handler: create_test_cases ──────────────────────────────────────────

async function handleCreateTestCases({ issueKeyOrName, additionalContext = "" }) {
  // Step 1: Resolve issue key
  let issueKey = issueKeyOrName.trim();

  if (!/^[A-Z]+-\d+$/.test(issueKey)) {
    // Search by summary
    const searchResult = await jiraRequest("POST", "/search", {
      jql: `summary ~ "${issueKey}" ORDER BY created DESC`,
      maxResults: 1,
      fields: ["summary"],
    });
    if (!searchResult.issues?.length) {
      throw new Error(`No Jira issue found matching: "${issueKeyOrName}"`);
    }
    issueKey = searchResult.issues[0].key;
  }

  // Step 2: Fetch full issue
  const issue = await jiraRequest("GET", `/issue/${issueKey}`);
  const f = issue.fields;

  const summary     = f.summary || "";
  const description = extractTextFromADF(f.description);
  const issueType   = f.issuetype?.name || "Story";
  const priority    = f.priority?.name  || "Medium";
  const projectKey  = f.project?.key    || issueKey.split("-")[0];

  // Try to extract acceptance criteria from common custom fields
  const acRaw =
    f.customfield_10016 ||
    f.customfield_10014 ||
    f.customfield_10028 ||
    f.acceptance_criteria ||
    "";
  const acceptanceCriteria =
    typeof acRaw === "string" ? acRaw : extractTextFromADF(acRaw);

  // Step 3: Generate test cases via Claude
  const systemPrompt = `You are a senior QA engineer. Generate thorough test cases based on a Jira user story.
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON.

Return a JSON array of test case objects with this exact shape:
[
  {
    "title": "Short descriptive TC title",
    "type": "positive" | "negative" | "edge",
    "objective": "One sentence — what this test verifies",
    "preconditions": "State or setup needed before executing this test",
    "priority": "High" | "Medium" | "Low",
    "steps": [
      { "step": "Action to perform", "expectedResult": "What should happen" }
    ]
  }
]

Rules:
- At minimum: 3 positive, 3 negative, 2 edge cases.
- More cases if the story is complex or has multiple acceptance criteria.
- Steps should be clear, atomic, and independently executable.
- Negative cases should cover invalid inputs, boundary violations, and error paths.
- Edge cases should cover limits, race conditions, and unusual-but-valid scenarios.`;

  const userPrompt = `
Story Key:   ${issueKey}
Project:     ${projectKey}
Issue Type:  ${issueType}
Priority:    ${priority}

Summary:
${summary}

Description:
${description || "(No description provided)"}

Acceptance Criteria:
${acceptanceCriteria || "(None explicitly stated — infer from description and summary)"}
${additionalContext ? `\nAdditional Context:\n${additionalContext}` : ""}

Generate the test cases now.`;

  const rawResponse = await callClaude(systemPrompt, userPrompt);

  // Parse
  let testCases;
  try {
    const cleaned = rawResponse.replace(/```json|```/g, "").trim();
    testCases = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse AI test case response:\n${rawResponse}`);
  }

  const positive = testCases.filter((tc) => tc.type === "positive");
  const negative = testCases.filter((tc) => tc.type === "negative");
  const edge     = testCases.filter((tc) => tc.type === "edge");

  return {
    issueKey,
    projectKey,
    summary,
    totalGenerated: testCases.length,
    breakdown: { positive: positive.length, negative: negative.length, edge: edge.length },
    testCases,
    message: `Generated ${testCases.length} test cases for ${issueKey}. Use generate_in_zephyr to push them to Zephyr Scale.`,
  };
}

// ─── NEW Handler: generate_in_zephyr ─────────────────────────────────────────

async function handleGenerateInZephyr({ projectKey, testCases, issueKey }) {
  const created = [];
  const failed  = [];

  const priorityMap = { High: "HIGH", Medium: "MEDIUM", Low: "LOW" };

  for (const tc of testCases) {
    try {
      const payload = {
        projectKey,
        name:         tc.title,
        objective:    tc.objective    || "",
        precondition: tc.preconditions || "",
        priority:     { name: priorityMap[tc.priority] || "MEDIUM" },
        labels:       [tc.type], // tag as positive / negative / edge
        testScript: {
          type: "STEP_BY_STEP",
          steps: (tc.steps || []).map((s) => ({
            description:    s.step,
            testData:       "",
            expectedResult: s.expectedResult || "",
          })),
        },
      };

      const result = await zephyrRequest("POST", "/testcases", payload);

      created.push({
        zephyrKey: result.key,
        zephyrId:  result.id,
        title:     tc.title,
        type:      tc.type,
      });
    } catch (err) {
      failed.push({ title: tc.title, error: err.message });
    }
  }

  // Auto-link to story if issueKey provided
  let linkResult = null;
  if (issueKey && created.length > 0) {
    try {
      linkResult = await linkTestCasesToIssue(
        issueKey,
        created.map((c) => c.zephyrKey)
      );
    } catch (err) {
      linkResult = { error: `Auto-link failed: ${err.message}` };
    }
  }

  return {
    projectKey,
    totalCreated:  created.length,
    totalFailed:   failed.length,
    created,
    failed,
    linkedToIssue: linkResult,
    message:
      `Created ${created.length}/${testCases.length} test cases in Zephyr Scale.` +
      (issueKey
        ? ` Auto-linked to ${issueKey}.`
        : " Use link_zephyr_tcs_to_story to link them to a Jira story."),
  };
}

// ─── NEW Handler: link_zephyr_tcs_to_story ───────────────────────────────────

async function handleLinkZephyrTcsToStory({ issueKey, zephyrTcKeys, issueKeyOrName }) {
  // Resolve story key
  let resolvedKey = issueKey;

  if (!resolvedKey && issueKeyOrName) {
    const trimmed = issueKeyOrName.trim();
    if (/^[A-Z]+-\d+$/.test(trimmed)) {
      resolvedKey = trimmed;
    } else {
      const searchResult = await jiraRequest("POST", "/search", {
        jql: `summary ~ "${trimmed}" ORDER BY created DESC`,
        maxResults: 1,
        fields: ["summary"],
      });
      if (!searchResult.issues?.length) {
        throw new Error(`No Jira issue found matching: "${issueKeyOrName}"`);
      }
      resolvedKey = searchResult.issues[0].key;
    }
  }

  if (!resolvedKey)       throw new Error("Provide issueKey or issueKeyOrName.");
  if (!zephyrTcKeys?.length) throw new Error("Provide at least one Zephyr TC key in zephyrTcKeys.");

  const result = await linkTestCasesToIssue(resolvedKey, zephyrTcKeys);
  return { issueKey: resolvedKey, ...result };
}

// ─── Shared: link TCs to a Jira story in Zephyr coverage ─────────────────────

async function linkTestCasesToIssue(issueKey, zephyrTcKeys) {
  const linked = [];
  const failed = [];

  for (const tcKey of zephyrTcKeys) {
    try {
      await zephyrRequest("POST", `/testcases/${tcKey}/links/issues`, {
        issueId: issueKey,
      });
      linked.push({ tcKey, issueKey });
    } catch (err) {
      failed.push({ tcKey, error: err.message });
    }
  }

  return {
    totalLinked: linked.length,
    totalFailed: failed.length,
    linked,
    failed,
    message: `Linked ${linked.length}/${zephyrTcKeys.length} test cases to ${issueKey} in Zephyr Scale coverage.`,
  };
}

// ─── NEW Handler: create_bug ─────────────────────────────────────────────────

async function handleCreateBug({
  zephyrTcKeyOrName,
  storyKey,
  storyKeyOrName,
  actualResult = "Not provided",
  severity = "High",
  additionalNotes = "",
}) {
  // ── Step 1: Resolve Zephyr TC key from name if needed ──────────────────────
  let tcKey = zephyrTcKeyOrName.trim();
  let tcData;

  // Try fetching directly first (assuming it's a key)
  try {
    tcData = await zephyrRequest("GET", `/testcases/${tcKey}`);
  } catch {
    // Not a valid key — search by name
    const searchResult = await zephyrRequest(
      "GET",
      `/testcases?projectKey=&maxResults=10&query=${encodeURIComponent(tcKey)}`
    );
    const matches = searchResult.values || searchResult.results || [];
    const match = matches.find(
      (tc) => tc.name?.toLowerCase() === tcKey.toLowerCase()
    ) || matches[0];

    if (!match) {
      throw new Error(`No Zephyr test case found matching: "${zephyrTcKeyOrName}"`);
    }
    tcKey  = match.key;
    tcData = match;
  }

  const tcName      = tcData.name      || tcKey;
  const tcObjective = tcData.objective  || "";
  const projectKey  = tcData.projectKey || tcKey.split("-")[0];

  // ── Step 2: Fetch TC steps from Zephyr ────────────────────────────────────
  let steps = [];
  try {
    const scriptData = await zephyrRequest("GET", `/testcases/${tcKey}/teststeps`);
    steps = scriptData.values || scriptData.steps || [];
  } catch {
    // Steps fetch failed — continue without them
  }

  // ── Step 3: Resolve Jira story key ────────────────────────────────────────
  let resolvedStoryKey = storyKey;

  if (!resolvedStoryKey && storyKeyOrName) {
    const trimmed = storyKeyOrName.trim();
    if (/^[A-Z]+-\d+$/.test(trimmed)) {
      resolvedStoryKey = trimmed;
    } else {
      const searchResult = await jiraRequest("POST", "/search", {
        jql: `summary ~ "${trimmed}" ORDER BY created DESC`,
        maxResults: 1,
        fields: ["summary"],
      });
      if (!searchResult.issues?.length) {
        throw new Error(`No Jira story found matching: "${storyKeyOrName}"`);
      }
      resolvedStoryKey = searchResult.issues[0].key;
    }
  }

  // ── Step 4: Build bug description with steps to reproduce ─────────────────
  const stepsText = steps.length
    ? steps
        .map((s, i) => `Step ${i + 1}: ${s.description || s.step || ""}\nExpected: ${s.expectedResult || ""}`)
        .join("\n\n")
    : "No steps available from Zephyr TC.";

  const bugDescription = [
    `*Failing Test Case:* ${tcName} (${tcKey})`,
    tcObjective ? `*Test Objective:* ${tcObjective}` : "",
    "",
    "*Steps to Reproduce:*",
    stepsText,
    "",
    `*Actual Result:*\n${actualResult}`,
    additionalNotes ? `\n*Additional Notes:*\n${additionalNotes}` : "",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  // ── Step 5: Create Jira Bug ───────────────────────────────────────────────
  const bugFields = {
    project:   { key: projectKey },
    summary:   `Bug: ${tcName} - Test Case Failed`,
    issuetype: { name: "Bug" },
    priority:  { name: severity },
    description: textToADF(bugDescription),
    labels: ["automated-bug", "test-failure"],
  };

  const bugResult = await jiraRequest("POST", "/issue", { fields: bugFields });
  const bugKey = bugResult.key;
  const bugId  = bugResult.id;

  // ── Step 6: Link bug to Jira story ───────────────────────────────────────
  let storyLinkResult = null;
  if (resolvedStoryKey) {
    try {
      await jiraRequest("POST", "/issueLink", {
        type:         { name: "Relates" },
        inwardIssue:  { key: bugKey },
        outwardIssue: { key: resolvedStoryKey },
      });
      storyLinkResult = { success: true, linkedTo: resolvedStoryKey };
    } catch (err) {
      storyLinkResult = { success: false, error: err.message };
    }
  }

  // ── Step 7: Link bug to Zephyr TC ─────────────────────────────────────────
  let zephyrLinkResult = null;
  try {
    await zephyrRequest("POST", `/testcases/${tcKey}/links/issues`, {
      issueId: bugKey,
    });
    zephyrLinkResult = { success: true, linkedTcKey: tcKey };
  } catch (err) {
    zephyrLinkResult = { success: false, error: err.message };
  }

  return {
    bugKey,
    bugId,
    bugUrl:          `${JIRA_BASE_URL}/browse/${bugKey}`,
    summary:         bugFields.summary,
    failedTcKey:     tcKey,
    failedTcName:    tcName,
    linkedToStory:   storyLinkResult,
    linkedToZephyrTc: zephyrLinkResult,
    message:
      `Bug ${bugKey} created for failed TC "${tcName}".` +
      (resolvedStoryKey ? ` Linked to story ${resolvedStoryKey}.` : "") +
      ` Linked to Zephyr TC ${tcKey}.`,
  };
}

// ─── ADF helpers ──────────────────────────────────────────────────────────────

function textToADF(text) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    })),
  };
}

function extractTextFromADF(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;

  const extractNode = (node) => {
    if (!node) return "";
    if (node.type === "text") return node.text || "";
    if (node.content) return node.content.map(extractNode).join(" ");
    return "";
  };

  return extractNode(adf).trim();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "jira-zephyr-mcp-server", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "jira_search_issues":        result = await handleSearchIssues(args);          break;
      case "jira_get_issue":            result = await handleGetIssue(args);              break;
      case "jira_create_issue":         result = await handleCreateIssue(args);           break;
      case "jira_update_issue":         result = await handleUpdateIssue(args);           break;
      case "jira_add_comment":          result = await handleAddComment(args);            break;
      case "jira_get_comments":         result = await handleGetComments(args);           break;
      case "create_test_cases":         result = await handleCreateTestCases(args);       break;
      case "generate_in_zephyr":        result = await handleGenerateInZephyr(args);      break;
      case "link_zephyr_tcs_to_story":  result = await handleLinkZephyrTcsToStory(args);  break;
      case "create_bug":                result = await handleCreateBug(args);              break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Jira + Zephyr Scale MCP server v3.0.0 running on stdio");
