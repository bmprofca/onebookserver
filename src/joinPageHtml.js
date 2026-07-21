/**
 * Public QR join page HTML — customer scans shop QR, picks device contact, saves once.
 */
export function buildJoinPageHtml({ appId, shopName }) {
  const safeAppId = String(appId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const safeShop = String(shopName || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const title = safeShop ? `Join ${safeShop}` : 'Join shop'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#1e40af" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    body { margin: 0; min-height: 100dvh; background: linear-gradient(180deg,#eff6ff,#f8fafc); color:#0f172a; }
    main { max-width: 420px; margin: 0 auto; padding: 1.35rem 1.1rem calc(1.5rem + env(safe-area-inset-bottom)); }
    .card { background:#fff; border:1px solid rgba(15,23,42,.08); border-radius:20px; padding:1.25rem; box-shadow:0 12px 40px rgba(30,64,175,.08); }
    .brand { font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; color:#1e40af; font-weight:700; margin-bottom:.45rem; }
    h1 { margin:0 0 .35rem; font-size:1.3rem; line-height:1.25; }
    .lead { margin:0 0 1.1rem; color:#64748b; line-height:1.45; font-size:.9rem; }
    button { width:100%; border:0; border-radius:14px; padding:.9rem 1rem; font:inherit; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .btn-primary { background:#2563eb; color:#fff; }
    .btn-contact { background:linear-gradient(135deg,#1e40af,#2563eb); color:#fff; text-align:left; display:flex; gap:.75rem; align-items:center; margin-bottom:.85rem; box-shadow:0 8px 22px rgba(37,99,235,.28); }
    .btn-contact .ico { flex-shrink:0; width:2.4rem; height:2.4rem; border-radius:12px; background:rgba(255,255,255,.18); display:flex; align-items:center; justify-content:center; font-size:1.2rem; }
    .btn-contact strong { display:block; font-size:.98rem; }
    .btn-contact span { display:block; font-size:.75rem; font-weight:500; opacity:.9; margin-top:.15rem; }
    .preview { display:none; margin:0 0 1rem; padding:.9rem; border-radius:14px; background:#f0fdf4; border:1px solid rgba(5,150,105,.28); }
    .preview.show { display:block; }
    .preview .row { display:flex; justify-content:space-between; gap:.75rem; padding:.35rem 0; font-size:.9rem; }
    .preview .row + .row { border-top:1px solid rgba(5,150,105,.15); }
    .preview dt { margin:0; color:#64748b; font-weight:600; font-size:.78rem; }
    .preview dd { margin:0; font-weight:700; text-align:right; word-break:break-word; }
    .manual { display:none; margin-top:.5rem; }
    .manual.open { display:block; }
    .manual-toggle { background:transparent; color:#1e40af; font-weight:650; font-size:.85rem; padding:.55rem 0; margin:0 0 .35rem; text-align:center; }
    label { display:block; margin:0 0 .85rem; font-size:.85rem; font-weight:600; }
    input { width:100%; margin-top:.35rem; box-sizing:border-box; border:1px solid rgba(15,23,42,.12); border-radius:12px; padding:.75rem .85rem; font:inherit; background:#fff; }
    input.filled { background:#f0fdf4; border-color:rgba(5,150,105,.35); }
    .err { color:#dc2626; margin:.55rem 0 0; font-size:.85rem; }
    .ok { color:#059669; margin:.55rem 0 0; font-size:.9rem; font-weight:650; line-height:1.4; }
    .hint { margin:.35rem 0 0; font-size:.75rem; color:#94a3b8; line-height:1.4; text-align:center; }
    [hidden] { display:none !important; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <div class="brand">OneBook</div>
      <h1 id="title">${safeShop ? `Join ${safeShop}` : 'Join shop'}</h1>
      <p class="lead" id="lead">${
        safeShop
          ? 'Pull your name &amp; mobile from this phone, then tap Save.'
          : 'Loading shop…'
      }</p>

      <form id="form">
        <button type="button" class="btn-contact" id="pickContact">
          <span class="ico" aria-hidden>👤</span>
          <span>
            <strong>Use my contact from this phone</strong>
            <span>Name &amp; mobile autofill from device contacts</span>
          </span>
        </button>

        <div class="preview" id="preview" aria-live="polite">
          <div class="row"><dt>Name</dt><dd id="previewName">—</dd></div>
          <div class="row"><dt>Mobile</dt><dd id="previewPhone">—</dd></div>
        </div>

        <button type="submit" class="btn-primary" id="submit" disabled>Save to shop</button>
        <p class="hint" id="saveHint">Select your contact first — then tap Save once.</p>

        <button type="button" class="manual-toggle" id="manualToggle">Enter name &amp; mobile manually</button>
        <div class="manual" id="manual">
          <label>Name
            <input id="name" name="name" maxlength="60" autocomplete="name" placeholder="Your name" />
          </label>
          <label>Mobile
            <input id="phone" name="phone" inputmode="tel" maxlength="10" pattern="[0-9]{10}" autocomplete="tel" placeholder="10-digit mobile" />
          </label>
        </div>

        <p class="err" id="error" hidden></p>
        <p class="ok" id="success" hidden></p>
      </form>
    </div>
  </main>
  <script>
    const appId = ${JSON.stringify(safeAppId)};
    const form = document.getElementById('form');
    const errorEl = document.getElementById('error');
    const successEl = document.getElementById('success');
    const submitBtn = document.getElementById('submit');
    const pickBtn = document.getElementById('pickContact');
    const nameEl = document.getElementById('name');
    const phoneEl = document.getElementById('phone');
    const titleEl = document.getElementById('title');
    const leadEl = document.getElementById('lead');
    const preview = document.getElementById('preview');
    const previewName = document.getElementById('previewName');
    const previewPhone = document.getElementById('previewPhone');
    const manual = document.getElementById('manual');
    const manualToggle = document.getElementById('manualToggle');
    const saveHint = document.getElementById('saveHint');
    let shopLabel = '';

    function digitsOnly(value) {
      return String(value || '').replace(/\\D/g, '');
    }
    function normalizePhone(raw) {
      const digits = digitsOnly(raw);
      if (digits.length === 10) return digits;
      if (digits.length > 10) return digits.slice(-10);
      return digits;
    }
    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      successEl.hidden = true;
    }
    function clearError() {
      errorEl.hidden = true;
    }
    function contactsSupported() {
      return !!(navigator.contacts && typeof navigator.contacts.select === 'function');
    }
    function refreshSaveState() {
      const name = nameEl.value.trim();
      const phone = normalizePhone(phoneEl.value);
      const ready = name.length > 0 && phone.length === 10;
      submitBtn.disabled = !ready;
      if (ready) {
        preview.classList.add('show');
        previewName.textContent = name;
        previewPhone.textContent = phone;
        nameEl.classList.add('filled');
        phoneEl.classList.add('filled');
        saveHint.textContent = 'Looks good — tap Save to join ' + (shopLabel || 'this shop') + '.';
        submitBtn.textContent = 'Save to shop';
      } else {
        if (!name && !phone) preview.classList.remove('show');
        saveHint.textContent = contactsSupported()
          ? 'Select your contact first — then tap Save once.'
          : 'Enter your name and 10-digit mobile, then tap Save.';
      }
    }
    function applyContact(name, phone) {
      const mobile = normalizePhone(phone);
      if (name) nameEl.value = String(name).trim().slice(0, 60);
      if (mobile) phoneEl.value = mobile.slice(0, 10);
      refreshSaveState();
    }

    async function pickFromDevice() {
      clearError();
      if (!contactsSupported()) {
        manual.classList.add('open');
        manualToggle.textContent = 'Hide manual entry';
        showError('Open this page in Chrome on Android to use contacts, or type below.');
        nameEl.focus();
        return;
      }
      try {
        pickBtn.disabled = true;
        const selected = await navigator.contacts.select(['name', 'tel'], { multiple: false });
        const first = selected && selected[0];
        if (!first) return;
        const name = (first.name && first.name[0]) || '';
        const tel = (first.tel && first.tel.find(Boolean)) || '';
        applyContact(name, tel);
        const mobile = normalizePhone(tel);
        if (mobile.length !== 10) {
          manual.classList.add('open');
          showError('Selected contact needs a valid 10-digit mobile. Fix the number, then Save.');
          phoneEl.focus();
          return;
        }
        if (!nameEl.value.trim()) {
          manual.classList.add('open');
          showError('Add your name, then tap Save.');
          nameEl.focus();
          return;
        }
        // Ready — user confirms with Save (no silent auto-post)
        submitBtn.focus();
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel|abort/i.test(String(err.message || '')))) return;
        showError(err.message || 'Could not open contacts on this phone');
        manual.classList.add('open');
      } finally {
        pickBtn.disabled = false;
      }
    }

    async function loadShop() {
      try {
        const res = await fetch('/api/public/join/' + encodeURIComponent(appId));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Shop not found');
        shopLabel = data.shopName;
        titleEl.textContent = 'Join ' + data.shopName;
        leadEl.textContent = contactsSupported()
          ? 'Tap “Use my contact” — your name & mobile fill from this phone. Then tap Save once.'
          : 'Enter your name and mobile to connect with ' + data.shopName + '.';
        if (!contactsSupported()) {
          pickBtn.querySelector('strong').textContent = 'Contacts not available here';
          pickBtn.querySelector('span span').textContent = 'Use Chrome on Android, or enter manually below';
          manual.classList.add('open');
          manualToggle.textContent = 'Hide manual entry';
        } else {
          setTimeout(function () { pickBtn.focus(); }, 200);
        }
        refreshSaveState();
      } catch (err) {
        titleEl.textContent = 'Shop not found';
        leadEl.textContent = err.message || 'Invalid QR code';
        form.hidden = true;
      }
    }

    pickBtn.addEventListener('click', function () { void pickFromDevice(); });
    manualToggle.addEventListener('click', function () {
      const open = manual.classList.toggle('open');
      manualToggle.textContent = open ? 'Hide manual entry' : 'Enter name & mobile manually';
      if (open) nameEl.focus();
    });
    nameEl.addEventListener('input', refreshSaveState);
    phoneEl.addEventListener('input', function () {
      phoneEl.value = normalizePhone(phoneEl.value).slice(0, 10);
      refreshSaveState();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError();
      successEl.hidden = true;
      const name = nameEl.value.trim();
      const phone = normalizePhone(phoneEl.value);
      if (!name) { showError('Name is required'); return; }
      if (phone.length !== 10) { showError('Enter a valid 10-digit mobile number'); return; }
      submitBtn.disabled = true;
      pickBtn.disabled = true;
      try {
        const res = await fetch('/api/public/join/' + encodeURIComponent(appId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, phone }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not connect');
        form.querySelectorAll('input,button').forEach((el) => { el.disabled = true; });
        successEl.textContent = data.message || 'Connected successfully';
        successEl.hidden = false;
        submitBtn.textContent = 'Saved';
        saveHint.hidden = true;
        leadEl.textContent = 'Your contact was saved to the shop database.';
      } catch (err) {
        showError(err.message || 'Could not connect');
        submitBtn.disabled = false;
        pickBtn.disabled = false;
        refreshSaveState();
      }
    });

    loadShop();
  </script>
</body>
</html>`
}
