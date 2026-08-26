<!-- Agent guidance for the subrouter repo: npm naming, layout, docs site. -->

# subrouter

Router for personal AI subscriptions. When one subscription hits a rate limit or
runs out of credits, the next one takes over.

pnpm workspace with two packages plus a docs site:

- `cli/` — account stores, presets, cooldown state, provider adapters, and the
  routing engine (`RouterModel`, an AI SDK `LanguageModelV3`). Ships the
  `subrouter` binary.
- `opencode/` — `@subrouter/opencode`: the opencode plugin plus the provider
  entry that opencode loads.
- `website/` — Holocron docs site deployed to subrouter.org.

## npm package naming: everything lives in the @subrouter scope

**Every published package MUST be scoped under `@subrouter`.** There is no
exception.

The unscoped name `subrouter` on npm is **not ours**. It belongs to a third
party:

```
$ npm view subrouter maintainers repository.url
maintainers = 'lawrencechen <lawrencechen2002@gmail.com>'
repository.url = 'git+https://github.com/manaflow-ai/subrouter.git'
```

That package is unrelated to this repo. We can never publish to it, and we must
never tell users to install it.

### Rules

- **Never write `npm i -g subrouter`** or `npx subrouter` in a README, docs page,
  error message, or CLI output. It installs a stranger's package.
- **Never name a workspace package `subrouter`** (unscoped) in `package.json`.
- New packages get `@subrouter/<name>`, matching their folder where possible.

### Naming is separate from the binary and the provider id

Scoping the package does not change any user-facing identifier. Keep these as
the bare word `subrouter`:

| Thing | Value | Where |
|---|---|---|
| CLI binary | `subrouter` | `bin` field, so `subrouter login` keeps working |
| opencode provider id | `subrouter` | `cli/src/router.ts` |
| state directory | `~/.subrouter` | `SUBROUTER_HOME` |
| env var prefix | `SUBROUTER_*` | adapters |

Only the **npm package name** must be scoped.

### The two packages

| Folder | Package | Notes |
|---|---|---|
| `cli/` | `@subrouter/cli` | Ships the `subrouter` binary |
| `opencode/` | `@subrouter/opencode` | Depends on `@subrouter/cli` |

Because `@subrouter/cli` is scoped, the `bin` field must be the **object form**.
The string form (`"bin": "dist/cli.js"`) makes npm derive the binary name from
the package name, which for a scoped package strips the scope and installs a
binary called `cli`:

```json
"bin": {
  "subrouter": "dist/cli.js"
}
```

`@subrouter/opencode` imports the engine by package name, so a rename has to
update these three places together:

```
opencode/package.json      "@subrouter/cli": "workspace:^"
opencode/src/provider.ts   export { createSubrouter } from '@subrouter/cli'
opencode/src/index.ts      import { DEFAULT_PRESET_NAME, loadPresets } from '@subrouter/cli'
```

Both packages are at version `0.0.0`, so **nothing has been published yet**.

## Docs site

`website/` is a Holocron site. `website/src/index.mdx` imports the repo
`README.md`, so **the README is the docs home page**. Editing the README changes
subrouter.org.

Consequences to respect when editing `README.md`:

- **No MDX JSX components** in the README. GitHub renders them as raw text.
- ASCII diagrams must use the ` ```diagram ` fence so Holocron styles them.
- After editing any diagram or table, run the fixer. LLMs cannot count padding.

```bash
npx -y "@holocron.so/cli" diagrams fix README.md
```

Build before deploying; the build reports broken links and MDX errors.

```bash
cd website
pnpm build
pnpm deploy:prod
```

The site is served from two Cloudflare custom domains, `subrouter.org` and
`www.subrouter.org`, configured in `website/wrangler.jsonc`.

## Tests

Tests never hit real APIs. Unit tests fake provider endpoints with local HTTP
servers. The e2e test boots a real `opencode serve` and points the adapters at
fake endpoints through `SUBROUTER_*_BASE_URL`.

```bash
pnpm build
pnpm test
```
