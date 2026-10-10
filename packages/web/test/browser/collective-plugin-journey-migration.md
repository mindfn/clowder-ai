# Collective browser journey migration

Status: **migration pending; installed Collective package and full journeys have not been verified**.
Host test-lane cleanup is not a Collective migration acceptance result.

Business migration uses fixed Host main `bb9f9f08ec574ee8888fbde9819ff95da96bb614`.
The later browser journeys are not present at that commit; their separately verified source is
`ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`. The adjacent JSON manifest records every movable
journey/fixture, its exact source blob and behavior. Retrieve a test with
`git show <browserSourceCommit>:<path>` from the Host repository, then move it into the Collective
plugin package test suite. Git preserves the source; no runtime or persistent data is changed.

These 14 full-stack journey entrypoints and seven dedicated fixtures directly compose the retired
Host Service/connector/routes or seed their private stores. They are removed from Host, not skipped
or replaced with success mocks. Thirteen were in `@cat-cafe/web test:browser`; the appearance
journey was a separate manual entrypoint. The plugin package must provide the runtime through
installation, then adapt test composition and HTTP edges:

- Install/start packaged Collective with isolated private storage and authentication.
- Exercise the preserved Client through generic Host plugin forwarding and package-owned endpoints;
  do not restore Host Collective routes or provision a Host-owned Service.
- Use SDK task/thread/message/send at the owner edge. Retain revocation, restart, replay, artifact,
  policy and multi-human authority assertions from the original journeys.
- Validate the Host launch surface and iframe appearance handshake against the installed package.

C2 production UI and Client code stay in Host. Pure Client conversation rendering coverage,
the frontend-only asset fixture, and shared Next/browser/default-entry harnesses are retained. They
do not prove the removed package integration journeys. No newly passing/skipped test count may be
used to claim those journeys are complete. Package migration, installed-package browser execution,
and operator acceptance remain outstanding.
