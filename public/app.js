// Minimal client for the OrchestraWriter MVP. No build step.
// Talks to Better Auth's REST endpoints under /api/auth and our file routes under /api/files.
// Sessions are HttpOnly cookies set by the server; the browser sends them automatically.

const $ = (sel) => document.querySelector(sel);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `${res.status} ${res.statusText}`);
  return data;
}

function show(el, on) { el.hidden = !on; }
function setError(sel, msg) { $(sel).textContent = msg || ""; }

// ---------- auth ----------

async function refreshSession() {
  const data = await api("GET", "/api/auth/get-session");
  const user = data && data.user;
  show($("#auth"), !user);
  show($("#app"), !!user);
  if (user) {
    $("#who").textContent = user.name ? `${user.name} (${user.email})` : user.email;
    await loadFiles();
  }
  return user;
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    show($("#signin-form"), btn.dataset.tab === "signin");
    show($("#signup-form"), btn.dataset.tab === "signup");
    setError("#auth-error", "");
  });
});

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  setError("#auth-error", "");
  try {
    await api("POST", "/api/auth/sign-in/email", { email: f.get("email"), password: f.get("password") });
    e.target.reset();
    await refreshSession();
  } catch (err) { setError("#auth-error", err.message); }
});

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  setError("#auth-error", "");
  try {
    await api("POST", "/api/auth/sign-up/email", {
      name: f.get("name"), email: f.get("email"), password: f.get("password"),
    });
    e.target.reset();
    await refreshSession();
  } catch (err) { setError("#auth-error", err.message); }
});

$("#google-btn").addEventListener("click", async () => {
  setError("#auth-error", "");
  try {
    // Better Auth returns the Google consent URL; we navigate there. Google sends the
    // user back to /api/auth/callback/google, which sets the cookie and redirects to callbackURL.
    const data = await api("POST", "/api/auth/sign-in/social", { provider: "google", callbackURL: "/" });
    if (data && data.url) window.location.href = data.url;
  } catch (err) { setError("#auth-error", err.message); }
});

$("#signout").addEventListener("click", async () => {
  try { await api("POST", "/api/auth/sign-out", {}); } catch { /* cookie is gone either way */ }
  await refreshSession();
});

// ---------- files ----------

function fmtDuration(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

async function loadFiles() {
  setError("#app-error", "");
  const list = $("#files");
  list.textContent = "";
  try {
    const { files } = await api("GET", "/api/files");
    show($("#files-empty"), files.length === 0);
    for (const f of files) list.appendChild(renderFile(f));
  } catch (err) { setError("#app-error", err.message); }
}

function renderFile(f) {
  const li = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = f.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${fmtDuration(f.audioLengthSeconds)} · ${new Date(f.createdAt).toLocaleString()}`;
  const actions = document.createElement("div");
  actions.className = "actions";

  const play = document.createElement("button");
  play.type = "button"; play.className = "secondary"; play.textContent = "Play";
  play.addEventListener("click", async () => {
    try {
      const { url } = await api("GET", `/api/files/${f.id}/download-url`);
      let audio = li.querySelector("audio");
      if (!audio) { audio = document.createElement("audio"); audio.controls = true; li.appendChild(audio); }
      audio.src = url;
      audio.play().catch(() => {});
    } catch (err) { setError("#app-error", err.message); }
  });

  const del = document.createElement("button");
  del.type = "button"; del.className = "danger"; del.textContent = "Delete";
  del.addEventListener("click", async () => {
    del.disabled = true;
    try { await api("DELETE", `/api/files/${f.id}`); li.remove(); }
    catch (err) { setError("#app-error", err.message); del.disabled = false; }
  });

  actions.append(play, del);
  li.append(title, meta, actions);
  return li;
}

/** Read the duration of an audio file in the browser so the server never has to decode it. */
function audioDurationSeconds(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (secs) => { URL.revokeObjectURL(url); resolve(secs); };
    a.addEventListener("loadedmetadata", () => done(Number.isFinite(a.duration) ? a.duration : 0));
    a.addEventListener("error", () => done(0));
    a.src = url;
  });
}

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const file = form.elements.file.files[0];
  if (!file) return;
  const name = (form.elements.name.value || file.name).trim().slice(0, 100);
  const button = form.querySelector("button");
  const status = $("#upload-status");
  setError("#app-error", "");
  button.disabled = true;
  try {
    status.textContent = "Reading duration…";
    const seconds = Math.max(1, Math.round(await audioDurationSeconds(file)));
    const contentType = file.type || "application/octet-stream";

    status.textContent = "Requesting upload URL…";
    const { uploadUrl, key } = await api("POST", "/api/files/upload-url", { filename: file.name, contentType });

    status.textContent = "Uploading to S3…";
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
    if (!put.ok) throw new Error(`S3 upload failed: ${put.status}`);

    status.textContent = "Saving…";
    await api("POST", "/api/files", { name, key, audioLengthSeconds: seconds });

    form.reset();
    status.textContent = "Uploaded.";
    await loadFiles();
  } catch (err) {
    status.textContent = "";
    setError("#app-error", err.message);
  } finally {
    button.disabled = false;
  }
});

// ---------- boot ----------

(async () => {
  try {
    const cfg = await api("GET", "/api/config");
    show($("#google"), !!cfg.googleEnabled);
  } catch { /* leave Google hidden */ }
  // Google callback errors arrive as ?error=... on the callbackURL.
  const params = new URLSearchParams(location.search);
  if (params.get("error")) setError("#auth-error", `Sign-in failed: ${params.get("error")}`);
  try { await refreshSession(); }
  catch (err) { show($("#auth"), true); setError("#auth-error", err.message); }
})();
