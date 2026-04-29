# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-04-29

### Added

- Static API key authentication via `--api-key` (clear text) and `--api-key-sha256` (hashed)
- Environment variable alternatives: `API_KEY` and `API_KEY_SHA256`
- Timing-safe key comparison (SHA-256 both sides to prevent length leaks)
- Bearer token trimming for robustness
- Auth gate on all `/mcp` endpoints (POST, GET, DELETE)
- CORS support for `Authorization` header
- 20 unit tests for the auth layer

## [0.1.0] - 2026-04-26

### Added

- Streamable HTTP proxy for stdio MCP servers
- Per-request header-to-env API key injection (--header-to-env)
- Keyed process pool with TTL eviction (generic-pool)
- Multi-tenant isolation — different keys get different process pools
- Queue with configurable timeout when pool is full (--queue-timeout)
- Session management via Mcp-Session-Id
- Structured JSON logging to stderr (--debug)
- Health endpoint (GET /health) with pool stats
- CORS support (--cors)
- Generic Dockerfile for wrapping any stdio MCP server
- 39 tests across 5 test files
