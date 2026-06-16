const DATA_URL = "data/conflict-index.json";
const numberFormatter = new Intl.NumberFormat("en-US");

const state = {
  data: null,
  authorsByNorm: new Map(),
  authorById: new Map(),
  articlesById: new Map(),
  filter: "all",
  lastRun: null,
  neighborCache: new Map(),
  resolutions: new Map(),
  selectedResolution: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  loadData();
});

function cacheElements() {
  [
    "dataStatus",
    "submissionAuthors",
    "candidateReviewers",
    "windowSelect",
    "runCheck",
    "downloadCsv",
    "clearInputs",
    "metricConflicts",
    "metricClear",
    "metricUnresolved",
    "decisionPanel",
    "decisionBadge",
    "decisionTitle",
    "decisionDetail",
    "decisionEvidence",
    "resultsEmpty",
    "resultsList",
    "lookupInput",
    "lookupOutput",
    "siteFooter",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
  els.tabs = Array.from(document.querySelectorAll(".tab"));
}

function bindEvents() {
  els.runCheck.addEventListener("click", runConflictCheck);
  els.downloadCsv.addEventListener("click", downloadCsv);
  els.clearInputs.addEventListener("click", clearInputs);
  els.windowSelect.addEventListener("change", () => {
    if (state.lastRun) runConflictCheck();
    renderLookup();
  });
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.filter = tab.dataset.filter;
      els.tabs.forEach((item) => item.classList.toggle("active", item === tab));
      renderResults();
    });
  });
  els.lookupInput.addEventListener("input", debounce(renderLookup, 180));
}

async function loadData() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.data = data;
    data.authors.forEach((author) => {
      state.authorsByNorm.set(author.k, author);
      state.authorById.set(author.id, author);
      // Merged name variants (e.g. "krista li" -> "Krista J Li") so any
      // spelling resolves to the same person.
      (author.al || []).forEach((alias) => {
        if (!state.authorsByNorm.has(alias)) state.authorsByNorm.set(alias, author);
      });
    });
    data.articles.forEach((article) => state.articlesById.set(article.id, article));
    setStatus(
      `${format(data.meta.authorCount)} authors, ${format(data.meta.articleCount)} articles, ${format(data.meta.pairCount)} coauthor pairs`,
      "ready"
    );
    els.siteFooter.textContent = `UTD extraction index generated ${data.meta.generatedAt}. Coverage: ${data.meta.minYear}-${data.meta.maxYear}. Author-name caveat: normalized names are not disambiguated person identifiers.`;
    applyUrlParams();
  } catch (error) {
    setStatus("Could not load data/conflict-index.json. Serve the folder with a local web server or GitHub Pages.", "error");
    els.resultsEmpty.textContent = "The dashboard needs data/conflict-index.json before it can run checks.";
  }
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const submission = params.get("submission") || params.get("authors");
  const reviewers = params.get("reviewers") || params.get("candidates");
  const lookup = params.get("lookup");
  if (submission) els.submissionAuthors.value = submission;
  if (reviewers) els.candidateReviewers.value = reviewers;
  if (lookup) {
    els.lookupInput.value = lookup;
    renderLookup();
  }
  if (params.get("run") === "1" && (submission || reviewers)) {
    runConflictCheck();
  }
}

function setStatus(message, mode) {
  els.dataStatus.textContent = message;
  els.dataStatus.className = `data-status ${mode || ""}`.trim();
}

function runConflictCheck() {
  if (!state.data) return;

  const submissionInputs = parseNames(els.submissionAuthors.value);
  const reviewerInputs = parseNames(els.candidateReviewers.value);
  const submission = submissionInputs.map((input) => resolveName(input, "submission"));
  const reviewers = reviewerInputs.map((input) => resolveName(input, "reviewer"));
  const minYear = selectedMinYear();
  const rows = [];
  const reviewerStatuses = new Map();

  reviewers.forEach((reviewer) => {
    if (reviewer.match) {
      reviewerStatuses.set(reviewer.match.id, { reviewer, conflict: false });
    }
  });

  reviewers
    .filter((reviewer) => reviewer.match)
    .forEach((reviewer) => {
      submission
        .filter((author) => author.match)
        .forEach((author) => {
          const reviewerAuthor = reviewer.match;
          const submissionAuthor = author.match;
          if (reviewerAuthor.id === submissionAuthor.id) {
            rows.push({
              type: "same-person",
              status: "Conflict",
              reviewer,
              author,
              articleIds: [],
              shownArticles: [],
              allCount: 0,
              windowCount: 0,
              latestYear: null,
              inWindow: true,
            });
            reviewerStatuses.get(reviewerAuthor.id).conflict = true;
            return;
          }

          const articleIds = state.data.pairs[pairKey(reviewerAuthor.id, submissionAuthor.id)];
          if (!articleIds) return;

          const articles = articleIds
            .map((id) => state.articlesById.get(id))
            .filter(Boolean)
            .sort((left, right) => right.y - left.y || left.t.localeCompare(right.t));
          const windowArticles = minYear
            ? articles.filter((article) => article.y >= minYear)
            : articles;
          const inWindow = windowArticles.length > 0;
          rows.push({
            type: inWindow ? "coauthor" : "historical",
            status: inWindow ? "Conflict" : "Historical",
            reviewer,
            author,
            articleIds,
            shownArticles: (inWindow ? windowArticles : articles).slice(0, 6),
            allCount: articles.length,
            windowCount: windowArticles.length,
            latestYear: articles[0]?.y || null,
            inWindow,
          });
          if (inWindow) reviewerStatuses.get(reviewerAuthor.id).conflict = true;
        });
    });

  const unresolved = [...submission, ...reviewers].filter((item) => !item.match);
  const matchedReviewerCount = Array.from(reviewerStatuses.values()).length;
  const clearReviewers = Array.from(reviewerStatuses.values()).filter((item) => !item.conflict);

  state.lastRun = {
    submission,
    reviewers,
    rows: rows.sort(sortRows),
    unresolved,
    clearReviewers,
    conflictCount: rows.filter((row) => row.inWindow).length,
    clearCount: matchedReviewerCount ? clearReviewers.length : 0,
  };

  els.metricConflicts.textContent = format(state.lastRun.conflictCount);
  els.metricClear.textContent = format(state.lastRun.clearCount);
  els.metricUnresolved.textContent = format(unresolved.length);
  els.downloadCsv.disabled = false;
  renderResults();
  renderResolutionDecision();
}

function renderResults() {
  if (!state.lastRun) {
    els.resultsEmpty.hidden = false;
    els.resultsList.hidden = true;
    return;
  }

  els.resultsList.replaceChildren();
  const fragment = document.createDocumentFragment();
  let visibleCount = 0;

  if (state.filter !== "unresolved") {
    state.lastRun.rows.forEach((row) => {
      if (state.filter === "conflicts" && !row.inWindow) return;
      fragment.appendChild(renderResultItem(row));
      visibleCount += 1;
    });

    if (state.filter === "all" && state.lastRun.clearReviewers.length) {
      const clear = document.createElement("div");
      clear.className = "result-item";
      const names = state.lastRun.clearReviewers
        .map((item) => item.reviewer.match.n)
        .sort((left, right) => left.localeCompare(right))
        .join(", ");
      appendTopline(clear, "No selected-window coauthorship found", names, "Clear", "clear");
      fragment.appendChild(clear);
      visibleCount += 1;
    }
  }

  if (state.filter !== "conflicts") {
    state.lastRun.unresolved.forEach((item) => {
      fragment.appendChild(renderUnresolvedItem(item));
      visibleCount += 1;
    });
  }

  if (!visibleCount) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      state.filter === "conflicts"
        ? "No conflicts found in the selected window."
        : "No rows match the current filter.";
    fragment.appendChild(empty);
  }

  els.resultsList.appendChild(fragment);
  els.resultsEmpty.hidden = true;
  els.resultsList.hidden = false;
}

function renderResultItem(row) {
  const item = document.createElement("article");
  item.className = "result-item";
  const detail =
    row.type === "same-person"
      ? "Candidate reviewer matches a submission author name."
      : `${row.windowCount || row.allCount} shared publication${(row.windowCount || row.allCount) === 1 ? "" : "s"}; latest ${row.latestYear}.`;
  appendTopline(
    item,
    `${row.reviewer.match.n} x ${row.author.match.n}`,
    detail,
    row.status,
    row.inWindow ? "conflict" : "historical"
  );

  if (row.shownArticles.length) {
    const list = document.createElement("div");
    list.className = "article-list";
    row.shownArticles.forEach((article) => list.appendChild(renderArticleLine(article)));
    if ((row.windowCount || row.allCount) > row.shownArticles.length) {
      const more = document.createElement("div");
      more.className = "article-line";
      more.textContent = `${(row.windowCount || row.allCount) - row.shownArticles.length} more shared publications not shown.`;
      list.appendChild(more);
    }
    item.appendChild(list);
  }
  return item;
}

function appendTopline(container, title, detail, badgeText, badgeClass) {
  const top = document.createElement("div");
  top.className = "result-topline";

  const names = document.createElement("div");
  names.className = "result-names";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = detail;
  names.append(strong, span);

  const badge = document.createElement("span");
  badge.className = `badge ${badgeClass}`;
  badge.textContent = badgeText;
  top.append(names, badge);
  container.appendChild(top);
}

function renderArticleLine(article) {
  const line = document.createElement("div");
  line.className = "article-line";
  const title = document.createElement("strong");
  title.textContent = article.t || "Untitled publication";
  const meta = document.createTextNode(` (${article.y}, ${article.j})`);
  line.append(title, meta);
  return line;
}

function renderUnresolvedItem(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "unresolved-item";
  const title = document.createElement("strong");
  title.textContent =
    item.side === "lookup"
      ? `No exact match: ${item.input}`
      : `No exact ${roleLabel(item.side)} match: ${item.input}`;
  wrapper.appendChild(title);

  if (item.suggestions.length) {
    const suggestions = document.createElement("div");
    suggestions.className = "suggestions";
    item.suggestions.forEach((author) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-button";
      const name = document.createElement("strong");
      name.textContent = author.n;
      const affiliation = document.createElement("span");
      affiliation.textContent = authorAffiliationLabel(author);
      const activity = document.createElement("small");
      activity.textContent = `${author.c} UTD publication${author.c === 1 ? "" : "s"}, ${author.f}-${author.l}`;
      button.append(name, affiliation, activity);
      button.setAttribute(
        "aria-label",
        `${author.n}. ${affiliation.textContent}. ${activity.textContent}.`
      );
      button.addEventListener("click", () => {
        selectSuggestedAuthor(item, author);
      });
      suggestions.appendChild(button);
    });
    wrapper.appendChild(suggestions);
  } else {
    const note = document.createElement("div");
    note.textContent = "No close UTD author-name candidates found.";
    wrapper.appendChild(note);
  }
  return wrapper;
}

function renderLookup() {
  if (!state.data) return;
  const raw = els.lookupInput.value.trim();
  els.lookupOutput.className = "lookup-output";
  els.lookupOutput.replaceChildren();

  if (!raw) {
    els.lookupOutput.textContent = "Search an author to view recent UTD coauthors.";
    return;
  }

  const resolved = resolveName(raw, "lookup");
  if (!resolved.match) {
    els.lookupOutput.appendChild(renderUnresolvedItem(resolved));
    return;
  }

  const minYear = selectedMinYear();
  const coauthors = getCoauthors(resolved.match.id)
    .map((item) => {
      const articles = item.articleIds
        .map((id) => state.articlesById.get(id))
        .filter(Boolean)
        .sort((left, right) => right.y - left.y || left.t.localeCompare(right.t));
      const windowArticles = minYear
        ? articles.filter((article) => article.y >= minYear)
        : articles;
      return {
        author: state.authorById.get(item.authorId),
        articles,
        windowArticles,
        latestYear: articles[0]?.y || 0,
      };
    })
    .filter((item) => item.windowArticles.length)
    .sort((left, right) => right.latestYear - left.latestYear || right.windowArticles.length - left.windowArticles.length)
    .slice(0, 50);

  els.lookupOutput.className = "lookup-output ready";
  const summary = document.createElement("div");
  summary.className = "lookup-summary";
  const head = document.createElement("div");
  head.className = "lookup-summary-head";
  const title = document.createElement("strong");
  title.textContent = resolved.match.n;
  const vizLink = document.createElement("button");
  vizLink.type = "button";
  vizLink.className = "viz-network-link";
  vizLink.textContent = "visualize network";
  vizLink.setAttribute("aria-label", `Visualize coauthor network for ${resolved.match.n}`);
  vizLink.addEventListener("click", () => openNetworkPanel(resolved.match.id));
  head.append(title, vizLink);
  const meta = document.createElement("div");
  meta.className = "lookup-meta";
  meta.textContent = `${resolved.match.c} UTD publication${resolved.match.c === 1 ? "" : "s"}, ${resolved.match.f}-${resolved.match.l}; ${authorAffiliationLabel(resolved.match)}`;
  summary.append(head, meta);
  els.lookupOutput.appendChild(summary);

  if (!coauthors.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No coauthors found in the selected window.";
    els.lookupOutput.appendChild(empty);
    return;
  }

  coauthors.forEach((item) => {
    const row = document.createElement("div");
    row.className = "lookup-item";
    const name = document.createElement("strong");
    name.textContent = item.author.n;
    const metaLine = document.createElement("div");
    metaLine.className = "lookup-meta";
    metaLine.textContent = `${item.windowArticles.length} shared publication${item.windowArticles.length === 1 ? "" : "s"}; latest ${item.latestYear}; ${authorAffiliationLabel(item.author)}`;
    row.append(name, metaLine, renderArticleLine(item.windowArticles[0]));
    els.lookupOutput.appendChild(row);
  });
}

function selectSuggestedAuthor(item, author) {
  els.lookupInput.value = author.n;
  if (item.side === "lookup") {
    renderLookup();
    return;
  }

  state.resolutions.set(resolutionKey(item.side, item.key), author);
  state.selectedResolution = {
    side: item.side,
    input: item.input,
    key: item.key,
    authorId: author.id,
  };
  renderLookup();
  runConflictCheck();
}

function renderResolutionDecision() {
  if (!state.lastRun || !state.selectedResolution) {
    els.decisionPanel.hidden = true;
    return;
  }

  const selectedSide = state.selectedResolution.side;
  const selectedList =
    selectedSide === "reviewer" ? state.lastRun.reviewers : state.lastRun.submission;
  const oppositeList =
    selectedSide === "reviewer" ? state.lastRun.submission : state.lastRun.reviewers;
  const selectedItem = selectedList.find(
    (item) =>
      item.key === state.selectedResolution.key &&
      item.input === state.selectedResolution.input &&
      item.match?.id === state.selectedResolution.authorId
  );

  if (!selectedItem?.match) {
    els.decisionPanel.hidden = true;
    return;
  }

  const comparedOpposite = oppositeList.filter((item) => item.match);
  const unresolvedOpposite = oppositeList.filter((item) => !item.match);
  const relevantRows = state.lastRun.rows.filter((row) =>
    selectedSide === "reviewer"
      ? row.reviewer.match?.id === selectedItem.match.id
      : row.author.match?.id === selectedItem.match.id
  );
  const conflictRows = relevantRows.filter((row) => row.inWindow);
  const historicalRows = relevantRows.filter((row) => !row.inWindow);

  let mode = "info";
  let badge = "Needs review";
  let title = "Resolve the remaining names";
  let detail = "";
  let evidenceRows = [];

  if (conflictRows.length) {
    mode = "conflict";
    badge = "Conflict";
    title = "Conflict: do not assign";
    detail = `${selectedItem.input} was resolved as ${selectedItem.match.n}. ${selectedItem.match.n} has selected-window UTD coauthorship with ${uniqueCounterpartNames(conflictRows, selectedSide).join(", ")}.`;
    evidenceRows = conflictRows;
  } else if (unresolvedOpposite.length) {
    mode = "needs-review";
    badge = "Needs review";
    title = "Resolve the other side before deciding";
    detail = `${selectedItem.input} was resolved as ${selectedItem.match.n}. No conflict can be finalized until ${unresolvedOpposite.map((item) => item.input).join(", ")} is resolved.`;
    evidenceRows = historicalRows;
  } else if (historicalRows.length) {
    mode = "historical";
    badge = "Historical";
    title = "Historical only in selected window";
    detail = `${selectedItem.input} was resolved as ${selectedItem.match.n}. Shared UTD work exists, but none inside ${windowLabel()}.`;
    evidenceRows = historicalRows;
  } else if (comparedOpposite.length) {
    mode = "clear";
    badge = "Clear";
    title = "Clear in selected window";
    detail = `${selectedItem.input} was resolved as ${selectedItem.match.n}. No selected-window UTD coauthorship was found against ${comparedOpposite.length} resolved ${oppositeRoleLabel(selectedSide)}.`;
  } else {
    detail = `${selectedItem.input} was resolved as ${selectedItem.match.n}. Add a ${oppositeRoleLabel(selectedSide)} to make a conflict decision.`;
  }

  els.decisionPanel.className = `decision-panel ${mode}`;
  els.decisionBadge.className = `badge ${mode === "needs-review" ? "info" : mode}`;
  els.decisionBadge.textContent = badge;
  els.decisionTitle.textContent = title;
  els.decisionDetail.textContent = detail;
  els.decisionEvidence.replaceChildren();

  evidenceRows.slice(0, 4).forEach((row) => {
    if (row.type === "same-person") {
      const same = document.createElement("div");
      same.className = "article-line";
      same.textContent = "Same UTD author selected on both sides.";
      els.decisionEvidence.appendChild(same);
      return;
    }
    row.shownArticles.slice(0, 2).forEach((article) => {
      els.decisionEvidence.appendChild(renderArticleLine(article));
    });
  });

  els.decisionPanel.hidden = false;
}

function authorAffiliationLabel(author) {
  if (author.u) {
    return `Latest UTD affiliation: ${author.u}${author.uy ? ` (${author.uy})` : ""}`;
  }
  if (author.i?.length) {
    return `UTD affiliation: ${author.i[0]}`;
  }
  return "No UTD affiliation listed";
}

function getCoauthors(authorId) {
  if (state.neighborCache.has(authorId)) return state.neighborCache.get(authorId);
  const items = [];
  Object.entries(state.data.pairs).forEach(([key, articleIds]) => {
    const [left, right] = key.split("|").map(Number);
    if (left === authorId) items.push({ authorId: right, articleIds });
    if (right === authorId) items.push({ authorId: left, articleIds });
  });
  state.neighborCache.set(authorId, items);
  return items;
}

function parseNames(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const separator = /[\n;]/.test(trimmed) ? /[\n;]+/ : /[,;\n]+/;
  return Array.from(new Set(trimmed.split(separator).map((item) => item.trim()).filter(Boolean)));
}

function resolveName(input, side = "lookup") {
  const key = normalizeName(input);
  const manualMatch = state.resolutions.get(resolutionKey(side, key)) || null;
  const match = manualMatch || state.authorsByNorm.get(key) || null;
  return {
    input,
    key,
    side,
    match,
    manual: Boolean(manualMatch),
    suggestions: match ? [] : searchAuthors(key, 6),
  };
}

function resolutionKey(side, key) {
  return `${side}:${key}`;
}

function roleLabel(side) {
  if (side === "submission") return "submission author";
  if (side === "reviewer") return "candidate reviewer";
  return "author";
}

function oppositeRoleLabel(side) {
  return side === "reviewer" ? "submission author" : "candidate reviewer";
}

function uniqueCounterpartNames(rows, selectedSide) {
  const names = rows.map((row) =>
    selectedSide === "reviewer" ? row.author.match?.n : row.reviewer.match?.n
  );
  return Array.from(new Set(names.filter(Boolean)));
}

function windowLabel() {
  const minYear = selectedMinYear();
  if (!minYear) return "all UTD years";
  return `${minYear}-${state.data.meta.maxYear}`;
}

function searchAuthors(key, limit) {
  if (!key) return [];
  const tokens = key.split(" ").filter(Boolean);
  const compactKey = compactName(key);
  const scored = [];
  state.data.authors.forEach((author) => {
    let score = 0;
    const authorCompact = compactName(author.k);
    if (author.k === key) score += 10000;
    if (authorCompact === compactKey) score += 9800;
    if (author.k.startsWith(key)) score += 900;
    if (authorCompact.startsWith(compactKey)) score += 760;
    if (author.k.includes(key)) score += 520;
    if (authorCompact.includes(compactKey)) score += 420;
    let matchedTokens = 0;
    tokens.forEach((token) => {
      if (author.k.includes(token)) matchedTokens += 1;
      if (author.k.split(" ").some((part) => part.startsWith(token))) score += 35;
    });
    if (matchedTokens === tokens.length) score += 260 + matchedTokens * 25;
    if (matchedTokens && matchedTokens < tokens.length) score += matchedTokens * 30;
    if (score > 0) scored.push({ author, score: score + Math.log10(author.c + 1) * 16 });
  });
  return scored
    .sort((left, right) => right.score - left.score || right.author.l - left.author.l || right.author.c - left.author.c)
    .slice(0, limit)
    .map((item) => item.author);
}

function compactName(value) {
  return value.replace(/\s+/g, "");
}

function selectedMinYear() {
  const value = els.windowSelect.value;
  if (value === "all" || !state.data) return null;
  return state.data.meta.maxYear - Number(value) + 1;
}

function pairKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function normalizeName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sortRows(left, right) {
  if (left.inWindow !== right.inWindow) return left.inWindow ? -1 : 1;
  return (right.latestYear || 9999) - (left.latestYear || 9999);
}

function clearInputs() {
  els.submissionAuthors.value = "";
  els.candidateReviewers.value = "";
  els.lookupInput.value = "";
  state.lastRun = null;
  state.selectedResolution = null;
  state.resolutions.clear();
  els.metricConflicts.textContent = "0";
  els.metricClear.textContent = "0";
  els.metricUnresolved.textContent = "0";
  els.downloadCsv.disabled = true;
  els.decisionPanel.hidden = true;
  els.resultsList.replaceChildren();
  els.resultsList.hidden = true;
  els.resultsEmpty.hidden = false;
  els.resultsEmpty.textContent = "Enter authors and candidate reviewers, then run a conflict check.";
  renderLookup();
}

function downloadCsv() {
  if (!state.lastRun) return;
  const rows = [
    ["reviewer_input", "reviewer_match", "submission_author_input", "submission_author_match", "status", "shared_publications", "latest_year", "example_publication"],
  ];
  state.lastRun.rows.forEach((row) => {
    rows.push([
      row.reviewer.input,
      row.reviewer.match?.n || "",
      row.author.input,
      row.author.match?.n || "",
      row.status,
      String(row.windowCount || row.allCount),
      row.latestYear ? String(row.latestYear) : "",
      row.shownArticles[0] ? `${row.shownArticles[0].t} (${row.shownArticles[0].y}, ${row.shownArticles[0].j})` : "",
    ]);
  });
  state.lastRun.unresolved.forEach((item) => {
    rows.push([item.input, "", "", "", "Unresolved", "", "", ""]);
  });

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "coauthor-conflict-results.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function format(value) {
  return numberFormatter.format(value || 0);
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

/* ---------- Coauthor network visualization ---------- */

const network = {
  overlay: null,
  svg: null,
  animationId: null,
  sim: null,
};

const NETWORK_MAX_COAUTHORS = 40;

function openNetworkPanel(focalId) {
  if (!state.data) return;
  const graph = buildNetworkGraph(focalId, selectedMinYear());
  ensureNetworkOverlay();
  const focal = state.authorById.get(focalId);
  network.titleEl.textContent = focal ? focal.n : "Coauthor network";
  network.subtitleEl.textContent =
    `${graph.nodes.length - 1} coauthor${graph.nodes.length - 1 === 1 ? "" : "s"} | ${windowLabel()} | line thickness = shared publications`;
  network.overlay.hidden = false;
  document.body.style.overflow = "hidden";
  runNetworkSimulation(graph, focalId);
}

function closeNetworkPanel() {
  if (network.animationId) cancelAnimationFrame(network.animationId);
  network.animationId = null;
  if (network.overlay) network.overlay.hidden = true;
  document.body.style.overflow = "";
}

function buildNetworkGraph(focalId, minYear) {
  const inWindow = (id) => {
    const article = state.articlesById.get(id);
    return article && (!minYear || article.y >= minYear);
  };

  const coauthors = getCoauthors(focalId)
    .map((item) => ({
      authorId: item.authorId,
      count: item.articleIds.filter(inWindow).length,
    }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, NETWORK_MAX_COAUTHORS);

  const idSet = new Set([focalId, ...coauthors.map((c) => c.authorId)]);
  const ids = Array.from(idSet);
  const countById = new Map(coauthors.map((c) => [c.authorId, c.count]));

  const nodes = ids.map((id) => {
    const author = state.authorById.get(id);
    return {
      id,
      name: author ? author.n : String(id),
      focal: id === focalId,
      weight: id === focalId ? 0 : countById.get(id) || 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const articleIds = state.data.pairs[pairKey(ids[i], ids[j])];
      if (!articleIds) continue;
      const weight = articleIds.filter(inWindow).length;
      if (weight > 0) {
        edges.push({ source: nodeById.get(ids[i]), target: nodeById.get(ids[j]), weight });
      }
    }
  }
  return { nodes, edges };
}

function ensureNetworkOverlay() {
  if (network.overlay) return;
  const overlay = document.createElement("div");
  overlay.className = "network-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "network-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Coauthor network");

  const header = document.createElement("div");
  header.className = "network-header";
  const titles = document.createElement("div");
  const title = document.createElement("strong");
  title.className = "network-title";
  const subtitle = document.createElement("span");
  subtitle.className = "network-subtitle";
  titles.append(title, subtitle);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "network-close";
  closeBtn.setAttribute("aria-label", "Close network view");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeNetworkPanel);
  header.append(titles, closeBtn);

  const canvas = document.createElement("div");
  canvas.className = "network-canvas";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "network-svg");
  canvas.appendChild(svg);

  dialog.append(header, canvas);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeNetworkPanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) closeNetworkPanel();
  });

  network.overlay = overlay;
  network.dialog = dialog;
  network.svg = svg;
  network.canvas = canvas;
  network.titleEl = title;
  network.subtitleEl = subtitle;
}

function runNetworkSimulation(graph, focalId) {
  if (network.animationId) cancelAnimationFrame(network.animationId);
  const svg = network.svg;
  svg.replaceChildren();

  const rect = network.canvas.getBoundingClientRect();
  const width = Math.max(rect.width || 720, 320);
  const height = Math.max(rect.height || 520, 320);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const cx = width / 2;
  const cy = height / 2;
  const maxWeight = graph.edges.reduce((max, edge) => Math.max(max, edge.weight), 1);
  const maxNodeWeight = graph.nodes.reduce((max, node) => Math.max(max, node.weight), 1);

  // Seed positions: focal at center, others on a ring.
  const ring = graph.nodes.filter((node) => !node.focal);
  ring.forEach((node, index) => {
    const angle = (index / Math.max(ring.length, 1)) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.34;
    node.x = cx + Math.cos(angle) * radius;
    node.y = cy + Math.sin(angle) * radius;
  });
  graph.nodes.forEach((node) => {
    if (node.focal) {
      node.x = cx;
      node.y = cy;
    }
  });

  const radiusFor = (node) =>
    node.focal ? 13 : 6 + (node.weight / maxNodeWeight) * 9;

  // Build SVG elements.
  const edgeEls = graph.edges.map((edge) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const thickness = 1 + (edge.weight / maxWeight) * 6;
    line.setAttribute("stroke-width", thickness.toFixed(2));
    line.setAttribute("class", edge.weight > 1 ? "network-edge strong" : "network-edge");
    const sharedTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    sharedTitle.textContent = `${edge.source.name} - ${edge.target.name}: ${edge.weight} shared publication${edge.weight === 1 ? "" : "s"}`;
    line.appendChild(sharedTitle);
    svg.appendChild(line);
    return { edge, line };
  });

  const nodeEls = graph.nodes.map((node) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", node.focal ? "network-node focal" : "network-node");
    g.style.cursor = "pointer";
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", radiusFor(node).toFixed(2));
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "network-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = node.name;
    const nodeTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    nodeTitle.textContent = node.focal
      ? node.name
      : `${node.name}: ${node.weight} shared publication${node.weight === 1 ? "" : "s"}`;
    g.append(circle, label, nodeTitle);
    svg.appendChild(g);

    if (!node.focal) {
      g.addEventListener("click", (event) => {
        if (g.dataset.dragged === "1") {
          g.dataset.dragged = "0";
          return;
        }
        event.stopPropagation();
        openNetworkPanel(node.id);
      });
    }
    enableNodeDrag(g, node, svg, width, height);
    return { node, g, circle, label, radius: radiusFor(node) };
  });

  // Label-aware collision radius so circles AND their name labels keep clear
  // of each other. Measured once from the rendered text width.
  nodeEls.forEach((entry) => {
    let halfWidth;
    try {
      halfWidth = entry.label.getComputedTextLength() / 2;
    } catch (error) {
      halfWidth = entry.node.name.length * 3.2;
    }
    if (!halfWidth || !isFinite(halfWidth)) halfWidth = entry.node.name.length * 3.2;
    const collide = Math.max(entry.radius + 10, Math.min(halfWidth * 0.78, 58));
    entry.collide = collide;
    entry.node.collide = collide;
  });

  // Degree drives link length: well-connected hubs sit a little closer.
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  graph.edges.forEach((edge) => {
    degree.set(edge.source.id, degree.get(edge.source.id) + 1);
    degree.set(edge.target.id, degree.get(edge.target.id) + 1);
  });

  const nodes = graph.nodes;
  const n = nodes.length;
  let alpha = 1;
  let fitted = false;
  const baseLink = Math.max(54, Math.min(width, height) * 0.22);
  const charge = 120;

  function render() {
    edgeEls.forEach(({ edge, line }) => {
      line.setAttribute("x1", edge.source.x.toFixed(1));
      line.setAttribute("y1", edge.source.y.toFixed(1));
      line.setAttribute("x2", edge.target.x.toFixed(1));
      line.setAttribute("y2", edge.target.y.toFixed(1));
    });
    nodeEls.forEach(({ node, g, label, radius }) => {
      g.setAttribute("transform", `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
      label.setAttribute("y", (radius + 12).toFixed(1));
    });
  }

  // Rescale + recenter the settled layout so it comfortably fills the canvas.
  function fitToView() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((node) => {
      minX = Math.min(minX, node.x - node.collide);
      maxX = Math.max(maxX, node.x + node.collide);
      minY = Math.min(minY, node.y - node.collide);
      maxY = Math.max(maxY, node.y + node.collide);
    });
    const margin = 36;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    let scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
    scale = Math.max(0.55, Math.min(scale, 1.25));
    const boxCx = (minX + maxX) / 2;
    const boxCy = (minY + maxY) / 2;
    nodes.forEach((node) => {
      node.x = cx + (node.x - boxCx) * scale;
      node.y = cy + (node.y - boxCy) * scale;
    });
  }

  function tick() {
    alpha *= 0.99;

    // Many-body repulsion (O(n^2), n <= ~41), scaled by node sizes.
    for (let i = 0; i < n; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          dx = (Math.random() - 0.5) * 0.5;
          dy = (Math.random() - 0.5) * 0.5;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        const force = (charge * (a.collide + b.collide) * alpha) / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Springs along edges; heavier collaborations sit closer.
    graph.edges.forEach((edge) => {
      const a = edge.source;
      const b = edge.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const desired = baseLink / Math.sqrt(edge.weight);
      const force = (dist - desired) * 0.045 * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    });

    // Gentle centering + focal pin, then integrate.
    nodes.forEach((node) => {
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
        return;
      }
      node.vx += (cx - node.x) * 0.01 * alpha;
      node.vy += (cy - node.y) * 0.01 * alpha;
      if (node.focal) {
        node.vx += (cx - node.x) * 0.2;
        node.vy += (cy - node.y) * 0.2;
      }
      node.vx *= 0.85;
      node.vy *= 0.85;
      node.x += node.vx;
      node.y += node.vy;
    });

    // Hard collision resolution so nodes/labels never sit on top of each other.
    for (let iter = 0; iter < 3; iter += 1) {
      for (let i = 0; i < n; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j += 1) {
          const b = nodes[j];
          const minDist = a.collide + b.collide;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          }
          if (dist < minDist) {
            const push = (minDist - dist) / dist;
            const ux = dx * push;
            const uy = dy * push;
            const aMove = a.fixed || a.focal ? 0 : b.fixed || b.focal ? 1 : 0.5;
            const bMove = b.fixed || b.focal ? 0 : a.fixed || a.focal ? 1 : 0.5;
            a.x -= ux * aMove;
            a.y -= uy * aMove;
            b.x += ux * bMove;
            b.y += uy * bMove;
          }
        }
      }
    }

    // Keep everyone inside the canvas.
    nodes.forEach((node) => {
      node.x = Math.max(node.collide, Math.min(width - node.collide, node.x));
      node.y = Math.max(node.collide, Math.min(height - node.collide, node.y));
    });

    render();

    if (alpha > 0.02) {
      network.animationId = requestAnimationFrame(tick);
    } else if (!fitted) {
      fitted = true;
      fitToView();
      render();
      network.animationId = null;
    } else {
      network.animationId = null;
    }
  }

  tick();
}

function enableNodeDrag(g, node, svg, width, height) {
  let dragging = false;
  let moved = false;

  const toLocal = (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const onMove = (event) => {
    if (!dragging) return;
    moved = true;
    g.dataset.dragged = "1";
    const point = toLocal(event);
    node.x = Math.max(24, Math.min(width - 24, point.x));
    node.y = Math.max(20, Math.min(height - 20, point.y));
    node.vx = 0;
    node.vy = 0;
  };

  const onUp = () => {
    dragging = false;
    node.fixed = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  g.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    moved = false;
    node.fixed = true;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}
