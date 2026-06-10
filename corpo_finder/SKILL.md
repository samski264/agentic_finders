---
name: score-shortlist
description: Agent de scoring (TS). Prend results.json (sortie findall), applique 3 gates puis 5 critères 0/1, score déterministe via score.ts, écrit shortlist.csv via shortlist.ts. NE LANCE JAMAIS la collecte (index.ts = API Parallel payante).
metadata: { "openclaw": { "emoji": "🎯", "requires": { "bins": ["node"] } } }
---

# score-shortlist — scoring de results.json (TS)

Entrée : `{baseDir}/results.json`, déjà produit par la collecte. Chaque candidat a
`name`, `url`, `description`, `output.{zone_check, software_product_check}` (avec
`is_matched`) et `basis[].citations[].excerpts` (les preuves).

Règle d'or : **tu mappes/extrais, le code score.** Tu produis un JSON enrichi, les
outils TS calculent le reste. Pas de note "au feeling". Pas de preuve → 0.

## INTERDIT — ne jamais lancer la collecte
- **N'exécute JAMAIS `index.ts` ni `npm start`** : c'est un run **Parallel FindAll = API payante**.
- Ton périmètre : **scorer le `results.json` existant**, rien d'autre. S'il manque ou est vide, **arrête-toi et signale-le** — ne le régénère pas.
- Aucun envoi de message. Tu t'arrêtes au CSV + rapport.

## Étape 1 — Gates (depuis le JSON, un seul false = drop)
| gate | source |
|------|--------|
| `zone_ok` | `output.zone_check.is_matched` (mappé automatiquement par score.ts) |
| `produit_ok` | `output.software_product_check.is_matched` (mappé auto) — force `false` si agence, studio démos, conseil pur, hardware sans soft |
| `stade_ok` | **pas dans le JSON** : déduis de `description` + `basis`. `true` si seed→série A ET équipe < 30 ; `false` si scale-up/grand groupe/racheté/effectif élevé |

## Étape 2 — 5 critères (0/1, depuis description + basis excerpts)
1 seulement si preuve explicite. `source` = l'URL de la citation. Sinon 0.
- `produit_pertinent` : interface riche / complexité réelle (AI / 3D / infra).
- `culture_builder` : founding, ownership, 0-to-1.
- `stack_match` : TS / React / Next / Three.js / AI mentionnés.
- `decideur_joignable` : founder ou CTO identifiable en source ouverte (**jamais LinkedIn/X**).
- `signal_frais` : levée OU poste ouvert daté < 60 jours.

## Étape 3 — Produire l'enrichi + scorer (déterministe)
Écris un tableau d'objets dans `/tmp/enrichis.json`, un par candidat :
```json
[{
  "name":"", "url":"", "city":"", "source":"",
  "gates": { "zone_ok": true, "stade_ok": true, "produit_ok": true },
  "criteria": {
    "produit_pertinent": { "value": 1, "why": "", "source": "" },
    "culture_builder":   { "value": 0, "why": "", "source": "" },
    "stack_match":       { "value": 1, "why": "", "source": "" },
    "decideur_joignable":{ "value": 1, "why": "", "source": "" },
    "signal_frais":      { "value": 1, "why": "", "source": "" }
  }
}]
```
Puis (exec) :
```bash
node {baseDir}/score.ts --in /tmp/enrichis.json --keep-only \
  | node {baseDir}/shortlist.ts --csv {baseDir}/shortlist.csv
```
`score.ts` : somme /5, garde ≥3, tier 1 (4-5) / 2 (3), gates avant score.
`shortlist.ts` : dédup (Nom OU Site), append `shortlist.csv`, imprime le rapport (nb + top 3).

## Étape 4 — Rapport
Renvoie le rapport de shortlist.ts. Rien d'autre.

## Tester / garde-fous
- `node {baseDir}/score.ts --self-test` → `OK`.
- score.ts lit aussi `results.json` brut (gates mappés depuis `output`) : utile pour vérifier, mais sans tes critères tout tombe sur `stade_ok`.
- `shortlist.ts --dry-run` pour voir avant d'écrire.
