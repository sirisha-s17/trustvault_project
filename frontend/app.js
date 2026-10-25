(() => {
  "use strict";

  // Note: hiding a button here is a convenience, never the protection. Every
  // action is authorised again by the API, which is the only thing that decides.

  const AUDIT_ACTIONS = [
    "login", "logout", "upload", "read", "download", "edit", "version_upload", "delete", "restore",
    "permission_grant", "permission_revoke", "access_suggestion", "access_denied", "search",
    "user_create", "user_deactivate", "user_activate", "ownership_transfer", "password_change", "password_reset"
  ];
  const ACTION_LABELS = {
    login: "Signed in",
    logout: "Signed out",
    upload: "Uploaded",
    read: "Opened",
    download: "Downloaded",
    edit: "Edited details",
    version_upload: "Uploaded new version",
    delete: "Deleted",
    restore: "Restored",
    permission_grant: "Granted access",
    permission_revoke: "Revoked access",
    access_suggestion: "Viewed access suggestions",
    access_denied: "Refused",
    search: "Searched",
    user_create: "Created account",
    user_deactivate: "Deactivated account",
    user_activate: "Activated account",
    ownership_transfer: "Transferred ownership",
    password_change: "Changed password",
    password_reset: "Reset password"
  };
  const ACTION_ICONS = {
    upload: "upload", download: "download", read: "eye", edit: "edit", version_upload: "layers",
    delete: "trash", restore: "restore", permission_grant: "plus", permission_revoke: "x",
    access_denied: "alert", ownership_transfer: "transfer", access_suggestion: "sparkle",
    login: "lock", logout: "logout", password_change: "key", password_reset: "key"
  };
  const EXTENSIONS = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "text/plain": "txt" };
  const PAGE_TITLES = {
    overview: "Overview",
    documents: "My documents",
    shared: "Shared with me",
    trash: "Trash",
    activity: "Activity log",
    users: "People"
  };

  const state = {
    user: null,
    page: null,
    documents: [],
    selected: null,
    docPage: 1,
    docLimit: 20,
    docTotal: 0,
    summary: null,
    auditPage: 1,
    auditLimit: 50,
    auditTotal: 0,
    users: [],
    searchTimer: null
  };

  /* ---------- helpers ---------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (className) svg.setAttribute("class", className);
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function pill(text, tone) {
    return el("span", `pill ${tone || ""}`, text);
  }

  function initials(name) {
    return String(name || "?").replace(/\(.*\)/, "").trim().split(/\s+/).slice(0, 2)
      .map((part) => part[0] || "").join("").toUpperCase() || "?";
  }

  const AVATAR_TONES = [
    ["#e0e7ff", "#4338ca"], ["#dcfce7", "#15803d"], ["#fef3c7", "#b45309"], ["#fce7f3", "#be185d"],
    ["#e0f2fe", "#0369a1"], ["#ede9fe", "#6d28d9"], ["#ffedd5", "#c2410c"], ["#ccfbf1", "#0f766e"]
  ];

  function paintAvatar(node, name) {
    const hash = [...String(name || "")].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
    const [background, color] = AVATAR_TONES[hash % AVATAR_TONES.length];
    node.textContent = initials(name);
    node.style.background = background;
    node.style.color = color;
    return node;
  }

  function avatar(name) {
    return paintAvatar(el("span", "avatar"), name);
  }

  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {})
    }).format(date);
  }

  function formatRelative(value) {
    const date = new Date(value);
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
    }
    return seconds >= 0 ? "in a moment" : "just now";
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return "—";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function extensionOf(item) {
    return EXTENSIONS[item.mimeType] || "file";
  }

  function permissionLabel(permission) {
    return { owner: "Owner", edit: "Can edit", read: "Can view" }[permission] || "—";
  }

  function toast(message, kind = "success") {
    const node = el("div", `toast${kind === "error" ? " error" : ""}`);
    node.append(icon(kind === "error" ? "alert" : "check"), el("span", "", message));
    $("#toast-region").append(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  function confirmAction({ title, message, confirmLabel = "Confirm", danger = false }) {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const ok = $("#confirm-ok");
    ok.textContent = confirmLabel;
    ok.className = `button ${danger ? "button-danger" : "button-primary"}`;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.textContent = label || "Working…";
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function skeletonRows(body, columns, rows = 4) {
    body.replaceChildren(...Array.from({ length: rows }, () => {
      const row = el("tr", "skeleton-row");
      for (let index = 0; index < columns; index += 1) {
        const cell = el("td");
        const bar = el("div", "skeleton");
        bar.style.width = `${40 + ((index * 23 + rows * 7) % 50)}%`;
        cell.append(bar);
        row.append(cell);
      }
      return row;
    }));
  }

  /* ---------- API ---------- */

  const apiBaseUrl = String(window.TRUSTVAULT_CONFIG?.apiBaseUrl || `${window.location.origin}/api`).replace(/\/+$/, "");

  function apiUrl(path) {
    return `${apiBaseUrl}/${String(path).replace(/^\/+/, "")}`;
  }

  async function api(path, options = {}) {
    const request = { credentials: "include", ...options, headers: { ...(options.headers || {}) } };
    if (request.body && !(request.body instanceof FormData) && typeof request.body !== "string") {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(request.body);
    }
    const response = await fetch(apiUrl(path), request);
    if (response.status === 401 && path !== "/auth/login" && path !== "/auth/me") {
      showLogin();
      throw new Error("Your session ended. Please sign in again.");
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 429) throw new Error("Too many requests. Please wait a moment and try again.");
      throw new Error(body?.error || `Request failed (${response.status})`);
    }
    return body;
  }

  /* ---------- session ---------- */

  function showLogin() {
    state.user = null;
    $$("dialog[open]").forEach((dialog) => dialog.close());
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    $("#login-email").focus();
  }

  function showApp(user) {
    state.user = user;
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    paintAvatar($("#account-avatar"), user.name);
    $("#account-name").textContent = user.name;
    $("#account-role").textContent = user.role === "owner" ? "Document owner" : user.role;
    $("#account-menu-name").textContent = user.name;
    $("#account-menu-email").textContent = user.email;
    $$(".owner-only").forEach((node) => { node.hidden = user.role !== "owner"; });
    $$(".admin-only").forEach((node) => { node.hidden = user.role !== "admin"; });
    switchPage(user.role === "admin" ? "overview" : user.role === "owner" ? "documents" : "shared");
  }

  async function login(event) {
    event.preventDefault();
    const error = $("#login-error");
    error.textContent = "";
    const submit = $("#login-form button[type=submit]");
    setBusy(submit, true, "Signing in…");
    try {
      const result = await api("/auth/login", {
        method: "POST",
        body: { email: $("#login-email").value.trim(), password: $("#login-password").value }
      });
      $("#login-form").reset();
      showApp(result.user);
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      setBusy(submit, false);
    }
  }

  async function logout() {
    closeAccountMenu();
    const ok = await confirmAction({
      title: "Sign out everywhere?",
      message: "This ends your session on every device. Any token issued to you stops working immediately.",
      confirmLabel: "Sign out"
    });
    if (!ok) return;
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Already signed out server-side; nothing more to do.
    }
    showLogin();
  }

  async function submitPassword(event) {
    event.preventDefault();
    const errorNode = $("#password-error");
    errorNode.textContent = "";
    try {
      await api("/auth/password", {
        method: "POST",
        body: { currentPassword: $("#current-password").value, newPassword: $("#new-password").value }
      });
      $("#password-dialog").close();
      $("#password-form").reset();
      toast("Password changed. Other sessions were signed out.");
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  function closeAccountMenu() {
    $("#account-menu").hidden = true;
    $("#account-button").setAttribute("aria-expanded", "false");
  }

  /* ---------- navigation ---------- */

  function switchPage(page) {
    const role = state.user?.role;
    if (["overview", "activity", "users"].includes(page) && role !== "admin") page = "shared";
    if (["documents", "trash"].includes(page) && role !== "owner") page = "shared";
    state.page = page;

    $("#breadcrumb-current").textContent = PAGE_TITLES[page];
    const sectionId = page === "shared" ? "documents-page" : `${page}-page`;
    $$(".page-section").forEach((section) => { section.hidden = section.id !== sectionId; });
    $$(".nav-link").forEach((button) => button.classList.toggle("is-active", button.dataset.nav === page));
    $("#sidebar").classList.remove("is-open");
    $("#sidebar-scrim").classList.remove("is-open");

    if (page === "documents" || page === "shared") {
      const shared = page === "shared";
      const hour = new Date().getHours();
      const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      $("#documents-eyebrow").textContent = `${greeting}, ${state.user.name.replace(/\s*\(.*\)/, "").split(" ")[0]}`;
      $("#documents-heading").textContent = shared ? "Shared with me" : "My documents";
      $("#documents-subheading").textContent = shared
        ? "Documents other people granted to you by name. Access can be revoked or expire at any time."
        : "Documents you own. Nobody else can reach them until you grant access.";
      $("#upload-open").hidden = shared || role !== "owner";
      state.docPage = 1;
      loadDocuments();
    } else if (page === "trash") {
      loadTrash();
    } else if (page === "activity") {
      state.auditPage = 1;
      loadAuditActors();
      loadAudit();
    } else if (page === "users") {
      loadUsers();
    } else if (page === "overview") {
      loadOverview();
    }
    loadSummary();
  }

  /* ---------- summary ---------- */

  async function loadSummary() {
    try {
      const summary = await api("/documents/summary");
      state.summary = summary;
      $("#stat-total").textContent = summary.accessible;
      $("#stat-owned").textContent = summary.owned;
      $("#stat-shared").textContent = summary.shared;
      $("#nav-owned-count").textContent = summary.owned || "";
      $("#nav-shared-count").textContent = summary.shared || "";
      $("#nav-trash-count").textContent = summary.trash || "";
      const select = $("#filter-category");
      const selected = select.value;
      select.replaceChildren(new Option("All categories", ""), ...summary.categories.map((category) => new Option(category, category)));
      if (summary.categories.includes(selected)) select.value = selected;
      $("#category-options").replaceChildren(...summary.categories.map((category) => new Option(category)));
    } catch {
      // Counts are decorative; the page itself reports real errors.
    }
  }

  /* ---------- documents ---------- */

  function documentQuery() {
    const params = new URLSearchParams({
      page: String(state.docPage),
      limit: String(state.docLimit),
      scope: state.page === "shared" ? "shared" : "owned"
    });
    const fields = { name: "#search-name", owner: "#filter-owner", category: "#filter-category", from: "#filter-from", to: "#filter-to" };
    for (const [key, selector] of Object.entries(fields)) {
      const value = $(selector).value.trim();
      if (value) params.set(key, value);
    }
    return params;
  }

  async function loadDocuments() {
    const body = $("#documents-body");
    skeletonRows(body, 6);
    $("#empty-documents").hidden = true;
    try {
      const result = await api(`/documents?${documentQuery()}`);
      state.documents = result.documents || [];
      state.docTotal = result.total || 0;
      renderDocuments();
    } catch (error) {
      body.replaceChildren();
      showEmpty("#empty-documents", "Could not load documents", error.message);
    }
  }

  function showEmpty(selector, title, message) {
    const node = $(selector);
    node.hidden = false;
    $("h3", node).textContent = title;
    const paragraph = $("p", node);
    if (paragraph) paragraph.textContent = message;
  }

  function renderDocuments() {
    const body = $("#documents-body");
    body.replaceChildren(...state.documents.map(documentRow));
    const filtered = documentQuery().toString().match(/name=|owner=|category=|from=|to=/);
    if (!state.documents.length) {
      showEmpty(
        "#empty-documents",
        filtered ? "No documents match" : state.page === "shared" ? "Nothing shared with you yet" : "No documents yet",
        filtered ? "Try a different search or clear the filters." : state.page === "shared"
          ? "When someone grants you a document, it appears here."
          : "Upload a document to get started. It stays private until you share it."
      );
    } else {
      $("#empty-documents").hidden = true;
    }
    const start = state.docTotal ? (state.docPage - 1) * state.docLimit + 1 : 0;
    $("#page-summary").textContent = state.docTotal
      ? `Showing ${start}–${Math.min(state.docPage * state.docLimit, state.docTotal)} of ${state.docTotal}`
      : "No documents";
    $("#prev-page").disabled = state.docPage <= 1;
    $("#next-page").disabled = state.docPage * state.docLimit >= state.docTotal;
  }

  function documentCell(item) {
    const cell = el("div", "document-cell");
    const extension = extensionOf(item);
    const copy = el("span");
    copy.append(el("strong", "doc-name", item.name));
    const meta = [formatBytes(item.sizeBytes), extension.toUpperCase()];
    if (item.currentVersion > 1) meta.push(`v${item.currentVersion}`);
    copy.append(el("small", "doc-meta", meta.join(" · ")));
    cell.append(el("span", `file-icon type-${extension}`, extension.toUpperCase()), copy);
    return cell;
  }

  function documentRow(item) {
    const row = el("tr", "clickable");
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button")) openDocument(item);
    });
    const nameCell = el("td");
    nameCell.append(documentCell(item));

    const categoryCell = el("td");
    categoryCell.append(pill(item.category || "Uncategorized", "neutral"));

    const ownerCell = el("td");
    const ownerName = item.permission === "owner" ? state.user.name : item.owner?.name;
    const ownerWrap = el("div", "owner-cell");
    ownerWrap.append(avatar(ownerName), el("span", "", item.permission === "owner" ? "You" : ownerName || "—"));
    ownerCell.append(ownerWrap);

    const accessCell = el("td", "nowrap");
    accessCell.append(pill(permissionLabel(item.permission), item.permission));
    if (item.permission === "owner") {
      accessCell.append(el("small", "doc-meta", item.sharedWith ? `Shared with ${item.sharedWith}` : "Private"));
    } else if (item.accessExpiresAt) {
      accessCell.append(el("small", "doc-meta", `Expires ${formatRelative(item.accessExpiresAt)}`));
    }

    const dateCell = el("td", "nowrap", formatDate(item.createdAt));
    const actionsCell = el("td");
    const actions = el("div", "row-actions");
    actions.append(
      rowAction("Open details", "eye", () => openDocument(item)),
      rowAction("Download", "download", (event) => downloadDocument(item, null, event.currentTarget))
    );
    actionsCell.append(actions);
    row.append(nameCell, categoryCell, ownerCell, accessCell, dateCell, actionsCell);
    return row;
  }

  function rowAction(label, iconName, action, danger = false) {
    const button = el("button", `row-action${danger ? " danger" : ""}`);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(iconName));
    button.addEventListener("click", action);
    return button;
  }

  async function downloadDocument(item, version, button) {
    if (button) button.disabled = true;
    try {
      const path = version
        ? `/documents/${encodeURIComponent(item.id)}/versions/${version}/download`
        : `/documents/${encodeURIComponent(item.id)}/download`;
      const response = await fetch(apiUrl(path), { credentials: "include" });
      if (response.status === 401) {
        showLogin();
        throw new Error("Your session ended. Please sign in again.");
      }
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.error || "Could not download the document.");
      }
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = el("a");
      link.href = url;
      link.download = match ? decodeURIComponent(match[1]) : `${item.name}.${extensionOf(item)}`;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoking synchronously can cancel the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Download started. It has been recorded in the audit trail.");
    } catch (error) {
      toast(error.message, "error");
      if (state.selected && state.selected.id === item.id) {
        // Access may have just been revoked; refresh the list so it disappears.
        loadDocuments();
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ---------- document details ---------- */

  async function openDocument(item) {
    try {
      const result = await api(`/documents/${encodeURIComponent(item.id)}`);
      state.selected = { ...item, ...result.document };
      const doc = state.selected;
      const isOwner = doc.permission === "owner";
      const canEdit = isOwner || doc.permission === "edit";
      const extension = extensionOf(doc);
      $("#detail-icon").className = `file-icon type-${extension}`;
      $("#detail-icon").textContent = extension.toUpperCase();
      $("#detail-title").textContent = doc.name;
      $("#detail-eyebrow").textContent = `${doc.category} · ${permissionLabel(doc.permission)}`;
      $("#detail-edit").hidden = !canEdit;
      $("#detail-delete").hidden = !isOwner;
      $$(".owner-tab").forEach((tab) => { tab.hidden = !isOwner; });
      $("#version-form").hidden = !canEdit;
      renderInfo();
      setTab("info");
      if (!$("#details-dialog").open) $("#details-dialog").showModal();
    } catch (error) {
      toast(error.message, "error");
      loadDocuments();
    }
  }

  function setTab(tab) {
    $$(".tab").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
    $$(".tab-panel").forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
    if (tab === "access") {
      loadPermissions();
      $("#suggestions-list").replaceChildren();
    }
    if (tab === "versions") loadVersions();
    if (tab === "history") loadHistory();
  }

  function renderInfo() {
    const doc = state.selected;
    const fields = [
      ["Category", doc.category],
      ["Your access", permissionLabel(doc.permission) + (doc.accessExpiresAt ? ` · until ${formatDate(doc.accessExpiresAt, true)}` : "")],
      ["Owner", doc.permission === "owner" ? "You" : doc.owner ? `${doc.owner.name} (${doc.owner.email})` : "—"],
      ["File", `${extensionOf(doc).toUpperCase()} · ${formatBytes(doc.sizeBytes)} · version ${doc.currentVersion || 1}`],
      ["Added", formatDate(doc.createdAt, true)],
      ["Last changed", formatDate(doc.updatedAt, true)],
      ["SHA-256 of current file", doc.checksumSha256, true]
    ];
    $("#document-detail").replaceChildren(...fields.map(([label, value, wide]) => {
      const item = el("div", `detail-item${wide ? " wide" : ""}`);
      const strong = el("strong", wide ? "mono" : "", value || "—");
      item.append(el("span", "", label), strong);
      return item;
    }));
  }

  async function loadPermissions() {
    const list = $("#permissions-list");
    list.replaceChildren(el("div", "grant-empty", "Loading…"));
    try {
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}/permissions`);
      renderPermissions(result.grants || []);
    } catch (error) {
      list.replaceChildren(el("div", "grant-empty form-error", error.message));
    }
  }

  function renderPermissions(grants) {
    const list = $("#permissions-list");
    if (!grants.length) {
      list.replaceChildren(el("div", "grant-empty", "Only you can reach this document."));
      return;
    }
    list.replaceChildren(...grants.map((grant) => {
      const row = el("div", "grant-row");
      const person = el("div", "grant-person");
      person.append(avatar(grant.user?.name));
      const copy = el("span");
      copy.append(el("strong", "", grant.user?.name || "Deleted account"), el("small", "", grant.user?.email || "—"));
      person.append(copy);
      const controls = el("div", "grant-actions");
      controls.append(pill(permissionLabel(grant.permission), grant.permission));
      if (grant.expired) controls.append(pill("Expired", "expired"));
      else if (grant.expiresAt) controls.append(pill(`Until ${formatDate(grant.expiresAt)}`, "warning"));
      if (grant.user && !grant.user.active) controls.append(pill("Inactive", "inactive"));
      if (grant.user?.id) {
        const revoke = el("button", "button button-danger button-small", "Revoke");
        revoke.type = "button";
        revoke.addEventListener("click", () => revokeGrant(grant.user));
        controls.append(revoke);
      }
      row.append(person, controls);
      return row;
    }));
  }

  async function revokeGrant(user) {
    const ok = await confirmAction({
      title: `Revoke ${user.name}'s access?`,
      message: "Their very next request for this document will be refused, including downloads from links they already have.",
      confirmLabel: "Revoke access",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/documents/${encodeURIComponent(state.selected.id)}/permissions/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      toast(`Access revoked for ${user.name}.`);
      loadPermissions();
      loadDocuments();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function grantAccess(userId, permission, expiresAt, source) {
    return api(`/documents/${encodeURIComponent(state.selected.id)}/permissions/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: { permission, expiresAt: expiresAt || null, source }
    });
  }

  async function submitShare(event) {
    event.preventDefault();
    const errorNode = $("#share-error");
    errorNode.textContent = "";
    const email = $("#share-email").value.trim();
    const submit = $("#share-form button[type=submit]");
    setBusy(submit, true, "Granting…");
    try {
      const lookup = await api(`/users/lookup?email=${encodeURIComponent(email)}`);
      if (!lookup.user) {
        errorNode.textContent = "No active account uses this email address.";
        return;
      }
      if (lookup.user.id === state.user.id) {
        errorNode.textContent = "You already own this document.";
        return;
      }
      await grantAccess(lookup.user.id, $("#share-permission").value, $("#share-expires").value, "manual");
      $("#share-form").reset();
      toast(`Access granted to ${lookup.user.name}.`);
      loadPermissions();
      loadDocuments();
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      setBusy(submit, false);
    }
  }

  async function loadSuggestions() {
    const list = $("#suggestions-list");
    const button = $("#load-suggestions");
    setBusy(button, true, "Thinking…");
    try {
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}/suggestions`);
      if (!result.suggestions.length) {
        list.replaceChildren(el("p", "muted suggestion-row", "No suggestions — nobody with access to your other documents is missing here."));
        return;
      }
      list.replaceChildren(...result.suggestions.map((suggestion) => {
        const row = el("div", "suggestion-row");
        const person = el("div", "grant-person");
        person.append(avatar(suggestion.user.name));
        const copy = el("span");
        copy.append(el("strong", "", `${suggestion.user.name} · ${suggestion.user.email}`), el("p", "", `${suggestion.reason.charAt(0).toUpperCase()}${suggestion.reason.slice(1)}.`));
        person.append(copy);
        const actions = el("div", "grant-actions");
        const accept = el("button", "button button-secondary button-small", "Grant view access");
        accept.type = "button";
        accept.addEventListener("click", async () => {
          const ok = await confirmAction({
            title: `Grant ${suggestion.user.name} view access?`,
            message: "This was suggested, not decided. Confirming records your decision in the audit trail.",
            confirmLabel: "Grant access"
          });
          if (!ok) return;
          try {
            await grantAccess(suggestion.user.id, "read", null, "suggestion");
            toast(`Access granted to ${suggestion.user.name}.`);
            row.remove();
            loadPermissions();
          } catch (error) {
            toast(error.message, "error");
          }
        });
        const dismiss = el("button", "button button-quiet button-small", "Dismiss");
        dismiss.type = "button";
        dismiss.addEventListener("click", () => row.remove());
        actions.append(accept, dismiss);
        row.append(person, actions);
        return row;
      }));
    } catch (error) {
      list.replaceChildren(el("p", "form-error", error.message));
    } finally {
      setBusy(button, false);
    }
  }

  async function loadVersions() {
    const list = $("#versions-list");
    list.replaceChildren(el("div", "grant-empty", "Loading…"));
    try {
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}/versions`);
      list.replaceChildren(...result.versions.map((version) => {
        const row = el("div", "version-row");
        const copy = el("div");
        const title = el("strong", "", `Version ${version.version}`);
        if (version.current) title.append(pill("Current", "success"));
        copy.append(title, el("small", "", `${formatBytes(version.sizeBytes)} · ${extensionOf(version).toUpperCase()} · by ${version.uploadedBy.name} · ${formatDate(version.uploadedAt, true)}`));
        const download = el("button", "button button-quiet button-small");
        download.type = "button";
        download.append(icon("download"), document.createTextNode(" Download"));
        download.addEventListener("click", (event) => downloadDocument(state.selected, version.version, event.currentTarget));
        row.append(copy, download);
        return row;
      }));
    } catch (error) {
      list.replaceChildren(el("div", "grant-empty form-error", error.message));
    }
  }

  async function submitVersion(event) {
    event.preventDefault();
    const errorNode = $("#version-error");
    errorNode.textContent = "";
    const file = $("#version-file").files[0];
    if (!file) {
      errorNode.textContent = "Choose a file first.";
      return;
    }
    const submit = $("#version-submit");
    setBusy(submit, true, "Uploading…");
    try {
      const data = new FormData();
      data.append("file", file);
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}/file`, { method: "PUT", body: data });
      state.selected = { ...state.selected, ...result.document };
      $("#version-form").reset();
      $("#version-file-label").textContent = "Choose a new version…";
      renderInfo();
      loadVersions();
      loadDocuments();
      toast(`Version ${result.document.currentVersion} uploaded.`);
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      setBusy(submit, false);
    }
  }

  function describeEvent(event, { includeDocument = false } = {}) {
    const details = event.details || {};
    const actor = event.actor?.name || event.actorId?.name || "Someone without a session";
    const label = (ACTION_LABELS[event.action] || event.action).toLowerCase();
    const extras = [];
    if (event.action === "access_denied") {
      return `${actor} was refused (${String(details.reason || "not permitted").replaceAll("_", " ")}${details.requestedPermission ? `, wanted ${details.requestedPermission}` : ""})`;
    }
    if (details.targetEmail) extras.push(`for ${details.targetEmail}`);
    if (details.permission) extras.push(`(${permissionLabel(details.permission).toLowerCase()}${details.expiresAt ? `, until ${formatDate(details.expiresAt)}` : ""})`);
    if (details.revokedPermission) extras.push(`(${permissionLabel(details.revokedPermission).toLowerCase()})`);
    if (details.source === "suggestion") extras.push("from a suggestion");
    if (details.version && ["download", "version_upload"].includes(event.action)) extras.push(`version ${details.version}`);
    if (details.changedFields) {
      extras.push(details.changedFields.map((field) => `${field}: "${details.previous?.[field] ?? ""}" → "${details.current?.[field] ?? ""}"`).join(", "));
    }
    if (details.resource === "permissions") extras.push("the access list");
    if (details.suggestedUserIds) extras.push(`(${details.suggestedUserIds.length} suggested)`);
    if (includeDocument && event.documentId) extras.push(`· doc ${String(event.documentId).slice(-6)}`);
    if (event.outcome === "failure") extras.push(`— failed: ${String(details.reason || "error").replaceAll("_", " ")}`);
    return `${actor} ${label} ${extras.join(" ")}`.trim();
  }

  function toneFor(event) {
    if (event.outcome === "denied" || event.outcome === "failure") return "tone-red";
    if (["permission_grant", "permission_revoke", "ownership_transfer"].includes(event.action)) return "tone-amber";
    if (["download", "read"].includes(event.action)) return "tone-teal";
    return "tone-indigo";
  }

  async function loadHistory() {
    const list = $("#history-list");
    list.replaceChildren(el("div", "grant-empty", "Loading…"));
    try {
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}/activity`);
      if (!result.events.length) {
        list.replaceChildren(el("div", "grant-empty", "No recorded activity."));
        return;
      }
      list.replaceChildren(...result.events.map((event) => {
        const item = el("div", "timeline-item");
        const dot = el("span", `feed-dot ${toneFor(event)}`);
        dot.append(icon(ACTION_ICONS[event.action] || "activity"));
        const copy = el("div");
        copy.append(el("p", "", describeEvent(event)), el("small", "", `${formatDate(event.occurredAt, true)} · ${formatRelative(event.occurredAt)} · #${event.sequence}`));
        item.append(dot, copy);
        return item;
      }));
    } catch (error) {
      list.replaceChildren(el("div", "grant-empty form-error", error.message));
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    const errorNode = $("#edit-error");
    errorNode.textContent = "";
    try {
      const result = await api(`/documents/${encodeURIComponent(state.selected.id)}`, {
        method: "PATCH",
        body: { name: $("#edit-name").value.trim(), category: $("#edit-category").value.trim() }
      });
      state.selected = { ...state.selected, ...result.document };
      $("#edit-dialog").close();
      $("#detail-title").textContent = state.selected.name;
      $("#detail-eyebrow").textContent = `${state.selected.category} · ${permissionLabel(state.selected.permission)}`;
      renderInfo();
      loadDocuments();
      loadSummary();
      toast("Document details updated.");
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  async function deleteSelected() {
    const doc = state.selected;
    const ok = await confirmAction({
      title: `Delete "${doc.name}"?`,
      message: "It becomes unreachable for everyone immediately. You can restore it from Trash.",
      confirmLabel: "Move to trash",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
      $("#details-dialog").close();
      state.selected = null;
      toast("Moved to trash.");
      loadDocuments();
      loadSummary();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------- upload ---------- */

  function setUploadFile(file) {
    $("#file-label").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "Drop a file here or click to choose";
    if (file && !$("#upload-name").value) $("#upload-name").value = file.name.replace(/\.[^.]+$/, "");
  }

  async function submitUpload(event) {
    event.preventDefault();
    const file = $("#upload-file").files[0];
    const errorNode = $("#upload-error");
    errorNode.textContent = "";
    if (!file) {
      errorNode.textContent = "Choose a file first.";
      return;
    }
    const submit = $("#upload-submit");
    setBusy(submit, true, "Uploading…");
    try {
      const data = new FormData();
      data.append("name", $("#upload-name").value.trim() || file.name);
      data.append("category", $("#upload-category").value.trim() || "Uncategorized");
      data.append("file", file);
      await api("/documents", { method: "POST", body: data });
      $("#upload-dialog").close();
      $("#upload-form").reset();
      setUploadFile(null);
      toast("Uploaded. Only you can reach it until you share it.");
      if (state.page !== "documents") switchPage("documents");
      else {
        state.docPage = 1;
        loadDocuments();
        loadSummary();
      }
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      setBusy(submit, false);
    }
  }

  /* ---------- trash ---------- */

  async function loadTrash() {
    const body = $("#trash-body");
    skeletonRows(body, 4, 3);
    $("#empty-trash").hidden = true;
    try {
      const result = await api("/documents/trash");
      body.replaceChildren(...result.documents.map((item) => {
        const row = el("tr");
        const nameCell = el("td");
        nameCell.append(documentCell(item));
        const categoryCell = el("td");
        categoryCell.append(pill(item.category, "neutral"));
        const actionsCell = el("td");
        const restore = el("button", "button button-secondary button-small");
        restore.type = "button";
        restore.append(icon("restore"), document.createTextNode(" Restore"));
        restore.addEventListener("click", () => restoreDocument(item, restore));
        const wrapper = el("div", "row-actions");
        wrapper.append(restore);
        actionsCell.append(wrapper);
        row.append(nameCell, categoryCell, el("td", "nowrap", `${formatDate(item.deletedAt, true)} · ${formatRelative(item.deletedAt)}`), actionsCell);
        return row;
      }));
      $("#empty-trash").hidden = result.documents.length !== 0;
    } catch (error) {
      body.replaceChildren();
      showEmpty("#empty-trash", "Could not load trash", error.message);
    }
  }

  async function restoreDocument(item, button) {
    setBusy(button, true, "Restoring…");
    try {
      await api(`/documents/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      toast(`"${item.name}" restored. Its previous grants apply again.`);
      loadTrash();
      loadSummary();
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  }

  /* ---------- overview (admin) ---------- */

  async function loadOverview() {
    try {
      const data = await api("/admin/overview");
      $("#ov-users").textContent = data.users.active;
      $("#ov-users-detail").textContent = `${data.users.byRole.admin} admin · ${data.users.byRole.owner} owners · ${data.users.byRole.viewer} viewers`;
      $("#ov-documents").textContent = data.documents.active;
      $("#ov-documents-detail").textContent = `${data.documents.deleted} in trash · ${data.last24h.uploads} uploaded today`;
      $("#ov-downloads").textContent = data.last24h.downloads;
      $("#ov-downloads-detail").textContent = `${data.last24h.reads} opens · ${data.last24h.permissionChanges} permission changes`;
      $("#ov-denied").textContent = data.last24h.denied;
      $("#ov-denied-detail").textContent = data.last24h.denied ? "Refused by the server" : "Nothing refused";
      $("#ov-rules").textContent = `Flags ≥${data.rules.deniedPerActor24h} refusals per person/day, ≥${data.rules.downloadsPerActor1h} downloads per person/hour, ≥${data.rules.failedLoginsPerEmail24h} failed sign-ins per email/day`;

      const alerts = $("#ov-alerts");
      if (!data.alerts.length) {
        const clear = el("div", "all-clear");
        clear.append(icon("check"), el("span", "", "Nothing unusual in the last 24 hours."));
        alerts.replaceChildren(clear);
      } else {
        alerts.replaceChildren(...data.alerts.map((alert) => {
          const item = el("div", `alert-item ${alert.severity}`);
          const copy = el("div");
          copy.append(el("strong", "", alert.title), el("p", "", alert.description));
          item.append(icon("alert"), copy);
          if (alert.actorId) {
            const view = el("button", "button button-quiet button-small", "View activity");
            view.style.marginLeft = "auto";
            view.addEventListener("click", async () => {
              switchPage("activity");
              await loadAuditActors();
              $("#audit-actor").value = alert.actorId;
              state.auditPage = 1;
              loadAudit();
            });
            item.append(view);
          }
          return item;
        }));
      }

      renderFeed("#ov-permissions", data.recentPermissionChanges, (event) => {
        const who = event.actor?.name || "System";
        const target = event.target?.email || event.target?.name || "someone";
        const verb = event.action === "permission_grant" ? `granted ${permissionLabel(event.permission).toLowerCase()} to ${target}`
          : event.action === "permission_revoke" ? `revoked ${target}'s access`
            : "transferred ownership";
        const extras = [event.expiresAt ? `until ${formatDate(event.expiresAt)}` : "", event.source === "suggestion" ? "from a suggestion" : ""].filter(Boolean).join(", ");
        return {
          text: `${who} ${verb}${extras ? ` (${extras})` : ""}`,
          meta: `doc …${String(event.documentId || "").slice(-6)} · ${formatRelative(event.occurredAt)}`,
          tone: "tone-amber",
          icon: ACTION_ICONS[event.action]
        };
      }, "No permission changes yet.");
      renderFeed("#ov-denied-list", data.recentDenied, (event) => ({
        text: `${event.actor?.name || "Unauthenticated request"} — ${String(event.reason || "refused").replaceAll("_", " ")}`,
        meta: `${event.path || ""} · ${formatRelative(event.occurredAt)}`,
        tone: "tone-red",
        icon: "alert"
      }), "No refused requests.");
    } catch (error) {
      $("#ov-alerts").replaceChildren(el("p", "form-error feed-empty", error.message));
    }
  }

  function renderFeed(selector, items, describe, emptyText) {
    const container = $(selector);
    if (!items.length) {
      container.replaceChildren(el("div", "feed-empty", emptyText));
      return;
    }
    container.replaceChildren(...items.map((item) => {
      const { text, meta, tone, icon: iconName } = describe(item);
      const row = el("div", "feed-item");
      const dot = el("span", `feed-dot ${tone}`);
      dot.append(icon(iconName || "activity"));
      const copy = el("div");
      copy.append(el("p", "", text), el("small", "", meta));
      row.append(dot, copy);
      return row;
    }));
  }

  /* ---------- audit (admin) ---------- */

  function auditQuery(page = state.auditPage, limit = state.auditLimit) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    for (const [key, selector] of [["action", "#audit-action"], ["outcome", "#audit-outcome"], ["actorId", "#audit-actor"], ["from", "#audit-from"], ["to", "#audit-to"]]) {
      const value = $(selector).value;
      if (value) params.set(key, value);
    }
    return params;
  }

  async function loadAuditActors() {
    try {
      const result = await api("/admin/users?page=1&limit=200");
      state.users = result.users;
      const select = $("#audit-actor");
      const selected = select.value;
      select.replaceChildren(new Option("Everyone", ""), ...result.users.map((user) => new Option(`${user.name} (${user.email})`, user.id)));
      select.value = selected;
    } catch {
      // Filter stays at "Everyone".
    }
  }

  async function loadAudit() {
    const body = $("#audit-body");
    skeletonRows(body, 7, 6);
    $("#empty-audit").hidden = true;
    try {
      const result = await api(`/admin/audit?${auditQuery()}`);
      state.auditTotal = result.total || 0;
      body.replaceChildren(...result.events.map(auditRow));
      $("#empty-audit").hidden = result.events.length !== 0;
      const start = state.auditTotal ? (state.auditPage - 1) * state.auditLimit + 1 : 0;
      $("#audit-page-summary").textContent = state.auditTotal
        ? `Showing ${start}–${Math.min(state.auditPage * state.auditLimit, state.auditTotal)} of ${state.auditTotal} events`
        : "No events";
      $("#audit-prev").disabled = state.auditPage <= 1;
      $("#audit-next").disabled = state.auditPage * state.auditLimit >= state.auditTotal;
    } catch (error) {
      body.replaceChildren();
      showEmpty("#empty-audit", "Could not load activity", error.message);
    }
  }

  function auditRow(event) {
    const row = el("tr");
    row.append(el("td", "mono", event.sequence));
    const actionCell = el("td", "nowrap");
    actionCell.append(el("strong", "", ACTION_LABELS[event.action] || event.action));
    row.append(actionCell);
    const actorCell = el("td");
    if (event.actorId) {
      actorCell.append(el("strong", "doc-name", event.actorId.name), el("small", "doc-meta", event.actorId.email));
    } else {
      actorCell.append(el("span", "small-text", "No session"));
    }
    row.append(actorCell);
    row.append(el("td", "mono", event.documentId ? `…${String(event.documentId).slice(-8)}` : event.details?.requestedDocumentId ? `…${String(event.details.requestedDocumentId).slice(-8)}` : "—"));
    const outcome = el("td");
    outcome.append(pill(event.outcome, event.outcome));
    row.append(outcome);
    const detailsCell = el("td", "small-text", auditDetails(event.details));
    detailsCell.style.maxWidth = "360px";
    row.append(detailsCell);
    row.append(el("td", "nowrap small-text", formatDate(event.occurredAt, true)));
    return row;
  }

  // One-line summary of what an administrator needs to judge an event.
  function auditDetails(details = {}) {
    const parts = [];
    if (details.reason) parts.push(String(details.reason).replaceAll("_", " "));
    if (details.requestedPermission) parts.push(`wanted ${details.requestedPermission}`);
    if (details.targetEmail) parts.push(details.targetEmail);
    else if (details.targetUserId) parts.push(`user …${String(details.targetUserId).slice(-6)}`);
    if (details.permission) parts.push(`${details.previousPermission ? `${details.previousPermission} → ` : ""}${details.permission}`);
    if (details.expiresAt) parts.push(`until ${formatDate(details.expiresAt)}`);
    if (details.source === "suggestion") parts.push("from suggestion");
    if (details.revokedPermission) parts.push(`revoked ${details.revokedPermission}`);
    if (details.changedFields) parts.push(`changed ${details.changedFields.join(", ")}`);
    if (details.version) parts.push(`v${details.version}`);
    if (details.email) parts.push(details.email);
    if (details.resultCount !== undefined) parts.push(`${details.resultCount} results`);
    if (details.path && !details.requestedDocumentId && !details.reason?.includes("login")) parts.push(details.path);
    return parts.join(" · ") || "—";
  }

  async function verifyAudit() {
    const button = $("#verify-audit");
    const banner = $("#audit-integrity");
    setBusy(button, true, "Verifying…");
    try {
      const result = await api("/admin/audit/verify");
      banner.className = "integrity-banner valid";
      banner.replaceChildren(icon("check"), el("span", "", `Audit chain intact — ${result.eventCount} events verified in sequence. Head hash ${result.headHash}`));
    } catch (error) {
      banner.className = "integrity-banner invalid";
      banner.replaceChildren(icon("alert"), el("span", "", `Audit chain verification FAILED: ${error.message}`));
    } finally {
      banner.hidden = false;
      setBusy(button, false);
    }
  }

  async function exportAudit() {
    const button = $("#export-audit");
    setBusy(button, true, "Exporting…");
    try {
      const rows = [["sequence", "occurredAt", "action", "outcome", "actorName", "actorEmail", "documentId", "details", "hash", "previousHash"]];
      for (let page = 1; page <= 25; page += 1) {
        const result = await api(`/admin/audit?${auditQuery(page, 200)}`);
        for (const event of result.events) {
          rows.push([
            event.sequence, event.occurredAt, event.action, event.outcome,
            event.actorId?.name || "", event.actorId?.email || "", event.documentId || "",
            JSON.stringify(event.details || {}), event.hash, event.previousHash
          ]);
        }
        if (page * 200 >= result.total) break;
      }
      // Prefix cells that a spreadsheet would treat as formulas.
      const csv = rows.map((row) => row.map((cell) => {
        let value = String(cell ?? "");
        if (/^[=+\-@]/.test(value)) value = `'${value}`;
        return `"${value.replaceAll('"', '""')}"`;
      }).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = el("a");
      link.href = url;
      link.download = `trustvault-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Exported ${rows.length - 1} events.`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  /* ---------- people (admin) ---------- */

  async function loadUsers() {
    const body = $("#users-body");
    skeletonRows(body, 6, 5);
    $("#empty-users").hidden = true;
    try {
      const role = $("#users-role").value;
      const result = await api(`/admin/users?page=1&limit=200${role ? `&role=${role}` : ""}`);
      state.users = result.users;
      body.replaceChildren(...result.users.map(userRow));
      $("#empty-users").hidden = result.users.length !== 0;
    } catch (error) {
      body.replaceChildren();
      showEmpty("#empty-users", "Could not load people", error.message);
    }
  }

  function userRow(user) {
    const row = el("tr");
    const personCell = el("td");
    const person = el("div", "document-cell");
    person.append(avatar(user.name));
    const copy = el("span");
    copy.append(el("strong", "doc-name", user.name), el("small", "doc-meta", user.email));
    person.append(copy);
    personCell.append(person);
    const roleCell = el("td");
    roleCell.append(pill(user.role === "owner" ? "Owner" : user.role === "admin" ? "Admin" : "Viewer", user.role));
    const statusCell = el("td");
    statusCell.append(pill(user.active ? "Active" : "Inactive", user.active ? "active" : "inactive"));
    const ownsCell = el("td", "small-text", user.role === "owner" || user.ownedDocuments ? `${user.ownedDocuments} document${user.ownedDocuments === 1 ? "" : "s"}` : "—");
    const actionsCell = el("td");
    const actions = el("div", "row-actions");
    if (user.ownedDocuments > 0) {
      actions.append(rowAction("Transfer documents", "transfer", () => openTransfer(user)));
    }
    actions.append(rowAction("Reset password", "key", () => openResetPassword(user)));
    if (user.id !== state.user.id) {
      actions.append(rowAction(user.active ? "Deactivate" : "Activate", user.active ? "x" : "check", () => setUserActive(user, !user.active), user.active));
    }
    actionsCell.append(actions);
    row.append(personCell, roleCell, statusCell, ownsCell, el("td", "nowrap small-text", formatDate(user.createdAt)), actionsCell);
    return row;
  }

  async function setUserActive(user, active) {
    const ok = await confirmAction({
      title: `${active ? "Activate" : "Deactivate"} ${user.name}?`,
      message: active
        ? "They will be able to sign in again. Their old document grants are not restored."
        : "They are signed out everywhere immediately and every document grant they hold is removed.",
      confirmLabel: active ? "Activate" : "Deactivate",
      danger: !active
    });
    if (!ok) return;
    try {
      await api(`/admin/users/${encodeURIComponent(user.id)}/active`, { method: "PATCH", body: { active } });
      toast(`${user.name} ${active ? "activated" : "deactivated"}.`);
      loadUsers();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openResetPassword(user) {
    state.targetUser = user;
    $("#reset-password-copy").textContent = `Set a new temporary password for ${user.name}. All of their sessions end immediately.`;
    $("#reset-password-error").textContent = "";
    $("#reset-password-form").reset();
    $("#reset-password-dialog").showModal();
  }

  async function submitResetPassword(event) {
    event.preventDefault();
    try {
      await api(`/admin/users/${encodeURIComponent(state.targetUser.id)}/password`, {
        method: "POST",
        body: { password: $("#reset-password").value }
      });
      $("#reset-password-dialog").close();
      toast(`Password reset for ${state.targetUser.name}.`);
    } catch (error) {
      $("#reset-password-error").textContent = error.message;
    }
  }

  async function openTransfer(user) {
    state.targetUser = user;
    $("#transfer-copy").textContent = `Move all ${user.ownedDocuments} document(s) owned by ${user.name}, including any in trash, to another owner. You will not see their names or contents.`;
    $("#transfer-error").textContent = "";
    const result = await api("/admin/users?page=1&limit=200&role=owner").catch(() => ({ users: [] }));
    const candidates = result.users.filter((candidate) => candidate.active && candidate.id !== user.id);
    $("#transfer-target").replaceChildren(...candidates.map((candidate) => new Option(`${candidate.name} (${candidate.email})`, candidate.id)));
    if (!candidates.length) $("#transfer-error").textContent = "There is no other active document owner to receive them.";
    $("#transfer-dialog").showModal();
  }

  async function submitTransfer(event) {
    event.preventDefault();
    const toUserId = $("#transfer-target").value;
    if (!toUserId) return;
    try {
      const result = await api(`/admin/users/${encodeURIComponent(state.targetUser.id)}/transfer-documents`, {
        method: "POST",
        body: { toUserId }
      });
      $("#transfer-dialog").close();
      toast(`${result.transferred} document(s) transferred.`);
      loadUsers();
    } catch (error) {
      $("#transfer-error").textContent = error.message;
    }
  }

  async function submitCreateUser(event) {
    event.preventDefault();
    const errorNode = $("#create-user-error");
    errorNode.textContent = "";
    const form = $("#create-user-form");
    try {
      await api("/admin/users", { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
      $("#create-user-dialog").close();
      form.reset();
      toast("Account created.");
      loadUsers();
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  /* ---------- wiring ---------- */

  function debounced(fn) {
    return () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(fn, 280);
    };
  }

  function bindEvents() {
    $("#login-form").addEventListener("submit", login);
    $("#toggle-password").addEventListener("click", () => {
      const input = $("#login-password");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      const toggle = $("#toggle-password");
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
      toggle.title = show ? "Hide password" : "Show password";
      $("use", toggle).setAttribute("href", show ? "#i-eye-off" : "#i-eye");
    });
    $("#upload-form").addEventListener("submit", submitUpload);
    $("#edit-form").addEventListener("submit", submitEdit);
    $("#share-form").addEventListener("submit", submitShare);
    $("#version-form").addEventListener("submit", submitVersion);
    $("#create-user-form").addEventListener("submit", submitCreateUser);
    $("#reset-password-form").addEventListener("submit", submitResetPassword);
    $("#transfer-form").addEventListener("submit", submitTransfer);
    $("#password-form").addEventListener("submit", submitPassword);

    $$(".nav-link").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.nav)));
    $$(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));

    $("#account-button").addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("#account-menu");
      menu.hidden = !menu.hidden;
      $("#account-button").setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".account")) closeAccountMenu();
    });
    $("#logout-button").addEventListener("click", logout);
    $("#open-password").addEventListener("click", () => {
      closeAccountMenu();
      $("#password-form").reset();
      $("#password-error").textContent = "";
      $("#password-dialog").showModal();
    });

    $("#upload-open").addEventListener("click", () => {
      $("#upload-error").textContent = "";
      $("#upload-dialog").showModal();
    });
    $("#upload-file").addEventListener("change", (event) => setUploadFile(event.target.files[0]));
    const dropzone = $("#dropzone");
    ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove("is-dragging")));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!file) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      $("#upload-file").files = transfer.files;
      setUploadFile(file);
    });
    $("#version-file").addEventListener("change", (event) => {
      const file = event.target.files[0];
      $("#version-file-label").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "Choose a new version…";
    });

    $("#detail-download").addEventListener("click", (event) => {
      if (state.selected) downloadDocument(state.selected, null, event.currentTarget);
    });
    $("#detail-edit").addEventListener("click", () => {
      $("#edit-name").value = state.selected.name;
      $("#edit-category").value = state.selected.category || "";
      $("#edit-error").textContent = "";
      $("#edit-dialog").showModal();
    });
    $("#detail-delete").addEventListener("click", deleteSelected);
    $("#load-suggestions").addEventListener("click", loadSuggestions);

    const reloadDocuments = () => { state.docPage = 1; loadDocuments(); };
    $("#search-name").addEventListener("input", debounced(reloadDocuments));
    $("#filter-owner").addEventListener("input", debounced(reloadDocuments));
    ["#filter-category", "#filter-from", "#filter-to"].forEach((selector) => $(selector).addEventListener("change", reloadDocuments));
    $("#filter-reset").addEventListener("click", () => {
      ["#search-name", "#filter-owner", "#filter-category", "#filter-from", "#filter-to"].forEach((selector) => { $(selector).value = ""; });
      reloadDocuments();
    });
    $("#refresh-documents").addEventListener("click", () => { loadDocuments(); loadSummary(); });
    $("#prev-page").addEventListener("click", () => { state.docPage -= 1; loadDocuments(); });
    $("#next-page").addEventListener("click", () => { state.docPage += 1; loadDocuments(); });

    const reloadAudit = () => { state.auditPage = 1; loadAudit(); };
    ["#audit-action", "#audit-outcome", "#audit-actor", "#audit-from", "#audit-to"].forEach((selector) => $(selector).addEventListener("change", reloadAudit));
    $("#audit-reset").addEventListener("click", () => {
      ["#audit-action", "#audit-outcome", "#audit-actor", "#audit-from", "#audit-to"].forEach((selector) => { $(selector).value = ""; });
      reloadAudit();
    });
    $("#audit-prev").addEventListener("click", () => { state.auditPage -= 1; loadAudit(); });
    $("#audit-next").addEventListener("click", () => { state.auditPage += 1; loadAudit(); });
    $("#verify-audit").addEventListener("click", verifyAudit);
    $("#export-audit").addEventListener("click", exportAudit);
    $("#overview-refresh").addEventListener("click", loadOverview);

    $("#users-role").addEventListener("change", loadUsers);
    $("#create-user-open").addEventListener("click", () => {
      $("#create-user-error").textContent = "";
      $("#create-user-dialog").showModal();
    });

    $("#mobile-menu").addEventListener("click", () => {
      $("#sidebar").classList.add("is-open");
      $("#sidebar-scrim").classList.add("is-open");
    });
    $("#sidebar-scrim").addEventListener("click", () => {
      $("#sidebar").classList.remove("is-open");
      $("#sidebar-scrim").classList.remove("is-open");
    });
    $$("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
    $$(".modal").forEach((dialog) => dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    }));
  }

  async function initialize() {
    bindEvents();
    AUDIT_ACTIONS.forEach((action) => $("#audit-action").add(new Option(ACTION_LABELS[action], action)));
    try {
      const result = await api("/auth/me");
      showApp(result.user);
    } catch {
      showLogin();
    }
  }

  initialize();
})();
