#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import axios, { type AxiosError } from "axios";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

dotenv.config({ quiet: true });

const ATLAR_API_KEY = process.env.ATLAR_API_KEY;
const ATLAR_API_SECRET = process.env.ATLAR_API_SECRET;

if (!ATLAR_API_KEY || !ATLAR_API_SECRET) {
  console.error(
    "Missing ATLAR_API_KEY or ATLAR_API_SECRET in environment variables"
  );
  process.exit(1);
}

const atlarClient = axios.create({
  baseURL: process.env.ATLAR_API_URL ?? "https://api.atlar.com",
  auth: {
    username: ATLAR_API_KEY,
    password: ATLAR_API_SECRET,
  },
});

function formatError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const ae = error as AxiosError<{ message?: string; details?: unknown[] }>;
    const status = ae.response?.status;
    const msg = ae.response?.data?.message ?? ae.message;
    const details = ae.response?.data?.details;
    let out = `API error (${status}): ${msg}`;
    if (details?.length) out += `\nDetails: ${JSON.stringify(details)}`;
    return out;
  }
  return String(error);
}

// ── Temp file storage ────────────────────────────────────────
// Large API responses are saved to disk so they never flood the LLM context.
// The tool returns a compact summary + file path instead.

const TEMP_DIR = path.join(os.tmpdir(), "atlar-mcp-data");

function ensureTempDir(): void {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function saveToDisk(label: string, data: unknown): string {
  ensureTempDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(TEMP_DIR, `${label}-${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function fmtAmount(minorUnits: number, currency: string): string {
  const major = minorUnits / 100;
  return `${currency} ${major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function extractAccountRow(acc: Record<string, unknown>) {
  const bal = acc.balance as Record<string, unknown> | undefined;
  const amt = bal?.amount as Record<string, unknown> | undefined;
  const cur = (amt?.currency as string) || (acc.currency as string) || "???";
  const val = (amt?.value as number) ?? (bal?.value as number) ?? null;
  const entityObj = acc.entity as Record<string, unknown> | undefined;
  return {
    id: acc.id as string,
    name: (acc.name || acc.alias || acc.id) as string,
    entity: (entityObj?.id as string) || (acc.entityId as string) || "",
    currency: cur,
    balance: val != null ? fmtAmount(val, cur) : "N/A",
  };
}

function summarizeAccounts(data: Record<string, unknown>): string {
  const filePath = saveToDisk("accounts", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;
  const rows = items.map(extractAccountRow);
  return JSON.stringify({ count: items.length, file: filePath, accounts: rows, nextToken: nextToken || undefined });
}

function summarizeTransactions(data: Record<string, unknown>): string {
  const filePath = saveToDisk("transactions", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;

  const dates = items
    .map((t) => (t.date as string) || (t.bookingDate as string) || (t.valueDate as string))
    .filter(Boolean)
    .sort();

  const byCurrency: Record<string, { inflows: number; outflows: number; count: number }> = {};
  for (const txn of items) {
    const amt = txn.amount as Record<string, unknown> | undefined;
    const cur = (amt?.currency as string) || (txn.currency as string) || "???";
    const val = (amt?.value as number) ?? 0;
    if (!byCurrency[cur]) byCurrency[cur] = { inflows: 0, outflows: 0, count: 0 };
    byCurrency[cur].count++;
    if (val >= 0) byCurrency[cur].inflows += val;
    else byCurrency[cur].outflows += Math.abs(val);
  }

  const totals = Object.fromEntries(
    Object.entries(byCurrency).map(([cur, a]) => [cur, {
      count: a.count,
      inflows: fmtAmount(a.inflows, cur),
      outflows: fmtAmount(a.outflows, cur),
      net: fmtAmount(a.inflows - a.outflows, cur),
    }])
  );

  return JSON.stringify({
    count: items.length,
    dateRange: dates.length > 0 ? [dates[0], dates[dates.length - 1]] : null,
    totals,
    file: filePath,
    hint: "Use read_saved_data to query individual transactions (filter by counterparty, amount, date, etc.)",
    nextToken: nextToken || undefined,
  });
}

function summarizeEntities(data: Record<string, unknown>): string {
  const filePath = saveToDisk("entities", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;
  const rows = items.map((e) => ({ id: e.id, name: (e.name || e.legalName || e.id) as string }));
  return JSON.stringify({ count: items.length, file: filePath, entities: rows, nextToken: nextToken || undefined });
}

function summarizeForecastedTransactions(data: Record<string, unknown>): string {
  const filePath = saveToDisk("forecasted-transactions", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;

  const dates = items.map((t) => t.date as string).filter(Boolean).sort();

  const byCurrency: Record<string, { inflows: number; outflows: number; count: number }> = {};
  for (const txn of items) {
    const amt = txn.amount as Record<string, unknown> | undefined;
    const cur = (amt?.currency as string) || "???";
    const val = (amt?.value as number) ?? 0;
    if (!byCurrency[cur]) byCurrency[cur] = { inflows: 0, outflows: 0, count: 0 };
    byCurrency[cur].count++;
    if (val >= 0) byCurrency[cur].inflows += val;
    else byCurrency[cur].outflows += Math.abs(val);
  }

  const totals = Object.fromEntries(
    Object.entries(byCurrency).map(([cur, a]) => [cur, {
      count: a.count,
      inflows: fmtAmount(a.inflows, cur),
      outflows: fmtAmount(a.outflows, cur),
    }])
  );

  const top5 = [...items]
    .sort((a, b) => {
      const aV = Math.abs(((a.amount as Record<string, unknown>)?.value as number) ?? 0);
      const bV = Math.abs(((b.amount as Record<string, unknown>)?.value as number) ?? 0);
      return bV - aV;
    })
    .slice(0, 5)
    .map((t) => {
      const amt = t.amount as Record<string, unknown> | undefined;
      return {
        id: t.id,
        date: t.date,
        amount: fmtAmount((amt?.value as number) ?? 0, (amt?.currency as string) || "???"),
        description: t.description || "",
      };
    });

  return JSON.stringify({
    count: items.length,
    dateRange: dates.length > 0 ? [dates[0], dates[dates.length - 1]] : null,
    totals,
    top5byAmount: top5,
    file: filePath,
    hint: "Use read_saved_data to query/filter individual forecasted transactions.",
    nextToken: nextToken || undefined,
  });
}

function summarizeScenarios(data: Record<string, unknown>): string {
  const filePath = saveToDisk("scenarios", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;

  const rows = items.map((s) => {
    const adjustments = (s.adjustments as Array<Record<string, unknown>>) ?? [];
    const adjSummary = adjustments.length > 0
      ? adjustments.map((a) => `${a.category}×${a.factor}`).join(", ")
      : "none";
    return {
      id: s.id,
      alias: s.alias,
      color: s.color,
      status: s.status,
      type: s.type,
      parentScenarioId: s.parentScenarioId || null,
      adjustments: adjSummary,
    };
  });

  return JSON.stringify({ count: items.length, file: filePath, scenarios: rows, nextToken: nextToken || undefined });
}

function summarizeBalances(data: Record<string, unknown>): string {
  const filePath = saveToDisk("balances", data);
  const items = (data?.items as Array<Record<string, unknown>>) ?? [];
  const nextToken = data?.nextToken as string | undefined;

  if (items.length === 0) {
    return JSON.stringify({ count: 0, file: filePath, message: "No balances found." });
  }

  const dates = items.map((b) => (b.localDate as string)).filter(Boolean).sort();

  const byAccount: Record<string, { currency: string; latest: string; latestBalance: string; count: number }> = {};
  for (const bal of items) {
    const accId = (bal.accountId as string) || "unknown";
    const amt = bal.amount as Record<string, unknown> | undefined;
    const cur = (amt?.currency as string) || "???";
    const val = (amt?.value as number) ?? 0;
    const date = (bal.localDate as string) || "";

    if (!byAccount[accId] || date > byAccount[accId].latest) {
      byAccount[accId] = {
        currency: cur,
        latest: date,
        latestBalance: fmtAmount(val, cur),
        count: (byAccount[accId]?.count ?? 0) + 1,
      };
    } else {
      byAccount[accId].count++;
    }
  }

  return JSON.stringify({
    count: items.length,
    dateRange: dates.length > 0 ? [dates[0], dates[dates.length - 1]] : null,
    accountSummaries: byAccount,
    file: filePath,
    hint: "Use read_saved_data to query individual balance entries (filter by date, account, etc.)",
    nextToken: nextToken || undefined,
  });
}

function createServer(): McpServer {
  return new McpServer({
    name: "Atlar Treasury MCP",
    version: "1.0.0",
  });
}

function registerTools(server: McpServer): void {

// ── Accounts ──────────────────────────────────────────────

server.tool(
  "get_accounts",
  "Retrieve a list of connected bank accounts from Atlar.",
  {
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max accounts to return (1-500, default 100)"),
    token: z
      .string()
      .optional()
      .describe("Pagination token from a previous response"),
  },
  async ({ limit, token }) => {
    try {
      const response = await atlarClient.get("/financial-data/v2/accounts", {
        params: { limit, token },
      });
      return {
        content: [
          { type: "text", text: summarizeAccounts(response.data) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Account Balances ─────────────────────────────────────────

server.tool(
  "get_account_balances",
  `Retrieve historical balance entries for one or all accounts. Returns daily balance snapshots over time.
  IMPORTANT: You must first call get_accounts to obtain account IDs, then pass an account ID here. Use '-' as the accountId to get balances across all accounts.
  Balances are returned chronologically — use read_saved_data with sortBy/search to filter by date range or account after fetching.`,
  {
    accountId: z
      .string()
      .describe("Account ID to get balances for, or '-' for all accounts. Get IDs from get_accounts first."),
    type: z
      .enum(["BOOKED", "BOOKED_ADJUSTED", "AVAILABLE"])
      .optional()
      .describe("Balance type (default: BOOKED)"),
    mostRecent: z
      .boolean()
      .optional()
      .describe("If true, only return the most recent balance per account"),
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max balance entries to return (1-500, default 100)"),
    token: z
      .string()
      .optional()
      .describe("Pagination token from a previous response"),
  },
  async ({ accountId, type, mostRecent, limit, token }) => {
    try {
      const response = await atlarClient.get(
        `/financial-data/v2/accounts/${accountId}/balances`,
        { params: { type: type ?? "BOOKED", mostRecent, limit, token } }
      );
      return {
        content: [
          { type: "text", text: summarizeBalances(response.data) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Entities ──────────────────────────────────────────────

server.tool(
  "list_entities",
  "List all entities (legal companies/subsidiaries) in the organization. Useful for resolving entity IDs to human-readable names.",
  {
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max entities to return (1-500, default 100)"),
    token: z
      .string()
      .optional()
      .describe("Pagination token from a previous response"),
  },
  async ({ limit, token }) => {
    try {
      const response = await atlarClient.get("/financial-data/v2/entities", {
        params: { limit, token },
      });
      return {
        content: [
          { type: "text", text: summarizeEntities(response.data) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_entity",
  "Retrieve a specific entity by ID. Returns details like name, organization, and metadata.",
  {
    id: z.string().describe("The entity ID"),
  },
  async ({ id }) => {
    try {
      const response = await atlarClient.get(
        `/financial-data/v2/entities/${id}`
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(response.data, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Transactions ────────────────────────────────────────────

server.tool(
  "get_transactions",
  "Retrieve recent bank transactions across all connected accounts.",
  {
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max transactions to return (1-500, default 100)"),
    accountId: z
      .string()
      .optional()
      .describe("Atlar Account ID to filter by"),
    token: z
      .string()
      .optional()
      .describe("Pagination token from a previous response"),
  },
  async ({ limit, accountId, token }) => {
    try {
      const response = await atlarClient.get(
        "/financial-data/v2/transactions",
        { params: { limit, accountId, token } }
      );
      return {
        content: [
          { type: "text", text: summarizeTransactions(response.data) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Forecasted Transactions ─────────────────────────────────

server.tool(
  "list_forecasted_transactions",
  `List forecasted transactions and/or forecast estimates. Both are the same API resource, distinguished by correctionType:
  - Forecasted Transaction (correctionType=""): A specific future cash movement — one line item with a date, amount, and description. Like a row in a spreadsheet: "Acme Corp will pay us $50,000 on March 15th." Created manually, via CSV, from AP/AR, or by a model. Granular and editable.
  - Forecast Estimate (correctionType="INFLOW"|"OUTFLOW"): An aggregated category-level total — a rolled-up figure from forecast config and models. Like: "We expect ~$200,000 in operating expenses next quarter." Not individual payments, but a top-down projection based on historical patterns.
  Use the 'type' parameter to filter for one or the other, or omit to get both.`,
  {
    type: z
      .enum(["transactions", "estimates", "all"])
      .optional()
      .describe("Filter by type: 'transactions' (correctionType=''), 'estimates' (correctionType=INFLOW|OUTFLOW), or 'all' (default)"),
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max items to return (1-500, default 100)"),
    accountId: z
      .string()
      .optional()
      .describe("Only include forecasts for this account"),
    batchId: z
      .string()
      .optional()
      .describe("Only include forecasts belonging to this batch"),
    scenarioId: z
      .string()
      .optional()
      .describe("Only include forecasts belonging to this scenario"),
    dateGte: z
      .string()
      .optional()
      .describe("Include forecasts with date >= this value (YYYY-MM-DD)"),
    dateLte: z
      .string()
      .optional()
      .describe("Include forecasts with date <= this value (YYYY-MM-DD)"),
    token: z
      .string()
      .optional()
      .describe("Pagination token from a previous response"),
  },
  async ({ type, limit, accountId, batchId, scenarioId, dateGte, dateLte, token }) => {
    try {
      const params: Record<string, unknown> = {
        limit,
        accountId,
        batchId,
        scenarioId,
        token,
      };
      if (dateGte) params["date[gte]"] = dateGte;
      if (dateLte) params["date[lte]"] = dateLte;

      if (type === "transactions") {
        params["correctionType"] = "";
      } else if (type === "estimates") {
        params["correctionType[in]"] = "INFLOW,OUTFLOW";
      }

      const response = await atlarClient.get(
        "/analytics/v2beta/forecasted-transactions",
        { params }
      );
      return {
        content: [
          { type: "text", text: summarizeForecastedTransactions(response.data) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_forecasted_transaction",
  "Retrieve a specific forecasted transaction or estimate by ID. Check correctionType to determine if it's a transaction ('') or estimate ('INFLOW'/'OUTFLOW').",
  {
    id: z.string().describe("The forecasted transaction ID"),
  },
  async ({ id }) => {
    try {
      const response = await atlarClient.get(
        `/analytics/v2beta/forecasted-transactions/${id}`
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(response.data, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "create_forecasted_transaction",
  `Create a new forecasted transaction or forecast estimate in Atlar. Set correctionType to distinguish:
  - '' (empty, default): creates a forecasted transaction (bottom-up, specific future cash movement)
  - 'INFLOW': creates a forecast estimate for expected inflows (top-down)
  - 'OUTFLOW': creates a forecast estimate for expected outflows (top-down)`,
  {
    parentType: z
      .enum(["ACCOUNT", "ENTITY"])
      .describe("Whether the forecast is linked to an ACCOUNT or ENTITY"),
    parentId: z
      .string()
      .describe("The ID of the account or entity this forecast belongs to"),
    amountValue: z
      .number()
      .describe(
        "Amount in currency minor units (e.g. 1502 = 15.02 EUR). Negative for outflows."
      ),
    currency: z.string().describe("3-letter ISO 4217 currency code (e.g. EUR)"),
    date: z.string().describe("Expected date in YYYY-MM-DD format"),
    description: z.string().describe("Description of the forecasted transaction"),
    originId: z
      .string()
      .describe("Origin ID identifying where the forecast came from"),
    originType: z
      .string()
      .describe("Origin type (e.g. USER for manual input, or an integration type)"),
    correctionType: z
      .enum(["", "INFLOW", "OUTFLOW"])
      .optional()
      .describe("'' = forecasted transaction (default), 'INFLOW' = estimate for inflows, 'OUTFLOW' = estimate for outflows"),
    scenarioId: z
      .string()
      .optional()
      .describe("ID of the scenario this forecast belongs to. Omit for the base/default scenario."),
    externalId: z
      .string()
      .optional()
      .describe("Optional unique external ID for deduplication"),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional key-value metadata (max 12 entries)"),
  },
  async ({
    parentType,
    parentId,
    amountValue,
    currency,
    date,
    description,
    originId,
    originType,
    correctionType,
    scenarioId,
    externalId,
    metadata,
  }) => {
    try {
      const payload: Record<string, unknown> = {
        parent: { type: parentType, id: parentId },
        amount: { currency, value: amountValue },
        date,
        description,
        origin: { id: originId, type: originType },
        correctionType: correctionType ?? "",
      };
      if (scenarioId) payload.scenarioId = scenarioId;
      if (externalId) payload.externalId = externalId;
      if (metadata) payload.metadata = metadata;

      const response = await atlarClient.post(
        "/analytics/v2beta/forecasted-transactions",
        payload
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(response.data, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "update_forecasted_transaction",
  "Update a forecasted transaction or estimate using JSON Patch. Works for both types (same resource). Requires the current ETag for optimistic concurrency.",
  {
    id: z.string().describe("The forecasted transaction ID to update"),
    etag: z
      .string()
      .describe('Current ETag of the resource (e.g. "version:1")'),
    amountValue: z
      .number()
      .optional()
      .describe("New amount in currency minor units"),
    amountStringValue: z
      .string()
      .optional()
      .describe('New amount as decimal string (e.g. "15.02")'),
    date: z.string().optional().describe("New date in YYYY-MM-DD format"),
    description: z.string().optional().describe("New description"),
  },
  async ({ id, etag, amountValue, amountStringValue, date, description }) => {
    try {
      const operations: Array<{
        op: string;
        path: string;
        value?: unknown;
      }> = [];
      if (amountValue !== undefined)
        operations.push({
          op: "replace",
          path: "/amount/value",
          value: amountValue,
        });
      if (amountStringValue !== undefined)
        operations.push({
          op: "replace",
          path: "/amount/stringValue",
          value: amountStringValue,
        });
      if (date)
        operations.push({ op: "replace", path: "/date", value: date });
      if (description !== undefined)
        operations.push({
          op: "replace",
          path: "/description",
          value: description,
        });

      if (operations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Specify at least one of: amountValue, amountStringValue, date, description.",
            },
          ],
          isError: true,
        };
      }

      const response = await atlarClient.patch(
        `/analytics/v2beta/forecasted-transactions/${id}`,
        operations,
        {
          headers: {
            "Content-Type": "application/json-patch+json",
            "If-Match": etag,
          },
        }
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(response.data, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "delete_forecasted_transaction",
  "Delete a forecasted transaction or estimate by ID.",
  {
    id: z.string().describe("The forecasted transaction ID to delete"),
  },
  async ({ id }) => {
    try {
      await atlarClient.delete(
        `/analytics/v2beta/forecasted-transactions/${id}`
      );
      return {
        content: [
          {
            type: "text",
            text: `Successfully deleted forecasted transaction ${id}.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Scenarios ───────────────────────────────────────────────
// A Scenario is a container for what-if analysis. It has a name, color, and optional
// category-level adjustments (e.g. "Salary +10% from Jan 1"). Forecasted transactions
// and estimates link to scenarios via their scenarioId field.

server.tool(
  "list_scenarios",
  "List forecast scenarios. A scenario is a container for what-if analysis — it has a name, color, optional category-level adjustments, and forecasted transactions/estimates are linked to it via scenarioId.",
  {
    limit: z.number().min(1).max(500).optional().describe("Max scenarios to return (default 100)"),
    status: z.string().optional().describe("Filter by status: CREATED, MERGE_STARTED, or MERGED"),
    type: z.string().optional().describe("Filter by type: USER_CREATED_SCENARIO, FORECAST_UPLOAD, or UNKNOWN"),
    token: z.string().optional().describe("Pagination token"),
  },
  async ({ limit, status, type, token }) => {
    try {
      const response = await atlarClient.get("/analytics/v2beta/scenarios", {
        params: { limit, status, type, token },
      });
      return {
        content: [{ type: "text", text: summarizeScenarios(response.data) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_scenario",
  "Retrieve a specific scenario by ID.",
  {
    id: z.string().describe("The scenario ID"),
  },
  async ({ id }) => {
    try {
      const response = await atlarClient.get(`/analytics/v2beta/scenarios/${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "create_scenario",
  "Create a new forecast scenario for what-if analysis. Optionally add category-level adjustments (e.g. 'Salary costs +10%'). Forecasted transactions can be linked to the scenario via their scenarioId.",
  {
    alias: z.string().describe("Name of the scenario (e.g. 'Worst case', 'Aggressive growth')"),
    color: z.string().describe("Display color as hex (e.g. '#5F4CE0') or theme key (e.g. 'data_group_3')"),
    adjustments: z
      .array(
        z.object({
          category: z.string().describe("The atlar.category metadata value (e.g. 'Salary')"),
          factor: z.number().describe("Multiplier to apply (e.g. 1.1 = +10%, 0.9 = -10%)"),
          startDate: z.string().describe("When the adjustment kicks in (YYYY-MM-DD, applies indefinitely)"),
        })
      )
      .optional()
      .describe("Category-level multipliers to apply to the base scenario"),
    parentScenarioId: z.string().optional().describe("ID of parent scenario to derive from"),
    type: z
      .enum(["USER_CREATED_SCENARIO", "FORECAST_UPLOAD", "UNKNOWN"])
      .optional()
      .describe("Scenario type (default: USER_CREATED_SCENARIO)"),
  },
  async ({ alias, color, adjustments, parentScenarioId, type }) => {
    try {
      const payload: Record<string, unknown> = {
        alias,
        color,
        type: type ?? "USER_CREATED_SCENARIO",
      };
      if (adjustments) payload.adjustments = adjustments;
      if (parentScenarioId) payload.parentScenarioId = parentScenarioId;

      const response = await atlarClient.post("/analytics/v2beta/scenarios", payload);
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "update_scenario",
  "Update a scenario using JSON Patch. Requires the current ETag.",
  {
    id: z.string().describe("The scenario ID to update"),
    etag: z.string().describe('Current ETag of the resource (e.g. "version:1")'),
    alias: z.string().optional().describe("New name"),
    color: z.string().optional().describe("New color"),
    status: z
      .enum(["CREATED", "MERGE_STARTED", "MERGED"])
      .optional()
      .describe("New status"),
  },
  async ({ id, etag, alias, color, status }) => {
    try {
      const operations: Array<{ op: string; path: string; value?: unknown }> = [];
      if (alias !== undefined) operations.push({ op: "replace", path: "/alias", value: alias });
      if (color !== undefined) operations.push({ op: "replace", path: "/color", value: color });
      if (status !== undefined) operations.push({ op: "replace", path: "/status", value: status });

      if (operations.length === 0) {
        return {
          content: [{ type: "text", text: "No fields provided to update." }],
          isError: true,
        };
      }

      const response = await atlarClient.patch(
        `/analytics/v2beta/scenarios/${id}`,
        operations,
        { headers: { "Content-Type": "application/json-patch+json", "If-Match": etag } }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "delete_scenario",
  "Delete a scenario by ID.",
  {
    id: z.string().describe("The scenario ID to delete"),
  },
  async ({ id }) => {
    try {
      await atlarClient.delete(`/analytics/v2beta/scenarios/${id}`);
      return {
        content: [{ type: "text", text: `Successfully deleted scenario ${id}.` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// ── Read saved data ─────────────────────────────────────────
// Lets Claude query temp files with filtering/pagination instead of loading everything.

server.tool(
  "read_saved_data",
  "Read and filter data from a previously saved temp file. Use this after calling a list tool to drill into the full data — e.g. find specific transactions by counterparty, filter forecasts by date, get individual item IDs for updates.",
  {
    filePath: z
      .string()
      .describe("Path to the saved JSON file (returned by list tools)"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max items to return (default 20, max 50)"),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe("Skip this many items (for pagination, default 0)"),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive text search across all string fields (e.g. 'BNP', 'loan')"),
    sortBy: z
      .string()
      .optional()
      .describe("Field path to sort by (e.g. 'amount.value', 'date'). Prefix with '-' for descending (e.g. '-amount.value')"),
    fields: z
      .array(z.string())
      .optional()
      .describe("Only return these fields per item (e.g. ['id', 'date', 'amount', 'description'])"),
  },
  async ({ filePath, limit, offset, search, sortBy, fields }) => {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
        };
      }

      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      let items: Array<Record<string, unknown>> = raw?.items ?? (Array.isArray(raw) ? raw : []);

      if (search) {
        const q = search.toLowerCase();
        items = items.filter((item) => {
          const text = JSON.stringify(item).toLowerCase();
          return text.includes(q);
        });
      }

      if (sortBy) {
        const desc = sortBy.startsWith("-");
        const field = desc ? sortBy.slice(1) : sortBy;
        const parts = field.split(".");
        const getVal = (obj: Record<string, unknown>) => {
          let v: unknown = obj;
          for (const p of parts) v = (v as Record<string, unknown>)?.[p];
          return v;
        };
        items.sort((a, b) => {
          const aV = getVal(a), bV = getVal(b);
          const cmp = (aV as number) < (bV as number) ? -1 : (aV as number) > (bV as number) ? 1 : 0;
          return desc ? -cmp : cmp;
        });
      }

      const total = items.length;
      const off = offset ?? 0;
      const lim = limit ?? 20;
      items = items.slice(off, off + lim);

      if (fields && fields.length > 0) {
        items = items.map((item) => {
          const picked: Record<string, unknown> = {};
          for (const f of fields) {
            const parts = f.split(".");
            let v: unknown = item;
            for (const p of parts) v = (v as Record<string, unknown>)?.[p];
            picked[f] = v;
          }
          return picked;
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total, offset: off, returned: items.length, items }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${String(error)}` }],
        isError: true,
      };
    }
  }
);

} // end registerTools

// ── Start ───────────────────────────────────────────────────

const httpMode = process.argv.includes("--http") || !!process.env.PORT;

console.error(`[startup] mode=${httpMode ? "http" : "stdio"} PORT=${process.env.PORT ?? "(unset)"} ATLAR_API_URL=${process.env.ATLAR_API_URL ?? "(default)"}`);

if (httpMode) {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  app.get("/", (_req, res) => {
    res.json({ status: "ok", server: "Atlar Treasury MCP", version: "1.0.0" });
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  });

  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[startup] Atlar MCP Server (HTTP) listening on 0.0.0.0:${PORT}`);
  });

  process.on("SIGINT", () => {
    console.log("Shutting down...");
    process.exit(0);
  });
} else {
  const server = createServer();
  registerTools(server);
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("Atlar MCP Server running on stdio");
  }).catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
