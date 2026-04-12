const vscode = acquireVsCodeApi();
const ALL_MODELS = window.__FR_CONFIG.models;
const DEFAULT_MODELS = window.__FR_CONFIG.defaults;
const TIMEOUT_SEC = window.__FR_CONFIG.timeoutSec;
const MODEL_TIMEOUTS = window.__FR_CONFIG.modelTimeouts;
const API_MODELS = new Set(window.__FR_CONFIG.apiModels);
const CLI_ICON = window.__FR_CONFIG.cliIconUri;
const API_ICON = window.__FR_CONFIG.apiIconUri;
const DIFF_SIZE_THRESHOLD = window.__FR_CONFIG.diffSizeThreshold;
const MODEL_STATS = window.__FR_CONFIG.modelStats;

let prs = [];
let currentReview = null;
let prLoadTimer = null;
var chunkBuffers = {};
var reviewHistory = [];
var isViewingHistory = false;

// ─── Tab switching ───
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["review", "grade", "scores"].forEach((t) => {
      document.getElementById("tab-" + t).classList.toggle("hidden", t !== btn.dataset.tab);
    });
    if (btn.dataset.tab === "scores") {
      vscode.postMessage({ type: "requestLeaderboard", timeframe: "all" });
    }
    if (btn.dataset.tab === "grade") {
      renderGradeForm();
    }
  };
});

// ─── Review tab ───
function init() {
  buildModelCheckboxes();
  requestPRs();
  vscode.postMessage({ type: "checkModelHealth" });
  vscode.postMessage({ type: "requestReviewHistory" });

  document.getElementById("btn-start").onclick = startReview;
  document.getElementById("btn-refresh").onclick = requestPRs;
  document.getElementById("btn-cancel").onclick = () => vscode.postMessage({ type: "cancelReview" });
  document.getElementById("btn-new-review").onclick = resetToSelect;
  document.getElementById("btn-compare").onclick = function () {
    var panel = document.getElementById("compare-panel");
    if (panel.classList.contains("hidden")) {
      if (currentReview) buildComparison(currentReview);
      panel.classList.remove("hidden");
      document.getElementById("btn-compare").textContent = "Hide Comparison";
    } else {
      panel.classList.add("hidden");
      document.getElementById("btn-compare").textContent = "Compare Models";
    }
  };
  document.getElementById("btn-submit-grades").onclick = submitGrades;
  document.getElementById("btn-grade-claude").onclick = () => vscode.postMessage({ type: "gradeWithClaude" });
  document.getElementById("btn-copy-grade-prompt").onclick = function () {
    var text = document.getElementById("grade-prompt-text").textContent || "";
    navigator.clipboard
      .writeText(text)
      .then(function () {
        document.getElementById("btn-copy-grade-prompt").textContent = "Copied!";
        setTimeout(function () {
          document.getElementById("btn-copy-grade-prompt").textContent = "Copy";
        }, 1500);
      })
      .catch(function () {
        document.getElementById("btn-copy-grade-prompt").textContent = "Failed";
        setTimeout(function () {
          document.getElementById("btn-copy-grade-prompt").textContent = "Copy";
        }, 1500);
      });
  };
}

function clearPrLoadTimer() {
  if (prLoadTimer !== null) {
    clearTimeout(prLoadTimer);
    prLoadTimer = null;
  }
}

function showPrError(message, optionLabel) {
  clearPrLoadTimer();
  var skel = document.getElementById("pr-skeleton");
  if (skel) skel.classList.add("hidden");
  const sel = document.getElementById("pr-select");
  sel.classList.remove("hidden");
  sel.disabled = false;
  sel.innerHTML = "<option disabled>" + optionLabel + "</option>";
  document.getElementById("btn-start").disabled = true;
  document.getElementById("pr-error").textContent = message;
  document.getElementById("pr-error").classList.remove("hidden");
}

function requestPRs() {
  clearPrLoadTimer();
  var skel = document.getElementById("pr-skeleton");
  var sel = document.getElementById("pr-select");
  if (skel) skel.classList.remove("hidden");
  sel.classList.add("hidden");
  sel.disabled = true;
  sel.innerHTML = "<option>Loading PRs...</option>";
  document.getElementById("btn-start").disabled = true;
  document.getElementById("pr-error").classList.add("hidden");

  prLoadTimer = setTimeout(() => {
    showPrError("Timed out while loading PRs. Check Output > Fleet Review for gh logs.", "PR load timed out");
  }, 10000);

  vscode.postMessage({ type: "requestPRs" });
}

function modelGlyphHtml(m) {
  var isApi = API_MODELS.has(m);
  var src = isApi ? API_ICON : CLI_ICON;
  var title = isApi ? "API" : "CLI";
  var escapedSrc = escapeHtml(src);
  return (
    '<span class="model-glyph" title="' +
    title +
    '" style="-webkit-mask-image:url(' +
    escapedSrc +
    ");mask-image:url(" +
    escapedSrc +
    ');"></span> '
  );
}

function buildModelCheckboxes() {
  document.getElementById("model-checkboxes").innerHTML = ALL_MODELS.map(
    (m) =>
      '<label><input type="checkbox" value="' +
      m +
      '"' +
      (DEFAULT_MODELS.includes(m) ? " checked" : "") +
      "> " +
      '<span class="health-dot" data-model="' +
      m +
      '" title="checking..."></span> ' +
      modelGlyphHtml(m) +
      m +
      '<span class="suggested-badge" data-model="' +
      m +
      '">Suggested</span></label>',
  ).join("");
  applySuggestedBadges();
}

function applySuggestedBadges() {
  if (!MODEL_STATS || !MODEL_STATS.length) return;
  var suggested = MODEL_STATS.filter(function (s) {
    return s.totalReviews >= 3 && s.avgScore >= 7;
  })
    .slice(0, 3)
    .map(function (s) {
      return s.model;
    });
  suggested.forEach(function (m) {
    var badge = document.querySelector('.suggested-badge[data-model="' + m + '"]');
    if (badge) badge.classList.add("visible");
  });
}

function getSelectedModels() {
  return Array.from(document.querySelectorAll("#model-checkboxes input:checked")).map((cb) => cb.value);
}

function showState(name) {
  ["select", "progress", "results"].forEach((s) =>
    document.getElementById("state-" + s).classList.toggle("hidden", s !== name),
  );
}

function resetToSelect() {
  showState("select");
}

function startReview() {
  const models = getSelectedModels();
  const prNumber = parseInt(document.getElementById("pr-select").value, 10);
  if (!models.length || isNaN(prNumber)) return;

  showState("progress");
  isViewingHistory = false;
  chunkBuffers = {};
  document.getElementById("progress-models").innerHTML = models
    .map(
      (m) =>
        '<div class="model-row entrance" id="progress-' +
        m +
        '">' +
        '<span class="progress-ring" id="ring-' +
        m +
        '"></span>' +
        '<span class="name">' +
        modelGlyphHtml(m) +
        m +
        "</span>" +
        '<span class="elapsed-time"></span>' +
        '<span class="elapsed-bytes"></span>' +
        '<span class="badge pending">pending</span>' +
        '<pre class="chunk-preview" id="chunks-' +
        m +
        '"></pre>' +
        "</div>",
    )
    .join("");

  startElapsedTimer();
  vscode.postMessage({ type: "startReview", models, prNumber });
}

function renderPRs() {
  clearPrLoadTimer();
  var skel = document.getElementById("pr-skeleton");
  if (skel) skel.classList.add("hidden");
  const sel = document.getElementById("pr-select");
  sel.classList.remove("hidden");
  sel.disabled = false;
  document.getElementById("btn-start").disabled = false;
  document.getElementById("pr-error").classList.add("hidden");

  if (prs.length === 0) {
    sel.innerHTML = "<option disabled>No open PRs in this repo</option>";
    document.getElementById("btn-start").disabled = true;
    return;
  }
  sel.innerHTML = prs
    .map(
      (pr) =>
        '<option value="' +
        pr.number +
        '">#' +
        pr.number +
        " " +
        escapeHtml(pr.title) +
        " (+" +
        pr.additions +
        "/-" +
        pr.deletions +
        ")</option>",
    )
    .join("");
  sel.onchange = checkDiffSize;
  checkDiffSize();
}

function checkDiffSize() {
  var sel = document.getElementById("pr-select");
  var warn = document.getElementById("diff-size-warning");
  var prNum = parseInt(sel.value, 10);
  var pr = prs.find(function (p) {
    return p.number === prNum;
  });
  if (pr) {
    var total = pr.additions + pr.deletions;
    if (total > DIFF_SIZE_THRESHOLD) {
      warn.textContent = "This PR has " + total + " changed lines. Reviews may be slower or truncated.";
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
    }
  } else {
    warn.classList.add("hidden");
  }
}

var modelStartTimes = {};
var elapsedTimerId = null;

function fmtElapsed(ms) {
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimerId = setInterval(tickElapsed, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimerId) {
    clearInterval(elapsedTimerId);
    elapsedTimerId = null;
  }
}

function tickElapsed() {
  var now = Date.now();
  var anyRunning = false;
  Object.keys(modelStartTimes).forEach(function (model) {
    var info = modelStartTimes[model];
    if (!info.ended) {
      anyRunning = true;
      var row = document.getElementById("progress-" + model);
      var el = row ? row.querySelector(".elapsed-time") : null;
      if (el) el.textContent = fmtElapsed(now - info.start);

      // Update progress ring
      var ring = document.getElementById("ring-" + model);
      if (ring) {
        var timeout = (MODEL_TIMEOUTS[model] ?? TIMEOUT_SEC) * 1000;
        if (info.extended) {
          // Extended run — dark red overlays from top, bright red (first lap) shows through remainder
          var extElapsed = now - (info.extendedAt || info.start);
          var extPct = Math.min(extElapsed / timeout, 1);
          var extDeg = Math.round(extPct * 360);
          ring.style.background =
            "conic-gradient(#8b0000 0deg, #8b0000 " +
            extDeg +
            "deg, var(--vscode-testing-iconFailed) " +
            extDeg +
            "deg)";
        } else {
          var elapsed = now - info.start;
          var pct = Math.min(elapsed / timeout, 1);
          var deg = Math.round(pct * 360);
          var color =
            pct < 0.7
              ? "var(--vscode-testing-iconPassed)"
              : pct < 0.9
                ? "var(--vscode-editorWarning-foreground)"
                : "var(--vscode-testing-iconFailed)";
          ring.style.background =
            "conic-gradient(" + color + " 0deg, " + color + " " + deg + "deg, transparent " + deg + "deg)";
        }
      }
    }
  });
  if (!anyRunning) stopElapsedTimer();
}

function updateProgress(model, status) {
  var row = document.getElementById("progress-" + model);
  if (!row) return;
  var badge = row.querySelector(".badge");
  badge.className = "badge " + status;

  var labels = {
    pending: "pending",
    running: "running",
    done: "done",
    failed: "failed",
    timeout: "timed out",
    "timeout-pending": "timed out",
  };
  badge.textContent = labels[status] || status;

  // Remove any existing timeout action buttons
  var existing = row.querySelector(".timeout-actions");
  if (existing) existing.remove();

  if (status === "timeout-pending") {
    var actions = document.createElement("div");
    actions.className = "timeout-actions";
    var extBtn = document.createElement("button");
    extBtn.className = "extend-btn";
    var modelTimeout = MODEL_TIMEOUTS[model] ?? TIMEOUT_SEC;
    extBtn.textContent = "Extend " + modelTimeout + "s";
    extBtn.onclick = function () {
      vscode.postMessage({ type: "extendTimeout", model: model });
    };
    var killBtn = document.createElement("button");
    killBtn.className = "kill-btn";
    killBtn.textContent = "Kill";
    killBtn.onclick = function () {
      vscode.postMessage({ type: "killModel", model: model });
    };
    actions.appendChild(extBtn);
    actions.appendChild(killBtn);
    row.appendChild(actions);
  }

  // Show/hide progress ring
  var ring = document.getElementById("ring-" + model);
  if (ring) {
    if (status === "running" || status === "timeout-pending") {
      ring.classList.add("active");
    } else {
      ring.classList.remove("active", "extended");
    }
  }

  if (status === "running" && !modelStartTimes[model]) {
    modelStartTimes[model] = { start: Date.now(), ended: false, extended: false };
  }
  if (status === "running" && modelStartTimes[model] && modelStartTimes[model].ended) {
    // Resumed after extend — mark as extended and reset ring
    modelStartTimes[model].ended = false;
    modelStartTimes[model].extended = true;
    modelStartTimes[model].extendedAt = Date.now();
    var extRing = document.getElementById("ring-" + model);
    if (extRing) extRing.classList.add("extended");
    if (!elapsedTimerId) startElapsedTimer();
  }
  if (status === "done" || status === "failed" || status === "timeout") {
    if (modelStartTimes[model]) modelStartTimes[model].ended = true;
  }
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  return (b / 1024).toFixed(1) + " KB";
}

function updateBytes(model, bytes) {
  var bRow = document.getElementById("progress-" + model);
  var el = bRow ? bRow.querySelector(".elapsed-bytes") : null;
  if (!el || !modelStartTimes[model] || modelStartTimes[model].ended) return;
  el.textContent = "· " + fmtBytes(bytes);
}

function renderSummaryCard(review) {
  var models = Object.keys(review.results);
  var ok = models.filter(function (m) {
    return review.results[m].success;
  });
  var fail = models.filter(function (m) {
    return !review.results[m].success;
  });
  var durations = models.map(function (m) {
    return review.results[m].durationMs;
  });
  var avgDur = durations.length
    ? durations.reduce(function (a, b) {
        return a + b;
      }, 0) /
      durations.length /
      1000
    : 0;
  var fastest = durations.length ? Math.min.apply(null, durations) / 1000 : 0;
  var slowest = durations.length ? Math.max.apply(null, durations) / 1000 : 0;
  var posted = models.filter(function (m) {
    return review.results[m].postedToGitHub;
  }).length;
  var totalKB =
    models.reduce(function (sum, m) {
      return sum + review.results[m].output.length;
    }, 0) / 1024;

  var statusDetail = ok.length + "/" + models.length + " done";
  if (fail.length) statusDetail += ", " + fail.length + " failed";

  // Aggregate token usage from API models
  var totalPromptTokens = 0;
  var totalCompletionTokens = 0;
  models.forEach(function (m) {
    var tu = review.results[m].tokenUsage;
    if (tu) {
      totalPromptTokens += tu.prompt;
      totalCompletionTokens += tu.completion;
    }
  });
  var hasTokens = totalPromptTokens > 0 || totalCompletionTokens > 0;
  var totalTokens = totalPromptTokens + totalCompletionTokens;

  return (
    '<div class="summary-card">' +
    '<div class="summary-stat"><div class="summary-label">Status</div>' +
    '<div class="summary-value">' +
    ok.length +
    "/" +
    models.length +
    "</div>" +
    '<div class="summary-detail">' +
    (fail.length ? fail.join(", ") + " failed" : "all passed") +
    "</div></div>" +
    '<div class="summary-stat"><div class="summary-label">Duration</div>' +
    '<div class="summary-value">' +
    avgDur.toFixed(1) +
    "s</div>" +
    '<div class="summary-detail">' +
    fastest.toFixed(0) +
    "s – " +
    slowest.toFixed(0) +
    "s</div></div>" +
    '<div class="summary-stat"><div class="summary-label">GitHub</div>' +
    '<div class="summary-value">' +
    posted +
    "</div>" +
    '<div class="summary-detail">comment' +
    (posted !== 1 ? "s" : "") +
    " posted</div></div>" +
    '<div class="summary-stat"><div class="summary-label">Output</div>' +
    '<div class="summary-value">' +
    totalKB.toFixed(1) +
    "</div>" +
    '<div class="summary-detail">KB total</div></div>' +
    (hasTokens
      ? '<div class="summary-stat"><div class="summary-label">Tokens</div>' +
        '<div class="summary-value">' +
        (totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + "K" : totalTokens) +
        "</div>" +
        '<div class="summary-detail">' +
        totalPromptTokens +
        " in / " +
        totalCompletionTokens +
        " out</div></div>"
      : "") +
    "</div>"
  );
}

function renderResults(review) {
  showState("results");
  const models = Object.keys(review.results);

  document.getElementById("results-summary").innerHTML = renderSummaryCard(review);

  var detailEl = document.getElementById("results-detail");
  detailEl.innerHTML = "";
  var hasFailed = false;

  models.forEach(function (m) {
    var r = review.results[m];
    var block = document.createElement("div");
    block.className = "result-block";
    var details = document.createElement("details");
    if (r.success) details.open = true;
    var summary = document.createElement("summary");
    summary.innerHTML =
      modelGlyphHtml(m) + m + (r.success ? " ✓" : " ✗") + " — " + (r.durationMs / 1000).toFixed(1) + "s";
    details.appendChild(summary);

    if (r.success) {
      var outputKB = (r.output.length / 1024).toFixed(1);
      var innerDetails = document.createElement("details");
      innerDetails.open = true;
      var innerSummary = document.createElement("summary");
      innerSummary.textContent = "Output (" + outputKB + " KB)";
      innerSummary.style.cssText = "font-size:11px;color:var(--desc-fg);cursor:pointer;padding:4px 0;";
      innerDetails.appendChild(innerSummary);
      var wrapper = document.createElement("div");
      wrapper.className = "result-output-wrapper";
      var pre = document.createElement("pre");
      pre.textContent = r.output;
      var copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.onclick = function () {
        navigator.clipboard
          .writeText(r.output)
          .then(function () {
            copyBtn.textContent = "Copied!";
            setTimeout(function () {
              copyBtn.textContent = "Copy";
            }, 1500);
          })
          .catch(function () {
            copyBtn.textContent = "Failed";
            setTimeout(function () {
              copyBtn.textContent = "Copy";
            }, 1500);
          });
      };
      wrapper.appendChild(pre);
      wrapper.appendChild(copyBtn);
      innerDetails.appendChild(wrapper);
      details.appendChild(innerDetails);
    } else {
      hasFailed = true;
      var errP = document.createElement("p");
      errP.className = "error";
      errP.textContent = r.error || "Error";
      details.appendChild(errP);
      var retryBtn = document.createElement("button");
      retryBtn.className = "secondary";
      retryBtn.textContent = "Retry " + m;
      retryBtn.style.marginTop = "8px";
      if (isViewingHistory) {
        retryBtn.disabled = true;
        retryBtn.title = "Cannot retry from history — start a new review";
      } else {
        retryBtn.onclick = function () {
          vscode.postMessage({ type: "retryModel", model: m });
        };
      }
      details.appendChild(retryBtn);
    }

    block.appendChild(details);
    detailEl.appendChild(block);
  });

  if (hasFailed) {
    var retryAllBtn = document.createElement("button");
    retryAllBtn.className = "secondary";
    retryAllBtn.textContent = "Retry All Failed";
    retryAllBtn.style.marginTop = "4px";
    if (isViewingHistory) {
      retryAllBtn.disabled = true;
      retryAllBtn.title = "Cannot retry from history — start a new review";
    } else {
      retryAllBtn.onclick = function () {
        vscode.postMessage({ type: "retryAllFailed" });
      };
    }
    detailEl.appendChild(retryAllBtn);
  }
}

// ─── Comparison view ───
function parseFindings(output) {
  var findings = [];
  // Match the audit output format: #### [N]. [Title] — Severity: ...
  var blocks = output.split(/(?=####\s*\[?\d+\]?\.?)/);
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i].trim();
    if (!block) continue;
    var titleMatch = block.match(/####\s*\[?(\d+)\]?\.?\s*(.+?)(?:\s*—|$)/m);
    var fileMatch = block.match(/\*\*File:\*\*\s*`([^`]+)`\s*L?(\d+)?/);
    if (titleMatch) {
      findings.push({
        id: (titleMatch[1] || i).toString(),
        title: titleMatch[2] ? titleMatch[2].trim() : "Finding " + i,
        file: fileMatch ? fileMatch[1] : "",
        line: fileMatch && fileMatch[2] ? parseInt(fileMatch[2]) : 0,
        raw: block,
      });
    }
  }
  return findings;
}

function buildComparison(review) {
  var panel = document.getElementById("compare-panel");
  if (!panel) return;
  panel.innerHTML = "";

  var models = Object.keys(review.results).filter(function (m) {
    return review.results[m].success;
  });
  if (models.length < 2) {
    panel.innerHTML = '<p class="empty-state">Need 2+ successful models to compare.</p>';
    return;
  }

  // Parse findings per model
  var modelFindings = {};
  models.forEach(function (m) {
    modelFindings[m] = parseFindings(review.results[m].output);
  });

  // Match findings across models by file+line proximity
  var allFindings = [];
  models.forEach(function (m) {
    modelFindings[m].forEach(function (f) {
      allFindings.push({ model: m, finding: f });
    });
  });

  // Group by file reference (findings about the same file within 5 lines)
  var groups = [];
  var used = new Set();
  for (var i = 0; i < allFindings.length; i++) {
    if (used.has(i)) continue;
    var group = [allFindings[i]];
    used.add(i);
    if (allFindings[i].finding.file) {
      for (var j = i + 1; j < allFindings.length; j++) {
        if (used.has(j)) continue;
        if (
          allFindings[j].finding.file === allFindings[i].finding.file &&
          allFindings[j].model !== allFindings[i].model &&
          Math.abs(allFindings[j].finding.line - allFindings[i].finding.line) <= 5
        ) {
          group.push(allFindings[j]);
          used.add(j);
        }
      }
    }
    groups.push(group);
  }

  // Build consensus summary
  var consensus = groups.filter(function (g) {
    return g.length >= 2;
  });
  var unique = groups.filter(function (g) {
    return g.length === 1;
  });

  var summaryDiv = document.createElement("div");
  summaryDiv.className = "consensus-summary";

  if (consensus.length > 0) {
    var h3c = document.createElement("h3");
    h3c.innerHTML = '<span class="finding-tag consensus">' + consensus.length + "</span> Consensus Issues";
    summaryDiv.appendChild(h3c);
    consensus.forEach(function (g) {
      var item = document.createElement("div");
      item.className = "consensus-item";
      var modelsInGroup = g
        .map(function (e) {
          return e.model;
        })
        .join(", ");
      item.textContent = g[0].finding.title + " (" + modelsInGroup + ")";
      if (g[0].finding.file) item.textContent += " — " + g[0].finding.file;
      summaryDiv.appendChild(item);
    });
  }

  if (unique.length > 0) {
    var h3u = document.createElement("h3");
    h3u.innerHTML = '<span class="finding-tag unique">' + unique.length + "</span> Unique Findings";
    summaryDiv.appendChild(h3u);
    unique.forEach(function (g) {
      var item = document.createElement("div");
      item.className = "unique-item";
      item.textContent = g[0].finding.title + " (only " + g[0].model + ")";
      if (g[0].finding.file) item.textContent += " — " + g[0].finding.file;
      summaryDiv.appendChild(item);
    });
  }

  panel.appendChild(summaryDiv);

  // Tabbed model outputs
  var tabBar = document.createElement("div");
  tabBar.className = "compare-tabs";
  var contentDiv = document.createElement("div");
  contentDiv.className = "compare-content";

  models.forEach(function (m, idx) {
    var tab = document.createElement("button");
    tab.textContent = m;
    var stat = MODEL_STATS.find(function (s) {
      return s.model === m;
    });
    if (stat) {
      var avg = stat.avgScore.toFixed(1);
      tab.textContent = m + " (" + avg + ")";
    }
    if (idx === 0) tab.classList.add("active");
    tab.onclick = function () {
      tabBar.querySelectorAll("button").forEach(function (b) {
        b.classList.remove("active");
      });
      tab.classList.add("active");
      contentDiv.querySelectorAll("pre").forEach(function (p) {
        p.classList.add("hidden");
      });
      document.getElementById("compare-output-" + m).classList.remove("hidden");
    };
    tabBar.appendChild(tab);

    var pre = document.createElement("pre");
    pre.id = "compare-output-" + m;
    pre.textContent = review.results[m].output;
    if (idx !== 0) pre.classList.add("hidden");
    contentDiv.appendChild(pre);
  });

  panel.appendChild(tabBar);
  panel.appendChild(contentDiv);
}

// ─── Grade tab ───
function renderGradeForm() {
  if (!currentReview) {
    document.getElementById("grade-empty").classList.remove("hidden");
    document.getElementById("grade-form").classList.add("hidden");
    return;
  }

  document.getElementById("grade-empty").classList.add("hidden");
  document.getElementById("grade-form").classList.remove("hidden");
  document.getElementById("grade-success").classList.add("hidden");
  document.getElementById("btn-submit-grades").disabled = false;

  const models = Object.entries(currentReview.results).filter(([, r]) => r.success);
  document.getElementById("grade-sliders").innerHTML = models
    .map(
      ([m]) =>
        '<div class="grade-row" data-model="' +
        m +
        '">' +
        '<span class="name">' +
        m +
        "</span>" +
        '<input type="range" min="1" max="10" value="5" oninput="this.parentElement.querySelector(\'.val\').textContent=this.value">' +
        '<span class="val">5</span></div>',
    )
    .join("");
}

function submitGrades() {
  if (!currentReview) return;
  const models = Object.keys(currentReview.results).filter((m) => currentReview.results[m].success);
  const scores = models.map((m) => {
    const row = document.querySelector('.grade-row[data-model="' + m + '"]');
    return {
      model: m,
      score: parseInt(row.querySelector("input").value, 10),
      feedback: "",
    };
  });

  vscode.postMessage({ type: "submitGrades", scores });
  document.getElementById("btn-submit-grades").disabled = true;
  document.getElementById("grade-success").classList.remove("hidden");
  document.getElementById("grade-success").textContent =
    "Saved: " + scores.map((s) => s.model + "=" + s.score).join(", ");
}

// ─── Scores tab ───
document.querySelectorAll(".filters button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".filters button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    vscode.postMessage({ type: "requestLeaderboard", timeframe: btn.dataset.tf });
  };
});

function renderLeaderboard(stats) {
  const el = document.getElementById("leaderboard-content");
  if (!stats.length) {
    el.innerHTML = '<p class="empty-state">No scores for this period.</p>';
    return;
  }

  let html = "<table><thead><tr><th>Model</th><th>Avg</th><th>N</th><th>Trend</th></tr></thead><tbody>";
  for (const s of stats) {
    const avg = s.avgScore.toFixed(1);
    const cls = s.avgScore >= 7 ? "high" : s.avgScore >= 5 ? "mid" : "low";
    html +=
      "<tr><td>" +
      s.model +
      "</td>" +
      '<td><span class="score ' +
      cls +
      '">' +
      avg +
      "</span></td>" +
      "<td>" +
      s.totalReviews +
      "</td>" +
      '<td class="sparkline">' +
      sparkline(s.recentScores, 60, 18) +
      "</td></tr>";
  }
  html += "</tbody></table>";
  el.innerHTML = html;
}

function sparkline(scores, w, h) {
  if (!scores || scores.length < 2) return "—";
  const pts = scores
    .map((v, i) => {
      const x = (i / (scores.length - 1)) * w;
      const y = h - ((v - 1) / 9) * h;
      return x.toFixed(1) + "," + y.toFixed(1);
    })
    .join(" ");
  const last = scores[scores.length - 1];
  const c =
    last >= 7
      ? "var(--vscode-testing-iconPassed)"
      : last >= 5
        ? "var(--vscode-editorWarning-foreground)"
        : "var(--vscode-testing-iconFailed)";
  return (
    '<svg width="' +
    w +
    '" height="' +
    h +
    '"><polyline points="' +
    pts +
    '" fill="none" stroke="' +
    c +
    '" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  );
}

// ─── History ───
function renderHistory() {
  var list = document.getElementById("history-list");
  if (!reviewHistory.length) {
    list.innerHTML = '<p class="empty-state">No past reviews.</p>';
    return;
  }
  list.innerHTML = "";
  reviewHistory.forEach(function (r) {
    var item = document.createElement("div");
    item.className = "history-item";
    var titleSpan = document.createElement("span");
    titleSpan.className = "history-title";
    var prBadge = document.createElement("span");
    prBadge.className = "history-pr";
    prBadge.textContent = "#" + r.prNumber;
    titleSpan.appendChild(prBadge);
    titleSpan.appendChild(document.createTextNode(" " + r.prTitle));
    var dateSpan = document.createElement("span");
    dateSpan.className = "history-date";
    dateSpan.textContent = new Date(r.timestamp).toLocaleDateString();
    item.appendChild(titleSpan);
    item.appendChild(dateSpan);
    item.onclick = function () {
      currentReview = r;
      isViewingHistory = true;
      renderResults(r);
    };
    list.appendChild(item);
  });
}

// ─── Message handler ───
window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "prs":
      prs = msg.prs;
      renderPRs();
      break;
    case "reviewProgress":
      updateProgress(msg.model, msg.status);
      break;
    case "reviewBytes":
      updateBytes(msg.model, msg.bytes);
      break;
    case "reviewChunk": {
      if (!chunkBuffers[msg.model]) chunkBuffers[msg.model] = "";
      chunkBuffers[msg.model] += msg.text;
      if (chunkBuffers[msg.model].length > 4096) {
        chunkBuffers[msg.model] = chunkBuffers[msg.model].slice(-4096);
      }
      var preview = document.getElementById("chunks-" + msg.model);
      if (preview) {
        var lines = chunkBuffers[msg.model].split("\n");
        preview.textContent = lines.slice(-3).join("\n");
        preview.classList.add("active");
      }
      break;
    }
    case "reviewComplete":
      stopElapsedTimer();
      modelStartTimes = {};
      isViewingHistory = false;
      currentReview = msg.review;
      renderResults(msg.review);
      break;
    case "reviewError":
      stopElapsedTimer();
      modelStartTimes = {};
      showState("select");
      document.getElementById("pr-error").textContent = msg.error;
      document.getElementById("pr-error").classList.remove("hidden");
      break;
    case "leaderboard":
      renderLeaderboard(msg.stats);
      break;
    case "modelHealth":
      Object.keys(msg.health).forEach(function (m) {
        var dot = document.querySelector('.health-dot[data-model="' + m + '"]');
        if (dot) {
          dot.className = "health-dot " + (msg.health[m] ? "available" : "unavailable");
          dot.title = msg.health[m] ? m + " is available" : m + " not found";
        }
      });
      break;
    case "reviewHistory":
      reviewHistory = msg.reviews;
      renderHistory();
      break;
    case "gradePromptReady": {
      var promptBlock = document.getElementById("grade-prompt-block");
      var promptText = document.getElementById("grade-prompt-text");
      if (promptBlock && promptText) {
        promptText.textContent = msg.prompt;
        promptBlock.classList.remove("hidden");
      }
      break;
    }
    case "error":
      showPrError(msg.message, "Failed to load PRs");
      break;
  }
});

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Defer init so the VS Code webview message bridge is ready
setTimeout(init, 50);
