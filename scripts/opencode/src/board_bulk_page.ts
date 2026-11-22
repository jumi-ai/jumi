/**
 * Operator board bulk-requeue page script.
 *
 * Injected after the main board script in the same page scope. It shares the
 * page's global lexical bindings (`state`, `render`, `keyOf`, `forgeOf`,
 * `groupsOf`, `attentionKind`) and adds scoped bulk selection for the
 * visible review-execution-failure group only.
 *
 * Rules enforced here (server re-validates everything):
 * - exactly one forge scope (the current `state.forge`); selections are
 *   scoped to that forge and cleared when the scope changes;
 * - only visible, eligible rows in the exec-failure group can be selected;
 *   hidden, paginated, overflow-truncated, or ineligible rows are never
 *   selected by "select all";
 * - preview names the exact forge, repos/PRs, heads, and reasons before
 *   confirmation; changing scope or losing freshness invalidates it;
 * - single-row actions are untouched.
 */

export const BOARD_BULK_SCRIPT = `
(function () {
  var BULK_MAX = 20;
  var BULK_ALLOW = {
    "Incomplete review: no output": 1,
    "Incomplete review: no findings": 1,
    "Incomplete review: no check verdict": 1,
    "incomplete review: no artifact": 1
  };
  var FETCH_TIMEOUT_MS = 30000;
  var bulkSelected = {};
  var bulkForge = null;
  var bulkPreview = null;
  var bulkResult = null;
  var bulkBusy = false;

  function bulkState() { return window.__boardBulk || null; }

  function isStale() { try { return state.stale === true; } catch (e) { return true; } }
  function catalogOk() { try { return state.catalogOk !== false; } catch (e) { return false; } }
  function currentForge() { try { return state.forge || "gitea"; } catch (e) { return "gitea"; } }
  function dataGroups() { try { return groupsOf(state.data); } catch (e) { return null; } }

  function itemKey(item) { try { return keyOf(item); } catch (e) { return item.owner + "/" + item.repo + "#" + item.number; } }
  function itemForge(item) { try { return forgeOf(item, state.data); } catch (e) { return item.forge || currentForge(); } }

  function isBulkEligible(item) {
    if (!item || item.kind !== "review") return false;
    if (item.failingVerdict === true) return false;
    if (item.bulkEligible === true) {
      var head = (item.commit || item.headSha || "").trim();
      if (!head) return false;
      return true;
    }
    var head2 = (item.commit || item.headSha || "").trim();
    if (!head2) return false;
    var kick = (item.kick && typeof item.kick.kick === "string" ? item.kick.kick.trim() : "");
    if (!kick || !BULK_ALLOW[kick]) return false;
    if (!item.kick || typeof item.kick.effect !== "string" || !item.kick.effect) return false;
    return true;
  }

  function visibleExecItems() {
    var groups = dataGroups();
    if (!groups) return [];
    var forge = currentForge();
    var needs = groups.needsKick || [];
    return needs.filter(function (item) {
      if (itemForge(item) !== forge) return false;
      try { if (attentionKind(item) !== "exec-failure") return false; } catch (e) { return false; }
      return true;
    });
  }

  function ensureScope() {
    var forge = currentForge();
    if (bulkForge !== forge) {
      bulkForge = forge;
      bulkSelected = {};
      bulkPreview = null;
      bulkResult = null;
    }
  }

  function selectedKeys() { return Object.keys(bulkSelected); }

  function previewItems() {
    if (!bulkPreview) return [];
    return bulkPreview.items || [];
  }

  function previewStillFresh() {
    if (!bulkPreview) return false;
    if (isStale()) return false;
    if (!catalogOk()) return false;
    if (bulkPreview.forge !== currentForge()) return false;
    var groups = dataGroups();
    if (!groups) return false;
    var byKey = {};
    var all = (groups.needsKick || []).concat(groups.inProgress || []).concat(groups.sitting || []);
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      if (itemForge(it) !== bulkPreview.forge) continue;
      byKey[itemKey(it)] = it;
    }
    var items = previewItems();
    for (var j = 0; j < items.length; j++) {
      var want = items[j];
      var live = byKey[want.key];
      if (!live) return false;
      var liveCommit = (live.commit || live.headSha || "").trim();
      var liveKick = (live.kick && typeof live.kick.kick === "string" ? live.kick.kick.trim() : "");
      if (liveCommit !== want.commit || liveKick !== want.kick) return false;
      if (!isBulkEligible(live)) return false;
    }
    return true;
  }

  function clearPreviewIfStale(box) {
    if (bulkPreview && !previewStillFresh()) {
      bulkPreview = null;
      if (box) renderBulk(box);
    }
  }

  function newBatchKey() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return String(Date.now()) + "-" + Math.floor(Math.random() * 1e9);
  }

  function shortHead(sha) { return String(sha || "").slice(0, 8); }

  function peerUnavailable() {
    try {
      var data = state.data;
      var forge = currentForge();
      if (!data || forge === (data.forge || "gitea")) return false;
      var peers = data.peers || {};
      var peer = peers[forge];
      return !peer || peer.available !== true;
    } catch (e) { return true; }
  }

  function renderBulk(box) {
    ensureScope();
    box.textContent = "";
    if (peerUnavailable()) {
      var off = document.createElement("div");
      off.className = "sub";
      off.textContent = "Bulk requeue is unavailable on " + currentForge() + " — showing local rows only.";
      box.appendChild(off);
      return;
    }
    var items = visibleExecItems();
    var eligible = items.filter(isBulkEligible);
    var ineligibleCount = items.length - eligible.length;
    var selCount = selectedKeys().length;

    var wrap = document.createElement("div");
    wrap.className = "sub";
    wrap.dataset.bulk = "controls";

    if (items.length === 0) {
      wrap.textContent = "No execution failures on this forge — nothing to bulk-requeue.";
      box.appendChild(wrap);
      return;
    }

    var line = document.createElement("div");
    var label = document.createElement("label");
    var all = document.createElement("input");
    all.type = "checkbox";
    all.checked = eligible.length > 0 && eligible.every(function (it) { return bulkSelected[itemKey(it)]; });
    all.disabled = eligible.length === 0 || bulkBusy || isStale() || !catalogOk();
    all.setAttribute("aria-label", "Select all eligible");
    all.addEventListener("change", function () {
      ensureScope();
      bulkPreview = null;
      bulkResult = null;
      if (all.checked) {
        var next = {};
        for (var i = 0; i < eligible.length && Object.keys(next).length < BULK_MAX; i++) {
          next[itemKey(eligible[i])] = true;
        }
        bulkSelected = next;
      } else {
        bulkSelected = {};
      }
      render();
    });
    label.appendChild(all);
    label.appendChild(document.createTextNode(" Select all eligible (" + eligible.length + " of " + items.length + " visible)"));
    line.appendChild(label);
    wrap.appendChild(line);

    var note = document.createElement("div");
    var noteText = "Scoped to " + currentForge() + " · visible rows only";
    if (ineligibleCount > 0) noteText += " · " + ineligibleCount + " visible excluded (not bulk-eligible)";
    if (items.length < eligible.length + ineligibleCount) noteText += " · capped view";
    note.textContent = noteText;
    wrap.appendChild(note);

    if (selCount > 0) {
      var selLine = document.createElement("div");
      selLine.textContent = selCount + " selected (max " + BULK_MAX + ")";
      wrap.appendChild(selLine);
      var prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "primary";
      prevBtn.textContent = "Preview requeue (" + selCount + ")";
      prevBtn.disabled = bulkBusy || isStale() || !catalogOk();
      prevBtn.addEventListener("click", function () {
        ensureScope();
        var snap = [];
        var byKey = {};
        for (var i = 0; i < eligible.length; i++) byKey[itemKey(eligible[i])] = eligible[i];
        var keys = selectedKeys();
        for (var j = 0; j < keys.length; j++) {
          var live = byKey[keys[j]];
          if (!live) continue;
          snap.push({
            key: keys[j],
            owner: live.owner,
            repo: live.repo,
            number: live.number,
            commit: (live.commit || live.headSha || "").trim(),
            kick: (live.kick.kick || "").trim(),
            message: live.message || live.reason
          });
        }
        bulkPreview = { forge: currentForge(), items: snap, batchKey: newBatchKey() };
        bulkResult = null;
        render();
      });
      wrap.appendChild(prevBtn);
      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "secondary";
      clearBtn.textContent = "Clear";
      clearBtn.disabled = bulkBusy;
      clearBtn.addEventListener("click", function () {
        bulkSelected = {};
        bulkPreview = null;
        bulkResult = null;
        render();
      });
      wrap.appendChild(document.createTextNode(" "));
      wrap.appendChild(clearBtn);
    }

    if (bulkPreview) {
      var pv = document.createElement("div");
      pv.dataset.bulk = "preview";
      var title = document.createElement("div");
      if (!previewStillFresh()) {
        title.textContent = "Preview expired — scope changed or data went stale. Preview again.";
      } else {
        title.textContent = "Preview: requeue " + bulkPreview.items.length + " on " + bulkPreview.forge + "? Same head only; no push, no CI rerun.";
      }
      pv.appendChild(title);
      var ul = document.createElement("ul");
      ul.className = "rows";
      var pItems = previewItems();
      for (var k = 0; k < pItems.length; k++) {
        var pi = pItems[k];
        var li = document.createElement("li");
        li.className = "row";
        li.textContent = pi.owner + "/" + pi.repo + "#" + pi.number + " @ " + shortHead(pi.commit) + " · " + pi.kick;
        ul.appendChild(li);
      }
      pv.appendChild(ul);
      if (previewStillFresh()) {
        var go = document.createElement("button");
        go.type = "button";
        go.className = "primary";
        go.textContent = bulkBusy ? "Working…" : "Confirm requeue (" + pItems.length + ")";
        go.disabled = bulkBusy;
        go.addEventListener("click", submitBulk);
        pv.appendChild(go);
        pv.appendChild(document.createTextNode(" "));
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "secondary";
        cancel.textContent = "Cancel";
        cancel.disabled = bulkBusy;
        cancel.addEventListener("click", function () { bulkPreview = null; render(); });
        pv.appendChild(cancel);
        var msg = document.createElement("div");
        msg.className = "sub";
        msg.id = "bulk-msg";
        pv.appendChild(msg);
      }
      wrap.appendChild(pv);
    }

    if (bulkResult) {
      var res = document.createElement("div");
      res.dataset.bulk = "results";
      var t = bulkResult.totals || { queued: 0, skipped: 0, failed: 0 };
      var h = document.createElement("div");
      h.textContent = "Result: " + t.queued + " queued · " + t.skipped + " skipped · " + t.failed + " failed";
      res.appendChild(h);
      var rul = document.createElement("ul");
      rul.className = "rows";
      var rItems = bulkResult.results || [];
      for (var r = 0; r < rItems.length; r++) {
        var ri = rItems[r];
        var rli = document.createElement("li");
        rli.className = "row";
        rli.textContent = ri.owner + "/" + ri.repo + "#" + ri.number + " · " + ri.status + " · " + (ri.reason || ri.code || "");
        rul.appendChild(rli);
      }
      res.appendChild(rul);
      var dis = document.createElement("button");
      dis.type = "button";
      dis.className = "secondary";
      dis.textContent = "Dismiss";
      dis.addEventListener("click", function () { bulkResult = null; bulkPreview = null; bulkSelected = {}; render(); });
      res.appendChild(dis);
      wrap.appendChild(res);
    }

    box.appendChild(wrap);
  }

  async function submitBulk() {
    if (!bulkPreview || !previewStillFresh() || bulkBusy) return;
    var preview = bulkPreview;
    bulkBusy = true;
    render();
    var msg = document.getElementById("bulk-msg");
    if (msg) msg.textContent = "Working…";
    var controller = null;
    var timer = 0;
    try { controller = new AbortController(); } catch (e) { controller = null; }
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, FETCH_TIMEOUT_MS);
    var payload = {
      forge: preview.forge,
      idempotencyKey: preview.batchKey,
      items: preview.items.map(function (it) {
        return { owner: it.owner, repo: it.repo, number: it.number, commit: it.commit, kick: it.kick };
      })
    };
    try {
      var res = await fetch("/api/board/kick/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": preview.batchKey
        },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });
      if (timer) clearTimeout(timer);
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.ok && body && Array.isArray(body.results)) {
        var totals = body.totals || { queued: 0, skipped: 0, failed: 0 };
        bulkResult = { totals: totals, results: body.results };
        bulkPreview = null;
        bulkSelected = {};
        bulkBusy = false;
        render();
        try { await load(); } catch (e) {}
        return;
      }
      var detail = (body && typeof body.error === "string" && body.error.trim() !== "") ? body.error.trim() : ("Bulk did not land (" + res.status + ").");
      bulkBusy = false;
      if (msg) msg.textContent = detail;
      else bulkResult = { totals: { queued: 0, skipped: 0, failed: 0 }, results: [] };
      render();
    } catch (err) {
      if (timer) clearTimeout(timer);
      bulkBusy = false;
      var timedOut = (err && err.name === "AbortError") || /abort/i.test(String((err && err.message) || err));
      if (timedOut) {
        bulkResult = {
          totals: { queued: 0, skipped: 0, failed: 1 },
          results: preview.items.map(function (it) {
            return { owner: it.owner, repo: it.repo, number: it.number, commit: it.commit, status: "failed", code: "unknown", reason: "Request timed out; outcome unknown. Refresh before trying again." };
          })
        };
        bulkPreview = null;
        render();
      } else {
        if (msg) msg.textContent = "Bulk did not land. Close and confirm again to try once more.";
        render();
      }
    }
  }

  function mountBulk() {
    try {
      var sw = document.getElementById("forge-switch");
      if (sw && !sw.dataset.bulkBound) {
        sw.dataset.bulkBound = "1";
        sw.addEventListener("change", function () {
          bulkSelected = {};
          bulkPreview = null;
          bulkResult = null;
          bulkForge = null;
        });
      }
    } catch (e) {}
    try {
      if (typeof render === "function" && !render.__bulkWrapped) {
        var prev = render;
        var wrapped = function () {
          prev();
          try {
            ensureScope();
            var det = document.querySelector('[data-group="needs-exec-failure"]');
            if (det) {
              var old = det.querySelector('[data-bulk="controls"]');
              if (old && old.parentNode) old.parentNode.removeChild(old);
              var oldPrev = det.querySelector('[data-bulk="preview"]');
              if (oldPrev && oldPrev.parentNode && oldPrev.parentNode !== det) oldPrev.parentNode.removeChild(oldPrev);
              var box = document.createElement("div");
              if (bulkPreview && !previewStillFresh()) bulkPreview = null;
              renderBulk(box);
              det.appendChild(box);
              var rows = det.querySelectorAll("ul.rows li.row");
              for (var i = 0; i < rows.length; i++) {
                (function (li) {
                  if (li.querySelector('input[data-bulk-check="1"]')) return;
                  var key = li.dataset ? li.dataset.key : null;
                  if (!key) return;
                  var groups = dataGroups();
                  var found = null;
                  if (groups) {
                    var all = (groups.needsKick || []);
                    for (var j = 0; j < all.length; j++) {
                      try { if (keyOf(all[j]) === key) { found = all[j]; break; } } catch (e) {}
                    }
                  }
                  if (!found || !isBulkEligible(found)) return;
                  if (itemForge(found) !== currentForge()) return;
                  var cb = document.createElement("input");
                  cb.type = "checkbox";
                  cb.dataset.bulkCheck = "1";
                  cb.checked = !!bulkSelected[key];
                  cb.disabled = bulkBusy || isStale() || !catalogOk();
                  cb.setAttribute("aria-label", "Select for bulk requeue");
                  cb.addEventListener("click", function (ev) { ev.stopPropagation(); });
                  cb.addEventListener("change", function () {
                    ensureScope();
                    bulkPreview = null;
                    bulkResult = null;
                    if (cb.checked) {
                      if (Object.keys(bulkSelected).length >= BULK_MAX && !bulkSelected[key]) {
                        cb.checked = false;
                        return;
                      }
                      bulkSelected[key] = true;
                    } else {
                      delete bulkSelected[key];
                    }
                    render();
                  });
                  li.insertBefore(cb, li.firstChild);
                })(rows[i]);
              }
            }
          } catch (e) {}
        };
        wrapped.__bulkWrapped = true;
        render = wrapped;
      }
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBulk);
  } else {
    mountBulk();
  }
  setTimeout(mountBulk, 0);
})();
`;
