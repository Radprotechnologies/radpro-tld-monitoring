const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLIENT = path.join(__dirname, 'pg-bridge-client.js');
const DAEMON = path.join(__dirname, 'pg-bridge-daemon.js');
let daemonStarted = false;

function ensureDaemon() {
  if (daemonStarted) return;
  daemonStarted = true;
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, RADPRO_PARENT_PID: String(process.pid) },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.unref();
}

const CAMEL_KEY_MAP = {
  organizationid: 'organizationId', contactperson: 'contactPerson', packagename: 'packageName', licensestatus: 'licenseStatus', trialstartdate: 'trialStartDate', trialenddate: 'trialEndDate', registrationdate: 'registrationDate', renewaldueDate: 'renewalDueDate', renewaldue: 'renewalDueDate', billingamount: 'billingAmount', billingcycle: 'billingCycle', maxhospitals: 'maxHospitals', maxtldusers: 'maxTldUsers', billingnotes: 'billingNotes', createdat: 'createdAt', updatedat: 'updatedAt',
  hospitalid: 'hospitalId', tldnumber: 'tldNumber', accessrole: 'accessRole', twofactorenabled: 'twoFactorEnabled', passwordhash: 'passwordHash', isrso: 'isRSO',
  employeeid: 'employeeId', hp007: 'hp007', reportlabel: 'reportLabel', doctype: 'docType', periodlabel: 'periodLabel', documentstatus: 'documentStatus', originalname: 'originalName', storedname: 'storedName', mimetype: 'mimeType', publishtoemployees: 'publishToEmployees', uploadedby: 'uploadedBy',
  acknowledgedat: 'acknowledgedAt', signername: 'signerName', signaturedata: 'signatureData', signedat: 'signedAt', signedip: 'signedIp', statementtext: 'statementText', posterversion: 'posterVersion', posterurl: 'posterUrl', useragent: 'userAgent',
  sourcedoc: 'sourceDoc', questioncount: 'questionCount', createdby: 'createdBy', quizid: 'quizId', questiontext: 'questionText', optiona: 'optionA', optionb: 'optionB', optionc: 'optionC', optiond: 'optionD', correctoption: 'correctOption', sourcepage: 'sourcePage', sortorder: 'sortOrder', totalquestions: 'totalQuestions', answersjson: 'answersJson', startedat: 'startedAt', submittedat: 'submittedAt',
  actorid: 'actorId', actorname: 'actorName', doseid: 'doseId', rootcause: 'rootCause', immediateaction: 'immediateAction', correctiveaction: 'correctiveAction', closurestatus: 'closureStatus', rsosignername: 'rsoSignerName', rsosignaturedata: 'rsoSignatureData', openedby: 'openedBy', closedat: 'closedAt',
  incidentdate: 'incidentDate', incidenttype: 'incidentType', dosereportquarter: 'doseReportQuarter', receiveddose: 'receivedDose', doseunit: 'doseUnit', dosetype: 'doseType', reportreference: 'reportReference', incidentsummary: 'incidentSummary', suspectedcause: 'suspectedCause', medicalreview: 'medicalReview', actiontaken: 'actionTaken', preventiveaction: 'preventiveAction', regulatoryreportrequired: 'regulatoryReportRequired', reportedto: 'reportedTo', regulatoryreportdate: 'regulatoryReportDate', rscreviewdate: 'rscReviewDate', closurenote: 'closureNote', closedby: 'closedBy', employeesignername: 'employeeSignerName', employeeacknowledgementtext: 'employeeAcknowledgementText', employeesignaturedata: 'employeeSignatureData', employeesignedat: 'employeeSignedAt',
  remindertype: 'reminderType', recipientemployeeid: 'recipientEmployeeId', recipientname: 'recipientName', providerresponse: 'providerResponse', sentat: 'sentAt', targetemployeeid: 'targetEmployeeId', createdbyname: 'createdByName', notificationid: 'notificationId', employeename: 'employeeName', readat: 'readAt',
  committeerole: 'committeeRole', meetingdate: 'meetingDate', actionitems: 'actionItems', meetingid: 'meetingId', documenttype: 'documentType'
};
function normalizeRows(rows) {
  return (rows || []).map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[CAMEL_KEY_MAP[k] || k] = v;
    return out;
  });
}
function convertPlaceholders(sql) {
  let n = 0;
  let out = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') inSingle = !inSingle;
    if (ch === '?' && !inSingle) out += '$' + (++n);
    else out += ch;
  }
  return out;
}
function upsertTarget(table, cols) {
  if (table.toLowerCase() === 'settings') return 'key';
  return cols.split(',').map(s => s.trim()).includes('id') ? 'id' : cols.split(',')[0].trim();
}
function transformSql(sql) {
  let s = String(sql || '').trim();
  if (!s) return s;
  if (/^PRAGMA\s+/i.test(s)) return s;
  s = s.replace(/COLLATE\s+NOCASE/gi, '');
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  // SQLite accepts ALTER TABLE ADD COLUMN only after PRAGMA table_info checks.
  // In PostgreSQL, mixed-case column names are folded to lowercase unless quoted, so
  // the compatibility PRAGMA can miss existing camelCase columns. Make ADD COLUMN
  // idempotent at the SQL level to prevent crashes on repeated deploys/migrations.
  s = s.replace(/ALTER\s+TABLE\s+([a-zA-Z_][\w]*)\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i, 'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS ');
  s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z_][\w]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (m, table, cols, vals) => {
    const list = cols.split(',').map(c => c.trim()).filter(Boolean);
    const target = upsertTarget(table, cols);
    const updates = list.filter(c => c !== target).map(c => `${c}=EXCLUDED.${c}`).join(', ');
    return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${target}) DO UPDATE SET ${updates}`;
  });
  s = convertPlaceholders(s);
  return s;
}
function runWorker(sql, params = []) {
  ensureDaemon();
  const proc = spawnSync(process.execPath, [CLIENT], {
    input: JSON.stringify({ sql, params }),
    encoding: 'utf8',
    env: process.env,
    timeout: Number(process.env.PG_BRIDGE_SPAWN_TIMEOUT_MS || 40000),
    maxBuffer: 1024 * 1024 * 20
  });
  if (proc.error) {
    if (proc.error.code === 'ETIMEDOUT') throw new Error('PostgreSQL bridge timed out. Verify the Supabase Session Pooler DATABASE_URL and network access.');
    throw proc.error;
  }
  const raw = (proc.stdout || '').trim();
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch (e) { throw new Error(`PostgreSQL bridge returned invalid response: ${raw || proc.stderr}`); }
  if (!payload.ok) throw new Error(`PostgreSQL query failed: ${payload.error}${payload.sql ? `
SQL: ${payload.sql}` : ''}`);
  payload.rows = normalizeRows(payload.rows);
  return payload;
}

function splitStatements(sql) {
  return String(sql || '').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}
function createPostgresSyncBridge() {
  if (!process.env.DATABASE_URL) throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
  return {
    engine: 'postgres',
    pragma() {},
    exec(sql) {
      const text = String(sql || '').trim();
      if (!text) return;
      if (/^PRAGMA\s+/i.test(text)) return;
      for (const stmt of splitStatements(text)) {
        if (/^PRAGMA\s+/i.test(stmt)) continue;
        runWorker(transformSql(stmt));
      }
    },
    transaction(fn) { return (...args) => fn(...args); },
    prepare(sql) {
      const original = String(sql || '').trim();
      if (/^PRAGMA\s+table_info\(([^)]+)\)/i.test(original)) {
        const table = original.match(/^PRAGMA\s+table_info\(([^)]+)\)/i)[1].replace(/["'`]/g, '');
        return { all: () => runWorker(`SELECT column_name AS name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [table.toLowerCase()]).rows, get: () => undefined, run: () => ({ changes: 0 }) };
      }
      const converted = transformSql(original);
      return {
        all(...params) { return runWorker(converted, params).rows; },
        get(...params) { return runWorker(converted, params).rows[0]; },
        run(...params) { const r = runWorker(converted, params); return { changes: r.rowCount, lastInsertRowid: undefined }; }
      };
    }
  };
}
module.exports = { createPostgresSyncBridge, transformSql };
