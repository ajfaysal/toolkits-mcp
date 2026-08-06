/**
 * toolkits-mcp — Remote MCP server on Cloudflare Workers
 * Exposes tools to Claude for generating Adobe Stock-ready assets.
 * Transport: Streamable HTTP (JSON-RPC 2.0 over POST /mcp)
 */

export interface Env {
  MCP_AUTH_TOKEN: string;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  ASSETS_PUBLIC_BASE_URL: string; // e.g. https://pub-xxxx.r2.dev  (from R2 bucket's Public Development URL)
  ASSETS: R2Bucket;
}

const TOOLS = [
  {
    name: "generate_asset",
    description:
      "Generate a stock asset (icon, illustration, pattern, etc.) ready for Adobe Stock. Kicks off a background job.",
    inputSchema: {
      type: "object",
      properties: {
        asset_type: {
          type: "string",
          description: "Type of asset to generate, e.g. 'icon'. New types can be added later.",
        },
        description: { type: "string", description: "What the asset should look like" },
        style: {
          type: "string",
          description: "Style, e.g. 'line', 'flat', 'bi-chromatic'",
        },
        colors: {
          type: "array",
          items: { type: "string" },
          description: "Up to 2 hex color codes",
        },
        quantity: { type: "number", description: "How many variations", default: 1 },
        extra_options: {
          type: "object",
          description: "Optional freeform params for future asset types",
        },
      },
      required: ["asset_type", "description"],
    },
  },
  {
    name: "check_status",
    description: "Check the status of a previously started generate_asset job.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "get_files",
    description: "Get download links for the completed output files of a job.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
];

async function githubDispatch(env: Env, inputs: Record<string, unknown>) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/generate-asset.yml/dispatches`;
  const jobId = crypto.randomUUID();
  const body = {
    ref: "main",
    inputs: {
      options: JSON.stringify({ ...inputs, job_id: jobId }),
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "toolkits-mcp",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${text}`);
  }
  return jobId;
}

async function findRunIdForJob(env: Env, jobId: string): Promise<number | null> {
  // GitHub doesn't return a run ID directly from dispatch, so we search recent runs
  // and match by looking up runs created after dispatch time. We store a mapping via
  // R2 as a lightweight lookup instead, written by the workflow itself on start.
  const obj = await env.ASSETS.get(`jobs/${jobId}/run_id.txt`);
  if (!obj) return null;
  const text = await obj.text();
  return parseInt(text.trim(), 10);
}

async function checkStatus(env: Env, jobId: string) {
  const runId = await findRunIdForJob(env, jobId);
  if (!runId) {
    return { status: "queued", conclusion: null, note: "Run not yet registered, try again shortly" };
  }
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${runId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "toolkits-mcp",
    },
  });
  if (!res.ok) throw new Error(`GitHub status check failed: ${res.status}`);
  const data = (await res.json()) as { status: string; conclusion: string | null };
  return { status: data.status, conclusion: data.conclusion };
}

async function getFiles(env: Env, jobId: string) {
  const listed = await env.ASSETS.list({ prefix: `jobs/${jobId}/` });
  const files = listed.objects
    .filter((o) => !o.key.endsWith("run_id.txt"))
    .map((o) => ({
      filename: o.key.split("/").pop(),
      download_url: `${env.ASSETS_PUBLIC_BASE_URL}/${o.key}`,
    }));
  return files;
}

async function handleToolCall(env: Env, name: string, args: any) {
  switch (name) {
    case "generate_asset": {
      const jobId = await githubDispatch(env, args);
      return { job_id: jobId, status: "queued" };
    }
    case "check_status": {
      return await checkStatus(env, args.job_id);
    }
    case "get_files": {
      const files = await getFiles(env, args.job_id);
      return { files };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function jsonRpcResult(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    // Auth check
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
    }

    const { id, method, params } = body;

    try {
      if (method === "initialize") {
        return Response.json(
          jsonRpcResult(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "toolkits-mcp", version: "1.0.0" },
          })
        );
      }

      if (method === "tools/list") {
        return Response.json(jsonRpcResult(id, { tools: TOOLS }));
      }

      if (method === "tools/call") {
        const { name, arguments: args } = params;
        const result = await handleToolCall(env, name, args);
        return Response.json(
          jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
          })
        );
      }

      return Response.json(jsonRpcError(id, -32601, `Method not found: ${method}`), { status: 400 });
    } catch (err: any) {
      return Response.json(jsonRpcError(id, -32000, err.message || "Internal error"), { status: 500 });
    }
  },
};
