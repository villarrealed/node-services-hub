# Salesforce MCP Server

Node.js Express sub-app providing 9 MCP tools for Salesforce Contacts, Accounts, and Cases.

Port of the Python FastMCP server at `/tmp/sf-mcp-server/` into the Express hub pattern.

## Purpose

Expose Salesforce data and operations via MCP protocol for use by AI agents (Webex AI Studio, Claude Desktop, etc.).

## Tools

### Contact Tools (4)
- `search_contacts` — Search by name, email, or phone
- `lookup_contact_by_phone` — Format-agnostic phone lookup
- `get_contact` — Get contact by ID
- `verify_identity` — Verify caller identity (phone + name match)

### Account Tools (2)
- `search_accounts` — Search accounts by name
- `get_account` — Get account by ID

### Case Tools (3)
- `search_cases` — Search cases by subject, number, status, priority
- `get_case` — Get case by ID or case number
- `create_case` — Create a new case

## Required Environment Variables

### Salesforce OAuth (REQUIRED)
```bash
SF_CLIENT_ID=<your_connected_app_client_id>
SF_CLIENT_SECRET=<your_connected_app_client_secret>
SF_REFRESH_TOKEN=<your_refresh_token>
```

### MCP Authentication (REQUIRED for production)
```bash
SALESFORCE_MCP_BEARER_TOKEN=<random_secure_token>
```

If not set, the server runs in **unauthenticated dev mode** (logs a warning).

### Optional Salesforce Config
```bash
SF_LOGIN_URL=https://login.salesforce.com  # default
SF_INSTANCE_URL=                           # auto-detected from token response
SF_API_VERSION=v62.0                       # default
```

## Endpoints

All endpoints are mounted under `/salesforce`:

- `GET /salesforce/` — JSON manifest
- `GET /salesforce/health` — Health check
- `POST /salesforce/mcp` — JSON-RPC endpoint (requires `Authorization: Bearer <token>`)
- `GET /salesforce/mcp` — SSE stream
- `DELETE /salesforce/mcp` — Session close stub
- `GET /salesforce/mcp-log` — Last 50 requests (debugging)

## Authentication

All `/mcp` requests require:
```
Authorization: Bearer <SALESFORCE_MCP_BEARER_TOKEN>
```

Health checks and manifest endpoints are unauthenticated.

## Generating a Refresh Token

Use the `get_refresh_token.py` script from the original Python repo to obtain a refresh token via OAuth web flow. You'll need:
1. A Salesforce Connected App with OAuth enabled
2. Callback URL configured (e.g., `http://localhost:8080/callback`)
3. Required OAuth scopes: `api`, `refresh_token`, `offline_access`

Run the script, complete the browser OAuth flow, and copy the refresh token to your env vars.

## Development

This sub-app is part of the node-services-hub. It does NOT run standalone.

To test locally:
1. Set all required env vars in your shell or `.env` file
2. Start the hub: `npm run dev` (from hub root)
3. Access at `http://localhost:3000/salesforce/`

## Dependencies

Uses existing hub dependencies (no new packages added):
- `express` — routing
- `axios` — Salesforce API client
- `zod` — input validation
- `zod-to-json-schema` — MCP schema generation

## Port Notes

This is a 1:1 port of the Python FastMCP server logic:
- SOQL queries match exactly (lines 334-345, 374-383, 497-506, 557-563 from `server.py`)
- Field names match Pydantic models exactly
- Confidence levels in `verify_identity` match Python logic (lines 449-480)
- Phone pattern matching uses same algorithm (`_phone_like_pattern`)
- SOQL escaping matches Python (`_esc`)

## License

MIT
