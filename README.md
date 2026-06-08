# Coauthor Conflict Dashboard

Static GitHub Pages dashboard for screening reviewer assignments against UTD coauthorship history.

## Run Locally

```bash
python3 scripts/build_conflict_data.py
python3 -m http.server 8000
```

Open `http://localhost:8000`.

You can prefill a check with URL parameters, for example:

```text
http://localhost:8000/?submission=Ashley%20Rocc&reviewers=Laura%20Doria&run=1
```

## Publish On GitHub Pages

1. Commit `index.html`, `styles.css`, `app.js`, `data/conflict-index.json`, and `scripts/build_conflict_data.py`.
2. Push the repository to GitHub.
3. In the repository settings, enable Pages from the main branch root.

## Data Notes

The dashboard flags conflicts when two normalized author names appear on the same UTD-indexed publication. UTD author names are not disambiguated person identifiers, so name collisions and spelling variants should be reviewed manually. Institution labels are the latest UTD-recorded article affiliations, not live appointment records. When an unresolved name is resolved by choosing a suggested UTD author, the app recomputes the assignment and shows a decision panel for that resolution.
