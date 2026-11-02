# Contributing to meerCAD

Thanks for wanting to help. Bug reports, ideas and pull requests are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- `pnpm install`, then `pnpm typecheck` and `pnpm test` must pass. CI also checks the licenses of
  all dependencies (`node scripts/third-party-licenses.mjs --check`): no GPL, AGPL or LGPL-3 code
  can go into the app, because the App Store could no longer ship it.
- Keep the code style of the files you touch. Code, comments and commit messages are in English;
  new user-facing text goes through `t("…")` with a German translation in `apps/web/src/lib/i18n/de/`.
- Never commit keys, certificates, provisioning profiles or personal contact details.

## Contributor agreement

meerCAD is source-available under the FSL-1.1-ALv2 and sold through the App Store by
Torben Berger UG (haftungsbeschränkt) (“the company”). So that your contribution can go into those
apps, every pull request must include this statement, which the pull request template asks you to
confirm:

> I agree to the meerCAD contributor agreement in CONTRIBUTING.md for this contribution.

By confirming it, you agree to the following for every contribution you submit (code,
documentation, translations, images or other material):

1. **You keep your copyright.** You grant the company a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable licence to use, copy, modify, publish and distribute your contribution,
   and to sublicense these rights, under any licence terms, including the FSL, the Apache License,
   the App Store terms and proprietary terms. This includes the right to relicense meerCAD as a whole.
2. **Patents.** If your contribution is covered by patents you can license, you grant the company and
   everyone who receives meerCAD from it a licence to those patents for the contribution as part of meerCAD.
3. **It is yours to give.** The contribution is your own work, or you have the right to submit it
   under these terms (for example with your employer's permission). Where it contains third-party
   material, you say so in the pull request, with its licence.
4. **No obligation.** The company does not have to use your contribution. It is provided as is,
   without warranty.
5. **Credit.** Your authorship stays visible in the Git history.

German law applies, as far as permitted.
