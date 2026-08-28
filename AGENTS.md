# Repository Guidelines

## Project Structure & Module Organization

This is a small Node.js 18+ Express application for anonymous, QR-entry audience chat.

- `server.js` contains the HTTP routes, SSE handling, persistence helpers, validation, and self-tests.
- `public/` contains the browser pages and shared client assets: `index.html`, `join.html`, `present.html`, `admin.html`, `app.js`, and `style.css`.
- `events/<code>.json` stores tracked event metadata and poll definitions; `data/<code>.jsonl` is runtime message storage and is ignored by Git.
- `seed/seed.js` creates example runtime data. Deployment files and operational notes live in `deploy/`; product plans live in `docs/`.

## Build, Test, and Development Commands

Install the locked dependency set and run the local server:

```bash
npm ci
npm start                 # http://localhost:3000
node seed/seed.js         # optional sample event data
npm test                  # server self-test; equivalent to node server.js --selftest
```

Use `PORT=3001 npm start` when another local service occupies port 3000. There is no separate compile or bundling step.

## Coding Style & Naming Conventions

Use ES modules and Node 18-compatible JavaScript. Match the existing two-space indentation, semicolon style, and small single-purpose helpers in `server.js`. Use `camelCase` for JavaScript variables/functions, lowercase route paths such as `/present/:code`, and seven-digit event codes. Keep browser-specific code in `public/` and event definitions in JSON rather than embedding event copy in server logic. No formatter or linter is configured, so keep changes consistent with nearby code and avoid unrelated reformatting.

## Testing Guidelines

The project currently uses Node `console.assert` self-tests rather than a test framework. Run `npm test` after changes to validation, persistence, reactions, polls, moderation, or stage synchronization. For UI or SSE changes, also run the server and manually verify the affected `/`, `/r/:code`, `/present/:code`, and `/admin/:code?key=...` flows.

## Commit & Pull Request Guidelines

Use short imperative Conventional Commit-style subjects, for example `feat: add CSV export`, `fix: preserve IME Enter behavior`, or `chore: update deployment docs`. Keep commits focused. Pull requests should explain user-visible behavior and implementation impact, include test commands/results, link an issue when one exists, and add screenshots or a short manual-flow description for UI changes. Call out deployment or data-format changes explicitly.

## Security & Configuration Tips

Never commit `data/`, secrets, admin keys, tunnel credentials, or production configuration. Admin access is URL-key protected; do not expose admin keys in API responses or logs. Preserve input length limits, rate limiting, safe rendering, and soft-delete behavior when modifying message endpoints.
