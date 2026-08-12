# Publishing pi-process-monitor

This package publishes to npm from GitHub Actions on tag push. Two publish
modes are supported: classic token (works now) and provenance (recommended
once configured). Both require a one-time setup by Francesco on npmjs.com.

## Option A: classic token (fastest, works today)

1. Generate a **Publish** or **Automation** token at
   <https://www.npmjs.com/settings/ffrappo/tokens>. (Read the npm banner about
   2FA-bypassing tokens being restricted: prefer **Publish**.)
2. Add it as the repo secret (one-time):

   ```bash
   gh secret set NPM_TOKEN --repo Fornace/pi-process-monitor
   ```

3. Publish by pushing a tag or dispatching the workflow:

   ```bash
   git tag -a v<x.y.z> -m "..."
   git push origin v<x.y.z>
   # or, against an existing tag:
   gh workflow run publish.yml --repo Fornace/pi-process-monitor --ref v<x.y.z>
   ```

The workflow (`.github/workflows/publish.yml`) runs typecheck, the full test
suite, smoke, and a pack dry-run before `npm publish --access public`.

## Option B: npm provenance (recommended, no long-lived token)

npm provenance signing uses GitHub OIDC, so no `NPM_TOKEN` secret is needed
once the trusted-publisher link is configured. This is the durable answer to
npm's 2FA-token restrictions (Automation tokens that bypass 2FA are being
phased out for publishing from January 2027).

1. On npmjs.com, open the package settings and add a trusted publisher:
   - Organization/owner: `Fornace`
   - Repository: `pi-process-monitor`
   - Workflow filename: `publish.yml`
   - Environment: leave blank or set `release`
2. Replace the workflow's `Publish` step with the provenance form (requires
   `id-token: write` permission and `NODE_AUTH_TOKEN` removed):

   ```yaml
   - name: Publish
     run: npm publish --access public --provenance
   ```

3. Drop the `NPM_TOKEN` secret once provenance is verified.

See <https://docs.npmjs.com/generating-provenance-statements> for the current
npm-side steps before configuring.

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
