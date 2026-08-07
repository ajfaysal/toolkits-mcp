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
    name: "convert_image_to_vector",
    description:
      "Converts an uploaded raster image (PNG/JPG) into a clean vector file (SVG + EPS) using edge tracing. Best for logos, simple illustrations, and icon-style source images. Returns a job_id; use check_status then get_files as usual.",
    inputSchema: {
      type: "object",
      properties: {
        image_base64: {
          type: "string",
          description: "Base64-encoded PNG or JPG image data (no data: prefix, just the raw base64).",
        },
        image_format: {
          type: "string",
          description: "Format of the source image: 'png' or 'jpg'/'jpeg'.",
        },
        style: {
          type: "string",
          description: "Optional style hint, e.g. 'flat', 'line', 'detailed' -- passed to vtracer tuning",
        },
      },
      required: ["image_base64", "image_format"],
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

async function githubDispatch(env: Env, inputs: Record<string, unknown>, existingJobId?: string) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/generate-asset.yml/dispatches`;
  const jobId = existingJobId ?? crypto.randomUUID();
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

async function convertImageToVector(env: Env, args: any) {
  const { image_base64, image_format, style } = args;
  if (!image_base64 || !image_format) {
    throw new Error("image_base64 and image_format are required");
  }

  const jobId = crypto.randomUUID();

  // Decode base64 -> bytes (Workers runtime has global atob)
  const binaryString = atob(image_base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const MAX_BYTES = 8_000_000; // 8MB
  if (bytes.length > MAX_BYTES) {
    throw new Error("Image too large (max 8MB), please compress or resize it first.");
  }

  const ext = image_format === "jpg" || image_format === "jpeg" ? "jpg" : "png";
  await env.ASSETS.put(`jobs/${jobId}/source.${ext}`, bytes);

  await githubDispatch(
    env,
    {
      asset_type: "vector_trace",
      job_id: jobId,
      image_format: ext,
      style: style || "flat",
    },
    jobId
  );

  return { job_id: jobId, status: "queued" };
}

async function handleToolCall(env: Env, name: string, args: any) {
  switch (name) {
    case "generate_asset": {
      const jobId = await githubDispatch(env, args);
      return { job_id: jobId, status: "queued" };
    }
    case "convert_image_to_vector": {
      return await convertImageToVector(env, args);
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

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>toolkits.app — MCP Forge</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

  :root{
    --ink:#121319;
    --panel:#1B1D24;
    --panel-2:#20232B;
    --steel:#383C47;
    --paper:#EAE7DF;
    --paper-dim:#9A9C9C;
    --ember:#E8823C;
    --ember-dim:#8A5227;
    --signal:#6FE7C8;
  }
  *{box-sizing:border-box; margin:0; padding:0;}
  html{scroll-behavior:smooth;}
  body{
    background:var(--ink);
    color:var(--paper);
    font-family:'Inter', sans-serif;
    line-height:1.5;
    -webkit-font-smoothing:antialiased;
  }
  .mono{font-family:'JetBrains Mono', monospace;}
  .display{font-family:'Space Grotesk', sans-serif;}

  a{color:inherit;}

  .wrap{
    max-width:920px;
    margin:0 auto;
    padding:0 24px;
  }

  /* ---- top bar ---- */
  header{
    padding:28px 0 0;
  }
  .topbar{
    display:flex;
    align-items:center;
    justify-content:space-between;
  }
  .brand{
    display:flex;
    align-items:center;
    gap:10px;
    font-family:'Space Grotesk', sans-serif;
    font-weight:700;
    font-size:15px;
    letter-spacing:0.02em;
  }
  .brand-mark{
    width:9px; height:9px;
    background:var(--ember);
    border-radius:2px;
    transform:rotate(45deg);
    flex:none;
  }
  .status-pill{
    display:flex;
    align-items:center;
    gap:8px;
    font-family:'JetBrains Mono', monospace;
    font-size:12px;
    color:var(--signal);
    border:1px solid var(--steel);
    padding:6px 12px;
    border-radius:100px;
  }
  .dot{
    width:6px; height:6px;
    border-radius:50%;
    background:var(--signal);
    box-shadow:0 0 0 0 rgba(111,231,200,0.6);
    animation:pulse 2.4s ease-out infinite;
  }
  @keyframes pulse{
    0%{ box-shadow:0 0 0 0 rgba(111,231,200,0.45); }
    70%{ box-shadow:0 0 0 8px rgba(111,231,200,0); }
    100%{ box-shadow:0 0 0 0 rgba(111,231,200,0); }
  }

  /* ---- hero ---- */
  .hero{
    padding:96px 0 56px;
  }
  .eyebrow{
    font-family:'JetBrains Mono', monospace;
    font-size:12px;
    letter-spacing:0.14em;
    text-transform:uppercase;
    color:var(--ember);
    margin-bottom:18px;
  }
  h1{
    font-family:'Space Grotesk', sans-serif;
    font-weight:700;
    font-size:clamp(34px, 6vw, 56px);
    line-height:1.05;
    letter-spacing:-0.01em;
    max-width:11ch;
  }
  .hero-sub{
    margin-top:20px;
    max-width:46ch;
    color:var(--paper-dim);
    font-size:16px;
  }

  /* ---- signal line, the signature element ---- */
  .signal-line{
    margin:44px 0 8px;
    height:64px;
    position:relative;
    overflow:hidden;
    border-top:1px solid var(--steel);
    border-bottom:1px solid var(--steel);
  }
  .signal-line svg{ display:block; width:200%; height:100%; }
  .signal-path{
    stroke:var(--signal);
    stroke-width:1.6;
    fill:none;
    animation:travel 7s linear infinite;
  }
  @keyframes travel{
    from{ transform:translateX(0); }
    to{ transform:translateX(-50%); }
  }
  @media (prefers-reduced-motion: reduce){
    .signal-path{ animation:none; }
    .dot{ animation:none; }
  }
  .signal-caption{
    display:flex;
    justify-content:space-between;
    font-family:'JetBrains Mono', monospace;
    font-size:11px;
    color:var(--paper-dim);
    margin-top:8px;
  }

  /* ---- endpoint block ---- */
  .endpoint{
    margin-top:56px;
    background:var(--panel);
    border:1px solid var(--steel);
    border-radius:10px;
    overflow:hidden;
  }
  .endpoint-head{
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:12px 18px;
    border-bottom:1px solid var(--steel);
    font-family:'JetBrains Mono', monospace;
    font-size:11px;
    color:var(--paper-dim);
    letter-spacing:0.06em;
    text-transform:uppercase;
  }
  .endpoint-body{
    padding:20px 18px 22px;
    font-family:'JetBrains Mono', monospace;
    font-size:14px;
    overflow-x:auto;
  }
  .endpoint-body .k{ color:var(--paper-dim); }
  .endpoint-body .v{ color:var(--signal); }
  .endpoint-body pre{ white-space:pre-wrap; word-break:break-word; }

  /* ---- tools section ---- */
  .section-label{
    font-family:'JetBrains Mono', monospace;
    font-size:12px;
    letter-spacing:0.12em;
    text-transform:uppercase;
    color:var(--paper-dim);
    margin:80px 0 22px;
    display:flex;
    align-items:center;
    gap:12px;
  }
  .section-label::after{
    content:"";
    flex:1;
    height:1px;
    background:var(--steel);
  }

  .tools{
    display:grid;
    grid-template-columns:1fr;
    gap:14px;
  }
  @media (min-width:640px){
    .tools{ grid-template-columns:1fr 1fr; }
  }
  .tool-card{
    background:var(--panel);
    border:1px solid var(--steel);
    border-radius:10px;
    padding:20px;
    position:relative;
    transition:border-color .2s ease, transform .2s ease;
  }
  .tool-card:hover{
    border-color:var(--ember-dim);
    transform:translateY(-2px);
  }
  .tool-index{
    font-family:'JetBrains Mono', monospace;
    font-size:11px;
    color:var(--ember);
  }
  .tool-name{
    font-family:'Space Grotesk', sans-serif;
    font-weight:700;
    font-size:18px;
    margin:10px 0 8px;
  }
  .tool-desc{
    font-size:13.5px;
    color:var(--paper-dim);
  }
  .tool-card.wide{ grid-column:1 / -1; }

  /* ---- footer ---- */
  footer{
    margin-top:100px;
    padding:28px 0 48px;
    border-top:1px solid var(--steel);
    display:flex;
    justify-content:space-between;
    align-items:center;
    font-family:'JetBrains Mono', monospace;
    font-size:11px;
    color:var(--paper-dim);
    flex-wrap:wrap;
    gap:10px;
  }
</style>
</head>
<body>

<header>
  <div class="wrap topbar">
    <div class="brand"><span class="brand-mark"></span>toolkits.app</div>
    <div class="status-pill"><span class="dot"></span>server online</div>
  </div>
</header>

<main class="wrap">
  <section class="hero">
    <div class="eyebrow">MCP endpoint</div>
    <h1>The forge behind your stock assets.</h1>
    <p class="hero-sub">
      A remote control panel Claude connects to directly — describe an icon, it comes
      back as a finished, Adobe-Stock-ready file. No manual export, no local software.
    </p>

    <div class="signal-line" aria-hidden="true">
      <svg viewBox="0 0 800 64" preserveAspectRatio="none">
        <path class="signal-path" d="M0,32 L120,32 L136,10 L152,54 L168,32 L280,32 L296,18 L312,46 L328,32 L800,32
                                      L920,32 L936,10 L952,54 L968,32 L1080,32 L1096,18 L1112,46 L1128,32 L1600,32" />
      </svg>
    </div>
    <div class="signal-caption">
      <span>request → generate → convert → deliver</span>
      <span>~30–60s per job</span>
    </div>

    <div class="endpoint">
      <div class="endpoint-head">
        <span>connection</span>
        <span>Streamable HTTP</span>
      </div>
      <div class="endpoint-body">
        <pre><span class="k">POST</span> <span class="v">https://mcp.toolkits.app/mcp</span>
<span class="k">Authorization:</span> Bearer &lt;token&gt;
<span class="k">Content-Type:</span> application/json</pre>
      </div>
    </div>
  </section>

  <div class="section-label">available tools</div>
  <div class="tools">
    <div class="tool-card">
      <div class="tool-index">01</div>
      <div class="tool-name">generate_asset</div>
      <div class="tool-desc">Starts a job — description, style, and colors in, a job_id back out.</div>
    </div>
    <div class="tool-card">
      <div class="tool-index">02</div>
      <div class="tool-name">check_status</div>
      <div class="tool-desc">Polls a running job until it's queued, in progress, or complete.</div>
    </div>
    <div class="tool-card">
      <div class="tool-index">03</div>
      <div class="tool-name">get_files</div>
      <div class="tool-desc">Returns download links for every finished file — SVG source and print-ready EPS.</div>
    </div>
    <div class="tool-card">
      <div class="tool-index">04</div>
      <div class="tool-name">convert_image_to_vector</div>
      <div class="tool-desc">Converts an uploaded PNG/JPG image into clean SVG and EPS vector files.</div>
    </div>
  </div>

  <footer>
    <span>toolkits.app / mcp</span>
    <span>build via Cloudflare Workers + GitHub Actions</span>
  </footer>
</main>

</body>
</html>
`;

function jsonRpcResult(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function corsHeaders(request: Request, extraHeaders: HeadersInit = {}) {
  const headers = new Headers(extraHeaders);
  const origin = request.headers.get("Origin");

  headers.set("Access-Control-Allow-Origin", origin ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID"
  );
  headers.set("Access-Control-Max-Age", "86400");

  if (origin) {
    headers.append("Vary", "Origin");
  }

  return headers;
}

function jsonResponse(request: Request, body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: corsHeaders(request, init.headers),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(LANDING_HTML, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method === "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(request, { Allow: "POST, OPTIONS" }),
      });
    }

    // Auth check: accept either Authorization header (Claude) or ?token= query param (ChatGPT)
    const auth = request.headers.get("Authorization") || "";
    const queryToken = url.searchParams.get("token") || "";
    const headerOk = auth === `Bearer ${env.MCP_AUTH_TOKEN}`;
    const queryOk = queryToken === env.MCP_AUTH_TOKEN;
    if (!headerOk && !queryOk) {
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders(request, { "WWW-Authenticate": 'Bearer realm="toolkits-mcp"' }),
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(request, { Allow: "POST, OPTIONS" }),
      });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, jsonRpcError(null, -32700, "Parse error"), { status: 400 });
    }

    const { id, method, params } = body;

    try {
      if (method === "notifications/initialized" || id === undefined || id === null) {
        return new Response(null, {
          status: 202,
          headers: corsHeaders(request),
        });
      }

      if (method === "initialize") {
        return jsonResponse(
          request,
          jsonRpcResult(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "toolkits-mcp", version: "1.0.0" },
          })
        );
      }

      if (method === "tools/list") {
        return jsonResponse(request, jsonRpcResult(id, { tools: TOOLS }));
      }

      if (method === "tools/call") {
        const { name, arguments: args } = params;
        const result = await handleToolCall(env, name, args);
        return jsonResponse(
          request,
          jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
          })
        );
      }

      return jsonResponse(request, jsonRpcError(id, -32601, `Method not found: ${method}`), {
        status: 400,
      });
    } catch (err: any) {
      return jsonResponse(request, jsonRpcError(id, -32000, err.message || "Internal error"), {
        status: 500,
      });
    }
  },
};
