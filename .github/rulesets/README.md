Branch rulesets, kept here so the guardrail is reviewable. GitHub does not read this directory; apply by hand:

    gh api -X POST repos/samuelisch/formula-time/rulesets --input .github/rulesets/main.json

`main.json`: a pull request and a green `checks` job (CI) are required to change `main`; force-push and deletion are refused. No bypass actors, so it binds the owner too. To change it, edit the file, delete the old ruleset (`gh api repos/samuelisch/formula-time/rulesets` lists ids; `-X DELETE .../rulesets/<id>`), and re-apply.
