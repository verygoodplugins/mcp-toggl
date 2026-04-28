# Changelog

All notable changes to this project will be documented in this file.

## Unreleased
- Added `toggl_search_time_entries` tool backed by Reports API v3 `POST /reports/api/v3/workspace/{workspace_id}/search/time_entries`, exposing the full Toggl dashboard filter set: `client_ids`, `project_ids`, `task_ids`, `tag_ids`, `user_ids`, `group_ids`, `time_entry_ids`, `description`, `billable`, `min_duration_seconds`, `max_duration_seconds`, `order_by`, `order_dir`, `grouped`, `rounding`, `rounding_minutes`. Auto-paginates via `X-Next-ID` / `X-Next-Row-Number` and expands grouped rows into flat hydrated entries.
- Extended `toggl_get_time_entries` with client-side post-filters: `description`, `billable`, `user_ids`, `tags` (with `tags_all` for AND semantics), `min_duration_seconds`, `max_duration_seconds`.
- Added `TimeEntrySearchFilters` and `ReportsSearchRow` types; added `TogglAPI.searchTimeEntries` / `searchTimeEntriesPage` with 429 handling and premium-feature (402) error normalization.

## 1.0.0 - 2025-09-06
- Initial public release
- Added npx usage documentation for Claude Desktop and Cursor
- Added CLI flags: `--help` and `--version`
- Added .npmignore to publish only compiled output
- Added package metadata (repository, homepage, bugs, engines)
