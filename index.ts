#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import axios, { type AxiosError } from "axios";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

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

// ── Forecasted Transactions ─────────────────────────────────

server.tool(
  "list_forecasted_transactions",
  "List forecasted transactions to get insights into expected future cash flows.",
  {
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe("Max forecasted transactions to return (1-500, default 100)"),
    accountId: z
      .string()
      .optional()
      .describe("Only include forecasts for this account"),
    batchId: z
      .string()
      .optional()
      .describe("Only include forecasts belonging to this batch"),
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
  async ({ limit, accountId, batchId, dateGte, dateLte, token }) => {
    try {
      const params: Record<string, unknown> = {
        limit,
        accountId,
        batchId,
        token,
      };
      if (dateGte) params["date[gte]"] = dateGte;
      if (dateLte) params["date[lte]"] = dateLte;

      const response = await atlarClient.get(
        "/analytics/v2beta/forecasted-transactions",
        { params }
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
  "get_forecasted_transaction",
  "Retrieve a specific forecasted transaction by ID.",
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
  "Create a new forecasted transaction in Atlar.",
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
      };
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

// The Atlar PATCH endpoint uses JSON Patch (RFC 6902) with If-Match ETag header.
server.tool(
  "update_forecasted_transaction",
  "Update a forecasted transaction using JSON Patch. Requires the current ETag for optimistic concurrency.",
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
  "Delete a forecasted transaction by ID.",
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

} // end registerTools

// ── Start ───────────────────────────────────────────────────

const httpMode = process.argv.includes("--http") || !!process.env.PORT;

console.log(`[startup] mode=${httpMode ? "http" : "stdio"} PORT=${process.env.PORT ?? "(unset)"} ATLAR_API_URL=${process.env.ATLAR_API_URL ?? "(default)"}`);

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
