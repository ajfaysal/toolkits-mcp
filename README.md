# toolkits-mcp

A remote MCP server (Cloudflare Worker) that gives Claude/ChatGPT tools to generate and
convert Adobe-Stock-ready vector assets. Long-running work is offloaded to a GitHub
Actions pipeline; files are stored in Cloudflare R2 and served back as download links.

**Architecture:** Claude/ChatGPT (MCP client) → Cloudflare Worker (`src/index.ts`) →
GitHub Actions (`.github/workflows/generate-asset.yml`) → R2 (`toolkits-assets` bucket).

## Tools

- **generate_asset** — Starts a job that generates a stock asset (icon, illustration,
  pattern, etc.) from a text description, style, and colors. Returns a `job_id`.
- **check_status** — Polls a job's GitHub Actions run status.
- **get_files** — Returns public download URLs for a completed job's output files.
- **convert_image_to_vector** — Converts a user-uploaded raster image (PNG/JPG) into a
  clean vector file (SVG + EPS) using edge tracing. Best for logos, simple illustrations,
  and icon-style source images.

### convert_image_to_vector

This tool accepts a base64-encoded PNG or JPG (`image_base64` + `image_format`, plus an
optional `style` hint like `flat`, `line`, or `detailed`) and returns a `job_id`, just
like `generate_asset`.

Because `workflow_dispatch` inputs to GitHub Actions have a size limit, the Worker never
passes the image through the dispatch payload. Instead:

1. The Worker decodes the base64 image and writes the raw bytes directly to R2 at
   `jobs/{job_id}/source.{png|jpg}` (R2 has no such size limit; images up to 8MB are
   accepted).
2. The Worker triggers the GitHub Actions workflow with `asset_type: "vector_trace"` and
   the **same** `job_id`, so the workflow knows exactly which object to fetch from R2.
3. The workflow downloads the source image from R2, runs it through
   [`vtracer`](https://github.com/visioncortex/vtracer) (installed on the fly via `pip
   install vtracer`) to produce `icon.svg`, then uses headless Inkscape (already used by
   the `icon` pipeline) to produce `icon.eps`.
4. Both files are uploaded to R2 under `jobs/{job_id}/` with correct `Content-Type` /
   `Content-Disposition` headers, and become available via `get_files` exactly like any
   other job.

No extra API keys or secrets are required for this tool — `vtracer` and Inkscape are
both open-source and are installed fresh on the GitHub Actions runner for each job, using
the same R2 credentials (`CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
already configured for the rest of the pipeline.

Usage from an MCP client is the same three-step flow as `generate_asset`:

```
convert_image_to_vector(image_base64=..., image_format="png", style="flat")
  -> { "job_id": "..." }
check_status(job_id=...)
  -> { "status": "completed", "conclusion": "success" }
get_files(job_id=...)
  -> { "files": [ { "filename": "icon.svg", "download_url": "..." },
                  { "filename": "icon.eps", "download_url": "..." } ] }
```
