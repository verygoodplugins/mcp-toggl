# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development
```bash
npm run build          # Compile TypeScript to dist/
npm run dev           # Watch mode with tsx for development
npm start             # Run compiled server from dist/
```

### Code Quality
```bash
npm run lint          # ESLint on src/**/*.ts
npm run format        # Prettier formatting on src/**/*.ts
npm test              # Run test file
```

## Architecture

### MCP Server Pattern
This is a Model Context Protocol (MCP) server for Toggl Track time tracking:
- Main server entry point at `src/index.ts` sets up StdioServerTransport
- Tools are defined with JSON schemas and registered via `setRequestHandler`
- Each tool maps to a Toggl Track API operation

### File Structure
- `src/index.ts` - MCP server entry point, tool definitions
- `src/toggl-api.ts` - Toggl Track API client wrapper
- `src/cache-manager.ts` - Caching layer for API responses
- `src/types.ts` - TypeScript type definitions
- `src/utils.ts` - Utility functions

### Toggl API Integration
The `TogglAPI` class (`src/toggl-api.ts`) wraps the Toggl Track API:
- Uses API token authentication
- Supports time entries, projects, clients, and reports
- Caching layer reduces API calls for frequently accessed data

### TypeScript Configuration
- ES2022 modules with strict mode enabled
- Compiles to ES modules (not CommonJS)
- All imports require `.js` extensions (even for `.ts` files)

## Environment Variables

Required:
- `TOGGL_API_TOKEN`: Your Toggl Track API token (get from https://track.toggl.com/profile)

Optional:
- `TOGGL_WORKSPACE_ID`: Default workspace ID

## Key Implementation Patterns

### Caching Strategy
- `cache-manager.ts` provides TTL-based caching
- Reduces API rate limiting issues
- Cache invalidation on write operations

### Error Handling
- API errors wrapped with descriptive messages
- Rate limiting handled with retry logic
- Missing resources return clear error states
