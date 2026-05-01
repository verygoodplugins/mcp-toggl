# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0](https://github.com/verygoodplugins/mcp-toggl/compare/v1.0.0...v1.1.0) (2026-05-01)


### Features

* add CI/CD, MCP Registry, and standardization ([96b1059](https://github.com/verygoodplugins/mcp-toggl/commit/96b1059d663bf15ecebd19eb094a05f8f538b115))
* add Toggl timeline tool ([#25](https://github.com/verygoodplugins/mcp-toggl/issues/25)) ([053b71c](https://github.com/verygoodplugins/mcp-toggl/commit/053b71cd548e26c6fd648af8c7a157ba112ee72a))
* npx package ready; stderr logging for MCP; CLI --help/--version; CHANGELOG; LICENSE; metadata ([07d13ef](https://github.com/verygoodplugins/mcp-toggl/commit/07d13ef13385dcbf6dd5b4710ea4e75b52d6b9f7))


### Bug Fixes

* **cache:** bound cached collections and retry delay ([#31](https://github.com/verygoodplugins/mcp-toggl/issues/31)) ([61b133a](https://github.com/verygoodplugins/mcp-toggl/commit/61b133a69a86d6d558628c64fb939eccfb3404ce))
* preserve local dates for Toggl periods ([#18](https://github.com/verygoodplugins/mcp-toggl/issues/18)) ([ee98861](https://github.com/verygoodplugins/mcp-toggl/commit/ee98861c1addc621fe4785bde4ef87f0c9a6a294))
* **release:** address Claude Desktop feedback ([#30](https://github.com/verygoodplugins/mcp-toggl/issues/30)) ([505aeb9](https://github.com/verygoodplugins/mcp-toggl/commit/505aeb9de44b7bc6b10fc065813e797bb2e48206))
* **release:** align metadata and docs ([#26](https://github.com/verygoodplugins/mcp-toggl/issues/26)) ([c9fa1b4](https://github.com/verygoodplugins/mcp-toggl/commit/c9fa1b4ee6f90db313f95236e32adb2aedd7dcd3))
* skip retries on 4xx client errors ([#11](https://github.com/verygoodplugins/mcp-toggl/issues/11)) ([34fdbe9](https://github.com/verygoodplugins/mcp-toggl/commit/34fdbe9386095623c77eedfb1080485b4f96bb08))

## 1.0.0 - 2025-09-06
- Initial public release
- Added npx usage documentation for Claude Desktop and Cursor
- Added CLI flags: `--help` and `--version`
- Added .npmignore to publish only compiled output
- Added package metadata (repository, homepage, bugs, engines)
