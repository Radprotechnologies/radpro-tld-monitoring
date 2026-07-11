/* global Chart, XLSX, pdfjsLib */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.14.305/pdf.worker.min.js';
}

const state = {
  me: null,
  employees: [],
  doses: [],
  attachments: [],
  acknowledgements: [],
  settings: {},
  audit: [],
  auditPagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
  auditFilters: { modules: [] },
  periods: [],
  investigations: [],
  overexposureCases: [],
  reminderLogs: [],
  notifications: [],
  notificationRecipients: [],
  rscMembers: [],
  rscMeetings: [],
  rscDocuments: [],
  organizations: [],
  hospitals: [],
  departments: [],
  awarenessStatus: null,
  trainingModule: null,
  trainingQuiz: null,
  trainingAdminQuestions: null,
  trainingResults: [],
  trainingSelectedAnswers: {},
  trainingStartedAt: null,
  pending2FA: false,
  chart: null
};

let tenancyPanelOriginalHTML = '';
let tenancySearchText = '';
let tenancyPage = 1;
const tenancyPageSize = 5;

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeJS(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' '); }

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function setMsg(id, text, ok = true) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden', 'text-emerald-300', 'text-red-400', 'text-slate-400');
  el.classList.add(ok ? 'text-emerald-300' : 'text-red-400');
}

function clearMsg(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="px-2 py-6 text-center text-slate-500">${escapeHTML(text)}</td></tr>`;
}

function fmtDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function currentQuarterLabel(date = new Date()) {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `Q${q} ${date.getFullYear()}`;
}

function quarterToSortKey(q) {
  const text = String(q || '');
  const qMatch = text.match(/Q([1-4])\s*(20\d{2}|19\d{2})/i);
  if (qMatch) return Number(qMatch[2]) * 10 + Number(qMatch[1]);
  const yMatch = text.match(/(20\d{2}|19\d{2})/);
  const year = yMatch ? Number(yMatch[1]) : 0;
  const monthMap = { jan: 1, feb: 1, mar: 1, apr: 2, may: 2, jun: 2, jul: 3, aug: 3, sep: 3, oct: 4, nov: 4, dec: 4 };
  const m = text.toLowerCase().match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/);
  return year * 10 + (m ? monthMap[m[0]] : 0);
}

function getYearFromText(value) {
  const match = String(value || '').match(/(20\d{2}|19\d{2})/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function buildQuarterLabels(startYear = 2000) {
  const labels = [];
  const d = new Date();
  const currentYear = d.getFullYear();
  const currentQ = Math.floor(d.getMonth() / 3) + 1;
  for (let year = currentYear; year >= startYear; year -= 1) {
    const maxQ = year === currentYear ? currentQ : 4;
    for (let q = maxQ; q >= 1; q -= 1) {
      labels.push(`Q${q} ${year}`);
    }
  }
  return labels;
}

function collectQuarterOptions() {
  const set = new Set(buildQuarterLabels(2000));
  state.doses.forEach(d => set.add(d.quarter || d.period || 'Not specified'));
  state.attachments.forEach(a => { if (a.quarter) set.add(a.quarter); });
  return Array.from(set).filter(Boolean).sort((a, b) => quarterToSortKey(b) - quarterToSortKey(a) || String(b).localeCompare(String(a)));
}


function latestDoseQuarterLabel() {
  const doseQuarters = state.doses.map(d => d.quarter).filter(Boolean);
  if (!doseQuarters.length) return currentQuarterLabel();
  return doseQuarters.sort((a, b) => quarterToSortKey(b) - quarterToSortKey(a) || String(b).localeCompare(String(a)))[0];
}

function populateQuarterSelects() {
  const quarters = collectQuarterOptions();
  $$('[data-quarter-select="true"]').forEach((select) => {
    const defaultQuarter = select.id === 'complianceQuarter' ? latestDoseQuarterLabel() : currentQuarterLabel();
    const prev = select.value || defaultQuarter;
    select.innerHTML = quarters.map(q => `<option value="${escapeHTML(q)}">${escapeHTML(q)}</option>`).join('');
    select.value = quarters.includes(prev) ? prev : (quarters.includes(defaultQuarter) ? defaultQuarter : currentQuarterLabel());
  });
  const docQ = $('docFilterQuarter');
  if (docQ) {
    const prev = docQ.value || 'all';
    docQ.innerHTML = `<option value="all">All quarters</option>` + quarters.map(q => `<option value="${escapeHTML(q)}">${escapeHTML(q)}</option>`).join('');
    docQ.value = quarters.includes(prev) || prev === 'all' ? prev : 'all';
  }
  const hero = $('heroCurrentQuarter');
  if (hero) hero.textContent = currentQuarterLabel();
}

function employeeName(id) {
  const emp = state.employees.find(e => e.id === id);
  return emp ? emp.name : '—';
}

function docTypeLabel(type) {
  if (type === 'employeeForm') return 'Employee Form';
  if (type === 'quarterReport') return 'Quarter Report';
  return 'General';
}


function canAccessAdmin() {
  return ['sysadmin','org_admin','admin', 'rso', 'auditor'].includes(String(state.me?.accessRole || (state.me?.isRSO ? 'rso' : 'employee')).toLowerCase());
}

function canEditAdmin() {
  return ['sysadmin','org_admin','admin', 'rso'].includes(String(state.me?.accessRole || (state.me?.isRSO ? 'rso' : 'employee')).toLowerCase());
}

function currentAccessRole() {
  const username = String(state.me?.username || '').toLowerCase().trim();
  const clinicalRole = String(state.me?.role || '').toLowerCase().trim();
  const rawAccess = String(state.me?.accessRole || '').toLowerCase().trim();

  // Phase 2B.1: PostgreSQL compatibility can return older/legacy rows where
  // the primary Radpro account is still flagged as RSO. Never route the
  // protected Radpro account through the hospital/RSO command center.
  if (username === 'radpro' || clinicalRole.includes('radpro super admin') || clinicalRole.includes('radpro panel admin') || RADPRO_INTERNAL_ROLES.some(r => clinicalRole === r.toLowerCase())) return 'sysadmin';

  if (['sysadmin','org_admin','admin','rso','auditor','employee'].includes(rawAccess)) return rawAccess;
  if (username === 'rso' || state.me?.isRSO || clinicalRole === 'rso') return 'rso';
  return 'employee';
}
function normalizeCurrentUserRole() {
  if (!state.me) return;
  const uname = String(state.me.username || '').toLowerCase().trim();
  const role = String(state.me.role || '').toLowerCase().trim();
  if (uname === 'radpro' || role.includes('radpro super admin') || role.includes('radpro panel admin')) {
    state.me.accessRole = 'sysadmin';
    state.me.role = state.me.role || 'Radpro Super Admin';
    state.me.isRSO = true;
    state.me.organizationId = '';
    state.me.hospitalId = '';
  }
}

function forceTabVisibilityForRole() {
  normalizeCurrentUserRole();
  const role = currentAccessRole();
  const isSysadmin = role === 'sysadmin';
  const isOrgAdmin = role === 'org_admin';
  const allowed = isSysadmin
    ? new Set(['tabTenancy', 'tabRadproUsers'])
    : new Set($$('.admin-tab').map(btn => btn.dataset.tab).filter(Boolean));
  if (!isSysadmin) allowed.delete('tabRadproUsers');
  if (!isSysadmin && !isOrgAdmin) allowed.delete('tabTenancy');

  $$('.admin-tab').forEach(btn => {
    const show = allowed.has(btn.dataset.tab);
    btn.classList.toggle('hidden', !show);
    if (!show) btn.classList.remove('tab-active');
  });
  $$('.admin-tab-panel').forEach(panel => {
    if (!allowed.has(panel.id)) panel.classList.add('hidden');
  });
  const currentActive = $$('.admin-tab.tab-active').find(btn => allowed.has(btn.dataset.tab));
  const preferredId = isSysadmin ? 'tabTenancy' : (isOrgAdmin ? 'tabTenancy' : 'tabEmployees');
  const preferred = $$('.admin-tab').find(btn => btn.dataset.tab === preferredId && allowed.has(btn.dataset.tab));
  const fallback = $$('.admin-tab').find(btn => allowed.has(btn.dataset.tab));
  const target = currentActive || preferred || fallback;
  if (target) {
    $$('.admin-tab-panel').forEach(panel => panel.classList.add('hidden'));
    $(target.dataset.tab)?.classList.remove('hidden');
    $$('.admin-tab').forEach(btn => btn.classList.toggle('tab-active', btn === target));
  }
}

function canManageTenancy() { return ['sysadmin','org_admin'].includes(currentAccessRole()); }
function hospitalName(id) { const h = state.hospitals.find(x => x.id === id); return h ? h.name : ''; }
function organizationName(id) { const o = state.organizations.find(x => x.id === id); return o ? o.name : ''; }
function hospitalOptions(orgId = '') {
  return state.hospitals.filter(h => !orgId || h.organizationId === orgId).map(h => `<option value="${escapeHTML(h.id)}">${escapeHTML(h.name)}${h.city ? ' · '+escapeHTML(h.city) : ''}</option>`).join('');
}
function organizationOptions() {
  return state.organizations.map(o => `<option value="${escapeHTML(o.id)}">${escapeHTML(o.name)}</option>`).join('');
}

function yearOptions() {
  const years = new Set([new Date().getFullYear()]);
  state.doses.forEach(d => years.add(getYearFromText(d.quarter || d.period)));
  state.attachments.forEach(a => years.add(getYearFromText(a.quarter || a.periodLabel)));
  return Array.from(years).filter(Boolean).sort((a, b) => b - a);
}

function yesNo(value) {
  return value ? '<span class="status-pill text-emerald-200 bg-emerald-950/40">Yes</span>' : '<span class="status-pill text-amber-200 bg-amber-950/40">No</span>';
}

async function api(path, options = {}) {
  const config = { method: options.method || 'GET', headers: {} };
  if (options.formData) {
    config.body = options.formData;
  } else if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, config);
  if (!response.ok) {
    let message = response.statusText || 'Request failed';
    try {
      // Read the body only once. This avoids the browser error:
      // Failed to execute 'text' on 'Response': body stream already read.
      const text = await response.clone().text();
      if (text) {
        try {
          const data = JSON.parse(text);
          message = data.error || data.message || message;
        } catch (_) {
          message = text;
        }
      }
    } catch (_) {}
    if (response.status === 401 && path !== '/api/auth/me') {
      state.me = null;
      showLoggedOut();
    }
    throw new Error(message || 'Request failed');
  }
  const ct = response.headers.get('content-type') || '';
  return ct.includes('application/json') ? response.json() : response.text();
}

async function safeApi(path, fallback, options = {}) {
  try {
    return await api(path, options);
  } catch (err) {
    console.warn('Optional API failed:', path, err?.message || err);
    return fallback;
  }
}


function toggleRecoveryBox(show = true) {
  const box = $('recoveryBox');
  if (!box) return;
  box.classList.toggle('hidden', !show);
  if (show) $('recoveryContact')?.focus();
}

function updateRecoveryMode() {
  const type = $('recoveryType')?.value || 'username';
  $('passwordResetUsernameWrap')?.classList.toggle('hidden', type !== 'password');
  clearMsg('recoveryMsg');
}

async function submitRecoveryRequest() {
  clearMsg('recoveryMsg');
  const type = $('recoveryType')?.value || 'username';
  const contact = $('recoveryContact')?.value.trim() || '';
  const username = $('passwordResetUsername')?.value.trim() || '';
  if (!contact) {
    setMsg('recoveryMsg', 'Please enter your registered email or mobile number.', false);
    return;
  }
  if (type === 'password' && !username) {
    setMsg('recoveryMsg', 'Please enter your username for password reset.', false);
    return;
  }
  try {
    const endpoint = type === 'password' ? '/api/auth/recover-password' : '/api/auth/recover-username';
    const data = await api(endpoint, { method: 'POST', body: { contact, username } });
    setMsg('recoveryMsg', data.message || 'Recovery request processed. Please check your registered contact.', true);
  } catch (err) {
    setMsg('recoveryMsg', err.message || 'Recovery request failed', false);
  }
}

function showView(view) {
  ['loginView', 'adminView', 'employeeView'].forEach(id => $(id)?.classList.add('hidden'));
  if (view === 'login') $('loginView')?.classList.remove('hidden');
  if (view === 'admin') $('adminView')?.classList.remove('hidden');
  if (view === 'employee') $('employeeView')?.classList.remove('hidden');
}

function updateHeader() {
  const info = $('currentUserInfo');
  if (!info) return;
  if (!state.me) {
    info.classList.add('hidden');
    return;
  }
  info.classList.remove('hidden');
  $('currentUserName').textContent = state.me.name;
  $('currentUserRole').textContent = state.me.accessRole ? `${state.me.accessRole.toUpperCase()} · ${state.me.role || ''}` : (state.me.isRSO ? 'RSO Admin' : (state.me.role || 'Employee'));
}

function showLoggedOut() {
  updateHeader();
  showView('login');
}

async function finishLogin(user) {
  state.me = user;
  normalizeCurrentUserRole();
  state.pending2FA = false;
  $('twoFactorBox')?.classList.add('hidden');
  updateHeader();
  if (canAccessAdmin()) {
    showView('admin');
    forceTabVisibilityForRole();
    await loadAdminData();
    forceTabVisibilityForRole();
  } else {
    showView('employee');
    await loadEmployeeData();
  }
}

async function handleLogin() {
  clearMsg('loginError');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('loginUsername').value.trim(), password: $('loginPassword').value }
    });
    if (data.requires2FA) {
      state.pending2FA = true;
      $('twoFactorBox')?.classList.remove('hidden');
      $('twoFactorDelivery').textContent = data.devCode ? `${data.delivery} Demo/dev code: ${data.devCode}` : data.delivery;
      $('twoFactorCode')?.focus();
      return;
    }
    await finishLogin(data.user);
  } catch (err) {
    setMsg('loginError', err.message || 'Login failed', false);
  }
}

async function verifyTwoFactor() {
  clearMsg('loginError');
  try {
    const data = await api('/api/auth/verify-2fa', { method: 'POST', body: { code: $('twoFactorCode').value.trim() } });
    await finishLogin(data.user);
  } catch (err) {
    setMsg('loginError', err.message || '2FA verification failed', false);
  }
}

async function handleLogout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (_) {}
  state.me = null;
  showLoggedOut();
}

async function loadAdminData() {
  // Tenancy is critical for the Radpro organization/hospital panel. Load it first so
  // an unrelated optional module failure cannot leave the organization dropdown empty.
  const tenancy = await api(`/api/tenancy?_ts=${Date.now()}`);
  state.organizations = tenancy.organizations || [];
  state.hospitals = tenancy.hospitals || [];
  renderAdminUI();
  forceTabVisibilityForRole();

  const departmentHospitalId = state.me?.hospitalId || state.hospitals[0]?.id || '';
  const [employees, doses, attachments, settings, ack, periods, audit, investigations, overexposureCases, reminderLogs, notifications, rscMembers, rscMeetings, rscDocuments, trainingModule, trainingResults, trainingQuestions, departments] = await Promise.all([
    safeApi('/api/employees', { employees: [] }),
    safeApi('/api/doses', { doses: [] }),
    safeApi('/api/attachments', { attachments: [] }),
    safeApi('/api/settings', { settings: {} }),
    safeApi('/api/acknowledgements', { acknowledgements: [] }),
    safeApi('/api/doses/periods', { periods: [] }),
    safeApi('/api/audit?page=1&pageSize=50', { logs: [], pagination: { page:1,pageSize:50,total:0,pages:1 }, filters: { modules: [] } }),
    safeApi('/api/investigations', { investigations: [] }),
    safeApi('/api/overexposure-cases', { cases: [] }),
    safeApi('/api/reminders/logs', { logs: [] }),
    safeApi('/api/notifications', { notifications: [], recipients: [] }),
    safeApi('/api/rsc/members', { members: [] }),
    safeApi('/api/rsc/meetings', { meetings: [] }),
    safeApi('/api/rsc/documents', { documents: [] }),
    safeApi(`/api/training/module?quarter=${encodeURIComponent(currentQuarterLabel())}`, null),
    safeApi(`/api/training/results?quarter=${encodeURIComponent(currentQuarterLabel())}`, { results: [] }),
    safeApi(`/api/training/questions?quarter=${encodeURIComponent(currentQuarterLabel())}`, null),
    departmentHospitalId ? safeApi(`/api/departments?hospitalId=${encodeURIComponent(departmentHospitalId)}`, { departments: [] }) : Promise.resolve({ departments: [] })
  ]);
  state.employees = employees.employees || [];
  state.doses = doses.doses || [];
  state.attachments = attachments.attachments || [];
  state.settings = settings.settings || {};
  state.acknowledgements = ack.acknowledgements || [];
  state.periods = periods.periods || [];
  state.audit = audit.logs || [];
  state.auditPagination = audit.pagination || state.auditPagination;
  state.auditFilters = audit.filters || state.auditFilters;
  state.investigations = investigations.investigations || [];
  state.overexposureCases = overexposureCases.cases || [];
  state.reminderLogs = reminderLogs.logs || [];
  state.notifications = notifications.notifications || [];
  state.notificationRecipients = notifications.recipients || [];
  state.rscMembers = rscMembers.members || [];
  state.rscMeetings = rscMeetings.meetings || [];
  state.rscDocuments = rscDocuments.documents || [];
  state.trainingModule = trainingModule || null;
  state.trainingResults = trainingResults.results || [];
  state.trainingAdminQuestions = trainingQuestions || null;
  state.departments = departments.departments || [];
  normalizeCurrentUserRole();
  renderAdminUI();
  forceTabVisibilityForRole();
}

async function loadEmployeeData() {
  const quarter = currentQuarterLabel();
  // Employee portal should not fail to show the mandatory TLD awareness poster
  // just because an optional section such as training/notifications has no data.
  const [doses, attachments, settings, ack, notifications, awareness, trainingModule, trainingQuiz, rscMembers] = await Promise.all([
    safeApi('/api/doses', { doses: [] }),
    safeApi('/api/attachments', { attachments: [] }),
    safeApi('/api/settings', { settings: {} }),
    safeApi('/api/acknowledgements', { acknowledgements: [] }),
    safeApi('/api/notifications', { notifications: [], recipients: [] }),
    safeApi(`/api/awareness/status?quarter=${encodeURIComponent(quarter)}`, {
      required: true,
      acknowledged: false,
      quarter,
      posterVersion: 'v1',
      posterUrl: '/assets/tld_awareness_hindi.jpg',
      statementText: 'I have read and understood the TLD safe-use instructions and will follow the correct TLD badge usage procedure.'
    }),
    safeApi(`/api/training/module?quarter=${encodeURIComponent(quarter)}`, { available: false, quarter }),
    safeApi(`/api/training/quiz?quarter=${encodeURIComponent(quarter)}`, { available: false, quarter, questions: [] }),
    safeApi('/api/rsc/member-list', { members: [] })
  ]);
  state.doses = doses.doses || [];
  state.attachments = attachments.attachments || [];
  state.settings = settings.settings || {};
  state.acknowledgements = ack.acknowledgements || [];
  state.notifications = notifications.notifications || [];
  state.notificationRecipients = notifications.recipients || [];
  state.awarenessStatus = awareness || null;
  state.trainingModule = trainingModule || null;
  state.trainingQuiz = trainingQuiz || null;
  state.rscMembers = rscMembers.members || [];
  state.trainingSelectedAnswers = {};
  renderEmployeeUI();
  setTimeout(showAwarenessIfRequired, 50);
}


function renderTenantSelects() {
  const orgSel = $('empOrganizationId');
  if (orgSel) {
    const prev = orgSel.value || state.me?.organizationId || state.organizations[0]?.id || '';
    orgSel.innerHTML = organizationOptions();
    orgSel.value = state.organizations.some(o => o.id === prev) ? prev : (state.organizations[0]?.id || '');
    orgSel.disabled = !['sysadmin','org_admin'].includes(currentAccessRole());
  }
  const hOrg = $('hospitalOrgSelect');
  if (hOrg) {
    const prev = hOrg.value || state.me?.organizationId || state.organizations[0]?.id || '';
    hOrg.innerHTML = organizationOptions();
    hOrg.value = state.organizations.some(o => o.id === prev) ? prev : (state.organizations[0]?.id || '');
    hOrg.disabled = currentAccessRole() !== 'sysadmin';
  }
  renderEmployeeHospitalSelect();
}

function renderEmployeeHospitalSelect() {
  const hospSel = $('empHospitalId');
  if (!hospSel) return;
  const orgId = $('empOrganizationId')?.value || state.me?.organizationId || '';
  const prev = hospSel.value || state.me?.hospitalId || '';
  const hospitals = state.hospitals.filter(h => !orgId || h.organizationId === orgId);
  hospSel.innerHTML = hospitals.map(h => `<option value="${escapeHTML(h.id)}">${escapeHTML(h.name)}${h.city ? ' · '+escapeHTML(h.city) : ''}</option>`).join('');
  hospSel.value = hospitals.some(h => h.id === prev) ? prev : (hospitals[0]?.id || '');
  hospSel.disabled = !['sysadmin','org_admin'].includes(currentAccessRole());
}


function codeBaseFromName(value, fallback = 'CODE') {
  const stopWords = new Set(['THE','AND','OF','HOSPITAL','HOSPITALS','INSTITUTE','INSTITUTES','CENTRE','CENTER','CLINIC','CLINICS','MEDICAL','CANCER','GROUP','PVT','LTD','LIMITED','PRIVATE','TECHNOLOGIES','TECHNOLOGY','RADIOLOGY','HEALTHCARE','HEALTH']);
  const words = String(value || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const significant = words.filter(w => !stopWords.has(w));
  let base = significant[0] || words[0] || fallback;
  if (base.length <= 3 && significant.length > 1) base = significant.map(w => w[0]).join('').slice(0, 12) || base;
  return base.replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || fallback;
}
function uniqueLocalCode(base, existingCodes, currentId, rows) {
  const root = (base || 'CODE').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'CODE';
  const used = new Set((existingCodes || []).filter(Boolean).map(c => String(c).toUpperCase()));
  let code = root;
  let i = 1;
  while (used.has(code)) {
    const match = (rows || []).find(r => String(r.code || '').toUpperCase() === code);
    if (match && currentId && match.id === currentId) break;
    i += 1;
    code = `${root}-${String(i).padStart(2, '0')}`.slice(0, 40);
  }
  return code;
}
function updateOrganizationCode(force = false) {
  const input = $('orgCode');
  if (!input) return;
  const editId = $('orgEditId')?.value || '';
  if (editId && !force) return;
  const base = codeBaseFromName($('orgName')?.value || '', 'ORG');
  input.value = uniqueLocalCode(base, state.organizations.map(o => o.code), editId, state.organizations);
}
function updateHospitalCode(force = false) {
  const input = $('hospitalCode');
  if (!input) return;
  const editId = $('hospitalEditId')?.value || '';
  if (editId && !force) return;
  const org = state.organizations.find(o => o.id === ($('hospitalOrgSelect')?.value || ''));
  const orgCode = codeBaseFromName(org?.code || org?.name || '', 'HOSP');
  const cityCode = codeBaseFromName($('hospitalCity')?.value || '', '');
  const hospCode = codeBaseFromName($('hospitalName')?.value || '', 'HOSP');
  let base = orgCode;
  if (cityCode) base = `${orgCode}-${cityCode}`;
  else if (hospCode && hospCode !== 'HOSP' && hospCode !== orgCode) base = `${orgCode}-${hospCode}`;
  input.value = uniqueLocalCode(base, state.hospitals.map(h => h.code), editId, state.hospitals);
}

function bindTenancyEvents() {
  $('saveOrgBtn')?.addEventListener('click', saveOrganization);
  $('resetOrgBtn')?.addEventListener('click', resetOrganizationForm);
  $('saveHospitalBtn')?.addEventListener('click', saveHospital);
  $('resetHospitalBtn')?.addEventListener('click', resetHospitalForm);
  $('licenseOrgSelect')?.addEventListener('change', () => fillLicenseForm($('licenseOrgSelect').value));
  $('orgName')?.addEventListener('input', () => updateOrganizationCode());
  $('hospitalName')?.addEventListener('input', () => updateHospitalCode());
  $('hospitalCity')?.addEventListener('input', () => updateHospitalCode());
  $('hospitalOrgSelect')?.addEventListener('change', () => updateHospitalCode());
  $('saveLicenseBtn')?.addEventListener('click', saveOrganizationLicense);
  $('deleteDemoDataBtn')?.addEventListener('click', deleteDefaultDemoData);
}


const RADPRO_INTERNAL_ROLES = ['Radpro Super Admin','Radpro Admin','Software Manager','Support Engineer','Sales Manager','Sales Executive','Accounts','Marketing','Viewer / Read Only'];
function isRadproInternalUser(emp) {
  const role = String(emp?.role || '').toLowerCase();
  const uname = String(emp?.username || '').toLowerCase();
  return uname === 'radpro' || RADPRO_INTERNAL_ROLES.some(r => role === r.toLowerCase()) || (emp?.accessRole === 'sysadmin' && (!emp?.organizationId || emp?.username !== 'rso'));
}
function bindRadproUserEvents() {
  $('saveRadproUserBtn')?.addEventListener('click', saveRadproInternalUser);
  $('resetRadproUserBtn')?.addEventListener('click', resetRadproInternalUserForm);
  $('refreshRadproUsersBtn')?.addEventListener('click', loadAdminData);
}
function resetRadproInternalUserForm() {
  ['radproUserId','radproUserName','radproUserEmail','radproUserPhone','radproUserUsername','radproUserPassword'].forEach(id => { if ($(id)) $(id).value = ''; });
  if ($('radproUserRole')) $('radproUserRole').value = 'Radpro Admin';
  if ($('radproUserEnabled')) $('radproUserEnabled').checked = true;
  if ($('radproUserTwoFactor')) $('radproUserTwoFactor').checked = true;
  clearMsg('radproUserMsg');
  if ($('saveRadproUserBtn')) $('saveRadproUserBtn').textContent = 'Save User';
}
function renderRadproUsers() {
  const tbody = $('radproUsersTableBody');
  if (!tbody) return;
  if (currentAccessRole() !== 'sysadmin') {
    tbody.innerHTML = emptyRow(6, 'Radpro Super Admin access required.');
    return;
  }
  const users = state.employees.filter(isRadproInternalUser).sort((a,b) => String(a.username).localeCompare(String(b.username)));
  tbody.innerHTML = users.map(u => {
    const isPrimary = String(u.username || '').toLowerCase() === 'radpro';
    return `<tr class="border-b border-slate-800"><td class="table-cell"><div class="font-semibold">${escapeHTML(u.name)}</div><div class="text-slate-500">${escapeHTML(u.dept || 'Radpro Technologies')}</div></td><td class="table-cell"><span class="status-pill">${escapeHTML(u.role || 'Radpro Admin')}</span></td><td class="table-cell">${escapeHTML(u.username)}</td><td class="table-cell"><div>${escapeHTML(u.email || '')}</div><div class="text-slate-500">${escapeHTML(u.phone || '')}</div></td><td class="table-cell">${u.enabled ? '<span class="status-pill text-emerald-300">Enabled</span>' : '<span class="status-pill text-rose-300">Disabled</span>'} ${u.twoFactorEnabled ? '<span class="status-pill">2FA</span>' : ''}</td><td class="table-cell"><div class="flex flex-wrap gap-1"><button class="btn-secondary text-[11px]" onclick="editRadproInternalUser('${escapeJS(u.id)}')">Edit</button>${isPrimary ? '' : `<button class="btn-secondary text-[11px]" onclick="toggleRadproInternalUser('${escapeJS(u.id)}')">${u.enabled ? 'Disable' : 'Enable'}</button><button class="danger-btn text-[11px]" onclick="deleteRadproInternalUser('${escapeJS(u.id)}')">Delete</button>`}</div></td></tr>`;
  }).join('') || emptyRow(6, 'No Radpro internal users yet.');
}
function editRadproInternalUser(id) {
  const u = state.employees.find(e => e.id === id); if (!u) return;
  $('radproUserId').value = u.id;
  $('radproUserName').value = u.name || '';
  $('radproUserRole').value = RADPRO_INTERNAL_ROLES.includes(u.role) ? u.role : 'Radpro Admin';
  $('radproUserEmail').value = u.email || '';
  $('radproUserPhone').value = u.phone || '';
  $('radproUserUsername').value = u.username || '';
  $('radproUserPassword').value = '';
  $('radproUserEnabled').checked = !!u.enabled;
  $('radproUserTwoFactor').checked = !!u.twoFactorEnabled;
  if ($('saveRadproUserBtn')) $('saveRadproUserBtn').textContent = 'Update User';
  $('radproUserName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function saveRadproInternalUser() {
  clearMsg('radproUserMsg');
  const id = $('radproUserId')?.value || '';
  const body = {
    name: $('radproUserName').value.trim(),
    role: $('radproUserRole').value,
    email: $('radproUserEmail').value.trim(),
    phone: $('radproUserPhone').value.trim(),
    username: $('radproUserUsername').value.trim(),
    password: $('radproUserPassword').value,
    enabled: $('radproUserEnabled').checked,
    twoFactorEnabled: $('radproUserTwoFactor').checked
  };
  try {
    await api(id ? `/api/radpro-users/${encodeURIComponent(id)}` : '/api/radpro-users', { method: id ? 'PUT' : 'POST', body });
    resetRadproInternalUserForm();
    setMsg('radproUserMsg', id ? 'Radpro user updated.' : 'Radpro user created.', true);
    await loadAdminData();
  } catch (err) { setMsg('radproUserMsg', err.message, false); }
}
async function toggleRadproInternalUser(id) {
  try { await api(`/api/radpro-users/${encodeURIComponent(id)}/toggle`, { method: 'PATCH' }); await loadAdminData(); } catch (err) { alert(err.message); }
}
async function deleteRadproInternalUser(id) {
  if (!confirm('Delete this Radpro internal user?')) return;
  try { await api(`/api/radpro-users/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
}

function renderTenancySection() {
  const panel = $('tabTenancy');
  if (!panel) return;
  if (!tenancyPanelOriginalHTML) tenancyPanelOriginalHTML = panel.innerHTML;
  if (!canManageTenancy()) {
    if (panel.dataset.mode !== 'readonlyMessage') {
      panel.dataset.mode = 'readonlyMessage';
      panel.innerHTML = '<div class="glass-card rounded-3xl p-6 text-sm text-slate-300">Only Radpro Panel Admin and Organization Super Admin can manage organizations/hospitals.</div>';
    }
    return;
  }
  if (panel.dataset.mode === 'readonlyMessage' || !$('tenancyList')) {
    panel.innerHTML = tenancyPanelOriginalHTML;
    panel.dataset.mode = 'manage';
    bindTenancyEvents();
  } else {
    panel.dataset.mode = 'manage';
  }
  const list = $('tenancyList');
  if (!list) return;
  renderLicenseControl();
  updateOrganizationCode();
  updateHospitalCode();
  const normalizedSearch = String(tenancySearchText || '').trim().toLowerCase();
  const filteredOrganizations = state.organizations.filter(org => {
    if (!normalizedSearch) return true;
    const hospitals = state.hospitals.filter(h => h.organizationId === org.id);
    return [org.name, org.code, org.contactPerson, org.email, ...hospitals.flatMap(h => [h.name, h.code, h.city, h.state])].some(value => String(value || '').toLowerCase().includes(normalizedSearch));
  });
  const totalPages = Math.max(1, Math.ceil(filteredOrganizations.length / tenancyPageSize));
  tenancyPage = Math.min(Math.max(1, tenancyPage), totalPages);
  const pageOrganizations = filteredOrganizations.slice((tenancyPage - 1) * tenancyPageSize, tenancyPage * tenancyPageSize);
  const managementToolbar = `<div class="soft-card rounded-2xl p-3 mb-3"><div class="flex flex-wrap items-center gap-2"><input id="tenancySearchInput" class="input flex-1 min-w-[220px]" value="${escapeHTML(tenancySearchText)}" placeholder="Search organization, hospital, code, city..." oninput="setTenancySearch(this.value)"><button class="btn-secondary" onclick="setTenancySearch('')">Clear</button>${currentAccessRole() === 'sysadmin' ? '<button class="btn-secondary" onclick="mergeDuplicateTenancy()">Merge Duplicate Demo/TEST Records</button>' : ''}<span class="text-slate-400 text-xs">${filteredOrganizations.length} organization(s)</span></div></div>`;
  const cardsHtml = pageOrganizations.map(org => {
    const hs = state.hospitals.filter(h => h.organizationId === org.id);
    const empCount = state.employees.filter(e => e.organizationId === org.id).length;
    const orgActions = currentAccessRole() === 'sysadmin' ? `<div class="flex flex-wrap gap-2 mt-2"><button class="btn-secondary text-[11px]" onclick="editOrganization('${escapeJS(org.id)}')">Edit Organization</button><button class="btn-secondary text-[11px]" onclick="editOrganizationLicense('${escapeJS(org.id)}')">Edit License/Billing</button><button class="btn-secondary text-[11px]" onclick="toggleOrganizationActive('${escapeJS(org.id)}')">${org.active ? 'Deactivate' : 'Activate'}</button><button class="danger-btn text-[11px]" onclick="deleteOrganization('${escapeJS(org.id)}')">Delete</button></div>` : '';
    const hospitalRows = hs.length ? hs.map(h => `<tr class="border-b border-slate-800"><td class="table-cell"><div class="font-semibold">${escapeHTML(h.name)} ${h.active ? '<span class="status-pill text-emerald-300">Active</span>' : '<span class="status-pill text-rose-300">Inactive</span>'}</div></td><td class="table-cell">${escapeHTML(h.code)}</td><td class="table-cell">${escapeHTML([h.city,h.state].filter(Boolean).join(', '))}</td><td class="table-cell"><div>${escapeHTML(h.email || '')}</div><div class="text-slate-500">${escapeHTML(h.phone || '')}</div></td><td class="table-cell"><div class="flex flex-wrap gap-1"><button class="btn-secondary text-[11px]" onclick="editHospital('${escapeJS(h.id)}')">Edit</button><button class="btn-secondary text-[11px]" onclick="toggleHospitalActive('${escapeJS(h.id)}')">${h.active ? 'Deactivate' : 'Activate'}</button><button class="btn-secondary text-[11px]" onclick="createHospitalAccess('${escapeJS(h.id)}')">Create RSO Login</button><button class="danger-btn text-[11px]" onclick="deleteHospital('${escapeJS(h.id)}')">Delete</button></div></td></tr>`).join('') : emptyRow(5, 'No hospitals under this organization yet.');
    return `<div class="soft-card rounded-2xl p-3 mb-3">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2"><div class="font-semibold text-emerald-300">${escapeHTML(org.name)} <span class="status-pill ml-2">${escapeHTML(org.code)}</span> ${org.active ? '<span class="status-pill text-emerald-300">Active</span>' : '<span class="status-pill text-rose-300">Inactive</span>'}</div><div><span class="status-pill">${escapeHTML(org.licenseStatus || 'Trial')}</span> <span class="status-pill">${escapeHTML(org.packageName || 'Trial')}</span></div></div>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-slate-300 mb-3">
        <div><span class="text-slate-500">Trial:</span> ${escapeHTML(org.trialStartDate || '-')} to ${escapeHTML(org.trialEndDate || '-')}</div>
        <div><span class="text-slate-500">Renewal:</span> ${escapeHTML(org.renewalDueDate || '-')}</div>
        <div><span class="text-slate-500">Billing:</span> ${escapeHTML(org.billingAmount || '-')} ${org.billingCycle ? '· '+escapeHTML(org.billingCycle) : ''}</div>
        <div><span class="text-slate-500">Limits:</span> ${hs.length}/${Number(org.maxHospitals || 0)} hospitals · ${empCount}/${Number(org.maxTldUsers || 0)} users</div>
      </div>
      <div class="text-slate-400 mb-2">${escapeHTML(org.contactPerson || '')} ${org.email ? ' · '+escapeHTML(org.email) : ''} ${org.phone ? ' · '+escapeHTML(org.phone) : ''}</div>
      ${org.billingNotes ? `<div class="text-slate-400 mb-2">${escapeHTML(org.billingNotes)}</div>` : ''}
      ${orgActions}
      <table class="min-w-full text-left border border-slate-800 mt-3"><thead><tr><th class="table-cell">Hospital / Institute</th><th class="table-cell">Code</th><th class="table-cell">City/State</th><th class="table-cell">Contact</th><th class="table-cell">Actions / Access</th></tr></thead><tbody>${hospitalRows}</tbody></table></div>`;
  }).join('') || '<div class="text-slate-500">No organizations match the search.</div>';
  const paginationHtml = `<div class="flex items-center justify-between gap-2 mt-3"><button class="btn-secondary" onclick="changeTenancyPage(-1)" ${tenancyPage <= 1 ? 'disabled' : ''}>Previous</button><span class="text-slate-400 text-xs">Page ${tenancyPage} of ${totalPages}</span><button class="btn-secondary" onclick="changeTenancyPage(1)" ${tenancyPage >= totalPages ? 'disabled' : ''}>Next</button></div>`;
  list.innerHTML = managementToolbar + cardsHtml + paginationHtml;
  const orgForm = $('saveOrgBtn')?.closest('.glass-card');
  if (orgForm) orgForm.style.display = currentAccessRole() === 'sysadmin' ? '' : 'none';
  const licenseCard = $('licenseControlCard');
  if (licenseCard) licenseCard.style.display = currentAccessRole() === 'sysadmin' ? '' : 'none';
  const demoCleanupCard = $('demoCleanupCard');
  if (demoCleanupCard) {
    const hasDefaultDemo = state.organizations.some(o => o.id === 'org_default' || o.code === 'DEFAULT' || o.name === 'Default Organization') || state.hospitals.some(h => h.id === 'hosp_default' || h.code === 'DEFAULT-HOSP' || h.name === 'Default Hospital / Institute');
    demoCleanupCard.style.display = currentAccessRole() === 'sysadmin' && hasDefaultDemo ? '' : 'none';
  }
}

function setTenancySearch(value) {
  tenancySearchText = String(value || '');
  tenancyPage = 1;
  renderTenancySection();
  const input = $('tenancySearchInput');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
function changeTenancyPage(delta) { tenancyPage += Number(delta || 0); renderTenancySection(); }
async function mergeDuplicateTenancy() {
  if (!confirm('Merge duplicate organizations and hospitals with the same normalized name? Linked users, departments, documents, training and compliance records will be reassigned to the oldest record. A database backup is recommended before continuing.')) return;
  try {
    const result = await api('/api/tenancy/merge-duplicates', { method: 'POST', body: {} });
    const summary = result.summary || {};
    alert(`Duplicate cleanup completed. Organizations merged: ${summary.organizationsMerged || 0}. Hospitals merged: ${summary.hospitalsMerged || 0}.`);
    await loadAdminData();
  } catch (err) { alert(err.message); }
}

function renderLicenseControl() {
  const sel = $('licenseOrgSelect');
  if (!sel) return;
  const prev = sel.value || state.organizations[0]?.id || '';
  sel.innerHTML = state.organizations.map(o => `<option value="${escapeHTML(o.id)}">${escapeHTML(o.name)} · ${escapeHTML(o.code)}</option>`).join('');
  sel.value = state.organizations.some(o => o.id === prev) ? prev : (state.organizations[0]?.id || '');
  fillLicenseForm(sel.value);
}

function fillLicenseForm(orgId) {
  const org = state.organizations.find(o => o.id === orgId);
  if (!org) return;
  $('licensePackage').value = org.packageName || 'Trial';
  $('licenseStatus').value = org.licenseStatus || 'Trial';
  $('licenseActive').checked = !!org.active;
  $('licenseTrialStart').value = org.trialStartDate || '';
  $('licenseTrialEnd').value = org.trialEndDate || '';
  $('licenseRegistrationDate').value = org.registrationDate || '';
  $('licenseRenewalDue').value = org.renewalDueDate || '';
  $('licenseBillingAmount').value = org.billingAmount || '';
  $('licenseBillingCycle').value = org.billingCycle || 'Trial';
  $('licenseMaxHospitals').value = org.maxHospitals || 1;
  $('licenseMaxTldUsers').value = org.maxTldUsers || 100;
  $('licenseBillingNotes').value = org.billingNotes || '';
}

function resetOrganizationForm() {
  ['orgEditId','orgName','orgCode','orgContact','orgEmail','orgPhone','orgAddress'].forEach(id => { if ($(id)) $(id).value=''; });
  clearMsg('orgMsg');
  if ($('saveOrgBtn')) $('saveOrgBtn').textContent = 'Create / Update Organization';
  setTimeout(() => updateOrganizationCode(true), 0);
}

function resetHospitalForm() {
  ['hospitalEditId','hospitalName','hospitalCode','hospitalCity','hospitalState','hospitalEmail','hospitalPhone','hospitalAddress','hospitalAdminName','hospitalAdminUsername','hospitalAdminPassword'].forEach(id => { if ($(id)) $(id).value=''; });
  clearMsg('hospitalMsg');
  if ($('saveHospitalBtn')) $('saveHospitalBtn').textContent = 'Create / Update Hospital';
  setTimeout(() => updateHospitalCode(true), 0);
}

function editOrganization(id) {
  const org = state.organizations.find(o => o.id === id); if (!org) return;
  $('orgEditId').value = org.id; $('orgName').value = org.name || ''; $('orgCode').value = org.code || ''; $('orgContact').value = org.contactPerson || ''; $('orgEmail').value = org.email || ''; $('orgPhone').value = org.phone || ''; $('orgAddress').value = org.address || '';
  if ($('saveOrgBtn')) $('saveOrgBtn').textContent = 'Update Organization';
  $('orgName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function editOrganizationLicense(id) {
  if ($('licenseOrgSelect')) { $('licenseOrgSelect').value = id; fillLicenseForm(id); $('licenseOrgSelect').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function editHospital(id) {
  const h = state.hospitals.find(x => x.id === id); if (!h) return;
  $('hospitalEditId').value = h.id; $('hospitalOrgSelect').value = h.organizationId || ''; $('hospitalName').value = h.name || ''; $('hospitalCode').value = h.code || ''; $('hospitalCity').value = h.city || ''; $('hospitalState').value = h.state || ''; $('hospitalEmail').value = h.email || ''; $('hospitalPhone').value = h.phone || ''; $('hospitalAddress').value = h.address || '';
  if ($('saveHospitalBtn')) $('saveHospitalBtn').textContent = 'Update Hospital';
  $('hospitalName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveOrganization() {
  clearMsg('orgMsg');
  const id = $('orgEditId')?.value;
  updateOrganizationCode();
  const body = { name: $('orgName').value.trim(), code: $('orgCode').value.trim(), contactPerson: $('orgContact').value.trim(), email: $('orgEmail').value.trim(), phone: $('orgPhone').value.trim(), address: $('orgAddress').value.trim(), active: true };
  try {
    const result = await api(id ? `/api/organizations/${encodeURIComponent(id)}` : '/api/organizations', { method: id ? 'PUT' : 'POST', body });
    const saved = result.organization;
    const tenancy = await api(`/api/tenancy?_ts=${Date.now()}`);
    state.organizations = tenancy.organizations || [];
    state.hospitals = tenancy.hospitals || [];
    resetOrganizationForm();
    renderAdminUI();
    if ($('hospitalOrgSelect') && saved?.id) $('hospitalOrgSelect').value = saved.id;
    setMsg('orgMsg', id ? 'Organization updated and reloaded from PostgreSQL.' : 'Organization registered and reloaded from PostgreSQL.', true);
  } catch (err) { setMsg('orgMsg', err.message, false); }
}

async function saveHospital() {
  clearMsg('hospitalMsg');
  const id = $('hospitalEditId')?.value;
  updateHospitalCode();
  const body = { organizationId: $('hospitalOrgSelect').value, name: $('hospitalName').value.trim(), code: $('hospitalCode').value.trim(), city: $('hospitalCity').value.trim(), state: $('hospitalState').value.trim(), email: $('hospitalEmail').value.trim(), phone: $('hospitalPhone').value.trim(), address: $('hospitalAddress').value.trim(), active: true,
    adminName: $('hospitalAdminName')?.value.trim() || '', adminUsername: $('hospitalAdminUsername')?.value.trim() || '', adminPassword: $('hospitalAdminPassword')?.value || '', adminAccessRole: $('hospitalAdminAccessRole')?.value || 'rso' };
  try {
    const result = await api(id ? `/api/hospitals/${encodeURIComponent(id)}` : '/api/hospitals', { method: id ? 'PUT' : 'POST', body });
    resetHospitalForm();
    const accessMsg = result.adminAccess ? ` Login created: ${result.adminAccess.username} / ${result.adminAccess.tempPassword}` : '';
    const tenancy = await api(`/api/tenancy?_ts=${Date.now()}`);
    state.organizations = tenancy.organizations || [];
    state.hospitals = tenancy.hospitals || [];
    renderAdminUI();
    setMsg('hospitalMsg', (id ? 'Hospital / institute updated and reloaded from PostgreSQL.' : 'Hospital / institute registered and reloaded from PostgreSQL.') + accessMsg, true);
  } catch (err) { setMsg('hospitalMsg', err.message, false); }
}

async function toggleOrganizationActive(id) {
  const org = state.organizations.find(o => o.id === id); if (!org) return;
  try { await api(`/api/organizations/${encodeURIComponent(id)}/license`, { method: 'PUT', body: { ...org, active: !org.active }}); await loadAdminData(); } catch (err) { alert(err.message); }
}
async function deleteOrganization(id) {
  const org = state.organizations.find(o => o.id === id); if (!org) return;
  if (!confirm(`Delete organization ${org.name}? This is allowed only if it has no hospitals/users.`)) return;
  try { await api(`/api/organizations/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
}
async function toggleHospitalActive(id) {
  const h = state.hospitals.find(x => x.id === id); if (!h) return;
  try { await api(`/api/hospitals/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...h, active: !h.active }}); await loadAdminData(); } catch (err) { alert(err.message); }
}
async function deleteHospital(id) {
  const h = state.hospitals.find(x => x.id === id); if (!h) return;
  const isDefaultHospital = h.id === 'hosp_default' || h.code === 'DEFAULT-HOSP' || h.name === 'Default Hospital / Institute';
  if (isDefaultHospital) {
    if (!confirm('This is the default demo hospital. Use Delete Demo Data / Default Hospital to remove the default hospital, demo RSO, linked users, dose records and attachments. Continue?')) return;
    try {
      const result = await api('/api/demo/delete-default', { method: 'POST', body: {} });
      alert(result.message || 'Default demo data and hospital deleted.');
      await loadAdminData();
    } catch (err) { alert(err.message); }
    return;
  }
  if (!confirm(`Delete hospital ${h.name}? This is allowed only if it has no users.`)) return;
  try { await api(`/api/hospitals/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
}
async function createHospitalAccess(id) {
  const h = state.hospitals.find(x => x.id === id); if (!h) return;
  const username = prompt('Hospital RSO/Admin username', `rso_${String(h.code||h.name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}`); if (!username) return;
  const password = prompt('Temporary password', 'rso123'); if (!password) return;
  const name = prompt('RSO/Admin full name', `${h.name} RSO`); if (!name) return;
  try {
    const result = await api(`/api/hospitals/${encodeURIComponent(id)}/rso-access`, { method: 'POST', body: { username, password, name, accessRole: 'rso' }});
    alert(`Hospital login created/updated:
Username: ${result.username}
Password: ${password}`);
    await loadAdminData();
  } catch (err) { alert(err.message); }
}


async function deleteDefaultDemoData() {
  clearMsg('demoCleanupMsg');
  const realOrgs = state.organizations.filter(o => !(o.id === 'org_default' || o.code === 'DEFAULT' || o.name === 'Default Organization'));
  if (!realOrgs.length && !confirm('No real organization is detected yet. If you delete the default demo setup now, it may be recreated on next startup. Continue?')) return;
  const warning = 'Delete Default Organization / Default Hospital / demo RSO and linked demo records? This cannot be undone. Your real organizations/hospitals will remain.';
  if (!confirm(warning)) return;
  try {
    const result = await api('/api/demo/delete-default', { method: 'POST', body: {} });
    setMsg('demoCleanupMsg', result.message || 'Default demo data deleted.', true);
    await loadAdminData();
  } catch (err) {
    setMsg('demoCleanupMsg', err.message, false);
  }
}

async function saveOrganizationLicense() {
  clearMsg('licenseMsg');
  const orgId = $('licenseOrgSelect')?.value;
  if (!orgId) { setMsg('licenseMsg', 'Select organization first.', false); return; }
  const body = {
    packageName: $('licensePackage').value,
    licenseStatus: $('licenseStatus').value,
    active: $('licenseActive').checked,
    trialStartDate: $('licenseTrialStart').value,
    trialEndDate: $('licenseTrialEnd').value,
    registrationDate: $('licenseRegistrationDate').value,
    renewalDueDate: $('licenseRenewalDue').value,
    billingAmount: $('licenseBillingAmount').value.trim(),
    billingCycle: $('licenseBillingCycle').value,
    maxHospitals: Number($('licenseMaxHospitals').value || 0),
    maxTldUsers: Number($('licenseMaxTldUsers').value || 0),
    billingNotes: $('licenseBillingNotes').value.trim()
  };
  try {
    await api(`/api/organizations/${encodeURIComponent(orgId)}/license`, { method: 'PUT', body });
    setMsg('licenseMsg', 'License / billing updated.', true);
    await loadAdminData();
    if ($('licenseOrgSelect')) $('licenseOrgSelect').value = orgId;
    fillLicenseForm(orgId);
  } catch (err) { setMsg('licenseMsg', err.message, false); }
}

function renderAdminUI() {
  populateQuarterSelects();
  renderRoleChrome();
  renderDashboardCards();
  bindRadproUserEvents();
  renderRadproUsers();
  renderTenancySection();
  renderTenantSelects();
  renderEmployeeSelects();
  renderEmployeeDepartmentSelect();
  renderEmployeeTable();
  renderAttachmentTables();
  renderDocVault();
  renderPeriodSelect();
  renderAnalyticsControls();
  renderAnalytics();
  renderCompliance();
  renderSettings();
  renderDepartmentManager();
  renderOpsControls();
  renderReminderLog();
  renderNotificationControls();
  renderNotificationHistory();
  renderRscSection();
  renderTrainingAdmin();
  renderInvestigationTable();
  renderOverexposureSection();
  renderAuditLog();
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function renderRoleChrome() {
  normalizeCurrentUserRole();
  const role = currentAccessRole();
  const isSysadmin = role === 'sysadmin';
  const isOrgAdmin = role === 'org_admin';
  setText('heroEyebrow', isSysadmin ? 'Radpro Control Panel' : 'RSO Command Center');
  setText('heroTitle', isSysadmin ? 'Organizations, licensing, trials and billing control' : 'Personnel dose, forms and quarterly TLD report control');
  setText('heroSubtitle', isSysadmin
    ? 'Use this panel to register client groups, control trial period, package, renewal, billing and hospital/user limits.'
    : 'Server-backed app with SQLite persistence, file uploads, audit log, JSON backup/restore and employee portal.');
  setText('heroMetricOneLabel', isSysadmin ? 'Organizations' : 'Current Quarter');
  setText('heroMetricTwoLabel', isSysadmin ? 'Hospitals' : 'Backend');
  setText('heroMetricTwoValue', isSysadmin ? String(state.hospitals.length) : 'PostgreSQL');
  if ($('heroCurrentQuarter')) $('heroCurrentQuarter').textContent = isSysadmin ? String(state.organizations.length) : currentQuarterLabel();

  const sysadminTabs = new Set(['tabTenancy', 'tabRadproUsers']);
  const radproOnlyTabs = new Set(['tabRadproUsers']);
  const visibleTabs = new Set();
  $$('.admin-tab').forEach((btn) => {
    const tabName = btn.dataset.tab;
    let show = true;
    if (isSysadmin) {
      // Radpro Panel login must not open the hospital/RSO command center.
      // It should focus on tenancy, licensing/billing and Radpro internal users.
      show = sysadminTabs.has(tabName);
    } else if (radproOnlyTabs.has(tabName)) {
      show = false;
    } else if (!isOrgAdmin && tabName === 'tabTenancy') {
      show = false;
    }
    btn.classList.toggle('hidden', !show);
    if (show) visibleTabs.add(tabName);
  });

  // Hide any panel whose tab is not allowed for the current role. This prevents
  // stale panels from remaining visible after redeploy/session restoration.
  $$('.admin-tab-panel').forEach(panel => {
    if (!visibleTabs.has(panel.id)) panel.classList.add('hidden');
  });

  const activeBtn = $$('.admin-tab.tab-active').find(btn => !btn.classList.contains('hidden'));
  const activePanel = activeBtn ? $(activeBtn.dataset.tab) : null;
  if (!activeBtn || !activePanel || activePanel.classList.contains('hidden')) {
    const preferred = isSysadmin ? $$('.admin-tab').find(btn => btn.dataset.tab === 'tabTenancy' && !btn.classList.contains('hidden')) : null;
    const target = preferred || $$('.admin-tab').find(btn => !btn.classList.contains('hidden'));
    if (target) {
      $$('.admin-tab-panel').forEach(panel => panel.classList.add('hidden'));
      $(target.dataset.tab)?.classList.remove('hidden');
      $$('.admin-tab').forEach(tab => tab.classList.toggle('tab-active', tab === target));
    }
  }
}

function renderDashboardCards() {
  if (currentAccessRole() === 'sysadmin') {
    const orgAdmins = state.employees.filter(e => e.accessRole === 'org_admin').length;
    const hospitalAdmins = state.employees.filter(e => ['admin', 'rso'].includes(e.accessRole)).length;
    const activeUsers = state.employees.filter(e => e.enabled).length;
    const activeHospitals = state.hospitals.filter(h => h.active !== false).length;
    setText('cardTotalEmployeesLabel', 'Organizations');
    setText('cardActiveBadgesLabel', 'Hospitals');
    setText('cardDoseRecordsLabel', 'Total Users');
    setText('cardAlertsLabel', 'Org Admins');
    setText('cardEmployeeFormsLabel', 'Hospital RSO/Admin');
    setText('cardQuarterReportsLabel', 'Active Users');
    setText('cardPendingAckLabel', 'Active Hospitals');
    setText('cardCompleteQuarterLabel', 'Backend');
    $('cardTotalEmployees').textContent = String(state.organizations.length);
    $('cardActiveBadges').textContent = String(state.hospitals.length);
    $('cardDoseRecords').textContent = String(state.employees.length);
    $('cardAlerts').textContent = String(orgAdmins);
    $('cardEmployeeForms').textContent = String(hospitalAdmins);
    $('cardQuarterReports').textContent = String(activeUsers);
    $('cardPendingAck').textContent = String(activeHospitals);
    $('cardCompleteQuarter').textContent = 'PostgreSQL';
    return;
  }
  setText('cardTotalEmployeesLabel', 'Employees');
  setText('cardActiveBadgesLabel', 'Active Badges');
  setText('cardDoseRecordsLabel', 'Dose Records');
  setText('cardAlertsLabel', 'Dose Alerts');
  setText('cardEmployeeFormsLabel', 'Employee Forms');
  setText('cardQuarterReportsLabel', 'Quarter Reports');
  setText('cardPendingAckLabel', 'Pending Ack.');
  setText('cardCompleteQuarterLabel', 'Complete This Qtr');
  const active = state.employees.filter(e => e.enabled);
  const annualLimit = Number($('annualLimit')?.value || state.settings.annualLimit || 20);
  const currentQ = currentQuarterLabel();
  const cumByEmp = new Map();
  state.doses.forEach(d => {
    const year = getYearFromText(d.quarter || d.period);
    if (year !== new Date().getFullYear()) return;
    cumByEmp.set(d.employeeId, (cumByEmp.get(d.employeeId) || 0) + Number(d.hp10 || 0));
  });
  const alertCount = Array.from(cumByEmp.values()).filter(v => v >= annualLimit * 0.8).length;
  const openCaseCount = state.overexposureCases.filter(c => c.status !== 'Closed').length;
  const completeCount = active.filter(e => hasDose(e.id, currentQ) && hasForm(e.id, currentQ) && hasAck(e.id, currentQ)).length;
  const pendingAck = active.filter(e => hasDose(e.id, currentQ) && !hasAck(e.id, currentQ)).length;
  $('cardTotalEmployees').textContent = String(state.employees.length);
  $('cardActiveBadges').textContent = String(active.filter(e => e.tldNumber).length);
  $('cardDoseRecords').textContent = String(state.doses.length);
  $('cardAlerts').textContent = String(alertCount + openCaseCount);
  $('cardEmployeeForms').textContent = String(state.attachments.filter(a => a.docType === 'employeeForm').length);
  $('cardQuarterReports').textContent = String(state.attachments.filter(a => a.docType === 'quarterReport').length);
  $('cardPendingAck').textContent = String(pendingAck);
  $('cardCompleteQuarter').textContent = String(completeCount);
}

function renderEmployeeSelects() {
  const options = state.employees
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `<option value="${escapeHTML(e.id)}">${escapeHTML(e.name)}${e.tldNumber ? ` · ${escapeHTML(e.tldNumber)}` : ''}</option>`)
    .join('');
  ['formAttachmentEmployee', 'analyticsEmployeeSelect', 'statementEmployeeSelect', 'notificationEmployeeSelect', 'overexposureEmployee'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = options;
    if (state.employees.some(e => e.id === prev)) el.value = prev;
  });
}


function selectedDepartmentHospitalId() {
  return $('empHospitalId')?.value || $('departmentHospitalId')?.value || state.me?.hospitalId || state.hospitals[0]?.id || '';
}

function renderEmployeeDepartmentSelect(selectedValue = null) {
  const el = $('empDept');
  if (!el) return;
  const previous = selectedValue !== null ? selectedValue : el.value;
  const hospitalId = $('empHospitalId')?.value || state.me?.hospitalId || '';
  const rows = state.departments.filter(d => d.active && (!hospitalId || d.hospitalId === hospitalId));
  const names = rows.map(d => d.name).filter(Boolean).sort((a,b) => a.localeCompare(b));
  if (previous && !names.some(n => n.toLowerCase() === String(previous).toLowerCase())) names.push(previous);
  el.innerHTML = '<option value="">Select department</option>' + names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
  if (previous) el.value = previous;
}

async function loadDepartmentsForHospital(hospitalId, { render = true } = {}) {
  if (!hospitalId) { state.departments = []; if (render) { renderDepartmentManager(); renderEmployeeDepartmentSelect(); } return; }
  try {
    const data = await api(`/api/departments?hospitalId=${encodeURIComponent(hospitalId)}&_ts=${Date.now()}`);
    state.departments = data.departments || [];
  } catch (err) {
    state.departments = [];
    if ($('departmentMsg')) setMsg('departmentMsg', err.message, false);
  }
  if (render) { renderDepartmentManager(); renderEmployeeDepartmentSelect(); }
}

function renderDepartmentManager() {
  const hospitalSelect = $('departmentHospitalId');
  const list = $('departmentList');
  if (!hospitalSelect || !list) return;
  const role = currentAccessRole();
  const allowedHospitals = role === 'sysadmin' ? state.hospitals : role === 'org_admin' ? state.hospitals.filter(h => h.organizationId === state.me?.organizationId) : state.hospitals.filter(h => h.id === state.me?.hospitalId);
  const previous = hospitalSelect.value || state.me?.hospitalId || allowedHospitals[0]?.id || '';
  hospitalSelect.innerHTML = allowedHospitals.map(h => `<option value="${escapeHTML(h.id)}">${escapeHTML(h.name)}</option>`).join('');
  if (allowedHospitals.some(h => h.id === previous)) hospitalSelect.value = previous;
  else if (allowedHospitals[0]) hospitalSelect.value = allowedHospitals[0].id;
  const hospitalId = hospitalSelect.value;
  const rows = state.departments.filter(d => d.hospitalId === hospitalId).sort((a,b) => a.name.localeCompare(b.name));
  list.innerHTML = rows.length ? rows.map(d => `<div class="flex items-center justify-between gap-2 soft-card rounded-xl px-3 py-2 text-xs"><div><div class="font-semibold ${d.active ? '' : 'text-slate-500'}">${escapeHTML(d.name)}</div><div class="text-[10px] ${d.active ? 'text-emerald-300' : 'text-slate-500'}">${d.active ? 'Active' : 'Inactive'}</div></div><div class="flex gap-1"><button class="btn-secondary !py-1 !px-2" data-department-action="toggle" data-id="${escapeHTML(d.id)}">${d.active ? 'Deactivate' : 'Activate'}</button><button class="btn-danger !py-1 !px-2" data-department-action="delete" data-id="${escapeHTML(d.id)}">Delete</button></div></div>`).join('') : '<div class="text-xs text-slate-500 py-2">No departments added for this hospital.</div>';
}

async function addDepartment() {
  clearMsg('departmentMsg');
  const name = $('departmentName')?.value.trim() || '';
  const hospitalId = $('departmentHospitalId')?.value || state.me?.hospitalId || '';
  if (!name) return setMsg('departmentMsg', 'Enter department name.', false);
  try {
    const result = await api('/api/departments', { method: 'POST', body: { name, hospitalId } });
    if ($('departmentName')) $('departmentName').value = '';
    setMsg('departmentMsg', result.existing ? 'Department already exists and is active.' : 'Department added.', true);
    await loadDepartmentsForHospital(hospitalId);
  } catch (err) { setMsg('departmentMsg', err.message, false); }
}

async function handleDepartmentListClick(event) {
  const btn = event.target.closest('[data-department-action]');
  if (!btn) return;
  const dept = state.departments.find(d => d.id === btn.dataset.id);
  if (!dept) return;
  try {
    if (btn.dataset.departmentAction === 'toggle') await api(`/api/departments/${encodeURIComponent(dept.id)}`, { method: 'PUT', body: { name: dept.name, active: !dept.active } });
    if (btn.dataset.departmentAction === 'delete') {
      if (!confirm(`Delete department "${dept.name}"?`)) return;
      await api(`/api/departments/${encodeURIComponent(dept.id)}`, { method: 'DELETE' });
    }
    await loadDepartmentsForHospital($('departmentHospitalId')?.value || dept.hospitalId);
  } catch (err) { setMsg('departmentMsg', err.message, false); }
}

function resetEmployeeForm() {
  $('employeeId').value = '';
  if ($('empOrganizationId')) $('empOrganizationId').value = state.me?.organizationId || (state.organizations[0]?.id || '');
  renderEmployeeHospitalSelect();
  if ($('empHospitalId')) $('empHospitalId').value = state.me?.hospitalId || (state.hospitals[0]?.id || '');
  $('empName').value = '';
  renderEmployeeDepartmentSelect('');
  $('empRole').value = 'Other';
  $('empTldNumber').value = '';
  if ($('empEmail')) $('empEmail').value = '';
  if ($('empPhone')) $('empPhone').value = '';
  if ($('empAccessRole')) $('empAccessRole').value = 'employee';
  $('empUsername').value = '';
  $('empPassword').value = '';
  $('empEnabled').checked = true;
  $('empIsRSO').checked = false;
  if ($('empTwoFactorEnabled')) $('empTwoFactorEnabled').checked = false;
  clearMsg('employeeFormMsg');
}

async function saveEmployee() {
  clearMsg('employeeFormMsg');
  const id = $('employeeId').value;
  const body = {
    organizationId: $('empOrganizationId')?.value || state.me?.organizationId || '',
    hospitalId: $('empHospitalId')?.value || state.me?.hospitalId || '',
    name: $('empName').value.trim(),
    dept: $('empDept').value.trim(),
    role: $('empRole').value,
    tldNumber: $('empTldNumber').value.trim(),
    email: $('empEmail')?.value.trim() || '',
    phone: $('empPhone')?.value.trim() || '',
    accessRole: $('empAccessRole')?.value || ($('empIsRSO').checked ? 'rso' : 'employee'),
    twoFactorEnabled: !!$('empTwoFactorEnabled')?.checked,
    username: $('empUsername').value.trim(),
    password: $('empPassword').value,
    enabled: $('empEnabled').checked,
    isRSO: $('empIsRSO').checked
  };
  try {
    await api(id ? `/api/employees/${encodeURIComponent(id)}` : '/api/employees', { method: id ? 'PUT' : 'POST', body });
    setMsg('employeeFormMsg', 'Employee saved successfully.', true);
    resetEmployeeForm();
    await loadAdminData();
  } catch (err) {
    setMsg('employeeFormMsg', err.message, false);
  }
}

function renderEmployeeTable() {
  const tbody = $('employeeTableBody');
  if (!tbody) return;
  const search = ($('empSearch')?.value || '').toLowerCase();
  const formsByEmp = new Map();
  state.attachments.filter(a => a.docType === 'employeeForm').forEach(a => formsByEmp.set(a.employeeId, (formsByEmp.get(a.employeeId) || 0) + 1));
  const rows = state.employees.filter(e => {
    const text = `${e.name} ${e.dept} ${e.role} ${e.tldNumber} ${e.username}`.toLowerCase();
    return !search || text.includes(search);
  });
  if (!rows.length) {
    tbody.innerHTML = emptyRow(9, 'No employees found.');
    return;
  }
  tbody.innerHTML = rows.map(emp => `
    <tr class="border-b border-slate-800">
      <td class="table-cell">${escapeHTML(emp.name)}${emp.isRSO ? ' <span class="status-pill text-emerald-200 bg-emerald-950/40 ml-1">RSO</span>' : ''}</td>
      <td class="table-cell"><div>${escapeHTML(emp.dept || '')}</div><div class="text-[10px] text-slate-500">${escapeHTML(emp.hospitalName || hospitalName(emp.hospitalId) || '')}</div></td>
      <td class="table-cell">${escapeHTML(emp.role || '')}</td>
      <td class="table-cell font-mono">${escapeHTML(emp.tldNumber || '')}</td>
      <td class="table-cell"><div>${escapeHTML(emp.email || '')}</div><div class="text-slate-500">${escapeHTML(emp.phone || '')}</div></td>
      <td class="table-cell"><span class="status-pill">${escapeHTML(emp.accessRole || (emp.isRSO ? 'rso' : 'employee'))}</span>${emp.twoFactorEnabled ? '<div class="text-[10px] text-cyan-300 mt-1">2FA</div>' : ''}</td>
      <td class="table-cell">${emp.enabled ? '<span class="text-emerald-300">Enabled</span>' : '<span class="text-slate-500">Disabled</span>'}</td>
      <td class="table-cell">${formsByEmp.get(emp.id) || 0}</td>
      <td class="table-cell whitespace-nowrap">
        <button class="btn-secondary !py-1 !px-2" data-employee-action="edit" data-id="${escapeHTML(emp.id)}">Edit</button>
        <button class="btn-secondary !py-1 !px-2" data-employee-action="toggle" data-id="${escapeHTML(emp.id)}">${emp.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn-danger !py-1 !px-2" data-employee-action="delete" data-id="${escapeHTML(emp.id)}">Delete</button>
      </td>
    </tr>
  `).join('');
}

async function handleEmployeeTableClick(event) {
  const btn = event.target.closest('[data-employee-action]');
  if (!btn) return;
  const action = btn.dataset.employeeAction;
  const id = btn.dataset.id;
  const emp = state.employees.find(e => e.id === id);
  if (!emp) return;
  if (action === 'edit') {
    $('employeeId').value = emp.id;
    if ($('empOrganizationId')) $('empOrganizationId').value = emp.organizationId || '';
    renderEmployeeHospitalSelect();
    if ($('empHospitalId')) $('empHospitalId').value = emp.hospitalId || '';
    $('empName').value = emp.name || '';
    renderEmployeeDepartmentSelect(emp.dept || '');
    $('empRole').value = emp.role || 'Other';
    $('empTldNumber').value = emp.tldNumber || '';
    if ($('empEmail')) $('empEmail').value = emp.email || '';
    if ($('empPhone')) $('empPhone').value = emp.phone || '';
    if ($('empAccessRole')) $('empAccessRole').value = emp.accessRole || (emp.isRSO ? 'rso' : 'employee');
    $('empUsername').value = emp.username || '';
    $('empPassword').value = '';
    $('empEnabled').checked = !!emp.enabled;
    $('empIsRSO').checked = !!emp.isRSO;
    if ($('empTwoFactorEnabled')) $('empTwoFactorEnabled').checked = !!emp.twoFactorEnabled;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (action === 'toggle') {
    try { await api(`/api/employees/${encodeURIComponent(id)}/toggle`, { method: 'PATCH', body: {} }); await loadAdminData(); } catch (err) { alert(err.message); }
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Delete employee ${emp.name}? Dose records will also be deleted.`)) return;
    try { await api(`/api/employees/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
  }
}

async function uploadAttachment({ fileInputId, msgId, docType, employeeId, quarter, periodLabel, documentStatus, description, publishToEmployees }) {
  clearMsg(msgId);
  const input = $(fileInputId);
  const file = input?.files?.[0];
  if (!file) {
    setMsg(msgId, 'Select a file to upload.', false);
    return null;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docType', docType);
  if (employeeId) fd.append('employeeId', employeeId);
  fd.append('quarter', quarter || currentQuarterLabel());
  fd.append('periodLabel', periodLabel || '');
  fd.append('documentStatus', documentStatus || '');
  fd.append('description', description || '');
  fd.append('publishToEmployees', publishToEmployees ? 'true' : 'false');
  const result = await api('/api/attachments', { method: 'POST', formData: fd });
  input.value = '';
  return result.attachment;
}

async function handleFormAttachmentUpload() {
  try {
    await uploadAttachment({
      fileInputId: 'formAttachmentFile',
      msgId: 'formAttachmentMsg',
      docType: 'employeeForm',
      employeeId: $('formAttachmentEmployee').value,
      quarter: $('formAttachmentQuarter').value,
      periodLabel: $('formAttachmentQuarter').value,
      documentStatus: $('formAttachmentStatus').value,
      description: $('formAttachmentNotes').value.trim(),
      publishToEmployees: true
    });
    $('formAttachmentNotes').value = '';
    setMsg('formAttachmentMsg', 'Employee form uploaded.', true);
    await loadAdminData();
  } catch (err) {
    setMsg('formAttachmentMsg', err.message, false);
  }
}

async function handleQuarterAttachmentUpload() {
  try {
    await uploadAttachment({
      fileInputId: 'quarterAttachmentFile',
      msgId: 'quarterAttachmentMsg',
      docType: 'quarterReport',
      quarter: $('quarterAttachmentQuarter').value,
      periodLabel: $('quarterAttachmentPeriod').value.trim(),
      description: $('quarterAttachmentNotes').value.trim(),
      publishToEmployees: $('quarterAttachmentPublish').checked
    });
    $('quarterAttachmentNotes').value = '';
    setMsg('quarterAttachmentMsg', 'Quarterly TLD report uploaded.', true);
    await loadAdminData();
  } catch (err) {
    setMsg('quarterAttachmentMsg', err.message, false);
  }
}

function attachmentActionButtons(att) {
  return `
    <button class="btn-secondary !py-1 !px-2" data-attachment-action="open" data-id="${escapeHTML(att.id)}">Open</button>
    <button class="btn-secondary !py-1 !px-2" data-attachment-action="download" data-id="${escapeHTML(att.id)}">Download</button>
    ${canEditAdmin() ? `<button class="btn-danger !py-1 !px-2" data-attachment-action="delete" data-id="${escapeHTML(att.id)}">Delete</button>` : ''}
  `;
}

function renderAttachmentTables() {
  renderFormAttachmentTable();
  renderQuarterAttachmentTable();
}

function renderFormAttachmentTable() {
  const tbody = $('formAttachmentBody');
  if (!tbody) return;
  const list = state.attachments.filter(a => a.docType === 'employeeForm').slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
  if (!list.length) { tbody.innerHTML = emptyRow(6, 'No employee form attachments uploaded yet.'); return; }
  tbody.innerHTML = list.map(att => `
    <tr>
      <td class="table-cell">${escapeHTML(employeeName(att.employeeId))}</td>
      <td class="table-cell">${escapeHTML(att.quarter || '')}</td>
      <td class="table-cell">${escapeHTML(att.documentStatus || '')}</td>
      <td class="table-cell">${escapeHTML(att.originalName)}</td>
      <td class="table-cell">${escapeHTML(fmtDate(att.createdAt))}</td>
      <td class="table-cell whitespace-nowrap">${attachmentActionButtons(att)}</td>
    </tr>
  `).join('');
}

function renderQuarterAttachmentTable() {
  const tbody = $('quarterReportAttachmentBody');
  if (!tbody) return;
  const list = state.attachments.filter(a => a.docType === 'quarterReport').slice().sort((a, b) => quarterToSortKey(b.quarter) - quarterToSortKey(a.quarter) || String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!list.length) { tbody.innerHTML = emptyRow(6, 'No quarterly TLD report attachments uploaded yet.'); return; }
  tbody.innerHTML = list.map(att => `
    <tr>
      <td class="table-cell">${escapeHTML(att.quarter || '')}</td>
      <td class="table-cell">${escapeHTML(att.periodLabel || '')}</td>
      <td class="table-cell">${escapeHTML(att.originalName)}</td>
      <td class="table-cell">${yesNo(att.publishToEmployees)}</td>
      <td class="table-cell">${escapeHTML(fmtDate(att.createdAt))}</td>
      <td class="table-cell whitespace-nowrap">${attachmentActionButtons(att)}</td>
    </tr>
  `).join('');
}

function renderDocVault() {
  const tbody = $('docVaultBody');
  if (!tbody) return;
  const type = $('docFilterType')?.value || 'all';
  const quarter = $('docFilterQuarter')?.value || 'all';
  const q = ($('docSearch')?.value || '').toLowerCase();
  let list = state.attachments.slice();
  if (type !== 'all') list = list.filter(a => a.docType === type);
  if (quarter !== 'all') list = list.filter(a => a.quarter === quarter);
  if (q) {
    list = list.filter(a => [a.originalName, a.description, a.periodLabel, a.documentStatus, employeeName(a.employeeId), a.quarter].some(v => String(v || '').toLowerCase().includes(q)));
  }
  if (!list.length) { tbody.innerHTML = emptyRow(7, 'No documents match the current filter.'); return; }
  tbody.innerHTML = list.map(att => `
    <tr>
      <td class="table-cell">${escapeHTML(docTypeLabel(att.docType))}</td>
      <td class="table-cell">${escapeHTML(att.employeeId ? employeeName(att.employeeId) : '—')}</td>
      <td class="table-cell">${escapeHTML(att.quarter || '')}</td>
      <td class="table-cell">${escapeHTML(att.originalName)}</td>
      <td class="table-cell">${escapeHTML(fmtSize(att.size))}</td>
      <td class="table-cell max-w-xs">${escapeHTML(att.description || att.periodLabel || '')}</td>
      <td class="table-cell whitespace-nowrap">${attachmentActionButtons(att)}</td>
    </tr>
  `).join('');
}

async function handleAttachmentAction(event) {
  const btn = event.target.closest('[data-attachment-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.attachmentAction;
  const att = state.attachments.find(a => a.id === id);
  if (!att) return;
  if (action === 'open') window.open(`/api/attachments/${encodeURIComponent(id)}/download?inline=1`, '_blank', 'noopener');
  if (action === 'download') window.open(`/api/attachments/${encodeURIComponent(id)}/download`, '_blank', 'noopener');
  if (action === 'delete') {
    if (!confirm(`Delete attachment ${att.originalName}?`)) return;
    try {
      await api(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadAdminData();
    } catch (err) { alert(err.message); }
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some(v => String(v).trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += c;
  }
  row.push(cell);
  if (row.some(v => String(v).trim() !== '')) rows.push(row);
  return rows;
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsArrayBuffer(file);
  });
}

function pdfPeriodKeyFromText(value) {
  const text = String(value || '').toUpperCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  if (/JAN\s*-\s*MAR|JANUARY\s*-\s*MARCH/.test(text)) return 'JAN-MAR';
  if (/APR\s*-\s*JUN(E)?|APRIL\s*-\s*JUN(E)?/.test(text)) return 'APR-JUN';
  if (/JUL\s*-\s*SEP(T)?|JULY\s*-\s*SEP(TEMBER)?/.test(text)) return 'JUL-SEP';
  if (/OCT\s*-\s*DEC|OCTOBER\s*-\s*DECEMBER/.test(text)) return 'OCT-DEC';
  return '';
}

function pdfPeriodIndex(key) {
  return { 'JAN-MAR': 0, 'APR-JUN': 1, 'JUL-SEP': 2, 'OCT-DEC': 3 }[key] ?? null;
}

function isReportDoseToken(value) {
  const raw = String(value || '').trim().replace(/[()]/g, '').toUpperCase();
  if (!raw) return false;
  if (['RL', 'R.L.', 'BDL', 'BLD', 'NIL', 'NA', 'N/A', '-'].includes(raw)) return true;
  const cleaned = raw.replace(/[<>]/g, '').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned);
}

function reportDoseValue(value) {
  const raw = String(value || '').trim().replace(/[()]/g, '').toUpperCase();
  if (['RL', 'R.L.', 'BDL', 'BLD', 'NIL', 'NA', 'N/A', '-'].includes(raw)) return 0;
  const cleaned = raw.replace(/[<>]/g, '').replace(/,/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function pdfItemTokens(item) {
  const str = String(item.str || '').trim();
  if (!str) return [];
  const transform = item.transform || [0, 0, 0, 0, 0, 0];
  const x0 = Number(transform[4] || 0);
  const y = Number(transform[5] || 0);
  const width = Number(item.width || 0);
  const parts = str.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [{ text: str, x: x0, y }];
  let searchAt = 0;
  return parts.map(part => {
    const at = Math.max(0, str.indexOf(part, searchAt));
    searchAt = at + part.length;
    const x = x0 + (str.length ? (width * at / str.length) : 0);
    return { text: part, x, y };
  });
}

function groupPdfTokensIntoLines(tokens) {
  const sorted = tokens.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  sorted.forEach(token => {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - token.y) > 3) {
      lines.push({ y: token.y, tokens: [token] });
    } else {
      last.tokens.push(token);
      last.y = (last.y * (last.tokens.length - 1) + token.y) / last.tokens.length;
    }
  });
  lines.forEach(line => {
    line.tokens.sort((a, b) => a.x - b.x);
    line.text = line.tokens.map(t => t.text).join(' ');
  });
  return lines;
}

function uniqueSortedXs(xs) {
  const out = [];
  xs.slice().sort((a, b) => a - b).forEach(x => {
    if (!out.length || Math.abs(out[out.length - 1] - x) > 8) out.push(x);
  });
  return out;
}

function pdfHeaderTargets(tokens, activeKey) {
  if (!activeKey) return {};
  const xs = tokens
    .filter(t => pdfPeriodKeyFromText(t.text) === activeKey)
    .map(t => t.x)
    .filter(x => Number.isFinite(x));
  const periodXs = uniqueSortedXs(xs);
  if (!periodXs.length) return {};
  return { hp10X: periodXs[0], hp007X: periodXs.length > 1 ? periodXs[periodXs.length - 1] : null };
}

function nearestPdfDose(values, targetX) {
  if (targetX === null || targetX === undefined) return null;
  let best = null;
  values.forEach(v => {
    const dist = Math.abs(v.x - targetX);
    if (!best || dist < best.dist) best = { value: v, dist };
  });
  return best && best.dist <= 75 ? best.value : null;
}

function cleanPdfPersonName(tokensBeforeDose) {
  const parts = tokensBeforeDose.map(t => t.text).filter(Boolean);
  while (parts.length && /^(C|W|CW|C\/W|T|M|F)$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function parsePdfDoseLine(line, activeKey, targets) {
  const tokens = line.tokens || [];
  if (tokens.length < 5) return null;
  const firstIndex = tokens.findIndex((t, i) => i <= 2 && /^\d{1,6}$/.test(String(t.text || '').trim()));
  if (firstIndex < 0) return null;
  const first = tokens[firstIndex];
  const after = tokens.slice(firstIndex + 1);
  const values = after
    .filter(t => isReportDoseToken(t.text))
    .map(t => ({ ...t, value: reportDoseValue(t.text) }));
  if (values.length < 2) return null;

  const firstDoseIndex = after.findIndex(t => isReportDoseToken(t.text));
  const name = cleanPdfPersonName(firstDoseIndex >= 0 ? after.slice(0, firstDoseIndex) : after);
  const activeIndex = pdfPeriodIndex(activeKey);

  const hp10FromX = nearestPdfDose(values, targets.hp10X);
  const hp007FromX = nearestPdfDose(values, targets.hp007X);

  let hp10 = hp10FromX ? hp10FromX.value : null;
  let hp007 = hp007FromX ? hp007FromX.value : null;

  if (hp10 === null) {
    if (activeIndex !== null && values[activeIndex]) hp10 = values[activeIndex].value;
    else hp10 = values[Math.max(0, values.length - 2)].value;
  }
  if (hp007 === null) hp007 = values.length >= 2 ? values[values.length - 2].value : values[values.length - 1].value;

  return {
    tldNumber: first.text,
    name,
    hp10,
    hp007,
    remarks: name ? `PDF row: ${name}` : '',
    sourceLine: line.text
  };
}

function fallbackRowsFromPdfText(text) {
  return String(text || '')
    .split(/\n|(?=\s*\d{3,6}\s+(?:Mr|Mrs|Ms|Dr|Prof)\b)/i)
    .map(line => line.trim().split(/\s+/).filter(Boolean))
    .filter(cells => cells.length >= 3);
}

async function parsePDF(file, periodHint = '') {
  if (!window.pdfjsLib) throw new Error('PDF parser could not load. Try CSV or Excel.');
  const buf = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const structuredRows = [];
  let fullText = '';
  const periodFromHint = pdfPeriodKeyFromText(periodHint);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const tokens = content.items.flatMap(pdfItemTokens);
    const pageText = tokens.map(t => t.text).join(' ');
    fullText += pageText + '\n';
    const activeKey = periodFromHint || pdfPeriodKeyFromText(pageText);
    const targets = pdfHeaderTargets(tokens, activeKey);
    groupPdfTokensIntoLines(tokens).forEach(line => {
      const row = parsePdfDoseLine(line, activeKey, targets);
      if (row) structuredRows.push(row);
    });
  }

  return structuredRows.length ? structuredRows : fallbackRowsFromPdfText(fullText);
}

async function parseReportFile(file, periodHint = '') {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') return parseCSV(await readAsText(file));
  if (ext === 'xls' || ext === 'xlsx') {
    if (!window.XLSX) throw new Error('Excel parser could not load. Try CSV.');
    const data = new Uint8Array(await readAsArrayBuffer(file));
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1 });
  }
  if (ext === 'pdf') return parsePDF(file, periodHint);
  throw new Error('Unsupported file type. Use CSV, Excel, or text-based PDF.');
}

async function handleTldFileParse() {
  clearMsg('tldImportMsg');
  const input = $('tldFileInput');
  const file = input?.files?.[0];
  if (!file) { setMsg('tldImportMsg', 'Please select a TLD report file.', false); return; }
  const period = $('reportPeriod').value.trim() || $('reportQuarter').value || 'Not specified';
  const quarter = $('reportQuarter').value || currentQuarterLabel();
  try {
    const rows = await parseReportFile(file, period);
    const result = await api('/api/doses/import', { method: 'POST', body: { rows, period, quarter } });
    renderImportPreview(result.preview || []);
    if ($('saveImportAsQuarterReport').checked) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('docType', 'quarterReport');
      fd.append('quarter', quarter);
      fd.append('periodLabel', period);
      fd.append('description', 'Source TLD dose report used for import');
      fd.append('publishToEmployees', 'false');
      await api('/api/attachments', { method: 'POST', formData: fd });
    }
    const notified = Number(result.doseAlert?.count || 0);
    const limit = Number(result.doseAlert?.limit || 0);
    const alertText = limit ? ` Dose alert notifications: ${notified} employee(s) at/above ${limit.toFixed(2)} mSv.` : '';
    setMsg('tldImportMsg', `Import finished. ${result.imported} imported, ${result.updated} updated, ${result.unmatched} unmatched.${alertText}`, true);
    input.value = '';
    await loadAdminData();
    renderImportPreview(result.preview || []);
  } catch (err) {
    setMsg('tldImportMsg', err.message, false);
  }
}

function renderImportPreview(list) {
  const tbody = $('tldPreviewBody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = emptyRow(7, 'No parsed rows yet.'); return; }
  tbody.innerHTML = list.map(row => `
    <tr>
      <td class="table-cell font-mono">${escapeHTML(row.tldNumber)}</td>
      <td class="table-cell">${escapeHTML(row.employeeName || '')}</td>
      <td class="table-cell">${escapeHTML(row.period || '')}</td>
      <td class="table-cell">${escapeHTML(row.quarter || '')}</td>
      <td class="table-cell">${Number(row.hp10 || 0).toFixed(2)}</td>
      <td class="table-cell">${Number(row.hp007 || 0).toFixed(2)}</td>
      <td class="table-cell ${String(row.status || '').startsWith('No matching') ? 'text-amber-300' : 'text-emerald-300'}">${escapeHTML(row.status)}</td>
    </tr>
  `).join('');
}

function renderPeriodSelect() {
  const sel = $('periodSelect');
  if (!sel) return;
  const prev = sel.value;
  if (!state.periods.length) {
    sel.innerHTML = '<option value="">No periods available</option>';
    renderPeriodReport([]);
    return;
  }
  sel.innerHTML = state.periods.map(p => {
    const value = `${p.period}||${p.quarter}`;
    return `<option value="${escapeHTML(value)}">${escapeHTML(p.period)} · ${escapeHTML(p.quarter)} (${p.count})</option>`;
  }).join('');
  if (Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
  renderSelectedPeriodReport();
}

async function renderSelectedPeriodReport() {
  const sel = $('periodSelect');
  if (!sel || !sel.value) return;
  const [period, quarter] = sel.value.split('||');
  try {
    const data = await api(`/api/doses/period-report?period=${encodeURIComponent(period)}&quarter=${encodeURIComponent(quarter)}`);
    renderPeriodReport(data.rows || [], period, quarter);
  } catch (err) {
    console.error(err);
  }
}

function renderPeriodReport(rows, period = '', quarter = '') {
  const tbody = $('periodReportBody');
  if (!tbody) return;
  const total = rows.reduce((sum, row) => sum + Number(row.hp10 || 0), 0);
  $('periodBadgeCount').textContent = String(rows.length);
  $('periodTotalHp10').textContent = total.toFixed(2);
  $('periodAvgHp10').textContent = rows.length ? (total / rows.length).toFixed(2) : '0.00';
  $('periodAttachmentCount').textContent = String(state.attachments.filter(a => a.docType === 'quarterReport' && (!quarter || a.quarter === quarter || a.periodLabel === period)).length);
  if (!rows.length) { tbody.innerHTML = emptyRow(5, 'No rows for this period.'); return; }
  tbody.innerHTML = rows.map(row => `
    <tr><td class="table-cell">${escapeHTML(row.employeeName || employeeName(row.employeeId))}</td><td class="table-cell font-mono">${escapeHTML(row.tldNumber)}</td><td class="table-cell">${Number(row.hp10 || 0).toFixed(2)}</td><td class="table-cell">${Number(row.hp007 || 0).toFixed(2)}</td><td class="table-cell">${escapeHTML(row.remarks || '')}</td></tr>
  `).join('');
}

function hasDose(employeeId, quarter) {
  return state.doses.some(d => d.employeeId === employeeId && d.quarter === quarter);
}

function hasForm(employeeId, quarter) {
  return state.attachments.some(a => a.docType === 'employeeForm' && a.employeeId === employeeId && a.quarter === quarter);
}

function hasAck(employeeId, quarter) {
  return state.acknowledgements.some(a => a.employeeId === employeeId && a.quarter === quarter);
}

function renderCompliance() {
  const q = $('complianceQuarter')?.value || currentQuarterLabel();
  const tbody = $('complianceBody');
  if (!tbody) return;
  const active = state.employees.filter(e => e.enabled && e.tldNumber);
  const rows = active.map(emp => ({ emp, dose: hasDose(emp.id, q), form: hasForm(emp.id, q), ack: hasAck(emp.id, q) }));
  const complete = rows.filter(r => r.dose && r.form && r.ack).length;
  $('complianceComplete').textContent = String(complete);
  $('compliancePending').textContent = String(rows.length - complete);
  if (!rows.length) { tbody.innerHTML = emptyRow(4, 'No active employees with assigned TLD badge.'); return; }
  tbody.innerHTML = rows.map(r => `
    <tr><td class="table-cell">${escapeHTML(r.emp.name)}</td><td class="table-cell">${yesNo(r.dose)}</td><td class="table-cell">${yesNo(r.form)}</td><td class="table-cell">${yesNo(r.ack)}</td></tr>
  `).join('');
}

function renderAnalyticsControls() {
  const yearSelect = $('analyticsYearSelect');
  if (yearSelect) {
    const years = new Set([new Date().getFullYear()]);
    state.doses.forEach(d => years.add(getYearFromText(d.quarter || d.period)));
    const prev = yearSelect.value;
    yearSelect.innerHTML = Array.from(years).sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join('');
    if (Array.from(yearSelect.options).some(o => o.value === prev)) yearSelect.value = prev;
  }
  const annual = $('annualLimit');
  const settingAnnual = Number(state.settings.annualLimit || 20);
  if (annual && !annual.dataset.touched) annual.value = String(settingAnnual || 20);
}

function renderAnalytics() {
  const empId = $('analyticsEmployeeSelect')?.value || state.employees[0]?.id;
  const year = Number($('analyticsYearSelect')?.value || new Date().getFullYear());
  const annualLimit = Number($('annualLimit')?.value || state.settings.annualLimit || 20);
  const empDoses = state.doses.filter(d => d.employeeId === empId && getYearFromText(d.quarter || d.period) === year).sort((a, b) => quarterToSortKey(a.quarter) - quarterToSortKey(b.quarter));
  const cum = empDoses.reduce((sum, d) => sum + Number(d.hp10 || 0), 0);
  const formCount = state.attachments.filter(a => a.docType === 'employeeForm' && a.employeeId === empId && getYearFromText(a.quarter) === year).length;
  $('analyticsCumHp10').textContent = cum.toFixed(2);
  $('analyticsBadgeCount').textContent = String(empDoses.length);
  $('analyticsFormCount').textContent = String(formCount);
  let status = 'OK';
  let cls = 'text-xl font-bold text-emerald-300';
  if (cum >= annualLimit) { status = 'Above Limit'; cls = 'text-xl font-bold text-red-300'; }
  else if (cum >= annualLimit * 0.8) { status = 'High (80%+)'; cls = 'text-xl font-bold text-amber-300'; }
  const statusEl = $('analyticsStatus');
  statusEl.textContent = status;
  statusEl.className = cls;

  const chartCanvas = $('doseTrendChart');
  const chartEmpty = $('doseTrendEmpty');
  if (chartEmpty) chartEmpty.classList.toggle('hidden', empDoses.length > 0);
  if (chartCanvas) chartCanvas.classList.toggle('hidden', empDoses.length === 0);
  const ctx = chartCanvas?.getContext('2d');
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (ctx && window.Chart && empDoses.length > 0) {
    state.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: empDoses.map(d => d.quarter || d.period), datasets: [{ label: 'Hp(10) mSv', data: empDoses.map(d => Number(d.hp10 || 0)), fill: false, tension: 0.2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 150,
        plugins: { legend: { labels: { color: '#cbd5e1' } } },
        scales: { x: { ticks: { color: '#94a3b8' } }, y: { beginAtZero: true, ticks: { color: '#94a3b8' } } }
      }
    });
  }
  renderAlertsTable();
}

function renderAlertsTable() {
  const tbody = $('alertTableBody');
  if (!tbody) return;
  const annualLimit = Number($('annualLimit')?.value || state.settings.annualLimit || 20);
  const threshold = annualLimit / 4 * 0.8;
  const rows = state.doses.filter(d => Number(d.hp10 || 0) >= threshold).sort((a, b) => Number(b.hp10 || 0) - Number(a.hp10 || 0));
  if (!rows.length) { tbody.innerHTML = emptyRow(6, 'No high-dose cases at the current threshold.'); return; }
  tbody.innerHTML = rows.map(d => {
    const critical = Number(d.hp10 || 0) >= annualLimit / 4;
    const inv = state.investigations.find(i => i.doseId === d.id);
    return `<tr><td class="table-cell">${escapeHTML(employeeName(d.employeeId))}</td><td class="table-cell">${escapeHTML(d.quarter)}</td><td class="table-cell">${escapeHTML(d.period)}</td><td class="table-cell">${Number(d.hp10 || 0).toFixed(2)}</td><td class="table-cell ${critical ? 'text-red-300' : 'text-amber-300'}">${inv ? escapeHTML(inv.status) : (critical ? 'Critical quarter dose' : 'Investigate')}</td><td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-investigation-action="from-dose" data-dose-id="${escapeHTML(d.id)}">${inv ? 'Edit' : 'Open'} Investigation</button><button class="btn-secondary !py-1 !px-2" data-overexposure-action="from-dose" data-dose-id="${escapeHTML(d.id)}">Create Case</button></td></tr>`;
  }).join('');
}

function selectInvestigationFromDose(doseId) {
  const dose = state.doses.find(d => d.id === doseId);
  if (!dose) return;
  const inv = state.investigations.find(i => i.doseId === doseId);
  $('investigationDoseId').value = dose.id;
  $('investigationId').value = inv?.id || '';
  $('investigationDoseLabel').innerHTML = `<div class="font-semibold">${escapeHTML(employeeName(dose.employeeId))}</div><div>${escapeHTML(dose.quarter)} · ${escapeHTML(dose.period)} · Hp(10) ${Number(dose.hp10 || 0).toFixed(2)} mSv</div>`;
  $('investigationSeverity').value = inv?.severity || (Number(dose.hp10 || 0) >= Number($('annualLimit')?.value || 20) / 4 ? 'Critical' : 'Investigate');
  $('investigationStatus').value = inv?.status || 'Open';
  $('investigationRsoNote').value = inv?.rsoNote || '';
  $('investigationImmediateAction').value = inv?.immediateAction || '';
  $('investigationRootCause').value = inv?.rootCause || '';
  $('investigationCorrectiveAction').value = inv?.correctiveAction || '';
  $('investigationClosureStatus').value = inv?.closureStatus || '';
  $('investigationSignerName').value = inv?.rsoSignerName || state.me?.name || '';
  clearCanvas('investigationSignatureCanvas');
  if (inv?.rsoSignatureData) drawDataUrlOnCanvas('investigationSignatureCanvas', inv.rsoSignatureData);
  clearMsg('investigationMsg');
}

function renderInvestigationTable() {
  const tbody = $('investigationTableBody');
  if (!tbody) return;
  if (!state.investigations.length) { tbody.innerHTML = emptyRow(6, 'No investigation records yet.'); return; }
  tbody.innerHTML = state.investigations.map(inv => `
    <tr>
      <td class="table-cell">${escapeHTML(inv.employeeName || employeeName(inv.employeeId))}</td>
      <td class="table-cell">${escapeHTML(inv.quarter || '')}</td>
      <td class="table-cell">${escapeHTML(inv.severity || '')}</td>
      <td class="table-cell">${escapeHTML(inv.status || '')}</td>
      <td class="table-cell">${escapeHTML(fmtDate(inv.updatedAt))}</td>
      <td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-investigation-action="edit" data-id="${escapeHTML(inv.id)}">Edit</button><button class="btn-secondary !py-1 !px-2" data-investigation-action="pdf" data-id="${escapeHTML(inv.id)}">PDF</button></td>
    </tr>
  `).join('');
}

async function saveInvestigation() {
  clearMsg('investigationMsg');
  const doseId = $('investigationDoseId')?.value;
  if (!doseId) { setMsg('investigationMsg', 'Select a high-dose row first.', false); return; }
  const id = $('investigationId')?.value;
  const body = {
    doseId,
    severity: $('investigationSeverity').value,
    status: $('investigationStatus').value,
    rsoNote: $('investigationRsoNote').value.trim(),
    immediateAction: $('investigationImmediateAction').value.trim(),
    rootCause: $('investigationRootCause').value.trim(),
    correctiveAction: $('investigationCorrectiveAction').value.trim(),
    closureStatus: $('investigationClosureStatus').value.trim(),
    rsoSignerName: $('investigationSignerName').value.trim(),
    rsoSignatureData: canvasDataUrl('investigationSignatureCanvas')
  };
  try {
    await api(id ? `/api/investigations/${encodeURIComponent(id)}` : '/api/investigations', { method: id ? 'PUT' : 'POST', body });
    setMsg('investigationMsg', 'Investigation saved.', true);
    await loadAdminData();
    const saved = state.investigations.find(i => i.doseId === doseId);
    if (saved) selectInvestigationFromDose(doseId);
  } catch (err) { setMsg('investigationMsg', err.message, false); }
}

function handleInvestigationAction(event) {
  const btn = event.target.closest('[data-investigation-action]');
  if (!btn) return;
  const action = btn.dataset.investigationAction;
  if (action === 'from-dose') selectInvestigationFromDose(btn.dataset.doseId);
  if (action === 'edit') {
    const inv = state.investigations.find(i => i.id === btn.dataset.id);
    if (inv) selectInvestigationFromDose(inv.doseId);
  }
  if (action === 'pdf') window.open(`/api/investigations/${encodeURIComponent(btn.dataset.id)}/pdf`, '_blank', 'noopener');
}

function exportSelectedInvestigationPdf() {
  const id = $('investigationId')?.value;
  if (!id) { setMsg('investigationMsg', 'Save/select an investigation first.', false); return; }
  window.open(`/api/investigations/${encodeURIComponent(id)}/pdf`, '_blank', 'noopener');
}

function renderOverexposureDoseOptions(employeeId = '') {
  const select = $('overexposureDoseId');
  if (!select) return;
  const prev = select.value;
  const doses = state.doses
    .filter(d => !employeeId || d.employeeId === employeeId)
    .slice()
    .sort((a, b) => quarterToSortKey(b.quarter) - quarterToSortKey(a.quarter));
  select.innerHTML = `<option value="">No linked dose record / manual entry</option>` + doses.map(d => `<option value="${escapeHTML(d.id)}">${escapeHTML(d.quarter || d.period)} · Hp(10) ${Number(d.hp10 || 0).toFixed(2)} mSv · ${escapeHTML(employeeName(d.employeeId))}</option>`).join('');
  select.value = doses.some(d => d.id === prev) ? prev : '';
}

function resetOverexposureForm() {
  if (!$('overexposureCaseId')) return;
  $('overexposureCaseId').value = '';
  const firstEmployee = state.employees[0]?.id || '';
  $('overexposureEmployee').value = firstEmployee;
  renderOverexposureDoseOptions(firstEmployee);
  $('overexposureDoseId').value = '';
  $('overexposureIncidentDate').value = new Date().toISOString().slice(0, 10);
  $('overexposureIncidentType').value = 'Suspected overexposure';
  $('overexposureQuarter').value = currentQuarterLabel();
  $('overexposureReceivedDose').value = '';
  $('overexposureDoseType').value = 'Hp(10)';
  $('overexposureSeverity').value = 'Investigate';
  $('overexposureStatus').value = 'Open';
  $('overexposureReportReference').value = '';
  $('overexposureRegReportRequired').checked = false;
  ['overexposureReportedTo','overexposureRegReportDate','overexposureRscReviewDate','overexposureSummary','overexposureCause','overexposureImmediateAction','overexposureMedicalReview','overexposureActionTaken','overexposureCorrectiveAction','overexposurePreventiveAction','overexposureClosureNote'].forEach(id => { if ($(id)) $(id).value = ''; });
  $('overexposureSignerName').value = state.me?.name || '';
  $('overexposureEmployeeSignerName').value = '';
  $('overexposureEmployeeAckText').value = 'I have reviewed the accidental / overexposure investigation record, understood the findings and action taken, and confirm that I accept the investigation record with no objection.';
  clearCanvas('overexposureSignatureCanvas');
  clearCanvas('overexposureEmployeeSignatureCanvas');
  clearMsg('overexposureMsg');
}

function fillOverexposureFromDose(doseId) {
  const dose = state.doses.find(d => d.id === doseId);
  if (!dose) return;
  $('overexposureEmployee').value = dose.employeeId;
  renderOverexposureDoseOptions(dose.employeeId);
  $('overexposureDoseId').value = dose.id;
  $('overexposureQuarter').value = dose.quarter || currentQuarterLabel();
  $('overexposureReceivedDose').value = Number(dose.hp10 || 0).toFixed(2);
  $('overexposureDoseType').value = 'Hp(10)';
  $('overexposureSeverity').value = Number(dose.hp10 || 0) >= Number($('annualLimit')?.value || 20) / 4 ? 'Critical' : 'High';
  $('overexposureStatus').value = 'Open';
  $('overexposureSummary').value = `High TLD dose observed in imported report for ${employeeName(dose.employeeId)}. Review required for work history, badge usage, possible accidental exposure, and need for medical/regulatory follow-up.`;
  clearMsg('overexposureMsg');
}

function selectOverexposureCase(id) {
  const row = state.overexposureCases.find(c => c.id === id);
  if (!row) return;
  $('overexposureCaseId').value = row.id;
  $('overexposureEmployee').value = row.employeeId || '';
  renderOverexposureDoseOptions(row.employeeId || '');
  $('overexposureDoseId').value = row.doseId || '';
  $('overexposureIncidentDate').value = row.incidentDate || '';
  $('overexposureIncidentType').value = row.incidentType || 'Suspected overexposure';
  $('overexposureQuarter').value = row.doseReportQuarter || row.linkedDoseQuarter || '';
  $('overexposureReceivedDose').value = row.receivedDose ?? '';
  $('overexposureDoseType').value = row.doseType || 'Hp(10)';
  $('overexposureSeverity').value = row.severity || 'Investigate';
  $('overexposureStatus').value = row.status || 'Open';
  $('overexposureReportReference').value = row.reportReference || '';
  $('overexposureRegReportRequired').checked = !!row.regulatoryReportRequired;
  $('overexposureReportedTo').value = row.reportedTo || '';
  $('overexposureRegReportDate').value = row.regulatoryReportDate || '';
  $('overexposureRscReviewDate').value = row.rscReviewDate || '';
  $('overexposureSummary').value = row.incidentSummary || '';
  $('overexposureCause').value = row.suspectedCause || '';
  $('overexposureImmediateAction').value = row.immediateAction || '';
  $('overexposureMedicalReview').value = row.medicalReview || '';
  $('overexposureActionTaken').value = row.actionTaken || '';
  $('overexposureCorrectiveAction').value = row.correctiveAction || '';
  $('overexposurePreventiveAction').value = row.preventiveAction || '';
  $('overexposureClosureNote').value = row.closureNote || '';
  $('overexposureSignerName').value = row.rsoSignerName || state.me?.name || '';
  $('overexposureEmployeeSignerName').value = row.employeeSignerName || '';
  $('overexposureEmployeeAckText').value = row.employeeAcknowledgementText || 'I have reviewed the accidental / overexposure investigation record, understood the findings and action taken, and confirm that I accept the investigation record with no objection.';
  clearCanvas('overexposureSignatureCanvas');
  if (row.rsoSignatureData) drawDataUrlOnCanvas('overexposureSignatureCanvas', row.rsoSignatureData);
  clearCanvas('overexposureEmployeeSignatureCanvas');
  if (row.employeeSignatureData) drawDataUrlOnCanvas('overexposureEmployeeSignatureCanvas', row.employeeSignatureData);
  clearMsg('overexposureMsg');
}

function renderOverexposureSection() {
  renderOverexposureDoseOptions($('overexposureEmployee')?.value || state.employees[0]?.id || '');
  const tbody = $('overexposureCaseBody');
  if (!tbody) return;
  const rows = state.overexposureCases.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!rows.length) { tbody.innerHTML = emptyRow(8, 'No accidental / overexposure cases recorded yet.'); return; }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td class="table-cell">${escapeHTML(row.employeeName || employeeName(row.employeeId))}</td>
      <td class="table-cell">${escapeHTML(row.incidentDate || '')}</td>
      <td class="table-cell">${escapeHTML(row.incidentType || '')}</td>
      <td class="table-cell">${escapeHTML(row.doseReportQuarter || row.linkedDoseQuarter || '')}</td>
      <td class="table-cell">${Number(row.receivedDose || 0).toFixed(2)} ${escapeHTML(row.doseUnit || 'mSv')} ${escapeHTML(row.doseType || '')}</td>
      <td class="table-cell">${escapeHTML(row.severity || '')}</td>
      <td class="table-cell">${escapeHTML(row.status || '')}</td>
      <td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-overexposure-action="edit" data-id="${escapeHTML(row.id)}">Edit</button><button class="btn-secondary !py-1 !px-2" data-overexposure-action="pdf" data-id="${escapeHTML(row.id)}">PDF</button>${canEditAdmin() ? `<button class="btn-danger !py-1 !px-2" data-overexposure-action="delete" data-id="${escapeHTML(row.id)}">Delete</button>` : ''}</td>
    </tr>
  `).join('');
}

async function saveOverexposureCase() {
  clearMsg('overexposureMsg');
  const id = $('overexposureCaseId')?.value;
  const body = {
    employeeId: $('overexposureEmployee').value,
    doseId: $('overexposureDoseId').value,
    incidentDate: $('overexposureIncidentDate').value,
    incidentType: $('overexposureIncidentType').value,
    doseReportQuarter: $('overexposureQuarter').value.trim(),
    receivedDose: Number($('overexposureReceivedDose').value || 0),
    doseUnit: 'mSv',
    doseType: $('overexposureDoseType').value,
    severity: $('overexposureSeverity').value,
    status: $('overexposureStatus').value,
    reportReference: $('overexposureReportReference').value.trim(),
    regulatoryReportRequired: $('overexposureRegReportRequired').checked,
    reportedTo: $('overexposureReportedTo').value.trim(),
    regulatoryReportDate: $('overexposureRegReportDate').value,
    rscReviewDate: $('overexposureRscReviewDate').value,
    incidentSummary: $('overexposureSummary').value.trim(),
    suspectedCause: $('overexposureCause').value.trim(),
    immediateAction: $('overexposureImmediateAction').value.trim(),
    medicalReview: $('overexposureMedicalReview').value.trim(),
    actionTaken: $('overexposureActionTaken').value.trim(),
    correctiveAction: $('overexposureCorrectiveAction').value.trim(),
    preventiveAction: $('overexposurePreventiveAction').value.trim(),
    closureNote: $('overexposureClosureNote').value.trim(),
    closedBy: $('overexposureStatus').value === 'Closed' ? (state.me?.name || '') : '',
    rsoSignerName: $('overexposureSignerName').value.trim(),
    rsoSignatureData: canvasDataUrl('overexposureSignatureCanvas'),
    employeeSignerName: $('overexposureEmployeeSignerName').value.trim(),
    employeeAcknowledgementText: $('overexposureEmployeeAckText').value.trim(),
    employeeSignatureData: canvasDataUrl('overexposureEmployeeSignatureCanvas')
  };
  if (!body.employeeId) { setMsg('overexposureMsg', 'Select employee/TLD holder.', false); return; }
  if (!body.doseReportQuarter) { setMsg('overexposureMsg', 'Enter dose report quarter.', false); return; }
  try {
    await api(id ? `/api/overexposure-cases/${encodeURIComponent(id)}` : '/api/overexposure-cases', { method: id ? 'PUT' : 'POST', body });
    setMsg('overexposureMsg', 'Accidental / overexposure case saved.', true);
    await loadAdminData();
  } catch (err) { setMsg('overexposureMsg', err.message, false); }
}

function handleOverexposureAction(event) {
  const btn = event.target.closest('[data-overexposure-action]');
  if (!btn) return;
  const action = btn.dataset.overexposureAction;
  const id = btn.dataset.id;
  if (action === 'from-dose') {
    resetOverexposureForm();
    fillOverexposureFromDose(btn.dataset.doseId);
    $$('.admin-tab-panel').forEach(panel => panel.classList.add('hidden'));
    $('tabOverexposure')?.classList.remove('hidden');
    $$('.admin-tab').forEach(tab => tab.classList.toggle('tab-active', tab.dataset.tab === 'tabOverexposure'));
  }
  if (action === 'edit') selectOverexposureCase(id);
  if (action === 'pdf') window.open(`/api/overexposure-cases/${encodeURIComponent(id)}/pdf`, '_blank', 'noopener');
  if (action === 'delete') {
    if (!confirm('Delete this accidental / overexposure case?')) return;
    api(`/api/overexposure-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(loadAdminData).catch(err => alert(err.message));
  }
}

function exportSelectedOverexposurePdf() {
  const id = $('overexposureCaseId')?.value;
  if (!id) { setMsg('overexposureMsg', 'Save/select a case first.', false); return; }
  window.open(`/api/overexposure-cases/${encodeURIComponent(id)}/pdf`, '_blank', 'noopener');
}

function canvasDataUrl(id) {
  const canvas = $(id);
  if (!canvas) return '';
  if (canvas.dataset.hasInk !== '1') return '';
  try { return canvas.toDataURL('image/png'); } catch (_) { return ''; }
}

function clearCanvas(id) {
  const canvas = $(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.dataset.hasInk = '0';
}

function drawDataUrlOnCanvas(id, dataUrl) {
  const canvas = $(id);
  if (!canvas || !dataUrl) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.dataset.hasInk = '1';
  };
  img.src = dataUrl;
}

function initSignaturePad(id) {
  const canvas = $(id);
  if (!canvas || canvas.dataset.signatureReady) return;
  canvas.dataset.signatureReady = '1';
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  let drawing = false;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    const src = event.touches?.[0] || event;
    return { x: (src.clientX - rect.left) * (canvas.width / rect.width), y: (src.clientY - rect.top) * (canvas.height / rect.height) };
  };
  const start = (event) => { event.preventDefault(); drawing = true; const p = point(event); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (event) => { if (!drawing) return; event.preventDefault(); const p = point(event); ctx.lineTo(p.x, p.y); ctx.stroke(); canvas.dataset.hasInk = '1'; };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
}

function selectedReminderTypes() {
  return $$('.reminder-type').filter(c => c.checked).map(c => c.value);
}

function selectedReminderChannels() {
  return $$('.reminder-channel').filter(c => c.checked).map(c => c.value);
}

function renderOpsControls() {
  const years = yearOptions();
  ['statementYearSelect', 'auditPackYear'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const prev = el.value || (id === 'auditPackYear' ? 'all' : String(new Date().getFullYear()));
    const prefix = id === 'auditPackYear' ? '<option value="all">All years</option>' : '';
    el.innerHTML = prefix + years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (Array.from(el.options).some(o => o.value === prev)) el.value = prev;
  });
  const auditQ = $('auditPackQuarter');
  if (auditQ) {
    const quarters = collectQuarterOptions();
    const prev = auditQ.value || 'all';
    auditQ.innerHTML = '<option value="all">All quarters</option>' + quarters.map(q => `<option value="${escapeHTML(q)}">${escapeHTML(q)}</option>`).join('');
    auditQ.value = quarters.includes(prev) || prev === 'all' ? prev : 'all';
  }
  renderReminderLog();
}

function renderReminderPreview(rows) {
  const tbody = $('reminderPreviewBody');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = emptyRow(5, 'No reminder targets for the selected quarter/types.'); return; }
  tbody.innerHTML = rows.map(r => `
    <tr><td class="table-cell">${escapeHTML(r.type)}</td><td class="table-cell">${escapeHTML(r.employee?.name || '')}</td><td class="table-cell">${escapeHTML(r.employee?.email || '')}</td><td class="table-cell">${escapeHTML(r.employee?.phone || '')}</td><td class="table-cell max-w-md">${escapeHTML(r.message || '')}</td></tr>
  `).join('');
}

async function previewReminders() {
  clearMsg('reminderMsg');
  const quarter = $('reminderQuarter')?.value || currentQuarterLabel();
  try {
    const data = await api(`/api/reminders/preview?quarter=${encodeURIComponent(quarter)}`);
    const types = selectedReminderTypes();
    const rows = (data.reminders || []).filter(r => types.includes(r.type));
    renderReminderPreview(rows);
    setMsg('reminderMsg', `${rows.length} reminder target(s) found.`, true);
  } catch (err) { setMsg('reminderMsg', err.message, false); }
}

async function sendReminders() {
  clearMsg('reminderMsg');
  const quarter = $('reminderQuarter')?.value || currentQuarterLabel();
  try {
    const data = await api('/api/reminders/send', { method: 'POST', body: { quarter, types: selectedReminderTypes(), channels: selectedReminderChannels() } });
    setMsg('reminderMsg', `Reminder job completed for ${data.count} target(s).`, true);
    await loadAdminData();
    await previewReminders();
  } catch (err) { setMsg('reminderMsg', err.message, false); }
}

function renderReminderLog() {
  const tbody = $('reminderLogBody');
  if (!tbody) return;
  if (!state.reminderLogs.length) { tbody.innerHTML = emptyRow(7, 'No reminder delivery logs yet.'); return; }
  tbody.innerHTML = state.reminderLogs.slice(0, 300).map(r => `
    <tr><td class="table-cell">${escapeHTML(fmtDate(r.createdAt))}</td><td class="table-cell">${escapeHTML(r.reminderType)}</td><td class="table-cell">${escapeHTML(r.recipientName)}</td><td class="table-cell">${escapeHTML(r.channel)}</td><td class="table-cell">${escapeHTML(r.destination)}</td><td class="table-cell">${escapeHTML(r.status)}</td><td class="table-cell max-w-xs">${escapeHTML(r.providerResponse || '')}</td></tr>
  `).join('');
}


function selectedNotificationChannels() {
  return $$('.notification-channel').filter(c => c.checked).map(c => c.value);
}

function notificationAudienceLabel(value) {
  if (value === 'individual') return 'Individual user';
  if (value === 'allEmployees') return 'All active employees';
  return 'All active TLD users';
}

function notificationPayload() {
  return {
    audience: $('notificationAudience')?.value || 'allTldUsers',
    targetEmployeeId: $('notificationEmployeeSelect')?.value || '',
    subject: $('notificationSubject')?.value.trim() || '',
    message: $('notificationMessage')?.value.trim() || '',
    channels: selectedNotificationChannels()
  };
}

function renderNotificationControls() {
  const targetBox = $('notificationTargetBox');
  if (targetBox) targetBox.classList.toggle('hidden', ($('notificationAudience')?.value || 'allTldUsers') !== 'individual');
  const countBox = $('notificationStats');
  if (countBox) {
    const total = state.notifications.length;
    const rows = state.notificationRecipients || [];
    const sent = rows.filter(r => ['sent', 'posted'].includes(r.status)).length;
    const failed = rows.filter(r => ['failed', 'skipped'].includes(r.status)).length;
    countBox.innerHTML = `Notifications: <span class="font-semibold text-emerald-300">${total}</span> · Delivered/posted: <span class="font-semibold text-cyan-300">${sent}</span> · Skipped/failed: <span class="font-semibold text-amber-300">${failed}</span>`;
  }
}

function renderNotificationPreview(rows) {
  const tbody = $('notificationPreviewBody');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = emptyRow(6, 'No recipients found.'); return; }
  tbody.innerHTML = rows.map(r => {
    const channels = (r.channels || []).map(c => `<span class="status-pill mr-1">${escapeHTML(c)}</span>`).join('');
    const dest = r.destinations || {};
    return `<tr><td class="table-cell">${escapeHTML(r.employee?.name || '')}</td><td class="table-cell">${escapeHTML(r.employee?.tldNumber || '')}</td><td class="table-cell">${escapeHTML(r.employee?.email || '')}</td><td class="table-cell">${escapeHTML(r.employee?.phone || '')}</td><td class="table-cell">${channels}</td><td class="table-cell max-w-md">${escapeHTML(r.message || '')}<div class="text-slate-500 mt-1">Portal: ${escapeHTML(dest.portal || '')}</div></td></tr>`;
  }).join('');
}

async function previewNotification() {
  clearMsg('notificationMsg');
  try {
    const data = await api('/api/notifications/preview', { method: 'POST', body: notificationPayload() });
    renderNotificationPreview(data.recipients || []);
    setMsg('notificationMsg', `${data.count || 0} recipient(s) found.`, true);
  } catch (err) {
    renderNotificationPreview([]);
    setMsg('notificationMsg', err.message, false);
  }
}

async function sendNotification() {
  clearMsg('notificationMsg');
  try {
    const data = await api('/api/notifications', { method: 'POST', body: notificationPayload() });
    setMsg('notificationMsg', `Notification generated. ${data.count || 0} recipient-channel record(s) created.`, true);
    if ($('notificationSubject')) $('notificationSubject').value = '';
    if ($('notificationMessage')) $('notificationMessage').value = '';
    renderNotificationPreview([]);
    await loadAdminData();
  } catch (err) {
    setMsg('notificationMsg', err.message, false);
  }
}

function renderNotificationHistory() {
  const tbody = $('notificationHistoryBody');
  if (!tbody) return;
  if (!state.notifications.length) { tbody.innerHTML = emptyRow(7, 'No notifications generated yet.'); return; }
  const recipients = state.notificationRecipients || [];
  tbody.innerHTML = state.notifications.slice(0, 200).map(n => {
    const rows = recipients.filter(r => r.notificationId === n.id);
    const summary = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const statusText = Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(', ') || 'No recipients';
    const channels = (n.channels || []).map(c => `<span class="status-pill mr-1">${escapeHTML(c)}</span>`).join('');
    return `<tr><td class="table-cell">${escapeHTML(fmtDate(n.createdAt))}</td><td class="table-cell max-w-xs"><div class="font-semibold">${escapeHTML(n.subject)}</div><div class="text-slate-500 mt-1">${escapeHTML(n.message).slice(0, 160)}${String(n.message || '').length > 160 ? '…' : ''}</div></td><td class="table-cell">${escapeHTML(notificationAudienceLabel(n.audience))}</td><td class="table-cell">${channels}</td><td class="table-cell">${rows.length}</td><td class="table-cell max-w-xs">${escapeHTML(statusText)}</td><td class="table-cell"><button class="btn-danger !py-1 !px-2" data-notification-action="delete" data-id="${escapeHTML(n.id)}">Delete</button></td></tr>`;
  }).join('');
}

async function handleNotificationAction(event) {
  const btn = event.target.closest('[data-notification-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.notificationAction;
  if (action === 'delete') {
    if (!confirm('Delete this notification history entry?')) return;
    try { await api(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
  } else if (action === 'read') {
    try { await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }); await loadEmployeeData(); } catch (err) { alert(err.message); }
  }
}

function renderEmployeeNotifications() {
  const box = $('empNotificationList');
  if (!box) return;
  const list = state.notifications || [];
  if (!list.length) {
    box.innerHTML = '<div class="soft-card rounded-2xl p-3 text-slate-500">No notifications from RSO yet.</div>';
    return;
  }
  box.innerHTML = list.slice(0, 50).map(n => {
    const unread = !n.readAt;
    const status = unread ? '<span class="status-pill text-amber-200 bg-amber-950/40">Unread</span>' : '<span class="status-pill text-emerald-200 bg-emerald-950/40">Read</span>';
    const channels = (n.channels || []).map(c => `<span class="status-pill mr-1">${escapeHTML(c)}</span>`).join('');
    return `<div class="soft-card rounded-2xl p-3 ${unread ? 'border-amber-500/40' : ''}"><div class="flex items-start justify-between gap-2"><div><div class="font-semibold">${escapeHTML(n.subject || '')}</div><div class="text-slate-500 text-[10px] mt-1">${escapeHTML(fmtDate(n.createdAt))} · ${escapeHTML(n.createdByName || 'RSO')}</div></div>${status}</div><div class="text-slate-300 mt-2 whitespace-pre-wrap">${escapeHTML(n.message || '')}</div><div class="mt-2">${channels}</div>${unread ? `<button class="btn-secondary !py-1 !px-2 mt-2" data-notification-action="read" data-id="${escapeHTML(n.id)}">Mark as read</button>` : ''}</div>`;
  }).join('');
}

function rscMeetingOptions(includeBlank = true) {
  const opts = state.rscMeetings.slice().sort((a, b) => String(b.meetingDate).localeCompare(String(a.meetingDate))).map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.meetingDate)} · ${escapeHTML(m.title)}</option>`).join('');
  return (includeBlank ? '<option value="">General RSC document</option>' : '') + opts;
}

function renderRscSection() {
  const memberBody = $('rscMemberBody');
  if (memberBody) {
    if (!state.rscMembers.length) memberBody.innerHTML = emptyRow(8, 'No committee members added yet.');
    else memberBody.innerHTML = state.rscMembers.map(m => `<tr><td class="table-cell">${escapeHTML(m.name)}</td><td class="table-cell">${escapeHTML(m.committeeRole || '')}</td><td class="table-cell">${escapeHTML(m.designation || '')}</td><td class="table-cell">${escapeHTML(m.department || '')}</td><td class="table-cell"><div>${escapeHTML(m.email || '')}</div><div class="text-slate-500">${escapeHTML(m.phone || '')}</div></td><td class="table-cell">${m.active ? '<span class="text-emerald-300">Active</span>' : '<span class="text-slate-500">Inactive</span>'}</td><td class="table-cell">${escapeHTML(fmtDate(m.updatedAt || m.createdAt))}</td><td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-rsc-member-action="edit" data-id="${escapeHTML(m.id)}">Edit</button><button class="btn-danger !py-1 !px-2" data-rsc-member-action="delete" data-id="${escapeHTML(m.id)}">Delete</button></td></tr>`).join('');
  }
  const meetingBody = $('rscMeetingBody');
  if (meetingBody) {
    if (!state.rscMeetings.length) meetingBody.innerHTML = emptyRow(7, 'No Radiation Safety Committee meetings recorded yet.');
    else meetingBody.innerHTML = state.rscMeetings.map(m => { const docCount = state.rscDocuments.filter(d => d.meetingId === m.id).length; return `<tr><td class="table-cell">${escapeHTML(m.meetingDate)}</td><td class="table-cell max-w-xs"><div class="font-semibold">${escapeHTML(m.title)}</div><div class="text-slate-500 mt-1">${escapeHTML(m.venue || '')}</div></td><td class="table-cell">${escapeHTML(m.chairperson || '')}</td><td class="table-cell max-w-md">${escapeHTML(m.decisions || m.minutes || '').slice(0, 180)}${String(m.decisions || m.minutes || '').length > 180 ? '…' : ''}</td><td class="table-cell">${escapeHTML(m.status || '')}</td><td class="table-cell">${docCount}</td><td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-rsc-meeting-action="edit" data-id="${escapeHTML(m.id)}">Edit</button><button class="btn-danger !py-1 !px-2" data-rsc-meeting-action="delete" data-id="${escapeHTML(m.id)}">Delete</button></td></tr>`; }).join('');
  }
  const meetingSelect = $('rscDocumentMeeting');
  if (meetingSelect) {
    const prev = meetingSelect.value;
    meetingSelect.innerHTML = rscMeetingOptions(true);
    if (Array.from(meetingSelect.options).some(o => o.value === prev)) meetingSelect.value = prev;
  }
  const docBody = $('rscDocumentBody');
  if (docBody) {
    if (!state.rscDocuments.length) docBody.innerHTML = emptyRow(7, 'No RSC documents uploaded yet.');
    else docBody.innerHTML = state.rscDocuments.map(d => { const m = state.rscMeetings.find(x => x.id === d.meetingId); return `<tr><td class="table-cell">${escapeHTML(d.documentType || '')}</td><td class="table-cell">${escapeHTML(m ? `${m.meetingDate} · ${m.title}` : 'General')}</td><td class="table-cell"><div class="font-semibold">${escapeHTML(d.title || d.originalName)}</div><div class="text-slate-500">${escapeHTML(d.description || '')}</div></td><td class="table-cell break-all">${escapeHTML(d.originalName)}</td><td class="table-cell">${escapeHTML(fmtSize(d.size))}</td><td class="table-cell">${escapeHTML(fmtDate(d.createdAt))}</td><td class="table-cell whitespace-nowrap"><button class="btn-secondary !py-1 !px-2" data-rsc-doc-action="open" data-id="${escapeHTML(d.id)}">Open</button><button class="btn-secondary !py-1 !px-2" data-rsc-doc-action="download" data-id="${escapeHTML(d.id)}">Download</button><button class="btn-danger !py-1 !px-2" data-rsc-doc-action="delete" data-id="${escapeHTML(d.id)}">Delete</button></td></tr>`; }).join('');
  }
}

function resetRscMemberForm() {
  ['rscMemberId','rscMemberName','rscMemberDesignation','rscMemberDepartment','rscMemberCommitteeRole','rscMemberEmail','rscMemberPhone'].forEach(id => { if ($(id)) $(id).value = ''; });
  if ($('rscMemberActive')) $('rscMemberActive').checked = true;
  clearMsg('rscMemberMsg');
}

async function saveRscMember() {
  clearMsg('rscMemberMsg');
  const id = $('rscMemberId')?.value || '';
  const body = {
    name: $('rscMemberName')?.value.trim() || '',
    designation: $('rscMemberDesignation')?.value.trim() || '',
    department: $('rscMemberDepartment')?.value.trim() || '',
    committeeRole: $('rscMemberCommitteeRole')?.value.trim() || '',
    email: $('rscMemberEmail')?.value.trim() || '',
    phone: $('rscMemberPhone')?.value.trim() || '',
    active: !!$('rscMemberActive')?.checked
  };
  try {
    await api(id ? `/api/rsc/members/${encodeURIComponent(id)}` : '/api/rsc/members', { method: id ? 'PUT' : 'POST', body });
    setMsg('rscMemberMsg', 'Committee member saved.', true);
    resetRscMemberForm();
    await loadAdminData();
  } catch (err) { setMsg('rscMemberMsg', err.message, false); }
}

function resetRscMeetingForm() {
  ['rscMeetingId','rscMeetingDate','rscMeetingTitle','rscMeetingVenue','rscMeetingChairperson','rscMeetingAgenda','rscMeetingMinutes','rscMeetingDecisions','rscMeetingActions'].forEach(id => { if ($(id)) $(id).value = ''; });
  if ($('rscMeetingStatus')) $('rscMeetingStatus').value = 'Draft';
  clearMsg('rscMeetingMsg');
}

async function saveRscMeeting() {
  clearMsg('rscMeetingMsg');
  const id = $('rscMeetingId')?.value || '';
  const body = {
    meetingDate: $('rscMeetingDate')?.value || '',
    title: $('rscMeetingTitle')?.value.trim() || '',
    venue: $('rscMeetingVenue')?.value.trim() || '',
    chairperson: $('rscMeetingChairperson')?.value.trim() || '',
    agenda: $('rscMeetingAgenda')?.value.trim() || '',
    minutes: $('rscMeetingMinutes')?.value.trim() || '',
    decisions: $('rscMeetingDecisions')?.value.trim() || '',
    actionItems: $('rscMeetingActions')?.value.trim() || '',
    status: $('rscMeetingStatus')?.value || 'Draft'
  };
  try {
    await api(id ? `/api/rsc/meetings/${encodeURIComponent(id)}` : '/api/rsc/meetings', { method: id ? 'PUT' : 'POST', body });
    setMsg('rscMeetingMsg', 'Committee meeting / minutes saved.', true);
    resetRscMeetingForm();
    await loadAdminData();
  } catch (err) { setMsg('rscMeetingMsg', err.message, false); }
}

async function uploadRscDocument() {
  clearMsg('rscDocumentMsg');
  const input = $('rscDocumentFile');
  const file = input?.files?.[0];
  if (!file) { setMsg('rscDocumentMsg', 'Select a document to upload.', false); return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('meetingId', $('rscDocumentMeeting')?.value || '');
  fd.append('documentType', $('rscDocumentType')?.value || 'Minutes of Meeting');
  fd.append('title', $('rscDocumentTitle')?.value.trim() || file.name);
  fd.append('description', $('rscDocumentNotes')?.value.trim() || '');
  try {
    await api('/api/rsc/documents', { method: 'POST', formData: fd });
    input.value = '';
    if ($('rscDocumentTitle')) $('rscDocumentTitle').value = '';
    if ($('rscDocumentNotes')) $('rscDocumentNotes').value = '';
    setMsg('rscDocumentMsg', 'RSC document uploaded.', true);
    await loadAdminData();
  } catch (err) { setMsg('rscDocumentMsg', err.message, false); }
}

async function handleRscAction(event) {
  const memberBtn = event.target.closest('[data-rsc-member-action]');
  if (memberBtn) {
    const id = memberBtn.dataset.id;
    const member = state.rscMembers.find(m => m.id === id);
    if (!member) return;
    if (memberBtn.dataset.rscMemberAction === 'edit') {
      $('rscMemberId').value = member.id;
      $('rscMemberName').value = member.name || '';
      $('rscMemberDesignation').value = member.designation || '';
      $('rscMemberDepartment').value = member.department || '';
      $('rscMemberCommitteeRole').value = member.committeeRole || '';
      $('rscMemberEmail').value = member.email || '';
      $('rscMemberPhone').value = member.phone || '';
      $('rscMemberActive').checked = !!member.active;
      document.getElementById('tabRsc')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (memberBtn.dataset.rscMemberAction === 'delete') {
      if (!confirm(`Delete committee member ${member.name}?`)) return;
      try { await api(`/api/rsc/members/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
    }
    return;
  }
  const meetingBtn = event.target.closest('[data-rsc-meeting-action]');
  if (meetingBtn) {
    const id = meetingBtn.dataset.id;
    const meeting = state.rscMeetings.find(m => m.id === id);
    if (!meeting) return;
    if (meetingBtn.dataset.rscMeetingAction === 'edit') {
      $('rscMeetingId').value = meeting.id;
      $('rscMeetingDate').value = meeting.meetingDate || '';
      $('rscMeetingTitle').value = meeting.title || '';
      $('rscMeetingVenue').value = meeting.venue || '';
      $('rscMeetingChairperson').value = meeting.chairperson || '';
      $('rscMeetingAgenda').value = meeting.agenda || '';
      $('rscMeetingMinutes').value = meeting.minutes || '';
      $('rscMeetingDecisions').value = meeting.decisions || '';
      $('rscMeetingActions').value = meeting.actionItems || '';
      $('rscMeetingStatus').value = meeting.status || 'Draft';
      document.getElementById('tabRsc')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (meetingBtn.dataset.rscMeetingAction === 'delete') {
      if (!confirm(`Delete meeting ${meeting.title}? Related RSC documents will also be removed.`)) return;
      try { await api(`/api/rsc/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
    }
    return;
  }
  const docBtn = event.target.closest('[data-rsc-doc-action]');
  if (docBtn) {
    const id = docBtn.dataset.id;
    if (docBtn.dataset.rscDocAction === 'open') window.open(`/api/rsc/documents/${encodeURIComponent(id)}/download?inline=1`, '_blank', 'noopener');
    else if (docBtn.dataset.rscDocAction === 'download') window.location.href = `/api/rsc/documents/${encodeURIComponent(id)}/download`;
    else if (docBtn.dataset.rscDocAction === 'delete') {
      if (!confirm('Delete this RSC document?')) return;
      try { await api(`/api/rsc/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdminData(); } catch (err) { alert(err.message); }
    }
  }
}

function openAnnualStatement(employeeId, year) {
  if (!employeeId) return;
  window.open(`/api/reports/annual-statement/${encodeURIComponent(employeeId)}?year=${encodeURIComponent(year || new Date().getFullYear())}`, '_blank', 'noopener');
}

function exportAerbPack() {
  const quarter = $('auditPackQuarter')?.value || 'all';
  const year = $('auditPackYear')?.value || 'all';
  window.location.href = `/api/aerb/audit-pack?quarter=${encodeURIComponent(quarter)}&year=${encodeURIComponent(year)}`;
}

async function exportBackup() {
  clearMsg('importDataMsg');
  const encrypted = !!$('encryptedBackupToggle')?.checked;
  const password = $('backupPassword')?.value || '';
  if (encrypted && password.length < 8) { setMsg('importDataMsg', 'Enter a backup password of at least 8 characters.', false); return; }
  try {
    const response = await fetch(encrypted ? '/api/backup/export?encrypted=1' : '/api/backup/export', {
      headers: encrypted ? { 'X-Backup-Password': password } : {}
    });
    if (!response.ok) throw new Error((await response.json()).error || response.statusText);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    a.href = url;
    a.download = match ? match[1] : `radpro_tld_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMsg('importDataMsg', encrypted ? 'Encrypted backup exported.' : 'Backup exported.', true);
  } catch (err) {
    setMsg('importDataMsg', err.message || 'Backup export failed', false);
  }
}

function renderSettings() {
  if ($('settingDeptName')) $('settingDeptName').value = state.settings.deptName || '';
  if ($('settingRsoNotes')) $('settingRsoNotes').value = state.settings.rsoNotes || '';
  if ($('settingAnnualLimit')) $('settingAnnualLimit').value = state.settings.annualLimit || $('annualLimit')?.value || '20';
  if ($('settingDoseAlertEnabled')) $('settingDoseAlertEnabled').checked = String(state.settings.doseAlertEnabled || 'true') !== 'false';
  if ($('settingDoseAlertLimit')) $('settingDoseAlertLimit').value = state.settings.doseAlertLimit || '0';
  if ($('settingDosePortalVisibility')) $('settingDosePortalVisibility').value = state.settings.dosePortalVisibility || 'all';
  if ($('settingAwarenessMandatory')) $('settingAwarenessMandatory').checked = String(state.settings.awarenessMandatory || 'true') !== 'false';
  if ($('settingAwarenessPosterVersion')) $('settingAwarenessPosterVersion').value = state.settings.awarenessPosterVersion || 'v1';
  let channels = ['portal'];
  try { channels = JSON.parse(state.settings.doseAlertChannels || '["portal"]'); } catch (_) { channels = String(state.settings.doseAlertChannels || 'portal').split(','); }
  $$('.dose-alert-channel').forEach(box => { box.checked = channels.includes(box.value); });
}

async function saveSettings() {
  clearMsg('settingsMsg');
  try {
    const annualLimit = $('settingAnnualLimit').value || '20';
    const doseAlertChannels = $$('.dose-alert-channel').filter(c => c.checked).map(c => c.value);
    await api('/api/settings', { method: 'PUT', body: { deptName: $('settingDeptName').value.trim(), rsoNotes: $('settingRsoNotes').value.trim(), annualLimit, doseAlertEnabled: $('settingDoseAlertEnabled').checked, doseAlertLimit: $('settingDoseAlertLimit').value || '0', doseAlertChannels, dosePortalVisibility: $('settingDosePortalVisibility').value || 'all', awarenessMandatory: $('settingAwarenessMandatory') ? $('settingAwarenessMandatory').checked : true, awarenessPosterVersion: $('settingAwarenessPosterVersion') ? $('settingAwarenessPosterVersion').value.trim() || 'v1' : 'v1' } });
    $('annualLimit').value = annualLimit;
    setMsg('settingsMsg', 'Settings saved.', true);
    await loadAdminData();
  } catch (err) {
    setMsg('settingsMsg', err.message, false);
  }
}

function auditFilterParams(page = 1) {
  const p = new URLSearchParams(); p.set('page', String(page)); p.set('pageSize', '50');
  [['q','auditSearch'],['module','auditModuleFilter'],['actor','auditActorFilter'],['success','auditSuccessFilter'],['from','auditFromFilter'],['to','auditToFilter']].forEach(([key,id])=>{const v=$(id)?.value?.trim();if(v)p.set(key,v);});
  return p;
}
async function loadAuditLog(page = 1) {
  try { const data=await api(`/api/audit?${auditFilterParams(page).toString()}`); state.audit=data.logs||[]; state.auditPagination=data.pagination||state.auditPagination; state.auditFilters=data.filters||state.auditFilters; renderAuditLog(); }
  catch(err){ setMsg('settingsMsg',err.message||'Could not load audit log.',false); }
}
function renderAuditLog() {
  const tbody=$('auditLogBody'); if(!tbody)return;
  const mod=$('auditModuleFilter'); if(mod&&mod.options.length<=1){const cur=mod.value;mod.innerHTML='<option value="">All modules</option>'+(state.auditFilters.modules||[]).map(m=>`<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');mod.value=cur;}
  if(!state.audit.length) tbody.innerHTML=emptyRow(9,'No matching audit records.');
  else tbody.innerHTML=state.audit.map(log=>{const ok=Number(log.success)!==0;const entity=[log.entityType,log.entityId].filter(Boolean).join(' · ');return `<tr><td class="table-cell whitespace-nowrap">${escapeHTML(fmtDate(log.createdAt))}</td><td class="table-cell"><div class="font-semibold">${escapeHTML(log.actorName||'System')}</div><div class="text-slate-500">${escapeHTML(log.actorRole||'')}</div></td><td class="table-cell">${escapeHTML(log.module||'System')}</td><td class="table-cell">${escapeHTML(log.eventType||'')}</td><td class="table-cell">${escapeHTML(log.action||'')}</td><td class="table-cell">${escapeHTML(entity||'-')}</td><td class="table-cell"><span class="${ok?'text-emerald-400':'text-rose-400'}">${ok?'Success':`Failed ${log.statusCode||''}`}</span></td><td class="table-cell">${escapeHTML(log.ipAddress||'-')}</td><td class="table-cell max-w-[360px] break-words"><div>${escapeHTML(log.details||'')}</div>${log.requestPath?`<div class="text-slate-500">${escapeHTML(log.httpMethod||'')} ${escapeHTML(log.requestPath)}</div>`:''}</td></tr>`;}).join('');
  const pg=state.auditPagination||{page:1,pages:1,total:0}; if($('auditPageInfo'))$('auditPageInfo').textContent=`Page ${pg.page} of ${pg.pages} · ${pg.total} records`; if($('auditPrevBtn'))$('auditPrevBtn').disabled=pg.page<=1; if($('auditNextBtn'))$('auditNextBtn').disabled=pg.page>=pg.pages;
}

async function importBackupFromFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  clearMsg('importDataMsg');
  try {
    const data = JSON.parse(await readAsText(file));
    if (data.encrypted) {
      const password = $('backupPassword')?.value || prompt('Enter backup password') || '';
      data.password = password;
    }
    if (!confirm('Restore this backup? Existing server data will be replaced.')) return;
    await api('/api/backup/import', { method: 'POST', body: data });
    setMsg('importDataMsg', 'Backup restored successfully.', true);
    await loadAdminData();
  } catch (err) {
    setMsg('importDataMsg', err.message, false);
  } finally {
    event.target.value = '';
  }
}


function showAwarenessIfRequired() {
  const aw = state.awarenessStatus;
  const modal = $('awarenessModal');
  if (!modal || !aw || !aw.required || aw.acknowledged) return;
  if ($('awarenessPosterImg')) $('awarenessPosterImg').src = aw.posterUrl || '/assets/tld_awareness_hindi.jpg';
  if ($('awarenessQuarterText')) $('awarenessQuarterText').textContent = `Please read this TLD safe-use poster and acknowledge it for ${aw.quarter || currentQuarterLabel()}.`;
  if ($('awarenessConfirm')) $('awarenessConfirm').checked = false;
  if ($('awarenessMsg')) $('awarenessMsg').textContent = 'This acknowledgement is mandatory once every quarter before accessing the employee portal.';
  modal.classList.remove('hidden');
}

async function acknowledgeAwarenessPoster() {
  const aw = state.awarenessStatus || {};
  if (!$('awarenessConfirm')?.checked) {
    setMsg('awarenessMsg', 'Please tick the confirmation checkbox after reading the poster.', false);
    return;
  }
  try {
    await api('/api/awareness/acknowledge', {
      method: 'POST',
      body: {
        quarter: aw.quarter || currentQuarterLabel(),
        posterVersion: aw.posterVersion || 'v1',
        statementText: aw.statementText || 'I have read and understood the TLD safe-use instructions and will follow the correct TLD badge usage procedure.'
      }
    });
    if ($('awarenessModal')) $('awarenessModal').classList.add('hidden');
    state.awarenessStatus = { ...aw, acknowledged: true, acknowledgedAt: new Date().toISOString() };
  } catch (err) {
    setMsg('awarenessMsg', err.message || 'Could not save acknowledgement.', false);
  }
}

function downloadAcknowledgementStatusReport() {
  const quarter = $('ackReportQuarter')?.value || currentQuarterLabel();
  const status = $('ackReportStatus')?.value || 'all';
  window.open(`/api/acknowledgements/report.pdf?quarter=${encodeURIComponent(quarter)}&status=${encodeURIComponent(status)}`, '_blank');
}

function downloadAwarenessReport() {
  const quarter = $('ackReportQuarter')?.value || currentQuarterLabel();
  window.open(`/api/awareness/report.pdf?quarter=${encodeURIComponent(quarter)}`, '_blank');
}

function renderEmployeeUI() {
  const me = state.me;
  if (!me) return;
  const annualLimit = Number(state.settings.annualLimit || 20);
  const year = new Date().getFullYear();
  const doses = state.doses.slice().sort((a, b) => quarterToSortKey(b.quarter) - quarterToSortKey(a.quarter) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const currentYearDoses = doses.filter(d => getYearFromText(d.quarter || d.period) === year);
  const cum = currentYearDoses.reduce((sum, d) => sum + Number(d.hp10 || 0), 0);
  $('empViewName').textContent = me.name;
  $('empViewDept').textContent = me.dept || '';
  $('empViewTld').textContent = me.tldNumber || 'Not assigned';
  if ($('empSignerName') && !$('empSignerName').value) $('empSignerName').value = me.name || '';
  $('empViewCumHp10').textContent = cum.toFixed(2);
  let status = 'Within monitored working range';
  let cls = 'text-xs mt-1 text-emerald-300';
  if (cum >= annualLimit) { status = 'Above annual limit — contact RSO immediately.'; cls = 'text-xs mt-1 text-red-300'; }
  else if (cum >= annualLimit * 0.8) { status = 'High cumulative dose — follow RSO guidance.'; cls = 'text-xs mt-1 text-amber-300'; }
  const statusEl = $('empViewStatus');
  statusEl.textContent = status;
  statusEl.className = cls;
  renderEmployeeDoseTable(doses);
  renderEmployeeAttachments();
  renderEmployeeNotifications();
  renderEmployeeRscMembers();
  renderEmployeeAckText(doses);
}

function renderEmployeeRscMembers() {
  const tbody = $('empRscMemberBody');
  if (!tbody) return;
  const members = (state.rscMembers || []).filter(member => member.active !== false);
  if (!members.length) {
    tbody.innerHTML = emptyRow(5, 'No active Radiation Safety Committee members have been published yet.');
    return;
  }
  tbody.innerHTML = members.map(member => `
    <tr>
      <td class="table-cell font-semibold">${escapeHTML(member.name || '')}</td>
      <td class="table-cell">${escapeHTML(member.committeeRole || '')}</td>
      <td class="table-cell">${escapeHTML(member.designation || '')}</td>
      <td class="table-cell">${escapeHTML(member.department || '')}</td>
      <td class="table-cell"><div>${escapeHTML(member.email || '')}</div><div class="text-slate-500">${escapeHTML(member.phone || '')}</div></td>
    </tr>`).join('');
}

function renderEmployeeDoseTable(doses) {
  const tbody = $('empDoseTableBody');
  if (!tbody) return;
  if (!doses.length) {
    const limit = Number(state.settings.doseAlertLimit || 0);
    const hiddenPolicy = state.settings.dosePortalVisibility === 'aboveLimitOnly' && limit > 0;
    tbody.innerHTML = emptyRow(6, hiddenPolicy ? `No dose record is visible because your dose has not crossed the center's notification limit of ${limit.toFixed(2)} mSv.` : 'No dose records available yet.');
    return;
  }
  tbody.innerHTML = doses.map(d => `
    <tr><td class="table-cell">${escapeHTML(d.quarter || '')}</td><td class="table-cell">${escapeHTML(d.period || '')}</td><td class="table-cell">${Number(d.hp10 || 0).toFixed(2)}</td><td class="table-cell">${Number(d.hp007 || 0).toFixed(2)}</td><td class="table-cell">${escapeHTML(d.remarks || '')}</td><td class="table-cell">${hasAck(d.employeeId, d.quarter) ? '<span class="text-emerald-300">Acknowledged</span>' : '<span class="text-amber-300">Pending</span>'}</td></tr>
  `).join('');
}

function renderEmployeeAttachments() {
  const box = $('empAttachmentList');
  if (!box) return;
  const list = state.attachments.filter(a => a.docType === 'employeeForm').slice().sort((a, b) => quarterToSortKey(b.quarter) - quarterToSortKey(a.quarter) || String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!list.length) {
    box.innerHTML = '<div class="soft-card rounded-2xl p-3 text-slate-500">No attachments published for you yet.</div>';
    return;
  }
  box.innerHTML = list.map(att => `
    <div class="soft-card rounded-2xl p-3">
      <div class="flex items-center justify-between gap-2"><span class="font-semibold">${escapeHTML(docTypeLabel(att.docType))}</span><span class="status-pill">${escapeHTML(att.quarter || '')}</span></div>
      <div class="text-slate-400 mt-1 break-all">${escapeHTML(att.originalName)}</div>
      <div class="text-slate-500 mt-1">${escapeHTML(att.description || att.periodLabel || '')}</div>
      <div class="mt-2 flex gap-2">${attachmentActionButtons(att)}</div>
    </div>
  `).join('');
}

function renderEmployeeAckText(doses) {
  const latest = doses[0];
  const msg = $('empAckMsg');
  if (!latest) {
    msg.textContent = 'No dose record to acknowledge.';
    $('empAcknowledgeLatestBtn').disabled = true;
    return;
  }
  $('empAcknowledgeLatestBtn').disabled = false;
  msg.textContent = hasAck(latest.employeeId, latest.quarter) ? `Latest dose ${latest.quarter} acknowledged.` : `Latest dose ${latest.quarter} pending acknowledgement.`;
}

async function acknowledgeLatestDose() {
  const latest = state.doses.slice().sort((a, b) => quarterToSortKey(b.quarter) - quarterToSortKey(a.quarter) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!latest) return;
  if ($('empAckStatement') && !$('empAckStatement').checked) {
    $('empAckMsg').textContent = 'Please confirm the acknowledgement statement before signing.';
    return;
  }
  try {
    await api('/api/acknowledgements', {
      method: 'POST',
      body: {
        period: latest.period,
        quarter: latest.quarter,
        signerName: $('empSignerName')?.value.trim() || state.me?.name || '',
        signatureData: '',
        statementText: 'I have reviewed my personal TLD dose record and acknowledge the entry.'
      }
    });
    await loadEmployeeData();
  } catch (err) {
    $('empAckMsg').textContent = err.message;
  }
}

function initTabs() {
  $$('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('hidden')) return;
      const target = btn.dataset.tab;
      $$('.admin-tab-panel').forEach(panel => panel.classList.add('hidden'));
      $(target)?.classList.remove('hidden');
      $$('.admin-tab').forEach(tab => tab.classList.remove('tab-active'));
      btn.classList.add('tab-active');
      if (target === 'tabAnalytics') renderAnalytics();
      if (target === 'tabVault') renderDocVault();
      if (target === 'tabOps') { renderOpsControls(); renderReminderLog(); }
      if (target === 'tabNotifications') { renderNotificationControls(); renderNotificationHistory(); }
      if (target === 'tabRsc') renderRscSection();
      if (target === 'tabTraining') renderTrainingAdmin();
      if (target === 'tabOverexposure') renderOverexposureSection();
    });
  });
  forceTabVisibilityForRole();
}


function renderTrainingAdmin() {
  const qSel = $('trainingQuarter');
  if (qSel && !qSel.options.length) populateQuarterSelects();
  if (qSel && !qSel.value) qSel.value = currentQuarterLabel();
  const module = state.trainingModule?.module || {};
  setText('trainingDocTitle', module.title || 'Radiation Safety Training Module');
  setText('trainingQuestionBankCount', String(module.questionBankSize || 0));
  setText('trainingActiveQuizInfo', state.trainingModule?.activeQuiz ? `${state.trainingModule.activeQuiz.questionCount} questions generated for ${state.trainingModule.activeQuiz.quarter}` : 'No active questionnaire generated for this quarter yet.');
  renderTrainingResults();
  renderTrainingQuestionPreview();
}

function renderTrainingResults() {
  const tbody = $('trainingScoreBody');
  if (!tbody) return;
  const rows = state.trainingResults || [];
  if (!rows.length) { tbody.innerHTML = emptyRow(8, 'No training test attempts yet.'); return; }
  tbody.innerHTML = rows.map(r => `<tr class="border-b border-slate-800">
    <td class="table-cell">${escapeHTML(r.employeeName || '')}</td>
    <td class="table-cell font-mono">${escapeHTML(r.tldNumber || '')}</td>
    <td class="table-cell">${escapeHTML(r.employeeDept || '')}</td>
    <td class="table-cell">${escapeHTML(r.hospitalName || '')}</td>
    <td class="table-cell">${escapeHTML(r.quarter || '')}</td>
    <td class="table-cell font-semibold">${Number(r.score || 0)}/${Number(r.totalQuestions || 0)}</td>
    <td class="table-cell">${Number(r.percentage || 0).toFixed(1)}%</td>
    <td class="table-cell">${r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '-'}</td>
  </tr>`).join('');
}

function renderTrainingQuestionPreview() {
  const box = $('trainingQuestionPreview');
  if (!box) return;
  const data = state.trainingAdminQuestions || {};
  const questions = data.questions || [];
  if (!questions.length) {
    box.innerHTML = '<div class="soft-card rounded-2xl p-3 text-slate-400">No generated questionnaire for this quarter yet. Click <b>Auto Create Random Questionnaire</b> to create questions.</div>';
    return;
  }
  box.innerHTML = questions.map((q, idx) => {
    const opts = q.options || {};
    return `<div class="soft-card rounded-2xl p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="font-semibold text-slate-100">Q${idx + 1}. ${escapeHTML(q.questionText || '')}</div>
        <div class="text-[10px] px-2 py-1 rounded-full bg-slate-900/80 border border-slate-700 text-slate-300">Page ${escapeHTML(q.sourcePage || '-')}</div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
        ${['A','B','C','D'].map(k => `<div class="rounded-xl border ${q.correctOption === k ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-slate-800 bg-slate-950/40'} p-2"><span class="font-semibold">${k}.</span> ${escapeHTML(opts[k] || '')}${q.correctOption === k ? ' <span class="text-emerald-300 font-semibold">✓ Correct</span>' : ''}</div>`).join('')}
      </div>
      ${q.explanation ? `<div class="mt-2 text-[11px] text-slate-400"><span class="text-slate-300 font-semibold">Explanation:</span> ${escapeHTML(q.explanation)}</div>` : ''}
    </div>`;
  }).join('');
}

async function refreshTrainingQuestions() {
  const quarter = $('trainingQuarter')?.value || currentQuarterLabel();
  try {
    state.trainingAdminQuestions = await api(`/api/training/questions?quarter=${encodeURIComponent(quarter)}`);
    renderTrainingQuestionPreview();
  } catch (err) {
    const box = $('trainingQuestionPreview');
    if (box) box.innerHTML = `<div class="soft-card rounded-2xl p-3 text-rose-300">${escapeHTML(err.message || 'Could not load generated questions.')}</div>`;
  }
}

async function generateTrainingQuiz() {
  clearMsg('trainingAdminMsg');
  try {
    const quarter = $('trainingQuarter')?.value || currentQuarterLabel();
    const questionCount = Number($('trainingQuestionCount')?.value || 10);
    await api('/api/training/generate', { method: 'POST', body: { quarter, questionCount } });
    setMsg('trainingAdminMsg', `Questionnaire generated for ${quarter}.`, true);
    const [module, results, questions] = await Promise.all([api(`/api/training/module?quarter=${encodeURIComponent(quarter)}`), api(`/api/training/results?quarter=${encodeURIComponent(quarter)}`), api(`/api/training/questions?quarter=${encodeURIComponent(quarter)}`)]);
    state.trainingModule = module;
    state.trainingResults = results.results || [];
    state.trainingAdminQuestions = questions || null;
    renderTrainingAdmin();
  } catch (err) { setMsg('trainingAdminMsg', err.message || 'Could not generate questionnaire.', false); }
}

function downloadTrainingScoresPdf() {
  const quarter = $('trainingQuarter')?.value || currentQuarterLabel();
  window.open(`/api/training/results.pdf?quarter=${encodeURIComponent(quarter)}`, '_blank');
}

function renderEmployeeTraining() {
  const module = state.trainingModule?.module || {};
  setText('empTrainingTitle', module.title || 'Radiation Safety Training Module');
  setText('empTrainingQuarter', currentQuarterLabel());
  const quiz = state.trainingQuiz?.quiz;
  const attempt = state.trainingQuiz?.attempt;
  setText('empTrainingQuizInfo', quiz ? `${quiz.questionCount} objective questions - 1 mark each` : 'No active questionnaire available yet.');
  setText('empTrainingScore', attempt ? `Latest score: ${attempt.score}/${attempt.totalQuestions} (${Number(attempt.percentage || 0).toFixed(1)}%)` : 'No attempt submitted yet.');
  const box = $('empTrainingQuizBox');
  if (box) box.classList.add('hidden');
}

function startEmployeeTrainingQuiz() {
  const quiz = state.trainingQuiz?.quiz;
  const questions = state.trainingQuiz?.questions || [];
  const box = $('empTrainingQuizBox');
  const body = $('empTrainingQuestionList');
  if (!quiz || !questions.length || !box || !body) return;
  state.trainingStartedAt = new Date().toISOString();
  state.trainingSelectedAnswers = {};
  body.innerHTML = questions.map((q, idx) => `<div class="soft-card rounded-2xl p-3 mb-3">
    <div class="font-semibold mb-2">${idx + 1}. ${escapeHTML(q.questionText)}</div>
    ${Object.entries(q.options || {}).map(([key, val]) => `<label class="block py-1 text-xs"><input type="radio" name="trq_${escapeHTML(q.id)}" value="${key}" data-training-q="${escapeHTML(q.id)}"> <span class="font-semibold">${key}.</span> ${escapeHTML(val)}</label>`).join('')}
    <div class="text-[10px] text-slate-500 mt-1">Source page: ${escapeHTML(q.sourcePage || '-')}</div>
  </div>`).join('');
  body.querySelectorAll('[data-training-q]').forEach(input => input.addEventListener('change', e => { state.trainingSelectedAnswers[e.target.dataset.trainingQ] = e.target.value; }));
  box.classList.remove('hidden');
  clearMsg('empTrainingMsg');
}

async function submitEmployeeTrainingQuiz() {
  clearMsg('empTrainingMsg');
  const quiz = state.trainingQuiz?.quiz;
  const questions = state.trainingQuiz?.questions || [];
  if (!quiz || !questions.length) { setMsg('empTrainingMsg', 'No active questionnaire available.', false); return; }
  if (Object.keys(state.trainingSelectedAnswers || {}).length < questions.length) { setMsg('empTrainingMsg', 'Please answer all questions before submitting.', false); return; }
  try {
    const answers = questions.map(q => ({ questionId: q.id, selectedOption: state.trainingSelectedAnswers[q.id] || '' }));
    const result = await api('/api/training/submit', { method: 'POST', body: { quizId: quiz.id, startedAt: state.trainingStartedAt, answers } });
    const a = result.attempt;
    setMsg('empTrainingMsg', `Training submitted. Your score is ${a.score}/${a.totalQuestions} (${Number(a.percentage || 0).toFixed(1)}%).`, true);
    state.trainingQuiz.attempt = a;
    renderEmployeeTraining();
    $('empTrainingQuizBox')?.classList.add('hidden');
  } catch (err) { setMsg('empTrainingMsg', err.message || 'Could not submit training test.', false); }
}

function bindEvents() {
  $('loginBtn')?.addEventListener('click', handleLogin);
  $('forgotLoginBtn')?.addEventListener('click', () => toggleRecoveryBox(true));
  $('closeRecoveryBtn')?.addEventListener('click', () => toggleRecoveryBox(false));
  $('recoveryType')?.addEventListener('change', updateRecoveryMode);
  $('submitRecoveryBtn')?.addEventListener('click', submitRecoveryRequest);
  $('recoveryContact')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRecoveryRequest(); });
  $('passwordResetUsername')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRecoveryRequest(); });
  $('verifyTwoFactorBtn')?.addEventListener('click', verifyTwoFactor);
  $('twoFactorCode')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyTwoFactor(); });
  $('loginPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $('logoutBtn')?.addEventListener('click', handleLogout);
  $('saveEmployeeBtn')?.addEventListener('click', saveEmployee);
  $('resetEmployeeFormBtn')?.addEventListener('click', resetEmployeeForm);
  $('empAccessRole')?.addEventListener('change', () => { if ($('empIsRSO')) $('empIsRSO').checked = ['sysadmin','org_admin','admin','rso'].includes($('empAccessRole').value); });
  $('empOrganizationId')?.addEventListener('change', () => { renderEmployeeHospitalSelect(); loadDepartmentsForHospital($('empHospitalId')?.value || ''); });
  $('empHospitalId')?.addEventListener('change', () => loadDepartmentsForHospital($('empHospitalId')?.value || ''));
  bindTenancyEvents();
  $('hospitalOrgSelect')?.addEventListener('change', () => {});
  $('empIsRSO')?.addEventListener('change', () => { if ($('empAccessRole') && $('empIsRSO').checked) $('empAccessRole').value = 'rso'; });
  $('employeeTableBody')?.addEventListener('click', handleEmployeeTableClick);
  $('empSearch')?.addEventListener('input', renderEmployeeTable);
  $('uploadFormAttachmentBtn')?.addEventListener('click', handleFormAttachmentUpload);
  $('uploadQuarterAttachmentBtn')?.addEventListener('click', handleQuarterAttachmentUpload);
  $('parseTldFileBtn')?.addEventListener('click', handleTldFileParse);
  $('refreshPeriodBtn')?.addEventListener('click', renderSelectedPeriodReport);
  $('periodSelect')?.addEventListener('change', renderSelectedPeriodReport);
  $('docFilterType')?.addEventListener('change', renderDocVault);
  $('docFilterQuarter')?.addEventListener('change', renderDocVault);
  $('docSearch')?.addEventListener('input', renderDocVault);
  $('refreshComplianceBtn')?.addEventListener('click', renderCompliance);
  $('complianceQuarter')?.addEventListener('change', renderCompliance);
  $('analyticsEmployeeSelect')?.addEventListener('change', renderAnalytics);
  $('analyticsYearSelect')?.addEventListener('change', renderAnalytics);
  $('annualLimit')?.addEventListener('input', () => { $('annualLimit').dataset.touched = 'true'; renderAnalytics(); renderDashboardCards(); });
  $('refreshAnalyticsBtn')?.addEventListener('click', renderAnalytics);
  $('adminAnnualStatementBtn')?.addEventListener('click', () => openAnnualStatement($('analyticsEmployeeSelect')?.value, $('analyticsYearSelect')?.value));
  $('saveInvestigationBtn')?.addEventListener('click', saveInvestigation);
  $('exportInvestigationPdfBtn')?.addEventListener('click', exportSelectedInvestigationPdf);
  $('clearInvestigationSignatureBtn')?.addEventListener('click', () => clearCanvas('investigationSignatureCanvas'));
  $('saveOverexposureBtn')?.addEventListener('click', saveOverexposureCase);
  $('resetOverexposureBtn')?.addEventListener('click', resetOverexposureForm);
  $('exportOverexposurePdfBtn')?.addEventListener('click', exportSelectedOverexposurePdf);
  $('clearOverexposureSignatureBtn')?.addEventListener('click', () => clearCanvas('overexposureSignatureCanvas'));
  $('clearOverexposureEmployeeSignatureBtn')?.addEventListener('click', () => clearCanvas('overexposureEmployeeSignatureCanvas'));
  $('overexposureEmployee')?.addEventListener('change', () => renderOverexposureDoseOptions($('overexposureEmployee').value));
  $('overexposureDoseId')?.addEventListener('change', () => { if ($('overexposureDoseId').value) fillOverexposureFromDose($('overexposureDoseId').value); });
  $('previewRemindersBtn')?.addEventListener('click', previewReminders);
  $('sendRemindersBtn')?.addEventListener('click', sendReminders);
  $('notificationAudience')?.addEventListener('change', renderNotificationControls);
  $('previewNotificationBtn')?.addEventListener('click', previewNotification);
  $('sendNotificationBtn')?.addEventListener('click', sendNotification);
  $('saveRscMemberBtn')?.addEventListener('click', saveRscMember);
  $('resetRscMemberBtn')?.addEventListener('click', resetRscMemberForm);
  $('saveRscMeetingBtn')?.addEventListener('click', saveRscMeeting);
  $('resetRscMeetingBtn')?.addEventListener('click', resetRscMeetingForm);
  $('uploadRscDocumentBtn')?.addEventListener('click', uploadRscDocument);
  $('generateTrainingQuizBtn')?.addEventListener('click', generateTrainingQuiz);
  $('downloadTrainingScoresBtn')?.addEventListener('click', downloadTrainingScoresPdf);
  $('refreshTrainingQuestionsBtn')?.addEventListener('click', refreshTrainingQuestions);
  $('trainingQuarter')?.addEventListener('change', async () => {
    const quarter = $('trainingQuarter')?.value || currentQuarterLabel();
    try {
      const [module, results, questions] = await Promise.all([api(`/api/training/module?quarter=${encodeURIComponent(quarter)}`), api(`/api/training/results?quarter=${encodeURIComponent(quarter)}`), api(`/api/training/questions?quarter=${encodeURIComponent(quarter)}`)]);
      state.trainingModule = module;
      state.trainingResults = results.results || [];
      state.trainingAdminQuestions = questions || null;
      renderTrainingAdmin();
    } catch (err) { setMsg('trainingAdminMsg', err.message || 'Could not load selected quarter.', false); }
  });
  $('empOpenTrainingDocBtn')?.addEventListener('click', () => window.open('/assets/radiation_safety_training_module.pdf', '_blank'));
  $('empStartTrainingQuizBtn')?.addEventListener('click', startEmployeeTrainingQuiz);
  $('empSubmitTrainingQuizBtn')?.addEventListener('click', submitEmployeeTrainingQuiz);
  $('downloadAnnualStatementBtn')?.addEventListener('click', () => openAnnualStatement($('statementEmployeeSelect')?.value, $('statementYearSelect')?.value));
  $('downloadAckStatusReportBtn')?.addEventListener('click', downloadAcknowledgementStatusReport);
  $('downloadAwarenessReportBtn')?.addEventListener('click', downloadAwarenessReport);
  $('acknowledgeAwarenessBtn')?.addEventListener('click', acknowledgeAwarenessPoster);
  $('exportAerbPackBtn')?.addEventListener('click', exportAerbPack);
  $('exportAuditCsvBtn')?.addEventListener('click', () => { window.location.href = '/api/audit/export.csv'; });
  $('auditApplyBtn')?.addEventListener('click',()=>loadAuditLog(1));
  $('auditRefreshBtn')?.addEventListener('click',()=>loadAuditLog(state.auditPagination?.page||1));
  $('auditClearBtn')?.addEventListener('click',()=>{['auditSearch','auditModuleFilter','auditActorFilter','auditSuccessFilter','auditFromFilter','auditToFilter'].forEach(id=>{if($(id))$(id).value='';});loadAuditLog(1);});
  $('auditExportFilteredBtn')?.addEventListener('click',()=>{const p=auditFilterParams(1);p.delete('page');p.delete('pageSize');window.location.href=`/api/audit/export.csv?${p.toString()}`;});
  $('auditPrevBtn')?.addEventListener('click',()=>loadAuditLog(Math.max(1,(state.auditPagination?.page||1)-1)));
  $('auditNextBtn')?.addEventListener('click',()=>loadAuditLog(Math.min(state.auditPagination?.pages||1,(state.auditPagination?.page||1)+1)));
  $('auditSearch')?.addEventListener('keydown',e=>{if(e.key==='Enter')loadAuditLog(1);});
  $('addDepartmentBtn')?.addEventListener('click', addDepartment);
  $('departmentName')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDepartment(); });
  $('refreshDepartmentsBtn')?.addEventListener('click', () => loadDepartmentsForHospital($('departmentHospitalId')?.value || state.me?.hospitalId || ''));
  $('departmentHospitalId')?.addEventListener('change', () => loadDepartmentsForHospital($('departmentHospitalId')?.value || ''));
  $('departmentList')?.addEventListener('click', handleDepartmentListClick);
  $('saveSettingsBtn')?.addEventListener('click', saveSettings);
  $('exportDataBtn')?.addEventListener('click', exportBackup);
  $('importDataInput')?.addEventListener('change', importBackupFromFile);
  $('empPrintBtn')?.addEventListener('click', () => window.print());
  $('empAnnualStatementBtn')?.addEventListener('click', () => openAnnualStatement(state.me?.id, new Date().getFullYear()));
  $('empAcknowledgeLatestBtn')?.addEventListener('click', acknowledgeLatestDose);
  document.addEventListener('click', handleAttachmentAction);
  document.addEventListener('click', handleInvestigationAction);
  document.addEventListener('click', handleOverexposureAction);
  document.addEventListener('click', handleNotificationAction);
  document.addEventListener('click', handleRscAction);
}

async function init() {
  bindEvents();
  initSignaturePad('empSignatureCanvas');
  initSignaturePad('investigationSignatureCanvas');
  initSignaturePad('overexposureSignatureCanvas');
  initSignaturePad('overexposureEmployeeSignatureCanvas');
  initTabs();
  renderImportPreview([]);
  try {
    const data = await api('/api/auth/me');
    state.me = data.user;
    updateHeader();
    if (canAccessAdmin()) {
      showView('admin');
      await loadAdminData();
    } else {
      showView('employee');
      await loadEmployeeData();
    }
  } catch (_) {
    state.me = null;
    showLoggedOut();
  }
}

document.addEventListener('DOMContentLoaded', init);
