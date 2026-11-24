# Publishing cvm

`@caveman-ai/cloud` is published by `release.yml` from the same tag as its
signed Cloud distribution. The source version `0.0.0` is replaced
with the tag version during publication. Do not publish the working checkout
as `0.0.0`, or use an older server tag that does not contain this package.
Do not add a long-lived npm token to GitHub Actions.

## How a release publishes

The `Publish cvm (@caveman-ai/cloud) to npm` job in `release.yml` runs on a
`v*` tag after `verify` and `release-distribution` succeed (or alone, when an
earlier run of the same tag already published the distribution). It:

1. builds the package and runs `node public/cloud-cli/scripts/check-package.mjs`;
2. skips publication when that version is already on npm, so a re-dispatched
   tag does not fail (and does not prove OIDC authentication either);
3. sets the version from the tag with `npm version VERSION --no-git-tag-version`;
4. runs `npm publish --access public --tag CHANNEL` through npm trusted
   publishing. A stable version takes `latest`; a prerelease takes `alpha`,
   `beta` or `rc`, and any other prerelease name takes `next`.

## Trusted publisher settings

On npm, open `@caveman-ai/cloud` → Settings → Trusted publishing → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `caveman-ai` |
| Repository | `caveman-ai/cloud-sdk` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | Enable direct `npm publish` |

npm 11.15.0 or newer can set the same configuration from the authenticated CLI
(2FA must be enabled):

```sh
npm trust github @caveman-ai/cloud --file release.yml \
  --repo caveman-ai/cloud-sdk --env npm --allow-publish --yes
npm trust list @caveman-ai/cloud --json
```

These values are case-sensitive. The workflow uses a GitHub-hosted runner
and `id-token: write`. `publishConfig.provenance` is false because npm cannot
generate provenance for this private source repository. Do not make the
repository public to enable npm provenance.

The package has no `repository` field: the source is private, and
`check-package.mjs` fails a tarball that names it (or carries an admin route,
an exclusion note from the operation catalogue, or a path into this
repository; `scripts/leaks.mjs`). npm's trusted-publishing docs say a GitHub
publish needs `repository.url` to match the workflow's repository, so until
that is settled the trusted publish step may refuse; publish by hand from a
clean, checked tarball meanwhile.

## Installation gate

After publication, verify registry metadata and install into an empty prefix:

```sh
npm view @caveman-ai/cloud version dist-tags --json
prefix=$(mktemp -d)
npm install --prefix "$prefix" --no-audit --no-fund @caveman-ai/cloud
"$prefix/node_modules/.bin/cvm" tools describe datasets.create --format json
```

Also run the package's offline installation/MCP check at the release commit.
Publishing only a prerelease does not move `latest`: check which version the
unqualified install resolves to rather than assuming a dist-tag.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
and [publishing scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
