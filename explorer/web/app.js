/**
 * ClaimClarify Explorer front-end.
 *
 * Same-origin calls only (no secrets, no keys): the static page talks to the
 * Explorer API behind the same CloudFront distribution under /api/*.
 *   POST /api/chat   { question }        -> { answer, traceId, model }
 *   GET  /api/logs?reasoningOnly=bool    -> { events: [{ group, timestamp, message }] }
 */
(function () {
  "use strict";

  var CHAT_ENDPOINT = "/api/chat";
  var LOGS_ENDPOINT = "/api/logs";

  var historyEl = document.getElementById("chat-history");
  var pendingEl = document.getElementById("chat-pending");
  var errorEl = document.getElementById("chat-error");
  var formEl = document.getElementById("chat-form");
  var inputEl = document.getElementById("chat-input");
  var submitEl = document.getElementById("chat-submit");

  var logsOutEl = document.getElementById("logs-output");
  var logsErrEl = document.getElementById("logs-error");
  var logsRefreshEl = document.getElementById("logs-refresh");
  var logsReasoningEl = document.getElementById("logs-reasoning");

  function addEntry(role, text) {
    var li = document.createElement("li");
    li.className = "chat-entry chat-entry--" + role;
    var r = document.createElement("span");
    r.className = "chat-entry__role";
    r.textContent = role === "user" ? "You" : "Assistant";
    var b = document.createElement("span");
    b.textContent = text;
    li.appendChild(r);
    li.appendChild(b);
    historyEl.appendChild(li);
    li.scrollIntoView({ block: "end" });
  }

  function setPending(on) {
    pendingEl.hidden = !on;
    submitEl.disabled = on;
    inputEl.disabled = on;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  formEl.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = inputEl.value.trim();
    showError("");
    if (!q) {
      showError("Please enter a question.");
      return;
    }
    addEntry("user", q);
    inputEl.value = "";
    setPending(true);

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);

    fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
      signal: controller.signal,
    })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        setPending(false);
        if (r.ok && r.data && r.data.answer) {
          addEntry("assistant", r.data.answer);
        } else {
          var m = r.data && r.data.error && r.data.error.message
            ? r.data.error.message
            : "The assistant could not answer. Please try again.";
          showError(m);
        }
      })
      .catch(function (err) {
        clearTimeout(timer);
        setPending(false);
        showError(err && err.name === "AbortError"
          ? "The request timed out. Please try again."
          : "Network error contacting the assistant.");
      });
  });

  function refreshLogs() {
    logsErrEl.hidden = true;
    logsOutEl.textContent = "Loading…";
    var url = LOGS_ENDPOINT + "?reasoningOnly=" + (logsReasoningEl.checked ? "true" : "false") + "&limit=50";
    fetch(url, { method: "GET" })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          logsErrEl.textContent = (r.data && r.data.error && r.data.error.message) || "Could not load logs.";
          logsErrEl.hidden = false;
          logsOutEl.textContent = "";
          return;
        }
        var ev = (r.data && r.data.events) || [];
        if (ev.length === 0) {
          logsOutEl.textContent = "No matching log events in the last 24h.\nGroups queried: " +
            ((r.data && r.data.groupsQueried) || []).join(", ");
          return;
        }
        logsOutEl.textContent = ev.map(function (e) {
          var ts = new Date(e.timestamp).toISOString();
          return "[" + ts + "] (" + e.group + ")\n" + e.message;
        }).join("\n\n");
      })
      .catch(function () {
        logsErrEl.textContent = "Network error loading logs.";
        logsErrEl.hidden = false;
        logsOutEl.textContent = "";
      });
  }

  logsRefreshEl.addEventListener("click", refreshLogs);
  logsReasoningEl.addEventListener("change", refreshLogs);
})();
