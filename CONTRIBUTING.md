# Contributing to Within

Thank you for your interest in contributing to **Within** — a self-hosted private journal built with Next.js and PostgreSQL.

Bug reports (issues) are welcome. There is no guaranteed response time. Contributions are welcome; for larger changes, please open an issue first to discuss the approach before you start writing code.

---

## Development Setup

Within ships a separate Docker Compose file for development — it builds the app from source and seeds it with synthetic data, so you never need real journal content or a production server to work on it.

1. Fork the repository and clone your fork.
2. Copy the dev credentials file: `cp .env.localdev.example .env.localdev`
3. Start the stack: `docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build`
4. Open `http://localhost:4000` and log in with password `localtest`.

Migrations run automatically on app start — `src/lib/db/migrate.ts` applies `schema.sql` idempotently on every boot. There are no separate, timestamp-named migration files and no `db:migrate` command to run by hand.

See [`docs/local-dev-docker.md`](docs/local-dev-docker.md) for seed data, resetting the database, and an optional HTTPS profile for testing the PWA on a phone.

Prefer running against your own Postgres instead of the full dev stack? `npm install` and `npm run dev` work too — copy `.env.example` to `.env.local` and fill in `DATABASE_URL` (see `.env.local.example`).

---

## Testing

Run these before opening a PR — all must pass:

```bash
npm test                 # unit/integration tests (vitest)
npm run lint              # eslint
npx tsc --noEmit          # type check
```

End-to-end tests run against the dev stack from the setup above:

```bash
E2E_PASSWORD=localtest npm run test:e2e
```

---

## Workflow

```
fork → feature branch → PR against main
```

1. Create a branch off `main`: `git checkout -b feature/<short-description>`
2. Write failing tests first (TDD encouraged), then implement.
3. Ensure all tests pass (see Testing above).
4. Open a pull request against `main` with a clear description.

---

## Commit Convention

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

Examples:
```
feat(entries): add word-count badge to editor
fix(media): stream range response instead of buffering
docs(readme): clarify self-hosting prerequisites
```

- Keep the summary line under 72 characters.
- Reference related issues in the body: `Closes #123`.

---

## Pull Request Guidelines

- **One concern per PR.** Do not bundle unrelated changes.
- Tests must be green.
- Follow TDD where practical: a failing-test commit before the implementation commit.
- Update relevant documentation if your change affects public-facing behaviour.
- No drive-by refactors, formatting sweeps, or unrelated comment changes.

---

## Code Style

- TypeScript strict mode — no `any` without a comment explaining why.
- Parameterised SQL only — never string-interpolate user input into queries.
- Streaming I/O for media and exports — never buffer entire files in memory.
- Uploads are validated by content, not by filename or claimed MIME type — images are decoded and re-encoded, video/audio are checked against an explicit allowlist.
- Markdown rendering never enables `rehype-raw` — raw HTML in journal entries would be an XSS vector.
- `npm run lint` must pass.

---

## Design notes

A few decisions come up often enough to answer here instead of in every PR discussion:

- **PostgreSQL, not SQLite.** Full-text search, JSON aggregation, and safe concurrent writes are native to Postgres and awkward to bolt onto SQLite.
- **`iron-session` for login.** Within has exactly one user, so a signed, stateless session cookie is enough — there is no user model or session store to build or maintain.
- **Streaming for media and exports.** Video/audio playback and journal exports use range requests and stream to disk instead of buffering whole files in memory, which matters on the low-power hardware this is meant to run on.
- **No `rehype-raw`.** Journal entries render through `react-markdown` without raw-HTML support, so a pasted `<script>` tag is just text, not a vulnerability.

### Frontend pattern: stale-data guard

A component that fetches data in a `useEffect` on mount needs a dependency that changes whenever the data it displays becomes stale — closing an editor elsewhere does not, by itself, change anything in that component's own dependency array. When you add a component like this, ask "what event outside this component makes its data stale?" and pass a value driven by that event (e.g. a `refreshNonce` prop) into the effect's dependency array. These bugs don't crash and don't fail type checks, so they need a behavioural test or a careful look in review.

---

## Security

Please do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible disclosure process.

---

## Licence and contributor agreement

Within is licensed under the GNU AGPL-3.0 with an additional permission for independent modules that talk to Within only through its HTTP interface (see [LICENSE](LICENSE)).

Before your first pull request can be merged, you need to agree to the short [Contributor License Agreement](CLA.md): add a comment with the sentence *"I have read the CLA and I agree to it."* to the pull request. It confirms that the contribution is yours to give and lets the maintainer keep Within under one licence and offer optional add-ons under other terms. You keep the copyright to your contribution.
