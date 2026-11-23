# Protected asset downloads

Builds can request a short-lived Bunny URL for a catalog asset from their project's download
issuer. The issuer is a separate App-Tracking edge deployment. It needs no database and stores
no identity or usage events. Product telemetry, when introduced, requires its own client opt-in.

| Project   | Link issuer               | Protected CDN                    |
| --------- | ------------------------- | -------------------------------- |
| Ferriki   | `downloads.ferriki.dev`   | `protected-assets.ferriki.dev`   |
| Ferrigura | `downloads.ferrigura.dev` | `protected-assets.ferrigura.dev` |

## Protocol

Send `POST /v1/downloads` over HTTPS with `Authorization: Bearer <build-token>` and JSON
`{"path":"/immutable/asset","sha256":"<lowercase SHA-256>"}`. Use the catalog pathname and expected
digest. The issuer matches both against a verified list and returns
`{"url":"https://protected-assets.…/immutable/asset?token=…&expires=…","bytes":123,"sha256":"…"}`.
The response uses `Cache-Control: private, no-store`. Invalid credentials receive 401, invalid input
receives 400 and absent catalog entries receive 404. Each URL is valid for two minutes and scoped to
one file. Anyone holding the URL can use it until expiration. Clients send only the URL to Bunny,
use no redirects, and verify the complete file before caching it. A warm cache or an offline
build does not call the issuer.

Provide one random 32-byte lowercase hex token per authorized build. Store it as
`FERRIKI_DOWNLOAD_TOKEN` or `FERRIGURA_DOWNLOAD_TOKEN` in the build's secret store. The issuer
stores only token digests. Its Bunny signing key lives in an encrypted edge secret. To allow
additional tokens, add their SHA-256 digests to the corresponding App-Tracking Actions variable
`FERRIKI_DOWNLOAD_TOKEN_SHA256` or `FERRIGURA_DOWNLOAD_TOKEN_SHA256` as a JSON array. Remove a
digest and redeploy the issuer to revoke its ability to obtain new URLs. The workflow uses the
matching App-Tracking repository secret for one authorized smoke-test token. Never expose this
secret to code from untrusted pull requests.

## Deployment sequence

1. Run **Deploy protected downloads** on main for each tool in `prepare` mode. Supply an array of
   full Ferriki catalog source commits or Ferrigura manifest paths with SHA-256 filenames. Old
   public versions can be copied into the protected zone with `import_public` for migration.
   For a private-only asset, upload its exact catalog files to the protected Storage Zone first
   and run with `import_public` disabled. Ferrigura's protected pins contain catalog JSON and
   renderer TTFs. Browser WOFF2 files use the existing public path.
2. Add the project's two DNS records with your DNS provider. The workflow prints the exact Bunny
   targets. Each record is a CNAME.

   | Host                             | Target                                    |
   | -------------------------------- | ----------------------------------------- |
   | `downloads.ferriki.dev`          | `at-ferriki-downloads.b-cdn.net`          |
   | `protected-assets.ferriki.dev`   | `at-ferriki-protected-assets.b-cdn.net`   |
   | `downloads.ferrigura.dev`        | `at-ferrigura-downloads.b-cdn.net`        |
   | `protected-assets.ferrigura.dev` | `at-ferrigura-protected-assets.b-cdn.net` |

3. Run the same workflow in `activate` mode with the same pins. It checks DNS, loads Bunny TLS
   certificates, and verifies an authorized, checksum-valid transfer plus unsigned rejection on
   the custom hosts. Then run an installed Ferriki and Ferrigura build with explicit protected
   mode and a fresh local cache.
4. Keep public legacy URLs available during the client rollout. A copied public object can still
   be downloaded at its old URL. To have exclusively protected delivery, publish new build assets
   only to the private Storage Zone with a compatible client and catalog. Retire old URLs only
   after checking the released clients and browser references that use them.

The workflow uses dedicated Storage and Pull Zones for each project and a dedicated Edge Script
per issuer. It checks that each private Pull Zone still points at its intended Storage Zone and
has token authentication enabled and request logging disabled. Keep signing keys and any build
tokens out of logging, URLs and version control. Never attach a public Pull Zone to protected
storage. Provisioning and checks can be rerun with the same pins. A failed sync leaves previous
catalog links in service because the issuer is published only after all selected assets verify.
