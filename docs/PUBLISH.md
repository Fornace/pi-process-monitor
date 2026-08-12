# Publishing pi-process-monitor

This package publishes to npm from GitHub Actions on tag push using **trusted
publishing (OIDC)**. No long-lived npm token is needed: npm exchanges the
short-lived GitHub OIDC token for publish access, and provenance attestations
are generated automatically. This is the durable answer to npm's
2FA-token restrictions (Automation/2FA-bypass tokens stop skipping 2FA for
account actions in early August 2026 and lose direct publishing around
January 2027; see the
[GitHub changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

One-time setup is required by Francesco on npmjs.com (2 minutes).

## Option B (recommended): trusted publishing (OIDC), no token

1. On https://www.npmjs.com/package/pi-process-monitor open **Settings** and
   find the **Trusted Publisher** section.
2. Under "Select your publisher", click **GitHub Actions** and configure:
   - Organization or user: `Fornace`
   - Repository: `pi-process-monitor`
   - Workflow filename: `publish.yml` (filename only, must exist in
     `.github/workflows/`)
   - Environment name: leave blank
   - Allowed actions: `npm publish`
3. Save. npm does not verify the configuration until the first publish, so
   double-check the workflow filename.
4. Publish by pushing a tag or dispatching the workflow:

   ```bash
   git tag -a v<x.y.z> -m "..."
   git push origin v<x.y.z>
   # or, against an existing tag:
   gh workflow run publish.yml --repo Fornace/pi-process-monitor --ref v<x.y.z>
   ```

The workflow (`.github/workflows/publish.yml`) runs typecheck, the full test
suite, smoke, and a pack dry-run before `npm publish --access public`. The
`id-token: write` permission is required and already set.

Optionally, after the first successful trusted publish, restrict publishing
access to tokens (Settings -> Publishing access -> "Require two-factor
authentication and disallow tokens") for maximum security.

## Option A (legacy): classic token (deprecated, avoid)

npm is phasing out token-based publishing for accounts with 2FA. A classic
Publish/Automation token, if used, requires a human OTP per publish and
2FA-bypass tokens stop working for direct publishing in January 2027. Prefer
Option B. If you still need a token for legacy tooling:

1. Generate a token at <https://www.npmjs.com/settings/ffrappo/tokens>.
2. Add it as the repo secret (one-time):

   ```bash
   gh secret set NPM_TOKEN --repo Fornace/pi-process-monitor
   ```

3. The workflow ignores it when OIDC is configured; keep it only for
   non-OIDC webhooks. The workflow's Publish step no longer reads
   `NODE_AUTH_TOKEN`.

## Verifying a publish

```bash
npm view pi-process-monitor version          # must equal the new tag
npm view pi-process-monitor@<ver> dist.tarball
gh run list --repo Fornace/pi-process-monitor --workflow=publish.yml
```

## Bypass until npm is published

`pi install` resolves `npm:pi-process-monitor` against npmjs.com, so until a
new version is published it installs the last registry version. The fix is
consumable immediately from git:

```bash
pi install git:github.com/Fornace/pi-process-monitor@v<x.y.z>
```
