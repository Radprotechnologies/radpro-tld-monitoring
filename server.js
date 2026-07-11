require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const DB_DRIVER = 'postgres';
const { createPostgresSyncBridge } = require('./scripts/pg-sync-bridge');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Phase 3.2 is PostgreSQL-only and no SQLite fallback is available.');
  process.exit(1);
}
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const TWO_FACTOR_REQUIRED = process.env.TWO_FACTOR_REQUIRED === 'true';
const AUTO_REMINDERS_ENABLED = process.env.AUTO_REMINDERS_ENABLED === 'true';
const REMINDER_INTERVAL_HOURS = Number(process.env.REMINDER_INTERVAL_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || '';
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || '';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const BACKUP_KDF_ITERATIONS = Number(process.env.BACKUP_KDF_ITERATIONS || 150000);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = createPostgresSyncBridge();
console.log('Radpro TLD database driver: postgres (Phase 3.2 PostgreSQL-only runtime)');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  address TEXT DEFAULT '',
  contactPerson TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  packageName TEXT DEFAULT 'Trial',
  licenseStatus TEXT DEFAULT 'Trial',
  trialStartDate TEXT DEFAULT '',
  trialEndDate TEXT DEFAULT '',
  registrationDate TEXT DEFAULT '',
  renewalDueDate TEXT DEFAULT '',
  billingAmount TEXT DEFAULT '',
  billingCycle TEXT DEFAULT '',
  maxHospitals INTEGER NOT NULL DEFAULT 1,
  maxTldUsers INTEGER NOT NULL DEFAULT 100,
  billingNotes TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hospitals (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  address TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(organizationId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_hospitals_org ON hospitals(organizationId);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT DEFAULT '',
  role TEXT DEFAULT 'Other',
  tldNumber TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  accessRole TEXT NOT NULL DEFAULT 'employee',
  twoFactorEnabled INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  isRSO INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_tld ON employees(tldNumber);
CREATE INDEX IF NOT EXISTS idx_employees_org ON employees(organizationId);
CREATE INDEX IF NOT EXISTS idx_employees_hospital ON employees(hospitalId);

CREATE TABLE IF NOT EXISTS doses (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  tldNumber TEXT NOT NULL,
  period TEXT NOT NULL,
  quarter TEXT NOT NULL,
  hp10 REAL NOT NULL DEFAULT 0,
  hp007 REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  reportLabel TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doses_employee ON doses(employeeId);
CREATE INDEX IF NOT EXISTS idx_doses_quarter ON doses(quarter);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doses_unique_period ON doses(employeeId, tldNumber, period, quarter);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  docType TEXT NOT NULL,
  employeeId TEXT,
  quarter TEXT DEFAULT '',
  periodLabel TEXT DEFAULT '',
  documentStatus TEXT DEFAULT '',
  description TEXT DEFAULT '',
  originalName TEXT NOT NULL,
  storedName TEXT NOT NULL,
  mimeType TEXT DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  publishToEmployees INTEGER NOT NULL DEFAULT 0,
  uploadedBy TEXT,
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_type ON attachments(docType);
CREATE INDEX IF NOT EXISTS idx_attachments_quarter ON attachments(quarter);
CREATE INDEX IF NOT EXISTS idx_attachments_employee ON attachments(employeeId);

CREATE TABLE IF NOT EXISTS acknowledgements (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  period TEXT DEFAULT '',
  quarter TEXT NOT NULL,
  acknowledgedAt TEXT NOT NULL,
  signerName TEXT DEFAULT '',
  signatureData TEXT DEFAULT '',
  signedAt TEXT,
  signedIp TEXT DEFAULT '',
  statementText TEXT DEFAULT '',
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE(employeeId, quarter)
);
CREATE INDEX IF NOT EXISTS idx_ack_employee ON acknowledgements(employeeId);

CREATE TABLE IF NOT EXISTS awareness_acknowledgements (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  quarter TEXT NOT NULL,
  posterVersion TEXT NOT NULL DEFAULT 'v1',
  posterUrl TEXT DEFAULT '/assets/tld_awareness_hindi.jpg',
  statementText TEXT DEFAULT '',
  acknowledgedAt TEXT NOT NULL,
  signedIp TEXT DEFAULT '',
  userAgent TEXT DEFAULT '',
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE(employeeId, quarter, posterVersion)
);
CREATE INDEX IF NOT EXISTS idx_awareness_employee ON awareness_acknowledgements(employeeId);
CREATE INDEX IF NOT EXISTS idx_awareness_quarter ON awareness_acknowledgements(quarter);


CREATE TABLE IF NOT EXISTS training_quizzes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sourceDoc TEXT DEFAULT '/assets/radiation_safety_training_module.pdf',
  quarter TEXT NOT NULL,
  questionCount INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_quizzes_quarter ON training_quizzes(quarter);

CREATE TABLE IF NOT EXISTS training_questions (
  id TEXT PRIMARY KEY,
  quizId TEXT NOT NULL,
  questionText TEXT NOT NULL,
  optionA TEXT NOT NULL,
  optionB TEXT NOT NULL,
  optionC TEXT NOT NULL,
  optionD TEXT NOT NULL,
  correctOption TEXT NOT NULL,
  explanation TEXT DEFAULT '',
  sourcePage INTEGER DEFAULT 0,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(quizId) REFERENCES training_quizzes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_questions_quiz ON training_questions(quizId);

CREATE TABLE IF NOT EXISTS training_attempts (
  id TEXT PRIMARY KEY,
  quizId TEXT NOT NULL,
  employeeId TEXT NOT NULL,
  quarter TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  totalQuestions INTEGER NOT NULL DEFAULT 0,
  percentage REAL NOT NULL DEFAULT 0,
  answersJson TEXT DEFAULT '[]',
  startedAt TEXT DEFAULT '',
  submittedAt TEXT NOT NULL,
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  FOREIGN KEY(quizId) REFERENCES training_quizzes(id) ON DELETE CASCADE,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_attempt_employee ON training_attempts(employeeId);
CREATE INDEX IF NOT EXISTS idx_training_attempt_quarter ON training_attempts(quarter);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  organizationId TEXT DEFAULT '',
  hospitalId TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_hospital ON departments(hospitalId);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organizationId);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actorId TEXT,
  actorName TEXT DEFAULT '',
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  doseId TEXT NOT NULL,
  employeeId TEXT NOT NULL,
  quarter TEXT DEFAULT '',
  period TEXT DEFAULT '',
  severity TEXT DEFAULT 'Investigate',
  status TEXT NOT NULL DEFAULT 'Open',
  rsoNote TEXT DEFAULT '',
  rootCause TEXT DEFAULT '',
  immediateAction TEXT DEFAULT '',
  correctiveAction TEXT DEFAULT '',
  closureStatus TEXT DEFAULT '',
  rsoSignerName TEXT DEFAULT '',
  rsoSignatureData TEXT DEFAULT '',
  openedBy TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  closedAt TEXT,
  FOREIGN KEY(doseId) REFERENCES doses(id) ON DELETE CASCADE,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE(doseId)
);
CREATE INDEX IF NOT EXISTS idx_investigations_employee ON investigations(employeeId);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);

CREATE TABLE IF NOT EXISTS overexposure_cases (
  id TEXT PRIMARY KEY,
  employeeId TEXT NOT NULL,
  doseId TEXT,
  incidentDate TEXT DEFAULT '',
  incidentType TEXT DEFAULT 'Suspected overexposure',
  doseReportQuarter TEXT DEFAULT '',
  receivedDose REAL NOT NULL DEFAULT 0,
  doseUnit TEXT DEFAULT 'mSv',
  doseType TEXT DEFAULT 'Hp(10)',
  severity TEXT DEFAULT 'Investigate',
  status TEXT NOT NULL DEFAULT 'Open',
  reportReference TEXT DEFAULT '',
  incidentSummary TEXT DEFAULT '',
  suspectedCause TEXT DEFAULT '',
  immediateAction TEXT DEFAULT '',
  medicalReview TEXT DEFAULT '',
  actionTaken TEXT DEFAULT '',
  correctiveAction TEXT DEFAULT '',
  preventiveAction TEXT DEFAULT '',
  regulatoryReportRequired INTEGER NOT NULL DEFAULT 0,
  reportedTo TEXT DEFAULT '',
  regulatoryReportDate TEXT DEFAULT '',
  rscReviewDate TEXT DEFAULT '',
  closureNote TEXT DEFAULT '',
  closedBy TEXT DEFAULT '',
  rsoSignerName TEXT DEFAULT '',
  rsoSignatureData TEXT DEFAULT '',
  employeeSignerName TEXT DEFAULT '',
  employeeAcknowledgementText TEXT DEFAULT '',
  employeeSignatureData TEXT DEFAULT '',
  employeeSignedAt TEXT,
  openedBy TEXT DEFAULT '',
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  closedAt TEXT,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY(doseId) REFERENCES doses(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_overexposure_cases_employee ON overexposure_cases(employeeId);
CREATE INDEX IF NOT EXISTS idx_overexposure_cases_status ON overexposure_cases(status);
CREATE INDEX IF NOT EXISTS idx_overexposure_cases_quarter ON overexposure_cases(doseReportQuarter);

CREATE TABLE IF NOT EXISTS reminder_logs (
  id TEXT PRIMARY KEY,
  reminderType TEXT NOT NULL,
  quarter TEXT DEFAULT '',
  channel TEXT NOT NULL,
  recipientEmployeeId TEXT,
  recipientName TEXT DEFAULT '',
  destination TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  providerResponse TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  sentAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_logs_quarter ON reminder_logs(quarter);
CREATE INDEX IF NOT EXISTS idx_reminder_logs_type ON reminder_logs(reminderType);


CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'allTldUsers',
  targetEmployeeId TEXT,
  channels TEXT NOT NULL DEFAULT '["portal"]',
  createdBy TEXT,
  createdByName TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  FOREIGN KEY(targetEmployeeId) REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(createdAt);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(targetEmployeeId);

CREATE TABLE IF NOT EXISTS notification_recipients (
  id TEXT PRIMARY KEY,
  notificationId TEXT NOT NULL,
  employeeId TEXT NOT NULL,
  employeeName TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'portal',
  destination TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted',
  providerResponse TEXT DEFAULT '',
  readAt TEXT,
  createdAt TEXT NOT NULL,
  sentAt TEXT,
  FOREIGN KEY(notificationId) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY(employeeId) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_notification ON notification_recipients(notificationId);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_employee ON notification_recipients(employeeId);

CREATE TABLE IF NOT EXISTS rsc_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  designation TEXT DEFAULT '',
  department TEXT DEFAULT '',
  committeeRole TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rsc_members_active ON rsc_members(active);

CREATE TABLE IF NOT EXISTS rsc_meetings (
  id TEXT PRIMARY KEY,
  meetingDate TEXT NOT NULL,
  title TEXT NOT NULL,
  venue TEXT DEFAULT '',
  chairperson TEXT DEFAULT '',
  agenda TEXT DEFAULT '',
  minutes TEXT DEFAULT '',
  decisions TEXT DEFAULT '',
  actionItems TEXT DEFAULT '',
  status TEXT DEFAULT 'Draft',
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rsc_meetings_date ON rsc_meetings(meetingDate);

CREATE TABLE IF NOT EXISTS rsc_documents (
  id TEXT PRIMARY KEY,
  meetingId TEXT,
  documentType TEXT DEFAULT 'Minutes of Meeting',
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  originalName TEXT NOT NULL,
  storedName TEXT NOT NULL,
  mimeType TEXT DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  uploadedBy TEXT DEFAULT '',
  organizationId TEXT DEFAULT '',
  hospitalId TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  FOREIGN KEY(meetingId) REFERENCES rsc_meetings(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rsc_documents_meeting ON rsc_documents(meetingId);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

[
  ['employees', 'email', "TEXT DEFAULT ''"],
  ['employees', 'phone', "TEXT DEFAULT ''"],
  ['employees', 'accessRole', "TEXT NOT NULL DEFAULT 'employee'"],
  ['employees', 'twoFactorEnabled', "INTEGER NOT NULL DEFAULT 0"],
  ['employees', 'organizationId', "TEXT DEFAULT ''"],
  ['employees', 'hospitalId', "TEXT DEFAULT ''"],
  ['organizations', 'packageName', "TEXT DEFAULT 'Trial'"],
  ['organizations', 'licenseStatus', "TEXT DEFAULT 'Trial'"],
  ['organizations', 'trialStartDate', "TEXT DEFAULT ''"],
  ['organizations', 'trialEndDate', "TEXT DEFAULT ''"],
  ['organizations', 'registrationDate', "TEXT DEFAULT ''"],
  ['organizations', 'renewalDueDate', "TEXT DEFAULT ''"],
  ['organizations', 'billingAmount', "TEXT DEFAULT ''"],
  ['organizations', 'billingCycle', "TEXT DEFAULT ''"],
  ['organizations', 'maxHospitals', "INTEGER NOT NULL DEFAULT 1"],
  ['organizations', 'maxTldUsers', "INTEGER NOT NULL DEFAULT 100"],
  ['organizations', 'billingNotes', "TEXT DEFAULT ''"],
  ['attachments', 'organizationId', "TEXT DEFAULT ''"],
  ['attachments', 'hospitalId', "TEXT DEFAULT ''"],
  ['notifications', 'organizationId', "TEXT DEFAULT ''"],
  ['notifications', 'hospitalId', "TEXT DEFAULT ''"],
  ['rsc_members', 'organizationId', "TEXT DEFAULT ''"],
  ['rsc_members', 'hospitalId', "TEXT DEFAULT ''"],
  ['rsc_meetings', 'organizationId', "TEXT DEFAULT ''"],
  ['rsc_meetings', 'hospitalId', "TEXT DEFAULT ''"],
  ['rsc_documents', 'organizationId', "TEXT DEFAULT ''"],
  ['rsc_documents', 'hospitalId', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'doseId', 'TEXT'],
  ['overexposure_cases', 'incidentDate', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'incidentType', "TEXT DEFAULT 'Suspected overexposure'"],
  ['overexposure_cases', 'doseReportQuarter', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'receivedDose', 'REAL NOT NULL DEFAULT 0'],
  ['overexposure_cases', 'doseUnit', "TEXT DEFAULT 'mSv'"],
  ['overexposure_cases', 'doseType', "TEXT DEFAULT 'Hp(10)'"],
  ['overexposure_cases', 'severity', "TEXT DEFAULT 'Investigate'"],
  ['overexposure_cases', 'status', "TEXT NOT NULL DEFAULT 'Open'"],
  ['overexposure_cases', 'reportReference', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'incidentSummary', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'suspectedCause', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'immediateAction', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'medicalReview', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'actionTaken', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'correctiveAction', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'preventiveAction', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'regulatoryReportRequired', "INTEGER NOT NULL DEFAULT 0"],
  ['overexposure_cases', 'reportedTo', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'regulatoryReportDate', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'rscReviewDate', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'closureNote', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'closedBy', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'rsoSignerName', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'rsoSignatureData', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'employeeSignerName', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'employeeAcknowledgementText', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'employeeSignatureData', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'employeeSignedAt', 'TEXT'],
  ['overexposure_cases', 'openedBy', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'organizationId', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'hospitalId', "TEXT DEFAULT ''"],
  ['overexposure_cases', 'closedAt', 'TEXT'],
  ['acknowledgements', 'signerName', "TEXT DEFAULT ''"],
  ['acknowledgements', 'signatureData', "TEXT DEFAULT ''"],
  ['acknowledgements', 'signedAt', 'TEXT'],
  ['acknowledgements', 'signedIp', "TEXT DEFAULT ''"],
  ['acknowledgements', 'statementText', "TEXT DEFAULT ''"],
  ['awareness_acknowledgements', 'posterUrl', "TEXT DEFAULT '/assets/tld_awareness_hindi.jpg'"],
  ['awareness_acknowledgements', 'statementText', "TEXT DEFAULT ''"],
  ['awareness_acknowledgements', 'signedIp', "TEXT DEFAULT ''"],
  ['awareness_acknowledgements', 'userAgent', "TEXT DEFAULT ''"],
  ['awareness_acknowledgements', 'organizationId', "TEXT DEFAULT ''"],
  ['awareness_acknowledgements', 'hospitalId', "TEXT DEFAULT ''"]
].forEach(([table, column, definition]) => ensureColumn(table, column, definition));

db.prepare("UPDATE employees SET accessRole = 'rso' WHERE isRSO = 1 AND (accessRole IS NULL OR accessRole = '' OR accessRole = 'employee')").run();

function nowISO() {
  return new Date().toISOString();
}

function currentQuarterFromDate(date = new Date()) {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `Q${q} ${date.getFullYear()}`;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}


const TRAINING_SOURCE_DOC = '/assets/radiation_safety_training_module.pdf';
const TRAINING_QUESTION_BANK = [
  { page: 18, q: 'What are the three basic factors for radiation protection?', a: 'Time, distance and shielding', b: 'Speed, power and color', c: 'Temperature, pressure and humidity', d: 'Voltage, current and resistance', correct: 'A', exp: 'The training module lists time, distance and shielding as the basic protection factors.' },
  { page: 27, q: 'What is the main purpose of a TLD badge?', a: 'To measure radiation dose received by the worker', b: 'To protect the worker from radiation', c: 'To switch off the X-ray machine', d: 'To reduce patient dose', correct: 'A', exp: 'A TLD badge is a radiation dose measuring device; it does not protect from radiation.' },
  { page: 28, q: 'Why should a TLD be used with its cassette?', a: 'The cassette filters help estimate dose correctly', b: 'The cassette makes the TLD waterproof only', c: 'The cassette increases X-ray output', d: 'The cassette replaces a lead apron', correct: 'A', exp: 'The cassette has windows/filters for dose estimation; a bare TLD can give wrong estimation.' },
  { page: 29, q: 'Where should a TLD be worn when using a lead apron?', a: 'Below the lead apron at chest level', b: 'Above the lead apron at head level', c: 'Inside the pocket away from the body', d: 'On the X-ray tube housing', correct: 'A', exp: 'The training emphasizes wearing the TLD below lead apron at chest level to estimate received dose.' },
  { page: 30, q: 'Where should TLD badges be stored when not in use?', a: 'In a radiation-free area', b: 'Inside the X-ray room', c: 'Near the CT gantry', d: 'On the fluoroscopy table', correct: 'A', exp: 'The module warns not to store personal/control TLD badges in radiation areas.' },
  { page: 19, q: 'How does reducing exposure time affect dose?', a: 'It reduces the dose received', b: 'It doubles the dose', c: 'It has no effect', d: 'It removes the need for shielding', correct: 'A', exp: 'Exposure from X-ray units is directly proportional to time.' },
  { page: 20, q: 'What happens to dose rate when distance from the X-ray source is doubled?', a: 'It falls to one-fourth of the original value', b: 'It doubles', c: 'It remains unchanged', d: 'It becomes zero', correct: 'A', exp: 'The inverse square law says doubling distance reduces dose rate to one-fourth.' },
  { page: 24, q: 'How much can radiation dose be reduced by using a lead apron according to the module?', a: 'More than 90%', b: 'About 10%', c: 'Only 1%', d: 'It is not reduced', correct: 'A', exp: 'The module states dose would be reduced by more than 90% by using lead apron.' },
  { page: 31, q: 'Which of the following is a radiation protection accessory?', a: 'Lead apron', b: 'Normal cotton coat', c: 'Plastic pen', d: 'Paper file', correct: 'A', exp: 'Lead apron is listed among radiation protection accessories.' },
  { page: 6, q: 'What is the mission of AERB as stated in the training module?', a: 'To ensure use of ionising radiation and nuclear energy does not cause undue risk to people and environment', b: 'To manufacture X-ray equipment', c: 'To issue hospital appointment letters', d: 'To process patient billing', correct: 'A', exp: 'The mission statement is given in the training module.' },
  { page: 16, q: 'What does ALARA mean in radiation protection?', a: 'As Low As Reasonably Achievable', b: 'As Large As Radiation Allows', c: 'Automatic Lead Apron Radiation Audit', d: 'Approved Local Area Radiation Alarm', correct: 'A', exp: 'Optimization of exposures requires keeping exposures ALARA.' },
  { page: 17, q: 'What is the whole-body occupational dose limit mentioned for workers?', a: '20 mSv/year averaged over 5 consecutive years; 30 mSv in any single year', b: '1 mSv/year only', c: '500 mSv/day', d: 'No limit applies', correct: 'A', exp: 'The dose-limit table gives the occupational worker whole-body limit.' },
  { page: 17, q: 'After pregnancy is declared, what dose limit is stated for embryo/fetus for the remainder of pregnancy?', a: '1 mSv', b: '20 mSv', c: '150 mSv', d: '500 mSv', correct: 'A', exp: 'The table note gives 1 mSv for the remainder of pregnancy.' },
  { page: 23, q: 'Which action helps reduce radiation dose to the individual?', a: 'Increase distance from the source', b: 'Stand closer to the source', c: 'Remove shielding accessories', d: 'Increase exposure time', correct: 'A', exp: 'The training says reduce time, increase distance and use shielding.' },
  { page: 33, q: 'Why should collimation be used?', a: 'To limit field size to the area of interest', b: 'To increase scattered radiation', c: 'To avoid image formation', d: 'To remove the need for TLD monitoring', correct: 'A', exp: 'The collimator limits field size to the area of interest.' },
  { page: 34, q: 'What does the training module say about antiscatter grids for pediatric patients?', a: 'Do not use grids where not required', b: 'Always use grids for every pediatric patient', c: 'Use grids instead of collimation', d: 'Use grids to eliminate radiation dose', correct: 'A', exp: 'The slide notes that antiscatter grids increase patient dose and should not be used for pediatric patients when not required.' },
  { page: 36, q: 'How should CT equipment be operated for radiation safety?', a: 'From the control room', b: 'Standing beside the gantry during exposure', c: 'From inside the scan room without shielding', d: 'With TLD left near the gantry', correct: 'A', exp: 'The CT safety slide says operate the CT equipment from the control room.' },
  { page: 39, q: 'What should be ensured for a dental IOPA X-ray cone?', a: 'It should be lead lined', b: 'It should be plastic only', c: 'It should be removed', d: 'It should be transparent without shielding', correct: 'A', exp: 'The dental radiography slide says ensure availability of a lead-lined cone and plastic cone should not be used.' },
  { page: 42, q: 'How often should QA testing of X-ray equipment be carried out according to the module?', a: 'Once in two years', b: 'Every day only', c: 'Once in ten years', d: 'Only after an accident', correct: 'A', exp: 'The module says carry out QA testing of each X-ray equipment once in two years.' },
  { page: 10, q: 'Which modality is included under diagnostic radiology equipment listed in the module?', a: 'Computed Tomography', b: 'MRI as ionising radiation equipment', c: 'Ultrasound as ionising radiation equipment', d: 'ECG machine', correct: 'A', exp: 'The module lists CT, IR, radiography, C-arm/O-arm, mammography, BMD and dental systems; MRI/ultrasound are non-ionising.' }
];
function shuffleArray(items) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function getActiveTrainingQuiz(quarter) {
  // Only RSO/Admin-published questionnaires are treated as active.
  // Older employee-side auto-generated quizzes are ignored so users cannot start a test
  // until RSO/Admin explicitly creates it from the Radiation Safety Training tab.
  return db.prepare(`
    SELECT q.*
    FROM training_quizzes q
    LEFT JOIN employees e ON e.id = q.createdBy
    WHERE q.quarter = ? AND q.active = 1
      AND (e.isRSO = 1 OR e.accessRole IN ('rso','sysadmin','org_admin','hospital_admin'))
    ORDER BY q.createdAt DESC
    LIMIT 1
  `).get(quarter);
}
function ensureTrainingQuiz(req, quarter, count = 10) {
  const existing = getActiveTrainingQuiz(quarter);
  if (existing) return existing;
  return createTrainingQuiz(req, quarter, count);
}
function createTrainingQuiz(req, quarter, count = 10) {
  const qCount = Math.max(1, Math.min(20, Number(count || 10)));
  const ts = nowISO();
  db.prepare('UPDATE training_quizzes SET active=0, updatedAt=? WHERE quarter=?').run(ts, quarter);
  const quizId = makeId('quiz');
  db.prepare('INSERT INTO training_quizzes (id, title, sourceDoc, quarter, questionCount, active, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(quizId, 'Radiation Safety Training Questionnaire', TRAINING_SOURCE_DOC, quarter, qCount, req.user ? req.user.id : '', ts, ts);
  const selected = shuffleArray(TRAINING_QUESTION_BANK).slice(0, qCount);
  const insert = db.prepare('INSERT INTO training_questions (id, quizId, questionText, optionA, optionB, optionC, optionD, correctOption, explanation, sourcePage, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  selected.forEach((item, idx) => insert.run(makeId('tq'), quizId, item.q, item.a, item.b, item.c, item.d, item.correct, item.exp, item.page, idx + 1));
  return db.prepare('SELECT * FROM training_quizzes WHERE id=?').get(quizId);
}
function trainingQuestionPublic(q, includeAnswer = false) {
  const row = { id: q.id, questionText: q.questionText, options: { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD }, sourcePage: q.sourcePage, sortOrder: q.sortOrder };
  if (includeAnswer) { row.correctOption = q.correctOption; row.explanation = q.explanation; }
  return row;
}
function trainingResultRows(req, quarter = 'all') {
  const scope = employeeScopeWhere(req.user, 'e');
  const params = [...scope.params];
  let where = scope.where;
  if (quarter && quarter !== 'all') { where += ' AND a.quarter = ?'; params.push(quarter); }
  return db.prepare(`
    SELECT a.*, e.name AS employeeName, e.dept AS employeeDept, e.tldNumber, e.role AS employeeRole, h.name AS hospitalName, o.name AS organizationName, q.title AS quizTitle
    FROM training_attempts a
    JOIN employees e ON e.id = a.employeeId
    LEFT JOIN hospitals h ON h.id = e.hospitalId
    LEFT JOIN organizations o ON o.id = e.organizationId
    LEFT JOIN training_quizzes q ON q.id = a.quizId
    WHERE ${where}
    ORDER BY a.submittedAt DESC
  `).all(...params);
}

function boolToInt(value) {
  return value === true || value === 'true' || value === '1' || value === 1 ? 1 : 0;
}

function normalizeTld(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(compact)) return compact.replace(/^0+(?=\d)/, '');
  return compact || raw;
}

function normalizePersonName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function dbBool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase().trim() === 'true';
}

function accessRoleFor(row) {
  const role = String(row && row.accessRole ? row.accessRole : '').toLowerCase().trim();
  const isRsoFlag = dbBool(row && row.isRSO);
  const clinicalRole = String(row && row.role ? row.role : '').toLowerCase().trim();
  const username = String(row && row.username ? row.username : '').toLowerCase().trim();

  // Phase 2B.1 role routing fix: in PostgreSQL migration/legacy rows the
  // protected Radpro account may still carry isRSO=1. The username/role must
  // take precedence so Radpro Admin never opens the hospital/RSO dashboard.
  if (username === 'radpro' || clinicalRole.includes('radpro super admin') || clinicalRole.includes('radpro panel admin') || isRadproInternalRole(row && row.role)) return 'sysadmin';

  if (['sysadmin', 'org_admin', 'admin', 'rso', 'auditor', 'employee'].includes(role)) return role;
  if (isRsoFlag || clinicalRole === 'rso' || username === 'rso') return 'rso';
  return 'employee';
}

function userCanAdmin(row) {
  const role = accessRoleFor(row);
  return role === 'sysadmin' || role === 'org_admin' || role === 'admin' || role === 'rso';
}

function userCanReadAudit(row) {
  const role = accessRoleFor(row);
  return role === 'sysadmin' || role === 'org_admin' || role === 'admin' || role === 'rso' || role === 'auditor';
}

function publicEmployee(row) {
  if (!row) return null;
  const accessRole = accessRoleFor(row);
  return {
    id: row.id,
    name: row.name,
    dept: row.dept || '',
    role: row.role || '',
    tldNumber: row.tldNumber || '',
    email: row.email || '',
    phone: row.phone || '',
    username: row.username,
    enabled: dbBool(row.enabled),
    isRSO: dbBool(row.isRSO) || accessRole === 'admin' || accessRole === 'rso',
    accessRole,
    twoFactorEnabled: !!row.twoFactorEnabled,
    organizationId: row.organizationId || '',
    hospitalId: row.hospitalId || '',
    organizationName: row.organizationName || '',
    hospitalName: row.hospitalName || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function attachmentPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    docType: row.docType,
    employeeId: row.employeeId,
    quarter: row.quarter || '',
    periodLabel: row.periodLabel || '',
    documentStatus: row.documentStatus || '',
    description: row.description || '',
    originalName: row.originalName,
    mimeType: row.mimeType || 'application/octet-stream',
    size: row.size || 0,
    publishToEmployees: !!row.publishToEmployees,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt
  };
}


function notificationPublic(row) {
  if (!row) return null;
  let channels = [];
  try { channels = JSON.parse(row.channels || '[]'); } catch (_) { channels = String(row.channels || '').split(',').filter(Boolean); }
  return {
    id: row.id,
    subject: row.subject,
    message: row.message,
    audience: row.audience || 'allTldUsers',
    targetEmployeeId: row.targetEmployeeId || '',
    channels,
    createdBy: row.createdBy || '',
    createdByName: row.createdByName || '',
    createdAt: row.createdAt
  };
}

function rscMemberPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    designation: row.designation || '',
    department: row.department || '',
    committeeRole: row.committeeRole || '',
    email: row.email || '',
    phone: row.phone || '',
    active: !!row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function rscMeetingPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    meetingDate: row.meetingDate,
    title: row.title,
    venue: row.venue || '',
    chairperson: row.chairperson || '',
    agenda: row.agenda || '',
    minutes: row.minutes || '',
    decisions: row.decisions || '',
    actionItems: row.actionItems || '',
    status: row.status || 'Draft',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function rscDocumentPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    meetingId: row.meetingId || '',
    documentType: row.documentType || 'Minutes of Meeting',
    title: row.title || '',
    description: row.description || '',
    originalName: row.originalName,
    mimeType: row.mimeType || 'application/octet-stream',
    size: row.size || 0,
    uploadedBy: row.uploadedBy || '',
    createdAt: row.createdAt
  };
}

function getEmployeeById(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

function getEmployeeByUsername(username) {
  return db.prepare('SELECT * FROM employees WHERE username = ?').get(username);
}

function getSettingValue(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? String(row.value || '') : fallback;
  } catch (_) {
    return fallback;
  }
}

function isDefaultDemoDeleted() {
  return getSettingValue('demoDefaultDeleted', '') === 'true';
}

function ensureDefaultTenancy() {
  // Production-safe behavior:
  // Do NOT recreate Default Organization / Default Hospital automatically.
  // The old behavior was causing the default hospital to come back after logout, restart or redeploy.
  // Demo seed can be explicitly enabled only for internal testing by setting ENABLE_DEMO_SEED=true.
  const enableDemoSeed = String(process.env.ENABLE_DEMO_SEED || '').toLowerCase() === 'true';
  const ts = nowISO();
  const defaultDeleted = isDefaultDemoDeleted();

  let org = db.prepare('SELECT * FROM organizations ORDER BY createdAt LIMIT 1').get();
  if (!org && enableDemoSeed && !defaultDeleted) {
    org = { id: 'org_default', name: 'Default Organization', code: 'DEFAULT' };
    db.prepare(`INSERT INTO organizations (id, name, code, address, contactPerson, email, phone, packageName, licenseStatus, trialStartDate, trialEndDate, registrationDate, renewalDueDate, billingAmount, billingCycle, maxHospitals, maxTldUsers, billingNotes, active, createdAt, updatedAt) VALUES (?, ?, ?, '', '', '', '', 'Trial', 'Trial', '', '', '', '', '', 'Trial', 1, 100, '', 1, ?, ?)`)
      .run(org.id, org.name, org.code, ts, ts);
  }

  let hosp = db.prepare('SELECT * FROM hospitals ORDER BY createdAt LIMIT 1').get();
  if (!hosp && enableDemoSeed && !defaultDeleted && org) {
    hosp = { id: 'hosp_default', organizationId: org.id, name: 'Default Hospital / Institute', code: 'DEFAULT-HOSP' };
    db.prepare(`INSERT INTO hospitals (id, organizationId, name, code, city, state, address, email, phone, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, '', '', '', '', '', 1, ?, ?)`)
      .run(hosp.id, hosp.organizationId, hosp.name, hosp.code, ts, ts);
  }

  // Only attach blank legacy rows when a real tenant exists. Never create a default tenant for this.
  if (org) {
    db.prepare(`UPDATE employees SET organizationId=? WHERE username <> 'radpro' AND (organizationId IS NULL OR organizationId='')`).run(org.id);
    db.prepare(`UPDATE attachments SET organizationId=? WHERE organizationId IS NULL OR organizationId=''`).run(org.id);
    db.prepare(`UPDATE rsc_members SET organizationId=? WHERE organizationId IS NULL OR organizationId=''`).run(org.id);
    db.prepare(`UPDATE rsc_meetings SET organizationId=? WHERE organizationId IS NULL OR organizationId=''`).run(org.id);
    db.prepare(`UPDATE rsc_documents SET organizationId=? WHERE organizationId IS NULL OR organizationId=''`).run(org.id);
  }
  if (hosp) {
    db.prepare(`UPDATE employees SET hospitalId=? WHERE username <> 'radpro' AND (hospitalId IS NULL OR hospitalId='')`).run(hosp.id);
    db.prepare(`UPDATE attachments SET hospitalId=? WHERE hospitalId IS NULL OR hospitalId=''`).run(hosp.id);
    db.prepare(`UPDATE rsc_members SET hospitalId=? WHERE hospitalId IS NULL OR hospitalId=''`).run(hosp.id);
    db.prepare(`UPDATE rsc_meetings SET hospitalId=? WHERE hospitalId IS NULL OR hospitalId=''`).run(hosp.id);
    db.prepare(`UPDATE rsc_documents SET hospitalId=? WHERE hospitalId IS NULL OR hospitalId=''`).run(hosp.id);
  }
  return { org, hosp };
}

function orgHospitalForUser(user) {
  const role = accessRoleFor(user);
  return { role, organizationId: user.organizationId || '', hospitalId: user.hospitalId || '' };
}

function employeeScopeWhere(user, alias = '') {
  const p = alias ? `${alias}.` : '';
  const role = accessRoleFor(user);
  if (role === 'sysadmin') return { where: '1=1', params: [] };
  if (role === 'org_admin') return { where: `${p}organizationId = ?`, params: [user.organizationId || ''] };
  if (['admin','rso','auditor'].includes(role)) return { where: `${p}hospitalId = ?`, params: [user.hospitalId || ''] };
  return { where: `${p}id = ?`, params: [user.id] };
}

function tableScopeWhere(user, alias = '') {
  const p = alias ? `${alias}.` : '';
  const role = accessRoleFor(user);
  if (role === 'sysadmin') return { where: '1=1', params: [] };
  if (role === 'org_admin') return { where: `${p}organizationId = ?`, params: [user.organizationId || ''] };
  return { where: `${p}hospitalId = ?`, params: [user.hospitalId || ''] };
}

function resolveTenantForEmployee(req, body) {
  const role = accessRoleFor(req.user);
  let organizationId = String(body.organizationId || '').trim();
  let hospitalId = String(body.hospitalId || '').trim();
  if (role === 'sysadmin') {
    if (!organizationId && hospitalId) {
      const h = db.prepare('SELECT organizationId FROM hospitals WHERE id=?').get(hospitalId);
      organizationId = h ? h.organizationId : organizationId;
    }
    if (!organizationId) organizationId = req.user.organizationId || 'org_default';
    if (!hospitalId) {
      const h = db.prepare('SELECT id FROM hospitals WHERE organizationId=? ORDER BY name LIMIT 1').get(organizationId);
      hospitalId = h ? h.id : '';
    }
  } else if (role === 'org_admin') {
    organizationId = req.user.organizationId || organizationId;
    if (!hospitalId) {
      const h = db.prepare('SELECT id FROM hospitals WHERE organizationId=? ORDER BY name LIMIT 1').get(organizationId);
      hospitalId = h ? h.id : req.user.hospitalId || '';
    }
  } else {
    organizationId = req.user.organizationId || organizationId;
    hospitalId = req.user.hospitalId || hospitalId;
  }
  return { organizationId, hospitalId };
}

function publicOrganization(row){ return row ? { id: row.id, name: row.name, code: row.code, address: row.address||'', contactPerson: row.contactPerson||'', email: row.email||'', phone: row.phone||'', packageName: row.packageName || 'Trial', licenseStatus: row.licenseStatus || 'Trial', trialStartDate: row.trialStartDate || '', trialEndDate: row.trialEndDate || '', registrationDate: row.registrationDate || '', renewalDueDate: row.renewalDueDate || '', billingAmount: row.billingAmount || '', billingCycle: row.billingCycle || '', maxHospitals: Number(row.maxHospitals || 0), maxTldUsers: Number(row.maxTldUsers || 0), billingNotes: row.billingNotes || '', active: !!row.active, createdAt: row.createdAt, updatedAt: row.updatedAt } : null; }
function publicHospital(row){ return row ? { id: row.id, organizationId: row.organizationId, name: row.name, code: row.code, city: row.city||'', state: row.state||'', address: row.address||'', email: row.email||'', phone: row.phone||'', active: !!row.active, createdAt: row.createdAt, updatedAt: row.updatedAt } : null; }

function requireRadproOrOrgAdmin(req, res, next) {
  const role = accessRoleFor(req.user);
  if (!['sysadmin','org_admin'].includes(role)) return res.status(403).json({ error: 'Radpro/System admin or organization super admin access required' });
  next();
}

function requireSysadmin(req, res, next) {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Radpro Super Admin access required' });
  next();
}

const RADPRO_INTERNAL_ROLES = new Set(['Radpro Super Admin','Radpro Admin','Software Manager','Support Engineer','Sales Manager','Sales Executive','Accounts','Marketing','Viewer / Read Only']);
function isRadproInternalRole(role) { return RADPRO_INTERNAL_ROLES.has(String(role || '').trim()); }
function isProtectedRadproUser(row) { return String(row && row.username || '').toLowerCase() === 'radpro' || String(row && row.id || '') === 'sys_radpro'; }

function logAudit(req, action, details = '') {
  const actor = req && req.session && req.session.user ? req.session.user : null;
  db.prepare(`
    INSERT INTO audit_logs (actorId, actorName, action, details, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor ? actor.id : null, actor ? actor.name : 'System', action, details, nowISO());
}

function logSystem(action, details = '') {
  db.prepare(`
    INSERT INTO audit_logs (actorId, actorName, action, details, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(null, 'System', action, details, nowISO());
}

function ensureDemoRSO() {
  // Production-safe behavior: do not recreate the demo RSO automatically.
  // Enable only for internal demo builds with ENABLE_DEMO_SEED=true.
  const enableDemoSeed = String(process.env.ENABLE_DEMO_SEED || '').toLowerCase() === 'true';
  if (!enableDemoSeed || isDefaultDemoDeleted()) return;

  const ts = nowISO();
  const defaultOrg = db.prepare("SELECT * FROM organizations WHERE id='org_default' OR code='DEFAULT' OR name='Default Organization' LIMIT 1").get();
  const defaultHosp = db.prepare("SELECT * FROM hospitals WHERE id='hosp_default' OR code='DEFAULT-HOSP' OR name='Default Hospital / Institute' LIMIT 1").get();
  if (!defaultOrg || !defaultHosp) return;

  const existingRso = db.prepare('SELECT * FROM employees WHERE username = ?').get('rso');
  if (existingRso) {
    db.prepare(`
      UPDATE employees
      SET role = 'RSO', accessRole = 'rso', enabled = 1, isRSO = 1, organizationId=?, hospitalId=?, updatedAt = ?
      WHERE username = ?
    `).run(defaultOrg.id, defaultHosp.id, ts, 'rso');
    return;
  }

  const existingEmp1 = db.prepare('SELECT * FROM employees WHERE id = ?').get('emp_1');
  const safeId = existingEmp1 ? `emp_rso_${Date.now()}` : 'emp_1';
  db.prepare(`
    INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(safeId, 'RSO Admin', 'Radiation Safety', 'RSO', 'RSO-001', '', '', 'rso', 0, 'rso', bcrypt.hashSync('rso123', 10), 1, 1, defaultOrg.id, defaultHosp.id, ts, ts);
  logSystem('Demo RSO created', 'Username: rso');
}


function ensureRadproSysadmin() {
  const ts = nowISO();
  const existing = db.prepare('SELECT * FROM employees WHERE username=?').get('radpro');
  if (existing) {
    db.prepare(`UPDATE employees SET accessRole='sysadmin', role='Radpro Super Admin', enabled=1, isRSO=1, updatedAt=? WHERE username=?`).run(ts, 'radpro');
    return;
  }
  const org = db.prepare('SELECT id FROM organizations ORDER BY createdAt LIMIT 1').get();
  const hosp = org ? db.prepare('SELECT id FROM hospitals WHERE organizationId=? ORDER BY createdAt LIMIT 1').get(org.id) : null;
  db.prepare(`INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('sys_radpro', 'Radpro Panel Admin', 'Radpro Technologies', 'Radpro Super Admin', 'RADPRO', '', '', 'sysadmin', 0, 'radpro', bcrypt.hashSync('radpro123', 10), 1, 1, org ? org.id : '', hosp ? hosp.id : '', ts, ts);
}
ensureDefaultTenancy();
ensureDemoRSO();
ensureRadproSysadmin();
ensureDefaultTenancy();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '75mb' }));
app.use(express.urlencoded({ extended: true, limit: '75mb' }));
app.use(session({
  name: 'radpro_tld.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').slice(0, 16);
    cb(null, `${Date.now()}_${crypto.randomBytes(10).toString('hex')}${safeExt}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Authentication required' });
  const fresh = getEmployeeById(req.session.user.id);
  if (!fresh || !fresh.enabled) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Account disabled or unavailable' });
  }
  req.user = publicEmployee(fresh);
  req.session.user = req.user;
  next();
}

function requireRSO(req, res, next) {
  if (!req.user || !userCanAdmin(req.user)) return res.status(403).json({ error: 'RSO/Admin access required' });
  next();
}

function requireAuditAccess(req, res, next) {
  if (!req.user || !userCanReadAudit(req.user)) return res.status(403).json({ error: 'RSO/Admin/Auditor access required' });
  next();
}

function validateEmployeeInput(body, { create = false } = {}) {
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!name) return { error: 'Employee name is required' };
  if (!username) return { error: 'Username is required' };
  if (create && !password) return { error: 'Password is required for a new employee' };
  return { name, username, password };
}

function getSettingsObject() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
}

function isDoseValueToken(value) {
  const raw = String(value ?? '').trim().replace(/[()]/g, '').toUpperCase();
  if (!raw) return false;
  if (['RL', 'R.L.', 'BDL', 'BLD', 'NIL', 'NA', 'N/A', '-'].includes(raw)) return true;
  const cleaned = raw.replace(/[<>]/g, '').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned);
}

function doseNumber(value) {
  const raw = String(value ?? '').trim().replace(/[()]/g, '').toUpperCase();
  if (['RL', 'R.L.', 'BDL', 'BLD', 'NIL', 'NA', 'N/A', '-'].includes(raw)) return 0;
  const cleaned = raw.replace(/[<>]/g, '').replace(/,/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseDoseRow(row) {
  if (!row) return null;

  if (!Array.isArray(row) && typeof row === 'object') {
    const tldNumber = String(row.tldNumber || row.tld || row.badge || row.personNo || row.persNo || '').trim();
    if (!tldNumber) return null;
    return {
      tldNumber,
      name: String(row.name || row.employeeName || row.personName || '').trim(),
      hp10: doseNumber(row.hp10 ?? row.Hp10 ?? row['Hp(10)'] ?? row.wholeBodyDose ?? 0),
      hp007: doseNumber(row.hp007 ?? row.Hp007 ?? row['Hp(0.07)'] ?? row.skinDose ?? 0),
      remarks: String(row.remarks || row.note || row.sourceLine || '')
    };
  }

  const cells = (row || []).map(c => String(c ?? '').trim()).filter(c => c !== '');
  if (cells.length < 3) return null;
  const tldNumber = cells[0];
  const valueIndexes = [];
  cells.forEach((cell, index) => {
    if (index > 0 && isDoseValueToken(cell)) valueIndexes.push(index);
  });
  if (valueIndexes.length < 2) return null;
  const idxHp007 = valueIndexes[valueIndexes.length - 1];
  const idxHp10 = valueIndexes[valueIndexes.length - 2];
  const nameCells = cells.slice(1, Math.min(idxHp10, idxHp007)).filter(c => !isDoseValueToken(c));
  while (nameCells.length && /^(C|W|CW|C\/W|T|M|F)$/i.test(nameCells[nameCells.length - 1])) nameCells.pop();
  return {
    tldNumber,
    name: nameCells.join(' '),
    hp10: doseNumber(cells[idxHp10]),
    hp007: doseNumber(cells[idxHp007]),
    remarks: nameCells.join(' ')
  };
}

function rowsFromTable(tableName) {
  return db.prepare(`SELECT * FROM ${tableName}`).all();
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const data = match[3] || '';
  const buffer = isBase64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  return { mimeType, buffer };
}

function insertAttachmentFromBackup(att, req) {
  if (!att) return null;
  let storedName = att.storedName || '';
  let size = Number(att.size || 0);
  let mimeType = att.mimeType || att.fileType || 'application/octet-stream';
  const originalName = att.originalName || att.fileName || 'attachment.bin';

  if (att.dataUrl) {
    const decoded = decodeDataUrl(att.dataUrl);
    if (decoded) {
      mimeType = decoded.mimeType || mimeType;
      size = decoded.buffer.length;
      const ext = path.extname(originalName).slice(0, 16);
      storedName = `${Date.now()}_${crypto.randomBytes(10).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), decoded.buffer);
    }
  }

  if (!storedName) return null;
  const id = att.id || makeId('att');
  db.prepare(`
    INSERT OR REPLACE INTO attachments
    (id, docType, employeeId, quarter, periodLabel, documentStatus, description, originalName, storedName, mimeType, size, publishToEmployees, uploadedBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    att.docType || att.type || 'general',
    att.employeeId || null,
    att.quarter || '',
    att.periodLabel || '',
    att.documentStatus || '',
    att.description || att.notes || '',
    originalName,
    storedName,
    mimeType,
    size,
    boolToInt(att.publishToEmployees),
    att.uploadedBy || (req.user ? req.user.name : 'Import'),
    att.createdAt || att.uploadedAt || nowISO()
  );
  return id;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowsToCsv(headers, rows) {
  return [headers.map(csvEscape).join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\n');
}

function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(rowsToCsv(headers, rows));
}

function getMailer() {
  if (!process.env.SMTP_HOST || !SMTP_FROM) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined
  });
}

async function sendEmail(to, subject, text) {
  if (!to) return { ok: false, skipped: true, detail: 'No email address' };
  const mailer = getMailer();
  if (!mailer) return { ok: false, skipped: true, detail: 'SMTP not configured' };
  const info = await mailer.sendMail({ from: SMTP_FROM, to, subject, text });
  return { ok: true, detail: info.messageId || 'sent' };
}

async function sendWhatsApp(to, message) {
  if (!to) return { ok: false, skipped: true, detail: 'No WhatsApp/mobile number' };
  if (WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
    const response = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/[^0-9]/g, ''), type: 'text', text: { body: message } })
    });
    const body = await response.text();
    return { ok: response.ok, detail: body.slice(0, 500) };
  }
  if (WHATSAPP_API_URL) {
    const response = await fetch(WHATSAPP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(WHATSAPP_TOKEN ? { Authorization: `Bearer ${WHATSAPP_TOKEN}` } : {}) },
      body: JSON.stringify({ to, message })
    });
    const body = await response.text();
    return { ok: response.ok, detail: body.slice(0, 500) };
  }
  return { ok: false, skipped: true, detail: 'WhatsApp provider not configured' };
}


function normalizeContact(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function contactMatches(employee, contact) {
  const c = normalizeContact(contact);
  const digits = normalizePhoneDigits(contact);
  const email = normalizeContact(employee.email);
  const phone = normalizePhoneDigits(employee.phone);
  return (!!email && email === c) || (!!digits && !!phone && (phone === digits || phone.endsWith(digits) || digits.endsWith(phone)));
}

async function sendRecoveryMessage(employee, subject, message) {
  const deliveries = [];
  if (employee.email) deliveries.push({ channel: 'email', result: await sendEmail(employee.email, subject, message) });
  if (employee.phone) deliveries.push({ channel: 'whatsapp', result: await sendWhatsApp(employee.phone, message) });
  const sent = deliveries.filter(d => d.result && d.result.ok).map(d => d.channel);
  const skipped = deliveries.filter(d => !d.result || !d.result.ok).map(d => `${d.channel}: ${d.result ? d.result.detail : 'failed'}`);
  return { sent, skipped };
}

function genericRecoveryResponse(res) {
  return res.json({ message: 'If the details match a registered active user, recovery instructions will be sent to the registered email/mobile.' });
}

async function sendLoginCode(employee, subject, text) {
  const deliveries = [];
  if (employee.email) deliveries.push({ channel: 'email', result: await sendEmail(employee.email, subject, text) });
  if (employee.phone) deliveries.push({ channel: 'whatsapp', result: await sendWhatsApp(employee.phone, text) });
  const sent = deliveries.filter(d => d.result.ok).map(d => d.channel);
  const skipped = deliveries.filter(d => !d.result.ok).map(d => `${d.channel}: ${d.result.detail}`);
  const devCode = sent.length === 0 && NODE_ENV !== 'production';
  return {
    devCode,
    summary: sent.length ? `Sent by ${sent.join(', ')}` : `No provider delivered code (${skipped.join('; ') || 'no contact saved'}). Check server console/devCode.`
  };
}

function buildReminderPreview(quarter) {
  const activeEmployees = db.prepare('SELECT * FROM employees WHERE enabled = 1 ORDER BY name COLLATE NOCASE').all();
  const staff = db.prepare("SELECT * FROM employees WHERE enabled = 1 AND (accessRole IN ('admin','rso') OR isRSO = 1) ORDER BY name COLLATE NOCASE").all();
  const hasQuarterReport = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE docType = 'quarterReport' AND quarter = ?").get(quarter).n > 0;
  const rows = [];
  activeEmployees.filter(e => e.tldNumber).forEach(e => {
    rows.push({ type: 'tldReturn', employee: publicEmployee(e), subject: `TLD return reminder - ${quarter}`, message: `Please return your TLD badge for ${quarter} to the RSO office as per schedule.` });
  });
  activeEmployees.filter(e => e.tldNumber).forEach(e => {
    const hasForm = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE docType = 'employeeForm' AND employeeId = ? AND quarter = ?").get(e.id, quarter).n > 0;
    if (!hasForm) rows.push({ type: 'missingForm', employee: publicEmployee(e), subject: `Pending TLD personal monitoring form - ${quarter}`, message: `Your filled/signed TLD personal monitoring form for ${quarter} is pending. Please submit it to the RSO office.` });
  });
  activeEmployees.filter(e => e.tldNumber).forEach(e => {
    const hasDose = db.prepare('SELECT COUNT(*) AS n FROM doses WHERE employeeId = ? AND quarter = ?').get(e.id, quarter).n > 0;
    const hasAck = db.prepare('SELECT COUNT(*) AS n FROM acknowledgements WHERE employeeId = ? AND quarter = ?').get(e.id, quarter).n > 0;
    if (hasDose && !hasAck) rows.push({ type: 'acknowledgement', employee: publicEmployee(e), subject: `TLD dose acknowledgement pending - ${quarter}`, message: `Your TLD dose record for ${quarter} is available in Radpro TLD. Please log in, review, and e-sign the acknowledgement. ${APP_BASE_URL}` });
  });
  if (!hasQuarterReport) {
    staff.forEach(e => rows.push({ type: 'reportUpload', employee: publicEmployee(e), subject: `Quarterly TLD report upload pending - ${quarter}`, message: `The official TLD report attachment for ${quarter} is not available in Radpro TLD. Please upload/publish the report in the RSO portal.` }));
  }
  return rows;
}

async function logAndSendReminder({ type, quarter, employee, subject, message, channels }) {
  const outputs = [];
  for (const channel of channels) {
    const destination = channel === 'email' ? employee.email : employee.phone;
    let result;
    try {
      result = channel === 'email' ? await sendEmail(destination, subject, message) : await sendWhatsApp(destination, `${subject}\n\n${message}`);
    } catch (err) {
      result = { ok: false, detail: err.message || String(err) };
    }
    const status = result.ok ? 'sent' : (result.skipped ? 'skipped' : 'failed');
    db.prepare(`
      INSERT INTO reminder_logs (id, reminderType, quarter, channel, recipientEmployeeId, recipientName, destination, subject, message, status, providerResponse, createdAt, sentAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(makeId('rem'), type, quarter, channel, employee.id, employee.name, destination || '', subject, message, status, result.detail || '', nowISO(), result.ok ? nowISO() : null);
    outputs.push({ channel, status, detail: result.detail || '' });
  }
  return outputs;
}


function sanitizeNotificationChannels(channels) {
  const allowed = new Set(['portal', 'email', 'whatsapp']);
  const list = Array.isArray(channels) ? channels : String(channels || 'portal').split(',');
  const filtered = list.map(c => String(c || '').trim().toLowerCase()).filter(c => allowed.has(c));
  return Array.from(new Set(filtered.length ? filtered : ['portal']));
}

function notificationTargets({ audience, targetEmployeeId }) {
  const scope = String(audience || 'allTldUsers');
  if (scope === 'individual') {
    if (!targetEmployeeId) return [];
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND enabled = 1').get(targetEmployeeId);
    return emp ? [emp] : [];
  }
  if (scope === 'allEmployees') {
    return db.prepare('SELECT * FROM employees WHERE enabled = 1 ORDER BY name COLLATE NOCASE').all();
  }
  return db.prepare("SELECT * FROM employees WHERE enabled = 1 AND COALESCE(tldNumber, '') <> '' ORDER BY name COLLATE NOCASE").all();
}

function buildNotificationPreview({ audience, targetEmployeeId, subject, message, channels }) {
  const cleanedChannels = sanitizeNotificationChannels(channels);
  const people = notificationTargets({ audience, targetEmployeeId });
  return people.map(emp => ({
    employee: publicEmployee(emp),
    subject,
    message,
    channels: cleanedChannels,
    destinations: {
      portal: 'Employee portal',
      email: emp.email || '',
      whatsapp: emp.phone || ''
    }
  }));
}

async function createAndSendNotification(req, { audience, targetEmployeeId, subject, message, channels }) {
  const cleanedSubject = String(subject || '').trim();
  const cleanedMessage = String(message || '').trim();
  if (!cleanedSubject) throw new Error('Notification subject is required');
  if (!cleanedMessage) throw new Error('Notification message is required');
  const cleanedChannels = sanitizeNotificationChannels(channels);
  const targets = notificationTargets({ audience, targetEmployeeId });
  if (!targets.length) throw new Error('No recipient found for this notification');
  const id = makeId('not');
  const scope = String(audience || 'allTldUsers');
  db.prepare(`
    INSERT INTO notifications (id, subject, message, audience, targetEmployeeId, channels, createdBy, createdByName, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, cleanedSubject, cleanedMessage, scope, scope === 'individual' ? targetEmployeeId : null, JSON.stringify(cleanedChannels), req.user.id, req.user.name, nowISO());

  const insertRecipient = db.prepare(`
    INSERT INTO notification_recipients (id, notificationId, employeeId, employeeName, channel, destination, status, providerResponse, readAt, createdAt, sentAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const emp of targets) {
    for (const channel of cleanedChannels) {
      const destination = channel === 'email' ? emp.email : (channel === 'whatsapp' ? emp.phone : 'Employee portal');
      let result = { ok: true, detail: 'Visible in employee portal' };
      if (channel === 'email') {
        try { result = await sendEmail(emp.email, cleanedSubject, cleanedMessage); }
        catch (err) { result = { ok: false, detail: err.message || String(err) }; }
      } else if (channel === 'whatsapp') {
        try { result = await sendWhatsApp(emp.phone, `${cleanedSubject}\n\n${cleanedMessage}`); }
        catch (err) { result = { ok: false, detail: err.message || String(err) }; }
      }
      const status = channel === 'portal' ? 'posted' : (result.ok ? 'sent' : (result.skipped ? 'skipped' : 'failed'));
      insertRecipient.run(makeId('notrec'), id, emp.id, emp.name, channel, destination || '', status, result.detail || '', null, nowISO(), result.ok || channel === 'portal' ? nowISO() : null);
      count += 1;
    }
  }
  return { notification: notificationPublic(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)), count };
}

async function createDoseLimitNotifications(req, alertRows, { period, quarter }) {
  const settings = getSettingsObject();
  const enabled = String(settings.doseAlertEnabled || 'true') !== 'false';
  const limit = Number(settings.doseAlertLimit || 0);
  if (!enabled || !limit || !Number.isFinite(limit)) return { count: 0, limit };
  const channels = sanitizeNotificationChannels(settings.doseAlertChannels || 'portal');
  const unique = new Map();
  alertRows.forEach(row => {
    if (Number(row.hp10 || 0) >= limit && row.employee?.id) unique.set(row.employee.id, row);
  });
  let count = 0;
  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, subject, message, audience, targetEmployeeId, channels, createdBy, createdByName, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRecipient = db.prepare(`
    INSERT INTO notification_recipients (id, notificationId, employeeId, employeeName, channel, destination, status, providerResponse, readAt, createdAt, sentAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of unique.values()) {
    const emp = row.employee;
    const subject = `TLD dose alert - ${quarter}`;
    const message = `Your TLD dose record for ${period || quarter} has been uploaded.\n\nHp(10): ${Number(row.hp10 || 0).toFixed(2)} mSv\nAlert limit: ${limit.toFixed(2)} mSv\n\nPlease log in to Radpro TLD, review your dose record, and contact the RSO if clarification is required.\n${APP_BASE_URL}`;
    const id = makeId('not');
    insertNotification.run(id, subject, message, 'doseLimitExceeded', emp.id, JSON.stringify(channels), req.user.id, req.user.name, nowISO());
    for (const channel of channels) {
      const destination = channel === 'email' ? emp.email : (channel === 'whatsapp' ? emp.phone : 'Employee portal');
      let result = { ok: true, detail: 'Visible in employee portal' };
      if (channel === 'email') {
        try { result = await sendEmail(emp.email, subject, message); }
        catch (err) { result = { ok: false, detail: err.message || String(err) }; }
      } else if (channel === 'whatsapp') {
        try { result = await sendWhatsApp(emp.phone, `${subject}\n\n${message}`); }
        catch (err) { result = { ok: false, detail: err.message || String(err) }; }
      }
      const status = result.ok ? 'sent' : (result.skipped ? 'skipped' : 'failed');
      insertRecipient.run(makeId('notrec'), id, emp.id, emp.name, channel, destination || '', status, result.detail || '', null, nowISO(), result.ok ? nowISO() : null);
      count += 1;
    }
  }
  return { count: unique.size, limit, channelRows: count };
}

function encryptPayload(data, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, BACKUP_KDF_ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: BACKUP_KDF_ITERATIONS,
    createdAt: nowISO(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64')
  };
}

function decryptPayload(wrapper, password) {
  if (!wrapper || !wrapper.encrypted) return wrapper;
  if (!password) throw new Error('Password is required to decrypt this backup');
  const salt = Buffer.from(wrapper.salt, 'base64');
  const iv = Buffer.from(wrapper.iv, 'base64');
  const tag = Buffer.from(wrapper.tag, 'base64');
  const encrypted = Buffer.from(wrapper.ciphertext, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, Number(wrapper.iterations || BACKUP_KDF_ITERATIONS), 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function doseRowsWithEmployees(where = '', params = []) {
  return db.prepare(`
    SELECT d.*, e.name AS employeeName, e.dept AS employeeDept, e.role AS employeeRole
    FROM doses d JOIN employees e ON e.id = d.employeeId
    ${where}
    ORDER BY e.name COLLATE NOCASE, d.quarter, d.period
  `).all(...params);
}

function ackRowsWithEmployees(where = '', params = []) {
  return db.prepare(`
    SELECT a.*, e.name AS employeeName, e.dept AS employeeDept
    FROM acknowledgements a JOIN employees e ON e.id = a.employeeId
    ${where}
    ORDER BY a.acknowledgedAt DESC
  `).all(...params);
}

function investigationRows(where = '', params = []) {
  return db.prepare(`
    SELECT i.*, e.name AS employeeName, e.dept AS employeeDept, d.hp10, d.hp007
    FROM investigations i JOIN employees e ON e.id = i.employeeId LEFT JOIN doses d ON d.id = i.doseId
    ${where}
    ORDER BY i.updatedAt DESC
  `).all(...params);
}

function overexposureCaseRows(where = '', params = []) {
  return db.prepare(`
    SELECT c.*, e.name AS employeeName, e.dept AS employeeDept, e.role AS employeeRole, e.tldNumber,
      d.period AS linkedDosePeriod, d.quarter AS linkedDoseQuarter, d.hp10, d.hp007
    FROM overexposure_cases c
    JOIN employees e ON e.id = c.employeeId
    LEFT JOIN doses d ON d.id = c.doseId
    ${where}
    ORDER BY c.updatedAt DESC
  `).all(...params);
}

function drawSignature(doc, dataUrl, x, y, w, h) {
  if (!dataUrl || !/^data:image\/png;base64,/.test(String(dataUrl))) return false;
  try {
    const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    doc.image(buffer, x, y, { fit: [w, h] });
    return true;
  } catch (_) {
    return false;
  }
}


function acknowledgementStatusRows(quarter, status = 'all') {
  const q = String(quarter || '').trim();
  const employees = db.prepare(`
    SELECT * FROM employees
    WHERE enabled = 1 AND COALESCE(tldNumber,'') <> ''
    ORDER BY name COLLATE NOCASE
  `).all();
  const rows = employees.map(emp => {
    const dose = q
      ? db.prepare('SELECT * FROM doses WHERE employeeId = ? AND quarter = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT 1').get(emp.id, q)
      : db.prepare('SELECT * FROM doses WHERE employeeId = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT 1').get(emp.id);
    const ack = q
      ? db.prepare('SELECT * FROM acknowledgements WHERE employeeId = ? AND quarter = ?').get(emp.id, q)
      : (dose ? db.prepare('SELECT * FROM acknowledgements WHERE employeeId = ? AND quarter = ?').get(emp.id, dose.quarter) : null);
    const acknowledged = !!ack;
    return {
      employeeName: emp.name,
      tldNumber: emp.tldNumber || '',
      department: emp.dept || '',
      role: emp.role || '',
      quarter: q || (dose ? dose.quarter : ''),
      hp10: dose ? Number(dose.hp10 || 0).toFixed(2) : '-',
      hp007: dose ? Number(dose.hp007 || 0).toFixed(2) : '-',
      acknowledged: acknowledged ? 'Yes' : 'No',
      acknowledgementStatus: acknowledged ? 'Acknowledged' : 'Pending',
      acknowledgedAt: ack ? ack.acknowledgedAt : '',
      signerName: ack ? (ack.signerName || '') : '',
      pending: acknowledged ? 'No' : 'Yes'
    };
  });
  const mode = String(status || 'all').toLowerCase();
  if (mode === 'acknowledged') return rows.filter(r => r.acknowledged === 'Yes');
  if (mode === 'pending') return rows.filter(r => r.acknowledged === 'No');
  return rows;
}

function makeAcknowledgementStatusPdf(res, rows, quarter, status) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="tld_acknowledgement_status_${String(quarter || 'all').replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
  doc.pipe(res);
  doc.fontSize(17).font('Helvetica-Bold').text('TLD Dose Acknowledgement Status Report', { align: 'center' });
  doc.moveDown(0.35).fontSize(9).font('Helvetica').text(`Quarter: ${quarter || 'All / latest'}     Status filter: ${status || 'All'}     Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  const total = rows.length;
  const ack = rows.filter(r => r.acknowledged === 'Yes').length;
  const pending = total - ack;
  doc.moveDown(0.7).fontSize(10).font('Helvetica-Bold').text(`Total users: ${total}    Acknowledged: ${ack}    Pending: ${pending}`);
  doc.moveDown(0.5);
  const headers = ['Employee Name', 'TLD No.', 'Department', 'Quarter', 'Hp(10)', 'Acknowledged', 'Ack. Date'];
  const widths = [150, 72, 130, 85, 55, 85, 110];
  let y = doc.y;
  const startX = doc.x;
  function row(values, bold=false) {
    if (y > 540) { doc.addPage(); y = 36; }
    let x = startX;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.3);
    values.forEach((v, i) => {
      doc.text(String(v || ''), x, y, { width: widths[i], height: 28, ellipsis: true });
      x += widths[i];
    });
    y += bold ? 22 : 26;
  }
  row(headers, true);
  rows.forEach(r => row([r.employeeName, r.tldNumber, r.department, r.quarter, r.hp10, r.acknowledgementStatus, r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleDateString() : '-']));
  doc.moveDown().fontSize(8).font('Helvetica').text('Generated by Radpro TLD Personal Monitoring Service. Verify against official PMS/TLD laboratory reports retained by RSO.', 36, 560, { align: 'center' });
  doc.end();
}

function awarenessRows(quarter) {
  const q = String(quarter || '').trim();
  const posterVersion = getSettingsObject().awarenessPosterVersion || 'v1';
  const employees = db.prepare(`
    SELECT * FROM employees
    WHERE enabled = 1 AND COALESCE(tldNumber,'') <> ''
    ORDER BY name COLLATE NOCASE
  `).all();
  return employees.map(emp => {
    const aw = db.prepare('SELECT * FROM awareness_acknowledgements WHERE employeeId = ? AND quarter = ? AND posterVersion = ?').get(emp.id, q, posterVersion);
    return {
      employeeName: emp.name,
      tldNumber: emp.tldNumber || '',
      department: emp.dept || '',
      role: emp.role || '',
      quarter: q,
      posterVersion,
      status: aw ? 'Accepted' : 'Pending',
      acknowledgedAt: aw ? aw.acknowledgedAt : '',
      statementText: aw ? aw.statementText : ''
    };
  });
}

function makeAwarenessStatusPdf(res, rows, quarter) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="tld_awareness_acknowledgement_${String(quarter || 'all').replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
  doc.pipe(res);
  doc.fontSize(17).font('Helvetica-Bold').text('TLD Awareness Poster Acceptance Report', { align: 'center' });
  doc.moveDown(0.35).fontSize(9).font('Helvetica').text(`Quarter: ${quarter || '-'}     Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  const accepted = rows.filter(r => r.status === 'Accepted').length;
  doc.moveDown(0.7).fontSize(10).font('Helvetica-Bold').text(`Total users: ${rows.length}    Accepted: ${accepted}    Pending: ${rows.length - accepted}`);
  doc.moveDown(0.5);
  const headers = ['Employee Name', 'TLD No.', 'Department', 'Quarter', 'Poster', 'Status', 'Accepted Date'];
  const widths = [150, 72, 130, 85, 70, 80, 110];
  let y = doc.y;
  const startX = doc.x;
  function row(values, bold=false) {
    if (y > 540) { doc.addPage(); y = 36; }
    let x = startX;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.3);
    values.forEach((v, i) => { doc.text(String(v || ''), x, y, { width: widths[i], height: 28, ellipsis: true }); x += widths[i]; });
    y += bold ? 22 : 26;
  }
  row(headers, true);
  rows.forEach(r => row([r.employeeName, r.tldNumber, r.department, r.quarter, r.posterVersion, r.status, r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleDateString() : '-']));
  doc.moveDown().fontSize(8).font('Helvetica').text('This report confirms quarterly viewing/acceptance of the TLD safe-use awareness poster.', 36, 560, { align: 'center' });
  doc.end();
}

function makeAnnualStatementPdf(res, employee, doses, acknowledgements, year) {
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="annual_dose_statement_${employee.name.replace(/[^a-z0-9]+/gi, '_')}_${year}.pdf"`);
  doc.pipe(res);
  doc.fontSize(18).text('Annual Personal Monitoring Dose Statement', { align: 'center' });
  doc.moveDown(0.5).fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'right' });
  doc.moveDown().fontSize(12).text(`Employee: ${employee.name}`);
  doc.text(`Department: ${employee.dept || '-'}`);
  doc.text(`Role: ${employee.role || '-'}`);
  doc.text(`TLD Badge No.: ${employee.tldNumber || '-'}`);
  doc.text(`Year: ${year}`);
  doc.moveDown();
  doc.fontSize(11).text('Quarter-wise dose records', { underline: true });
  doc.moveDown(0.4);
  const startX = doc.x;
  const widths = [80, 120, 70, 70, 170];
  const headers = ['Quarter', 'Period', 'Hp(10)', 'Hp(0.07)', 'Acknowledgement'];
  headers.forEach((h, idx) => doc.font('Helvetica-Bold').text(h, startX + widths.slice(0, idx).reduce((a, b) => a + b, 0), doc.y, { width: widths[idx] }));
  doc.moveDown(0.6).font('Helvetica');
  let totalHp10 = 0;
  let totalHp007 = 0;
  doses.forEach(d => {
    if (doc.y > 720) doc.addPage();
    const y = doc.y;
    totalHp10 += Number(d.hp10 || 0);
    totalHp007 += Number(d.hp007 || 0);
    const ack = acknowledgements.find(a => a.quarter === d.quarter);
    [d.quarter, d.period, Number(d.hp10 || 0).toFixed(2), Number(d.hp007 || 0).toFixed(2), ack ? `Signed ${new Date(ack.acknowledgedAt).toLocaleDateString()}` : 'Pending'].forEach((v, idx) => doc.text(String(v || ''), startX + widths.slice(0, idx).reduce((a, b) => a + b, 0), y, { width: widths[idx] }));
    doc.moveDown(0.9);
  });
  doc.moveDown().font('Helvetica-Bold').text(`Annual total Hp(10): ${totalHp10.toFixed(2)} mSv`);
  doc.text(`Annual total Hp(0.07): ${totalHp007.toFixed(2)} mSv`);
  doc.moveDown().font('Helvetica').fontSize(9).text('This statement is generated from Radpro TLD monitoring records and should be verified against the official PMS/TLD laboratory report retained by the RSO.');
  doc.end();
}

function makeInvestigationPdf(res, inv) {
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="overexposure_investigation_${inv.id}.pdf"`);
  doc.pipe(res);
  doc.fontSize(18).text('Overexposure / High Dose Investigation Record', { align: 'center' });
  doc.moveDown().fontSize(11);
  const rows = [
    ['Employee', inv.employeeName], ['Department', inv.employeeDept || '-'], ['Quarter', inv.quarter || '-'], ['Period', inv.period || '-'], ['Hp(10)', Number(inv.hp10 || 0).toFixed(2)], ['Hp(0.07)', Number(inv.hp007 || 0).toFixed(2)], ['Severity', inv.severity || '-'], ['Status', inv.status || '-'], ['Created', inv.createdAt || '-'], ['Closed', inv.closedAt || '-']
  ];
  rows.forEach(([k, v]) => { doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }); doc.font('Helvetica').text(String(v || '')); });
  doc.moveDown();
  [['RSO Note', inv.rsoNote], ['Immediate Action', inv.immediateAction], ['Root Cause', inv.rootCause], ['Corrective Action', inv.correctiveAction], ['Closure Status', inv.closureStatus]].forEach(([k, v]) => {
    doc.font('Helvetica-Bold').text(k);
    doc.font('Helvetica').text(String(v || '-'), { width: 500 });
    doc.moveDown(0.5);
  });
  doc.moveDown();
  doc.font('Helvetica-Bold').text('RSO e-signature');
  if (!drawSignature(doc, inv.rsoSignatureData, doc.x, doc.y + 5, 160, 60)) doc.font('Helvetica').text(inv.rsoSignerName || 'Not signed');
  doc.moveDown(4);
  doc.fontSize(9).text(`Signed by: ${inv.rsoSignerName || '-'} | Generated: ${new Date().toLocaleString()}`);
  doc.end();
}

function makeOverexposureCasePdf(res, row) {
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="accidental_overexposure_case_${row.id}.pdf"`);
  doc.pipe(res);
  doc.fontSize(18).text('Accidental / Overexposure Case Report', { align: 'center' });
  doc.moveDown(0.5).fontSize(9).text(`Generated: ${new Date().toLocaleString()}`, { align: 'right' });
  doc.moveDown().fontSize(11);
  const rows = [
    ['Employee', row.employeeName],
    ['Department / Role', `${row.employeeDept || '-'} / ${row.employeeRole || '-'}`],
    ['TLD Badge No.', row.tldNumber || '-'],
    ['Incident Date', row.incidentDate || '-'],
    ['Case Type', row.incidentType || '-'],
    ['Dose Report Quarter', row.doseReportQuarter || row.linkedDoseQuarter || '-'],
    ['Received Dose', `${Number(row.receivedDose || 0).toFixed(2)} ${row.doseUnit || 'mSv'} ${row.doseType || ''}`],
    ['Severity', row.severity || '-'],
    ['Status', row.status || '-'],
    ['Report Reference', row.reportReference || '-'],
    ['Reported To', row.reportedTo || '-'],
    ['Regulatory Report Required', row.regulatoryReportRequired ? 'Yes' : 'No'],
    ['Regulatory Report Date', row.regulatoryReportDate || '-'],
    ['RSC Review Date', row.rscReviewDate || '-'],
    ['Employee Acknowledgement Signed', row.employeeSignedAt || '-'],
    ['Created', row.createdAt || '-'],
    ['Closed', row.closedAt || '-']
  ];
  rows.forEach(([k, v]) => { doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }); doc.font('Helvetica').text(String(v || '')); });
  doc.moveDown();
  [
    ['Incident Information / Notes', row.incidentSummary],
    ['Suspected Cause', row.suspectedCause],
    ['Immediate Action', row.immediateAction],
    ['Medical Review / Fitness Advice', row.medicalReview],
    ['Action Taken After Overexposure', row.actionTaken],
    ['Corrective Action', row.correctiveAction],
    ['Preventive Action', row.preventiveAction],
    ['Employee Acknowledgement / No Objection', row.employeeAcknowledgementText],
    ['Closure Note / Follow-up', row.closureNote]
  ].forEach(([k, v]) => {
    if (doc.y > 700) doc.addPage();
    doc.font('Helvetica-Bold').text(k);
    doc.font('Helvetica').text(String(v || '-'), { width: 500 });
    doc.moveDown(0.5);
  });
  doc.moveDown();
  doc.font('Helvetica-Bold').text('Employee acknowledgement signature');
  if (!drawSignature(doc, row.employeeSignatureData, doc.x, doc.y + 5, 160, 60)) doc.font('Helvetica').text(row.employeeSignerName || 'Not signed');
  doc.moveDown(4);
  doc.fontSize(9).text(`Employee signed by: ${row.employeeSignerName || '-'} | Signed at: ${row.employeeSignedAt || '-'}`);
  doc.moveDown();
  doc.fontSize(11).font('Helvetica-Bold').text('RSO e-signature');
  if (!drawSignature(doc, row.rsoSignatureData, doc.x, doc.y + 5, 160, 60)) doc.font('Helvetica').text(row.rsoSignerName || 'Not signed');
  doc.moveDown(4);
  doc.fontSize(9).text(`Signed by: ${row.rsoSignerName || '-'} | Closed by: ${row.closedBy || '-'}`);
  doc.end();
}

// Phase 1 cloud-stability helpers
function safeFileSize(filePath) {
  try { return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch (_) { return 0; }
}

function directoryStats(dirPath, maxFiles = 2000) {
  const stats = { exists: false, files: 0, bytes: 0, truncated: false };
  try {
    if (!fs.existsSync(dirPath)) return stats;
    stats.exists = true;
    const walk = (current) => {
      if (stats.files >= maxFiles) { stats.truncated = true; return; }
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (stats.files >= maxFiles) { stats.truncated = true; return; }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          stats.files += 1;
          stats.bytes += safeFileSize(full);
        }
      }
    };
    walk(dirPath);
  } catch (error) {
    stats.error = error.message;
  }
  return stats;
}

function canWriteToDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.radpro_write_test_${process.pid}_${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function getCloudStabilityStatus() {
  const dataWrite = canWriteToDir(DATA_DIR);
  const uploadWrite = canWriteToDir(UPLOAD_DIR);
  const uploadStats = directoryStats(UPLOAD_DIR);
  const production = NODE_ENV === 'production';
  const expectedPersistent = path.resolve('/app/data');
  const dataDirLooksPersistent = !production || path.resolve(DATA_DIR) === expectedPersistent || path.resolve(DATA_DIR).startsWith(`${expectedPersistent}${path.sep}`);
  const warnings = [];
  if (production && !dataDirLooksPersistent) warnings.push('DATA_DIR is not /app/data. On Render, mount the persistent disk at /app/data and set DATA_DIR=/app/data.');
  if (production && process.env.ENABLE_DEMO_SEED === 'true') warnings.push('ENABLE_DEMO_SEED=true is enabled. Disable it for production/customer trials.');
  if (!dataWrite.ok) warnings.push(`DATA_DIR is not writable: ${dataWrite.error}`);
  if (!uploadWrite.ok) warnings.push(`UPLOAD_DIR is not writable: ${uploadWrite.error}`);
  if (production && SESSION_SECRET === 'dev-only-change-me') warnings.push('SESSION_SECRET is still using the development fallback. Set a strong value in Render.');
  return {
    ok: dataWrite.ok && uploadWrite.ok && warnings.length === 0,
    app: 'radpro-tld-monitoring',
    dbDriver: 'postgres',
    postgresConfigured: true,
    phase: 'Phase 3.2 PostgreSQL-only production runtime',
    nodeEnv: NODE_ENV,
    nodeVersion: process.version,
    time: nowISO(),
    paths: { dataDir: DATA_DIR, uploadDir: UPLOAD_DIR },
    storage: {
      dataDirWritable: dataWrite.ok,
      uploadDirWritable: uploadWrite.ok,
      uploadFileCount: uploadStats.files,
      uploadSizeMB: Number((uploadStats.bytes / (1024 * 1024)).toFixed(3)),
      uploadStatsTruncated: !!uploadStats.truncated
    },
    configuration: {
      cookieSecure: process.env.COOKIE_SECURE === 'true',
      maxUploadMB: MAX_UPLOAD_MB,
      smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      whatsappConfigured: !!(WHATSAPP_API_URL || (WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_TOKEN)),
      autoRemindersEnabled: AUTO_REMINDERS_ENABLED,
      twoFactorRequired: TWO_FACTOR_REQUIRED,
      demoSeedEnabled: process.env.ENABLE_DEMO_SEED === 'true'
    },
    warnings
  };
}

function logCloudStabilityStartup() {
  const status = getCloudStabilityStatus();
  console.log('Radpro Phase 1 cloud status:', JSON.stringify({
    ok: status.ok,
    nodeEnv: status.nodeEnv,
    dataDir: status.paths.dataDir,
    uploadDir: status.paths.uploadDir,
    dbFile: status.paths.dbFile,
    dataWritable: status.storage.dataDirWritable,
    uploadWritable: status.storage.uploadDirWritable,
    warnings: status.warnings
  }));
}

// Health and app shell
app.get('/health', (_req, res) => {
  const status = getCloudStabilityStatus();
  res.status(status.storage.dataDirWritable && status.storage.uploadDirWritable ? 200 : 503).json({
    ok: status.storage.dataDirWritable && status.storage.uploadDirWritable,
    app: status.app,
    phase: status.phase,
    time: status.time,
    storage: status.storage,
    warnings: status.warnings
  });
});

app.get('/api/system/cloud-status', requireAuth, requireSysadmin, (_req, res) => {
  const status = getCloudStabilityStatus();
  const counts = {
    organizations: db.prepare('SELECT COUNT(*) AS c FROM organizations').get().c,
    hospitals: db.prepare('SELECT COUNT(*) AS c FROM hospitals').get().c,
    users: db.prepare('SELECT COUNT(*) AS c FROM employees').get().c,
    doseRecords: db.prepare('SELECT COUNT(*) AS c FROM doses').get().c,
    attachments: db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c,
    auditLogs: db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c
  };
  res.json({ ...status, counts });
});

app.post('/api/system/cloud-preflight', requireAuth, requireSysadmin, (req, res) => {
  const status = getCloudStabilityStatus();
  const key = 'lastCloudPreflightAt';
  const value = nowISO();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  logAudit(req, 'Cloud preflight check', `Storage writable=${status.storage.dataDirWritable && status.storage.uploadDirWritable}`);
  res.json({ ok: status.storage.dataDirWritable && status.storage.uploadDirWritable, checkedAt: value, status });
});

// Auth
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const employee = getEmployeeByUsername(username);
  if (!employee || !employee.enabled || !bcrypt.compareSync(password, employee.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username/password or employee disabled' });
  }
  if (String(employee.username || '').toLowerCase().trim() === 'rso') {
    db.prepare(`UPDATE employees SET role='RSO', accessRole='rso', enabled=1, isRSO=1, updatedAt=? WHERE id=?`).run(nowISO(), employee.id);
  }
  const user = publicEmployee(getEmployeeById(employee.id));
  const needs2FA = TWO_FACTOR_REQUIRED || !!employee.twoFactorEnabled;
  if (needs2FA) {
    const code = String(crypto.randomInt(100000, 999999));
    req.session.pending2FA = {
      user,
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    };
    const subject = 'Radpro TLD login verification code';
    const text = `Your Radpro TLD login verification code is ${code}. It expires in 10 minutes.`;
    const delivery = await sendLoginCode(employee, subject, text);
    logSystem('2FA code generated', `${user.username}: ${delivery.summary}`);
    return res.json({ requires2FA: true, delivery: delivery.summary, devCode: delivery.devCode ? code : undefined });
  }
  req.session.user = user;
  logAudit(req, 'Login', user.username);
  res.json({ user });
});

app.post('/api/auth/verify-2fa', (req, res) => {
  const pending = req.session.pending2FA;
  const code = String(req.body.code || '').trim();
  if (!pending || !pending.user) return res.status(400).json({ error: 'No pending two-factor login. Please log in again.' });
  if (Date.now() > pending.expiresAt) {
    delete req.session.pending2FA;
    return res.status(400).json({ error: 'Verification code expired. Please log in again.' });
  }
  pending.attempts = Number(pending.attempts || 0) + 1;
  if (pending.attempts > 5) {
    delete req.session.pending2FA;
    return res.status(429).json({ error: 'Too many verification attempts. Please log in again.' });
  }
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  if (codeHash !== pending.codeHash) return res.status(401).json({ error: 'Invalid verification code' });
  req.session.user = pending.user;
  delete req.session.pending2FA;
  logAudit(req, 'Login 2FA verified', req.session.user.username);
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  logAudit(req, 'Logout', req.user.username);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/recover-username', async (req, res) => {
  const contact = String(req.body.contact || '').trim();
  if (!contact) return res.status(400).json({ error: 'Registered email or mobile is required.' });
  const matches = db.prepare('SELECT * FROM employees WHERE enabled = 1').all().filter(e => contactMatches(e, contact));
  if (!matches.length) {
    logSystem('Username recovery requested', 'No matching active user for supplied contact');
    return genericRecoveryResponse(res);
  }
  const byContact = new Map();
  matches.forEach(e => byContact.set(e.username, e));
  const usernames = Array.from(byContact.keys()).sort();
  const subject = 'Radpro TLD username recovery';
  const message = `Your Radpro TLD username${usernames.length > 1 ? 's are' : ' is'}: ${usernames.join(', ')}. If you did not request this, please contact your RSO/Admin immediately.`;
  const delivery = await sendRecoveryMessage(matches[0], subject, message);
  logSystem('Username recovery requested', `${matches.length} matching user(s); delivered via ${delivery.sent.join(', ') || 'none'}`);
  if (delivery.sent.length === 0 && NODE_ENV !== 'production') {
    return res.json({ message: `Development mode: username${usernames.length > 1 ? 's' : ''}: ${usernames.join(', ')}. Configure SMTP/WhatsApp for production delivery.` });
  }
  return genericRecoveryResponse(res);
});

app.post('/api/auth/recover-password', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const contact = String(req.body.contact || '').trim();
  if (!username || !contact) return res.status(400).json({ error: 'Username and registered email/mobile are required.' });
  const employee = getEmployeeByUsername(username);
  if (!employee || !employee.enabled || !contactMatches(employee, contact)) {
    logSystem('Password reset requested', `No matching active user/contact for username: ${username || '-'}`);
    return genericRecoveryResponse(res);
  }
  const tempPassword = `Rp${crypto.randomBytes(4).toString('hex')}!${crypto.randomInt(10, 99)}`;
  const passwordHash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE employees SET passwordHash=?, updatedAt=? WHERE id=?').run(passwordHash, nowISO(), employee.id);
  const subject = 'Radpro TLD temporary password';
  const message = `Your temporary Radpro TLD password is: ${tempPassword}\n\nPlease log in and ask your RSO/Admin to change/reset your password if required. If you did not request this, contact your RSO/Admin immediately.`;
  const delivery = await sendRecoveryMessage(employee, subject, message);
  logSystem('Password reset completed', `${employee.username}; delivered via ${delivery.sent.join(', ') || 'none'}`);
  if (delivery.sent.length === 0 && NODE_ENV !== 'production') {
    return res.json({ message: `Development mode: temporary password for ${employee.username}: ${tempPassword}. Configure SMTP/WhatsApp for production delivery.` });
  }
  return genericRecoveryResponse(res);
});


// Multi-hospital / organization management
app.get('/api/tenancy', requireAuth, requireAuditAccess, (req, res) => {
  const role = accessRoleFor(req.user);
  let orgRows = [];
  let hospitalRows = [];
  if (role === 'sysadmin') {
    orgRows = db.prepare('SELECT * FROM organizations ORDER BY name COLLATE NOCASE').all();
    hospitalRows = db.prepare('SELECT * FROM hospitals ORDER BY name COLLATE NOCASE').all();
  } else if (role === 'org_admin') {
    orgRows = db.prepare('SELECT * FROM organizations WHERE id=?').all(req.user.organizationId || '');
    hospitalRows = db.prepare('SELECT * FROM hospitals WHERE organizationId=? ORDER BY name COLLATE NOCASE').all(req.user.organizationId || '');
  } else {
    orgRows = db.prepare('SELECT * FROM organizations WHERE id=?').all(req.user.organizationId || '');
    hospitalRows = db.prepare('SELECT * FROM hospitals WHERE id=?').all(req.user.hospitalId || '');
  }
  res.json({ organizations: orgRows.map(publicOrganization), hospitals: hospitalRows.map(publicHospital) });
});



function normalizedEntityName(value) {
  return String(value || '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function findDuplicateOrganization(name, code, excludeId = '') {
  const targetName = normalizedEntityName(name);
  const targetCode = String(code || '').trim().toUpperCase();
  return db.prepare('SELECT * FROM organizations ORDER BY createdAt, id').all().find(row => row.id !== excludeId && ((targetName && normalizedEntityName(row.name) === targetName) || (targetCode && String(row.code || '').trim().toUpperCase() === targetCode)));
}
function findDuplicateHospital(organizationId, name, code, excludeId = '') {
  const targetName = normalizedEntityName(name);
  const targetCode = String(code || '').trim().toUpperCase();
  return db.prepare('SELECT * FROM hospitals WHERE organizationId=? ORDER BY createdAt, id').all(organizationId).find(row => row.id !== excludeId && ((targetName && normalizedEntityName(row.name) === targetName) || (targetCode && String(row.code || '').trim().toUpperCase() === targetCode)));
}
function dependencyCountsForHospital(hospitalId) {
  const tables = ['employees','attachments','awareness_acknowledgements','training_attempts','departments','overexposure_cases','rsc_members','rsc_meetings','rsc_documents'];
  const out = {};
  for (const table of tables) { try { out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE hospitalId=?`).get(hospitalId)?.n || 0); } catch (_) { out[table] = 0; } }
  return out;
}
function dependencyCountsForOrganization(organizationId) {
  const tables = ['hospitals','employees','attachments','awareness_acknowledgements','training_attempts','departments','overexposure_cases','rsc_members','rsc_meetings','rsc_documents'];
  const out = {};
  for (const table of tables) { try { out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organizationId=?`).get(organizationId)?.n || 0); } catch (_) { out[table] = 0; } }
  return out;
}
function moveHospitalReferences(fromId, toId) {
  const tables = ['employees','attachments','awareness_acknowledgements','training_attempts','departments','overexposure_cases','rsc_members','rsc_meetings','rsc_documents'];
  for (const table of tables) { try { db.prepare(`UPDATE ${table} SET hospitalId=? WHERE hospitalId=?`).run(toId, fromId); } catch (_) {} }
}
function moveOrganizationReferences(fromId, toId) {
  const tables = ['employees','attachments','awareness_acknowledgements','training_attempts','departments','overexposure_cases','rsc_members','rsc_meetings','rsc_documents'];
  for (const table of tables) { try { db.prepare(`UPDATE ${table} SET organizationId=? WHERE organizationId=?`).run(toId, fromId); } catch (_) {} }
}

function normalizeAutoCode(value, fallback = 'CODE') {
  const stopWords = new Set(['THE','AND','OF','HOSPITAL','HOSPITALS','INSTITUTE','INSTITUTES','CENTRE','CENTER','CLINIC','CLINICS','MEDICAL','CANCER','GROUP','PVT','LTD','LIMITED','PRIVATE','TECHNOLOGIES','TECHNOLOGY','RADIOLOGY','HEALTHCARE','HEALTH']);
  const words = String(value || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const significant = words.filter(w => !stopWords.has(w));
  let base = significant[0] || words[0] || fallback;
  if (base.length <= 3 && significant.length > 1) base = significant.map(w => w[0]).join('').slice(0, 12) || base;
  return (base.replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || fallback).toUpperCase();
}
function uniqueTableCode(table, base, excludeId = '') {
  let root = normalizeAutoCode(base, 'CODE');
  let code = root;
  let i = 1;
  while (true) {
    const row = db.prepare(`SELECT id FROM ${table} WHERE code=?`).get(code);
    if (!row || (excludeId && row.id === excludeId)) return code;
    i += 1;
    code = `${root}-${String(i).padStart(2, '0')}`.slice(0, 40);
  }
}
function buildHospitalCode(org, hospitalName, city) {
  const orgCode = normalizeAutoCode(org?.code || org?.name || '', 'HOSP');
  const cityCode = city ? normalizeAutoCode(city, '') : '';
  const hospCode = normalizeAutoCode(hospitalName, 'HOSP');
  if (cityCode) return `${orgCode}-${cityCode}`;
  if (hospCode && hospCode !== 'HOSP' && hospCode !== orgCode) return `${orgCode}-${hospCode}`;
  return orgCode;
}


app.post('/api/organizations', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro panel admin can create organizations' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required' });
  const ts = nowISO();
  const id = makeId('org');
  const requestedCode = normalizeAutoCode(req.body.code || name || id, 'ORG');
  const existingDuplicate = findDuplicateOrganization(name, requestedCode);
  if (existingDuplicate) return res.status(409).json({ error: 'Organization already exists', existing: publicOrganization(existingDuplicate) });
  const code = uniqueTableCode('organizations', requestedCode);
  db.prepare(`INSERT INTO organizations (id, name, code, address, contactPerson, email, phone, packageName, licenseStatus, trialStartDate, trialEndDate, registrationDate, renewalDueDate, billingAmount, billingCycle, maxHospitals, maxTldUsers, billingNotes, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, code, String(req.body.address||'').trim(), String(req.body.contactPerson||'').trim(), String(req.body.email||'').trim(), String(req.body.phone||'').trim(), String(req.body.packageName || 'Trial').trim(), String(req.body.licenseStatus || 'Trial').trim(), String(req.body.trialStartDate || '').trim(), String(req.body.trialEndDate || '').trim(), String(req.body.registrationDate || '').trim(), String(req.body.renewalDueDate || '').trim(), String(req.body.billingAmount || '').trim(), String(req.body.billingCycle || '').trim(), Number(req.body.maxHospitals || 1), Number(req.body.maxTldUsers || 100), String(req.body.billingNotes || '').trim(), boolToInt(req.body.active !== false), ts, ts);
  logAudit(req, 'Organization created', name);
  res.status(201).json({ organization: publicOrganization(db.prepare('SELECT * FROM organizations WHERE id=?').get(id)) });
});


app.put('/api/organizations/:id', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro panel admin can edit organizations' });
  const row = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Organization not found' });
  const name = String(req.body.name || row.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required' });
  const requestedCode = normalizeAutoCode(req.body.code || row.code || name, 'ORG');
  const duplicate = findDuplicateOrganization(name, requestedCode, row.id);
  if (duplicate) return res.status(409).json({ error: 'Another organization with the same name or code already exists', existing: publicOrganization(duplicate) });
  const code = uniqueTableCode('organizations', requestedCode, row.id);
  db.prepare(`UPDATE organizations SET name=?, code=?, address=?, contactPerson=?, email=?, phone=?, active=?, updatedAt=? WHERE id=?`)
    .run(name, code, String(req.body.address||'').trim(), String(req.body.contactPerson||'').trim(), String(req.body.email||'').trim(), String(req.body.phone||'').trim(), boolToInt(req.body.active !== false), nowISO(), row.id);
  logAudit(req, 'Organization updated', name);
  res.json({ organization: publicOrganization(db.prepare('SELECT * FROM organizations WHERE id=?').get(row.id)) });
});

app.delete('/api/organizations/:id', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro panel admin can delete organizations' });
  const row = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Organization not found' });
  const dependencies = dependencyCountsForOrganization(row.id);
  const totalDependencies = Object.values(dependencies).reduce((sum, n) => sum + Number(n || 0), 0);
  if (totalDependencies > 0) return res.status(409).json({ error: 'Organization cannot be deleted because linked records exist. Deactivate it or merge/reassign linked records first.', dependencies });
  db.prepare('DELETE FROM organizations WHERE id=?').run(row.id);
  logAudit(req, 'Organization deleted', row.name);
  res.json({ ok: true });
});

app.put('/api/organizations/:id/license', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro panel admin can update organization license/billing' });
  const row = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Organization not found' });
  db.prepare(`
    UPDATE organizations
    SET packageName=?, licenseStatus=?, trialStartDate=?, trialEndDate=?, registrationDate=?, renewalDueDate=?,
      billingAmount=?, billingCycle=?, maxHospitals=?, maxTldUsers=?, billingNotes=?, active=?, updatedAt=?
    WHERE id=?
  `).run(
    String(req.body.packageName || row.packageName || 'Trial').trim(),
    String(req.body.licenseStatus || row.licenseStatus || 'Trial').trim(),
    String(req.body.trialStartDate || '').trim(),
    String(req.body.trialEndDate || '').trim(),
    String(req.body.registrationDate || '').trim(),
    String(req.body.renewalDueDate || '').trim(),
    String(req.body.billingAmount || '').trim(),
    String(req.body.billingCycle || '').trim(),
    Number(req.body.maxHospitals || 0),
    Number(req.body.maxTldUsers || 0),
    String(req.body.billingNotes || '').trim(),
    boolToInt(req.body.active !== false),
    nowISO(),
    row.id
  );
  logAudit(req, 'Organization license updated', `${row.name}: ${req.body.licenseStatus || row.licenseStatus || ''}`);
  res.json({ organization: publicOrganization(db.prepare('SELECT * FROM organizations WHERE id=?').get(row.id)) });
});


function createOrUpdateHospitalAccessUser(req, hospital, body = {}) {
  const username = String(body.adminUsername || body.username || '').trim();
  const password = String(body.adminPassword || body.password || '').trim();
  if (!username && !password) return null;
  if (!username || !password) throw new Error('Both hospital admin username and temporary password are required');
  if (password.length < 4) throw new Error('Temporary password must have at least 4 characters');
  const accessRole = ['admin','rso'].includes(String(body.adminAccessRole || body.accessRole || 'rso').toLowerCase()) ? String(body.adminAccessRole || body.accessRole || 'rso').toLowerCase() : 'rso';
  const ts = nowISO();
  const existing = getEmployeeByUsername(username);
  const adminName = String(body.adminName || body.name || `${hospital.name} RSO`).trim();
  const email = String(body.adminEmail || body.email || hospital.email || '').trim();
  const phone = String(body.adminPhone || body.phone || hospital.phone || '').trim();
  const passwordHash = bcrypt.hashSync(password, 10);
  if (existing) {
    db.prepare(`UPDATE employees SET name=?, dept=?, role=?, email=?, phone=?, accessRole=?, twoFactorEnabled=?, passwordHash=?, enabled=1, isRSO=1, organizationId=?, hospitalId=?, updatedAt=? WHERE id=?`)
      .run(adminName, 'Radiation Safety', accessRole === 'admin' ? 'Hospital Admin' : 'RSO', email, phone, accessRole, 0, passwordHash, hospital.organizationId, hospital.id, ts, existing.id);
    logAudit(req, 'Hospital RSO/Admin login updated', `${hospital.name}: ${username}`);
    return { username, tempPassword: password, updated: true };
  }
  db.prepare(`INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('emp'), adminName, 'Radiation Safety', accessRole === 'admin' ? 'Hospital Admin' : 'RSO', `${hospital.code}-RSO`, email, phone, accessRole, 0, username, passwordHash, 1, 1, hospital.organizationId, hospital.id, ts, ts);
  logAudit(req, 'Hospital RSO/Admin login created', `${hospital.name}: ${username}`);
  return { username, tempPassword: password, updated: false };
}

app.post('/api/hospitals', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  const role = accessRoleFor(req.user);
  let organizationId = String(req.body.organizationId || '').trim();
  if (role === 'org_admin') organizationId = req.user.organizationId || organizationId;
  if (!organizationId) return res.status(400).json({ error: 'Organization is required' });
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Hospital / institute name is required' });
  const ts = nowISO();
  const id = makeId('hosp');
  const requestedCode = String(req.body.code || '').trim();
  const baseCode = requestedCode || buildHospitalCode(org, name, req.body.city || '');
  const duplicateHospital = findDuplicateHospital(organizationId, name, normalizeAutoCode(baseCode || name || id, 'HOSP'));
  if (duplicateHospital) return res.status(409).json({ error: 'Hospital / institute already exists under this organization', existing: publicHospital(duplicateHospital) });
  // Hospital codes must be unique only among hospitals.
  // A single-hospital organization is allowed to have the same organization code and hospital code
  // e.g. Organization TEST + Hospital TEST => hospital code TEST, not TEST-02.
  const code = uniqueTableCode('hospitals', baseCode || name || id);
  db.prepare(`INSERT INTO hospitals (id, organizationId, name, code, city, state, address, email, phone, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, organizationId, name, code, String(req.body.city||'').trim(), String(req.body.state||'').trim(), String(req.body.address||'').trim(), String(req.body.email||'').trim(), String(req.body.phone||'').trim(), boolToInt(req.body.active !== false), ts, ts);
  logAudit(req, 'Hospital/institute created', name);
  const hospital = db.prepare('SELECT * FROM hospitals WHERE id=?').get(id);
  let adminAccess = null;
  try { adminAccess = createOrUpdateHospitalAccessUser(req, hospital, req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  res.status(201).json({ hospital: publicHospital(hospital), adminAccess });
});


app.put('/api/hospitals/:id', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Hospital not found' });
  const role = accessRoleFor(req.user);
  if (role === 'org_admin' && h.organizationId !== req.user.organizationId) return res.status(403).json({ error: 'Not allowed for this organization' });
  let organizationId = String(req.body.organizationId || h.organizationId || '').trim();
  if (role === 'org_admin') organizationId = req.user.organizationId || organizationId;
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const name = String(req.body.name || h.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Hospital / institute name is required' });
  const requestedHospitalCode = normalizeAutoCode(req.body.code || h.code || buildHospitalCode(org, name, req.body.city || h.city || ''), 'HOSP');
  const duplicate = findDuplicateHospital(organizationId, name, requestedHospitalCode, h.id);
  if (duplicate) return res.status(409).json({ error: 'Another hospital with the same name or code already exists under this organization', existing: publicHospital(duplicate) });
  const code = uniqueTableCode('hospitals', requestedHospitalCode, h.id);
  db.prepare(`UPDATE hospitals SET organizationId=?, name=?, code=?, city=?, state=?, address=?, email=?, phone=?, active=?, updatedAt=? WHERE id=?`)
    .run(organizationId, name, code, String(req.body.city||'').trim(), String(req.body.state||'').trim(), String(req.body.address||'').trim(), String(req.body.email||'').trim(), String(req.body.phone||'').trim(), boolToInt(req.body.active !== false), nowISO(), h.id);
  const hospital = db.prepare('SELECT * FROM hospitals WHERE id=?').get(h.id);
  let adminAccess = null;
  try { adminAccess = createOrUpdateHospitalAccessUser(req, hospital, req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  logAudit(req, 'Hospital/institute updated', name);
  res.json({ hospital: publicHospital(hospital), adminAccess });
});

app.post('/api/hospitals/:id/rso-access', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Hospital not found' });
  const role = accessRoleFor(req.user);
  if (role === 'org_admin' && h.organizationId !== req.user.organizationId) return res.status(403).json({ error: 'Not allowed for this organization' });
  try {
    const access = createOrUpdateHospitalAccessUser(req, h, req.body);
    if (!access) return res.status(400).json({ error: 'Username and temporary password are required' });
    res.json(access);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/hospitals/:id', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  const h = db.prepare('SELECT * FROM hospitals WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Hospital not found' });
  if (accessRoleFor(req.user) === 'org_admin' && h.organizationId !== req.user.organizationId) return res.status(403).json({ error: 'Not allowed for this organization' });
  const dependencies = dependencyCountsForHospital(h.id);
  const totalDependencies = Object.values(dependencies).reduce((sum, n) => sum + Number(n || 0), 0);
  if (totalDependencies > 0) return res.status(409).json({ error: 'Hospital cannot be deleted because linked records exist. Deactivate it or merge/reassign linked records first.', dependencies });
  db.prepare('DELETE FROM hospitals WHERE id=?').run(h.id);
  logAudit(req, 'Hospital/institute deleted', h.name);
  res.json({ ok: true });
});




app.post('/api/tenancy/merge-duplicates', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro Panel Admin can merge duplicate organizations and hospitals' });
  const summary = { organizationsMerged: 0, hospitalsMerged: 0, organizationGroups: [], hospitalGroups: [] };
  const organizations = db.prepare('SELECT * FROM organizations ORDER BY createdAt, id').all();
  const groups = new Map();
  for (const org of organizations) {
    const key = normalizedEntityName(org.name) || String(org.code || '').trim().toUpperCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(org);
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const keep = rows[0];
    for (const duplicate of rows.slice(1)) {
      const duplicateHospitals = db.prepare('SELECT * FROM hospitals WHERE organizationId=? ORDER BY createdAt, id').all(duplicate.id);
      for (const hospital of duplicateHospitals) {
        const match = findDuplicateHospital(keep.id, hospital.name, hospital.code);
        if (match) {
          moveHospitalReferences(hospital.id, match.id);
          db.prepare('DELETE FROM hospitals WHERE id=?').run(hospital.id);
          summary.hospitalsMerged += 1;
          summary.hospitalGroups.push({ kept: match.name, removed: hospital.name });
        } else {
          db.prepare('UPDATE hospitals SET organizationId=?, updatedAt=? WHERE id=?').run(keep.id, nowISO(), hospital.id);
        }
      }
      moveOrganizationReferences(duplicate.id, keep.id);
      db.prepare('DELETE FROM organizations WHERE id=?').run(duplicate.id);
      summary.organizationsMerged += 1;
      summary.organizationGroups.push({ kept: keep.name, removed: duplicate.name });
    }
  }
  const remainingOrganizations = db.prepare('SELECT * FROM organizations ORDER BY createdAt, id').all();
  for (const org of remainingOrganizations) {
    const hospitals = db.prepare('SELECT * FROM hospitals WHERE organizationId=? ORDER BY createdAt, id').all(org.id);
    const hospitalGroups = new Map();
    for (const hospital of hospitals) {
      const key = normalizedEntityName(hospital.name) || String(hospital.code || '').trim().toUpperCase();
      if (!hospitalGroups.has(key)) hospitalGroups.set(key, []);
      hospitalGroups.get(key).push(hospital);
    }
    for (const rows of hospitalGroups.values()) {
      if (rows.length < 2) continue;
      const keep = rows[0];
      for (const duplicate of rows.slice(1)) {
        moveHospitalReferences(duplicate.id, keep.id);
        db.prepare('DELETE FROM hospitals WHERE id=?').run(duplicate.id);
        summary.hospitalsMerged += 1;
        summary.hospitalGroups.push({ kept: keep.name, removed: duplicate.name });
      }
    }
  }
  logAudit(req, 'Duplicate organizations/hospitals merged', JSON.stringify(summary));
  res.json({ ok: true, summary });
});

app.post('/api/demo/delete-default', requireAuth, requireRadproOrOrgAdmin, (req, res) => {
  if (accessRoleFor(req.user) !== 'sysadmin') return res.status(403).json({ error: 'Only Radpro Panel Admin can delete demo/default data' });
  const defaultOrg = db.prepare("SELECT * FROM organizations WHERE id='org_default' OR code='DEFAULT' OR name='Default Organization' ORDER BY id='org_default' DESC LIMIT 1").get();
  const defaultHosp = db.prepare("SELECT * FROM hospitals WHERE id='hosp_default' OR code='DEFAULT-HOSP' OR name='Default Hospital / Institute' ORDER BY id='hosp_default' DESC LIMIT 1").get();
  if (!defaultOrg && !defaultHosp) return res.json({ ok: true, message: 'No default demo organization/hospital found.', deleted: { employees: 0, hospitals: 0, organizations: 0 } });

  const targetOrgId = defaultOrg ? defaultOrg.id : '';
  const targetHospId = defaultHosp ? defaultHosp.id : '';
  const replacementOrg = db.prepare('SELECT * FROM organizations WHERE id<>? ORDER BY createdAt LIMIT 1').get(targetOrgId || '__none__');
  const replacementHosp = replacementOrg ? db.prepare('SELECT * FROM hospitals WHERE organizationId=? AND id<>? ORDER BY createdAt LIMIT 1').get(replacementOrg.id, targetHospId || '__none__') : null;
  const ts = nowISO();

  const demoEmployees = db.prepare(`SELECT id, username FROM employees WHERE username <> 'radpro' AND (organizationId=? OR hospitalId=? OR username='rso' OR id='emp_1')`).all(targetOrgId, targetHospId);
  const demoEmployeeIds = demoEmployees.map(e => e.id);
  const qMarks = demoEmployeeIds.map(() => '?').join(',');
  const runForIds = (sql) => { if (demoEmployeeIds.length) db.prepare(sql.replace('__IDS__', qMarks)).run(...demoEmployeeIds); };

  const attachmentRows = db.prepare(`SELECT storedName FROM attachments WHERE organizationId=? OR hospitalId=? ${demoEmployeeIds.length ? `OR employeeId IN (${qMarks})` : ''}`).all(targetOrgId, targetHospId, ...demoEmployeeIds);
  const rscDocRows = db.prepare('SELECT storedName FROM rsc_documents WHERE organizationId=? OR hospitalId=?').all(targetOrgId, targetHospId);
  const deleteUpload = (storedName) => {
    if (!storedName) return;
    const safe = path.basename(String(storedName));
    const full = path.join(UPLOAD_DIR, safe);
    try { if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) fs.unlinkSync(full); } catch (_) { /* ignore file delete failure */ }
  };

  const tx = db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('demoDefaultDeleted', 'true')`).run();
    runForIds('DELETE FROM notification_recipients WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM reminder_logs WHERE recipientEmployeeId IN (__IDS__)');
    runForIds('DELETE FROM training_attempts WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM awareness_acknowledgements WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM acknowledgements WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM overexposure_cases WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM investigations WHERE employeeId IN (__IDS__)');
    runForIds('DELETE FROM doses WHERE employeeId IN (__IDS__)');
    if (demoEmployeeIds.length) db.prepare(`DELETE FROM attachments WHERE employeeId IN (${qMarks})`).run(...demoEmployeeIds);

    db.prepare('DELETE FROM attachments WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM rsc_documents WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM rsc_meetings WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM rsc_members WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM overexposure_cases WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM training_attempts WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);
    db.prepare('DELETE FROM awareness_acknowledgements WHERE organizationId=? OR hospitalId=?').run(targetOrgId, targetHospId);

    if (demoEmployeeIds.length) db.prepare(`DELETE FROM employees WHERE id IN (${qMarks})`).run(...demoEmployeeIds);

    // Keep Radpro sysadmin active, but detach or reassign it before removing the demo/default tenant.
    db.prepare(`UPDATE employees SET organizationId=?, hospitalId=?, accessRole='sysadmin', role='Radpro Super Admin', enabled=1, isRSO=1, updatedAt=? WHERE username='radpro'`)
      .run(replacementOrg ? replacementOrg.id : '', replacementHosp ? replacementHosp.id : '', ts);

    if (targetHospId) db.prepare('DELETE FROM hospitals WHERE id=?').run(targetHospId);
    if (targetOrgId) db.prepare('DELETE FROM organizations WHERE id=?').run(targetOrgId);
  });
  tx();
  attachmentRows.forEach(r => deleteUpload(r.storedName));
  rscDocRows.forEach(r => deleteUpload(r.storedName));
  logAudit(req, 'Default demo data deleted', `Default organization/hospital removed. Employees deleted: ${demoEmployees.length}`);
  res.json({ ok: true, message: 'Default demo organization, hospital and linked demo records were deleted.', deleted: { employees: demoEmployees.length, hospitals: defaultHosp ? 1 : 0, organizations: defaultOrg ? 1 : 0 } });
});

// Employees
// Radpro internal user management
app.get('/api/radpro-users', requireAuth, requireSysadmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM employees
    WHERE username='radpro'
       OR role IN ('Radpro Super Admin','Radpro Admin','Software Manager','Support Engineer','Sales Manager','Sales Executive','Accounts','Marketing','Viewer / Read Only')
       OR (accessRole='sysadmin' AND (organizationId IS NULL OR organizationId=''))
    ORDER BY username
  `).all();
  res.json({ users: rows.map(publicEmployee) });
});

app.post('/api/radpro-users', requireAuth, requireSysadmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const roleName = String(req.body.role || 'Radpro Admin').trim();
  if (!name) return res.status(400).json({ error: 'Full name is required' });
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (!password) return res.status(400).json({ error: 'Temporary password is required' });
  if (!isRadproInternalRole(roleName)) return res.status(400).json({ error: 'Select a valid Radpro role' });
  if (getEmployeeByUsername(username)) return res.status(409).json({ error: 'Username already exists' });
  const ts = nowISO();
  const id = makeId('radpro_user');
  db.prepare(`INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, 'Radpro Technologies', roleName, '', String(req.body.email || '').trim(), String(req.body.phone || '').trim(), 'sysadmin', boolToInt(req.body.twoFactorEnabled !== false), username, bcrypt.hashSync(password, 10), boolToInt(req.body.enabled !== false), 1, '', '', ts, ts);
  logAudit(req, 'Radpro internal user created', `${name} · ${roleName}`);
  res.status(201).json({ user: publicEmployee(getEmployeeById(id)) });
});

app.put('/api/radpro-users/:id', requireAuth, requireSysadmin, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Radpro user not found' });
  if (!isProtectedRadproUser(existing) && existing.accessRole !== 'sysadmin' && !isRadproInternalRole(existing.role)) return res.status(400).json({ error: 'This is not a Radpro internal user' });
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim();
  const roleName = String(req.body.role || existing.role || 'Radpro Admin').trim();
  if (!name) return res.status(400).json({ error: 'Full name is required' });
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (!isRadproInternalRole(roleName)) return res.status(400).json({ error: 'Select a valid Radpro role' });
  const other = getEmployeeByUsername(username);
  if (other && other.id !== existing.id) return res.status(409).json({ error: 'Username already exists' });
  const password = String(req.body.password || '');
  const passwordHash = password ? bcrypt.hashSync(password, 10) : existing.passwordHash;
  const enabled = isProtectedRadproUser(existing) ? 1 : boolToInt(req.body.enabled !== false);
  db.prepare(`UPDATE employees SET name=?, dept='Radpro Technologies', role=?, tldNumber='', email=?, phone=?, accessRole='sysadmin', twoFactorEnabled=?, username=?, passwordHash=?, enabled=?, isRSO=1, organizationId='', hospitalId='', updatedAt=? WHERE id=?`)
    .run(name, roleName, String(req.body.email || '').trim(), String(req.body.phone || '').trim(), boolToInt(req.body.twoFactorEnabled), username, passwordHash, enabled, nowISO(), existing.id);
  logAudit(req, 'Radpro internal user updated', `${name} · ${roleName}`);
  res.json({ user: publicEmployee(getEmployeeById(existing.id)) });
});

app.patch('/api/radpro-users/:id/toggle', requireAuth, requireSysadmin, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Radpro user not found' });
  if (isProtectedRadproUser(existing) || existing.id === req.user.id) return res.status(400).json({ error: 'Cannot disable the primary/current Radpro admin' });
  if (existing.accessRole !== 'sysadmin' && !isRadproInternalRole(existing.role)) return res.status(400).json({ error: 'This is not a Radpro internal user' });
  const newStatus = existing.enabled ? 0 : 1;
  db.prepare('UPDATE employees SET enabled=?, updatedAt=? WHERE id=?').run(newStatus, nowISO(), existing.id);
  logAudit(req, newStatus ? 'Radpro internal user enabled' : 'Radpro internal user disabled', existing.name);
  res.json({ user: publicEmployee(getEmployeeById(existing.id)) });
});

app.delete('/api/radpro-users/:id', requireAuth, requireSysadmin, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Radpro user not found' });
  if (isProtectedRadproUser(existing) || existing.id === req.user.id) return res.status(400).json({ error: 'Cannot delete the primary/current Radpro admin' });
  if (existing.accessRole !== 'sysadmin' && !isRadproInternalRole(existing.role)) return res.status(400).json({ error: 'This is not a Radpro internal user' });
  db.prepare('DELETE FROM employees WHERE id=?').run(existing.id);
  logAudit(req, 'Radpro internal user deleted', existing.name);
  res.json({ ok: true });
});

app.get('/api/employees', requireAuth, requireAuditAccess, (req, res) => {
  const scope = employeeScopeWhere(req.user);
  const rows = db.prepare(`SELECT e.*, o.name AS organizationName, h.name AS hospitalName FROM employees e LEFT JOIN organizations o ON o.id=e.organizationId LEFT JOIN hospitals h ON h.id=e.hospitalId WHERE ${scope.where.replace(/id = \?/, 'e.id = ?')} ORDER BY e.accessRole='sysadmin' DESC, e.isRSO DESC, e.name COLLATE NOCASE`).all(...scope.params);
  res.json({ employees: rows.map(publicEmployee) });
});

app.post('/api/employees', requireAuth, requireRSO, (req, res) => {
  const valid = validateEmployeeInput(req.body, { create: true });
  if (valid.error) return res.status(400).json({ error: valid.error });
  if (getEmployeeByUsername(valid.username)) return res.status(409).json({ error: 'Username already exists' });

  const ts = nowISO();
  const id = req.body.id || makeId('emp');
  const passwordHash = bcrypt.hashSync(valid.password, 10);
  const accessRole = String(req.body.accessRole || (req.body.isRSO ? 'rso' : 'employee')).trim().toLowerCase();
  let safeAccessRole = ['sysadmin', 'org_admin', 'admin', 'rso', 'auditor', 'employee'].includes(accessRole) ? accessRole : 'employee';
  if (accessRoleFor(req.user) !== 'sysadmin' && safeAccessRole === 'sysadmin') safeAccessRole = 'employee';
  if (!['sysadmin','org_admin'].includes(accessRoleFor(req.user)) && safeAccessRole === 'org_admin') safeAccessRole = 'employee';
  const tenant = resolveTenantForEmployee(req, req.body);
  db.prepare(`
    INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    valid.name,
    String(req.body.dept || '').trim(),
    String(req.body.role || 'Other').trim(),
    String(req.body.tldNumber || '').trim(),
    String(req.body.email || '').trim(),
    String(req.body.phone || '').trim(),
    safeAccessRole,
    boolToInt(req.body.twoFactorEnabled),
    valid.username,
    passwordHash,
    boolToInt(req.body.enabled !== false),
    boolToInt(req.body.isRSO || ['sysadmin','org_admin','admin','rso'].includes(safeAccessRole)),
    tenant.organizationId,
    tenant.hospitalId,
    ts,
    ts
  );
  logAudit(req, 'Employee created', valid.name);
  res.status(201).json({ employee: publicEmployee(getEmployeeById(id)) });
});

app.put('/api/employees/:id', requireAuth, requireRSO, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const valid = validateEmployeeInput(req.body, { create: false });
  if (valid.error) return res.status(400).json({ error: valid.error });
  const other = getEmployeeByUsername(valid.username);
  if (other && other.id !== existing.id) return res.status(409).json({ error: 'Username already exists' });

  const passwordHash = valid.password ? bcrypt.hashSync(valid.password, 10) : existing.passwordHash;
  const accessRole = String(req.body.accessRole || (req.body.isRSO ? 'rso' : accessRoleFor(existing))).trim().toLowerCase();
  let safeAccessRole = ['sysadmin', 'org_admin', 'admin', 'rso', 'auditor', 'employee'].includes(accessRole) ? accessRole : 'employee';
  if (accessRoleFor(req.user) !== 'sysadmin' && safeAccessRole === 'sysadmin') safeAccessRole = 'employee';
  if (!['sysadmin','org_admin'].includes(accessRoleFor(req.user)) && safeAccessRole === 'org_admin') safeAccessRole = 'employee';
  const tenant = resolveTenantForEmployee(req, req.body);
  db.prepare(`
    UPDATE employees
    SET name=?, dept=?, role=?, tldNumber=?, email=?, phone=?, accessRole=?, twoFactorEnabled=?, username=?, passwordHash=?, enabled=?, isRSO=?, organizationId=?, hospitalId=?, updatedAt=?
    WHERE id=?
  `).run(
    valid.name,
    String(req.body.dept || '').trim(),
    String(req.body.role || 'Other').trim(),
    String(req.body.tldNumber || '').trim(),
    String(req.body.email || '').trim(),
    String(req.body.phone || '').trim(),
    safeAccessRole,
    boolToInt(req.body.twoFactorEnabled),
    valid.username,
    passwordHash,
    boolToInt(req.body.enabled),
    boolToInt(req.body.isRSO || ['sysadmin','org_admin','admin','rso'].includes(safeAccessRole)),
    tenant.organizationId,
    tenant.hospitalId,
    nowISO(),
    existing.id
  );
  logAudit(req, 'Employee updated', valid.name);
  res.json({ employee: publicEmployee(getEmployeeById(existing.id)) });
});

app.patch('/api/employees/:id/toggle', requireAuth, requireRSO, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const newStatus = existing.enabled ? 0 : 1;
  if (existing.isRSO && existing.enabled) {
    const enabledRsoCount = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE isRSO = 1 AND enabled = 1').get().n;
    if (enabledRsoCount <= 1) return res.status(400).json({ error: 'Cannot disable the last active RSO admin' });
  }
  db.prepare('UPDATE employees SET enabled=?, updatedAt=? WHERE id=?').run(newStatus, nowISO(), existing.id);
  logAudit(req, newStatus ? 'Employee enabled' : 'Employee disabled', existing.name);
  res.json({ employee: publicEmployee(getEmployeeById(existing.id)) });
});

app.delete('/api/employees/:id', requireAuth, requireRSO, (req, res) => {
  const existing = getEmployeeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  if (existing.isRSO) {
    const rsoCount = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE isRSO = 1').get().n;
    if (rsoCount <= 1) return res.status(400).json({ error: 'Cannot delete the last RSO admin' });
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(existing.id);
  logAudit(req, 'Employee deleted', existing.name);
  res.json({ ok: true });
});

// Doses
app.get('/api/doses', requireAuth, (req, res) => {
  let rows = userCanReadAudit(req.user)
    ? db.prepare(`SELECT d.* FROM doses d JOIN employees e ON e.id=d.employeeId WHERE ${employeeScopeWhere(req.user, 'e').where} ORDER BY d.createdAt DESC`).all(...employeeScopeWhere(req.user, 'e').params)
    : db.prepare('SELECT * FROM doses WHERE employeeId = ? ORDER BY createdAt DESC').all(req.user.id);
  if (!userCanReadAudit(req.user)) {
    const settings = getSettingsObject();
    const visibility = String(settings.dosePortalVisibility || 'all');
    const limit = Number(settings.doseAlertLimit || 0);
    if (visibility === 'aboveLimitOnly' && limit > 0) {
      rows = rows.filter(row => Number(row.hp10 || 0) >= limit);
    }
  }
  res.json({ doses: rows });
});

app.post('/api/doses/import', requireAuth, requireRSO, async (req, res) => {
  const period = String(req.body.period || '').trim() || 'Not specified';
  const quarter = String(req.body.quarter || '').trim() || period;
  let rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (rows.length && Array.isArray(rows[0]) && /[A-Za-z]/.test(String(rows[0][0] || '')) && !/[0-9]/.test(String(rows[0][0] || ''))) {
    rows = rows.slice(1);
  }

  const employees = db.prepare('SELECT * FROM employees').all();
  const employeeByTld = new Map();
  const nameBuckets = new Map();
  employees.forEach(emp => {
    if (emp.tldNumber) employeeByTld.set(normalizeTld(emp.tldNumber), emp);
    const nameKey = normalizePersonName(emp.name);
    if (nameKey) {
      if (!nameBuckets.has(nameKey)) nameBuckets.set(nameKey, []);
      nameBuckets.get(nameKey).push(emp);
    }
  });
  const employeeByName = new Map();
  nameBuckets.forEach((bucket, key) => {
    if (bucket.length === 1) employeeByName.set(key, bucket[0]);
  });

  const insert = db.prepare(`
    INSERT INTO doses (id, employeeId, tldNumber, period, quarter, hp10, hp007, remarks, reportLabel, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE doses SET tldNumber=?, hp10=?, hp007=?, remarks=?, reportLabel=?, updatedAt=? WHERE id=?
  `);
  const findExisting = db.prepare('SELECT * FROM doses WHERE employeeId=? AND period=? AND quarter=?');

  let imported = 0;
  let updated = 0;
  let unmatched = 0;
  const alertRows = [];
  const preview = [];
  const tx = db.transaction(() => {
    rows.forEach((raw, index) => {
      const parsed = parseDoseRow(raw);
      if (!parsed || !parsed.tldNumber) return;
      let emp = employeeByTld.get(normalizeTld(parsed.tldNumber));
      let matchMethod = 'TLD';
      if (!emp && parsed.name) {
        emp = employeeByName.get(normalizePersonName(parsed.name));
        if (emp) matchMethod = 'name';
      }
      if (!emp) {
        unmatched += 1;
        preview.push({ tldNumber: parsed.tldNumber, employeeName: parsed.name || '', period, quarter, hp10: parsed.hp10, hp007: parsed.hp007, status: 'No matching TLD/name' });
        return;
      }
      const storedTld = emp.tldNumber || parsed.tldNumber;
      const existing = findExisting.get(emp.id, period, quarter);
      if (existing) {
        update.run(storedTld, parsed.hp10, parsed.hp007, parsed.remarks || existing.remarks || '', period, nowISO(), existing.id);
        updated += 1;
      } else {
        insert.run(makeId('dose'), emp.id, storedTld, period, quarter, parsed.hp10, parsed.hp007, parsed.remarks || '', period, nowISO(), nowISO());
        imported += 1;
      }
      alertRows.push({ employee: emp, hp10: parsed.hp10, hp007: parsed.hp007, tldNumber: storedTld, period, quarter });
      preview.push({ tldNumber: parsed.tldNumber, employeeId: emp.id, employeeName: emp.name, period, quarter, hp10: parsed.hp10, hp007: parsed.hp007, status: existing ? `Updated by ${matchMethod}` : `Imported by ${matchMethod}` });
    });
  });
  tx();

  const doseAlert = await createDoseLimitNotifications(req, alertRows, { period, quarter });
  logAudit(req, 'Dose report imported', `${period} / ${quarter}: ${imported} imported, ${updated} updated, ${unmatched} unmatched`);
  if (doseAlert.count) logAudit(req, 'Dose limit notification generated', `${quarter}: ${doseAlert.count} employee(s) at/above ${doseAlert.limit} mSv`);
  res.json({ imported, updated, unmatched, preview, doseAlert });
});

app.get('/api/doses/periods', requireAuth, (req, res) => {
  const rows = userCanReadAudit(req.user)
    ? db.prepare(`
        SELECT period, quarter, COUNT(*) AS count, ROUND(CAST(SUM(hp10) AS numeric), 4) AS totalHp10, ROUND(CAST(AVG(hp10) AS numeric), 4) AS avgHp10
        FROM doses GROUP BY period, quarter ORDER BY MAX(createdAt) DESC
      `).all()
    : db.prepare(`
        SELECT period, quarter, COUNT(*) AS count, ROUND(CAST(SUM(hp10) AS numeric), 4) AS totalHp10, ROUND(CAST(AVG(hp10) AS numeric), 4) AS avgHp10
        FROM doses WHERE employeeId = ? GROUP BY period, quarter ORDER BY MAX(createdAt) DESC
      `).all(req.user.id);
  res.json({ periods: rows });
});

app.get('/api/doses/period-report', requireAuth, (req, res) => {
  const period = String(req.query.period || '');
  const quarter = String(req.query.quarter || '');
  const rows = userCanReadAudit(req.user)
    ? db.prepare(`
        SELECT d.*, e.name AS employeeName, e.dept AS employeeDept
        FROM doses d JOIN employees e ON e.id = d.employeeId
        WHERE d.period = ? AND d.quarter = ?
        ORDER BY e.name COLLATE NOCASE
      `).all(period, quarter)
    : db.prepare(`
        SELECT d.*, e.name AS employeeName, e.dept AS employeeDept
        FROM doses d JOIN employees e ON e.id = d.employeeId
        WHERE d.period = ? AND d.quarter = ? AND d.employeeId = ?
        ORDER BY e.name COLLATE NOCASE
      `).all(period, quarter, req.user.id);
  res.json({ rows });
});

// Attachments
app.post('/api/attachments', requireAuth, requireRSO, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required' });
  const docType = String(req.body.docType || '').trim();
  if (!['employeeForm', 'quarterReport', 'general'].includes(docType)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Invalid document type' });
  }
  const employeeId = req.body.employeeId || null;
  if (docType === 'employeeForm' && !employeeId) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Employee is required for employee form attachment' });
  }
  if (employeeId && !getEmployeeById(employeeId)) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Selected employee not found' });
  }
  const id = makeId('att');
  db.prepare(`
    INSERT INTO attachments
    (id, docType, employeeId, quarter, periodLabel, documentStatus, description, originalName, storedName, mimeType, size, publishToEmployees, uploadedBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    docType,
    employeeId,
    String(req.body.quarter || '').trim(),
    String(req.body.periodLabel || '').trim(),
    String(req.body.documentStatus || '').trim(),
    String(req.body.description || '').trim(),
    req.file.originalname,
    req.file.filename,
    req.file.mimetype || 'application/octet-stream',
    req.file.size,
    boolToInt(req.body.publishToEmployees),
    req.user.name,
    nowISO()
  );
  logAudit(req, 'Attachment uploaded', `${docType}: ${req.file.originalname}`);
  res.status(201).json({ attachment: attachmentPublic(db.prepare('SELECT * FROM attachments WHERE id=?').get(id)) });
});

app.get('/api/attachments', requireAuth, (req, res) => {
  const type = String(req.query.type || 'all');
  const quarter = String(req.query.quarter || 'all');
  const employeeId = String(req.query.employeeId || 'all');
  const q = String(req.query.q || '').toLowerCase();

  let rows = db.prepare('SELECT * FROM attachments ORDER BY createdAt DESC').all();
  if (!userCanReadAudit(req.user)) {
    // Employee portal must never expose uploaded quarterly TLD report PDFs.
    // Employees see only their mapped dose values and their own employee form attachments.
    rows = rows.filter(row => row.docType === 'employeeForm' && row.employeeId === req.user.id);
  }
  if (type !== 'all') rows = rows.filter(row => row.docType === type);
  if (quarter !== 'all') rows = rows.filter(row => (row.quarter || '') === quarter);
  if (employeeId !== 'all') rows = rows.filter(row => (row.employeeId || '') === employeeId);
  if (q) {
    rows = rows.filter(row => [row.originalName, row.description, row.periodLabel, row.documentStatus, row.quarter]
      .some(value => String(value || '').toLowerCase().includes(q)));
  }
  res.json({ attachments: rows.map(attachmentPublic) });
});

function canAccessAttachment(user, row) {
  if (!row) return false;
  if (userCanReadAudit(user)) return true;
  return row.docType === 'employeeForm' && row.employeeId === user.id;
}

app.get('/api/attachments/:id/download', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Attachment not found' });
  if (!canAccessAttachment(req.user, row)) return res.status(403).json({ error: 'Not allowed' });
  const filePath = path.join(UPLOAD_DIR, row.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Stored file missing' });
  const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', row.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${String(row.originalName || 'attachment').replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/attachments/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Attachment not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  const filePath = path.join(UPLOAD_DIR, row.storedName);
  fs.unlink(filePath, () => {});
  logAudit(req, 'Attachment deleted', row.originalName);
  res.json({ ok: true });
});

// Acknowledgements
app.get('/api/acknowledgements', requireAuth, (req, res) => {
  const rows = userCanReadAudit(req.user)
    ? db.prepare('SELECT * FROM acknowledgements ORDER BY acknowledgedAt DESC').all()
    : db.prepare('SELECT * FROM acknowledgements WHERE employeeId = ? ORDER BY acknowledgedAt DESC').all(req.user.id);
  res.json({ acknowledgements: rows });
});

app.post('/api/acknowledgements', requireAuth, (req, res) => {
  const quarter = String(req.body.quarter || '').trim();
  const period = String(req.body.period || '').trim();
  const signerName = String(req.body.signerName || req.user.name || '').trim();
  const signatureData = String(req.body.signatureData || '');
  const statementText = String(req.body.statementText || 'I have reviewed my personal TLD dose record and acknowledge the entry.');
  if (!quarter) return res.status(400).json({ error: 'Quarter is required' });
  if (!signerName) return res.status(400).json({ error: 'Signer name is required' });
  const signedAt = nowISO();
  const signedIp = req.ip || '';
  const existing = db.prepare('SELECT id FROM acknowledgements WHERE employeeId = ? AND quarter = ?').get(req.user.id, quarter);
  if (existing) {
    db.prepare('UPDATE acknowledgements SET period=?, acknowledgedAt=?, signerName=?, signatureData=?, signedAt=?, signedIp=?, statementText=? WHERE id=?')
      .run(period, signedAt, signerName, signatureData, signedAt, signedIp, statementText, existing.id);
  } else {
    db.prepare('INSERT INTO acknowledgements (id, employeeId, period, quarter, acknowledgedAt, signerName, signatureData, signedAt, signedIp, statementText) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(makeId('ack'), req.user.id, period, quarter, signedAt, signerName, signatureData, signedAt, signedIp, statementText);
  }
  logAudit(req, 'Dose e-signed acknowledgement', `${period || quarter} by ${signerName}`);
  res.json({ ok: true });
});


app.get('/api/acknowledgements/report.pdf', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || '').trim();
  const status = String(req.query.status || 'all').trim();
  const rows = acknowledgementStatusRows(quarter, status);
  makeAcknowledgementStatusPdf(res, rows, quarter, status);
});

app.get('/api/awareness/status', requireAuth, (req, res) => {
  const quarter = String(req.query.quarter || '').trim() || currentQuarterFromDate();
  const settings = getSettingsObject();
  const posterVersion = settings.awarenessPosterVersion || 'v1';
  const posterUrl = settings.awarenessPosterUrl || '/assets/tld_awareness_hindi.jpg';
  const mandatory = settings.awarenessMandatory !== 'false';
  const existing = db.prepare('SELECT * FROM awareness_acknowledgements WHERE employeeId = ? AND quarter = ? AND posterVersion = ?').get(req.user.id, quarter, posterVersion);
  res.json({ required: mandatory && !userCanReadAudit(req.user), quarter, posterVersion, posterUrl, acknowledged: !!existing, acknowledgedAt: existing ? existing.acknowledgedAt : null, statementText: 'I have read and understood the TLD safe-use instructions and will follow the correct TLD badge usage procedure.' });
});

app.post('/api/awareness/acknowledge', requireAuth, (req, res) => {
  const quarter = String(req.body.quarter || '').trim() || currentQuarterFromDate();
  const settings = getSettingsObject();
  const posterVersion = String(req.body.posterVersion || settings.awarenessPosterVersion || 'v1').trim();
  const posterUrl = settings.awarenessPosterUrl || '/assets/tld_awareness_hindi.jpg';
  const statementText = String(req.body.statementText || 'I have read and understood the TLD safe-use instructions and will follow the correct TLD badge usage procedure.');
  const ts = nowISO();
  db.prepare(`INSERT OR REPLACE INTO awareness_acknowledgements (id, employeeId, quarter, posterVersion, posterUrl, statementText, acknowledgedAt, signedIp, userAgent, organizationId, hospitalId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('aware'), req.user.id, quarter, posterVersion, posterUrl, statementText, ts, req.ip || '', req.headers['user-agent'] || '', req.user.organizationId || '', req.user.hospitalId || '');
  logAudit(req, 'TLD awareness poster accepted', `${quarter} ${posterVersion}`);
  res.json({ ok: true, acknowledgedAt: ts });
});

app.get('/api/awareness/acknowledgements', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || '').trim() || currentQuarterFromDate();
  res.json({ quarter, rows: awarenessRows(quarter) });
});

app.get('/api/awareness/report.pdf', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || '').trim() || currentQuarterFromDate();
  makeAwarenessStatusPdf(res, awarenessRows(quarter), quarter);
});

// Compliance
app.get('/api/compliance', requireAuth, requireRSO, (req, res) => {
  const quarter = String(req.query.quarter || '').trim();
  if (!quarter) return res.status(400).json({ error: 'Quarter is required' });
  const employees = db.prepare('SELECT * FROM employees WHERE enabled = 1 ORDER BY name COLLATE NOCASE').all();
  const rows = employees.map(emp => {
    const dose = db.prepare('SELECT COUNT(*) AS n FROM doses WHERE employeeId = ? AND quarter = ?').get(emp.id, quarter).n > 0;
    const form = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE docType = 'employeeForm' AND employeeId = ? AND quarter = ?").get(emp.id, quarter).n > 0;
    const ack = db.prepare('SELECT COUNT(*) AS n FROM acknowledgements WHERE employeeId = ? AND quarter = ?').get(emp.id, quarter).n > 0;
    return { employee: publicEmployee(emp), hasDose: dose, hasForm: form, hasAcknowledgement: ack, complete: dose && form && ack };
  });
  res.json({ quarter, rows, complete: rows.filter(r => r.complete).length, pending: rows.filter(r => !r.complete).length });
});

// Reminders
app.get('/api/reminders/preview', requireAuth, requireRSO, (req, res) => {
  const quarter = String(req.query.quarter || '').trim();
  if (!quarter) return res.status(400).json({ error: 'Quarter is required' });
  const rows = buildReminderPreview(quarter);
  res.json({ quarter, reminders: rows });
});

app.get('/api/reminders/logs', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM reminder_logs ORDER BY createdAt DESC LIMIT 300').all();
  res.json({ logs: rows });
});

app.post('/api/reminders/send', requireAuth, requireRSO, async (req, res) => {
  const quarter = String(req.body.quarter || '').trim();
  if (!quarter) return res.status(400).json({ error: 'Quarter is required' });
  const types = Array.isArray(req.body.types) && req.body.types.length ? req.body.types : ['tldReturn', 'missingForm', 'acknowledgement', 'reportUpload'];
  const channels = Array.isArray(req.body.channels) && req.body.channels.length ? req.body.channels : ['email'];
  const allowedTypes = new Set(['tldReturn', 'missingForm', 'acknowledgement', 'reportUpload']);
  const allowedChannels = new Set(['email', 'whatsapp']);
  const filteredTypes = types.filter(t => allowedTypes.has(t));
  const filteredChannels = channels.filter(c => allowedChannels.has(c));
  if (!filteredTypes.length || !filteredChannels.length) return res.status(400).json({ error: 'Select at least one reminder type and channel' });
  const preview = buildReminderPreview(quarter).filter(r => filteredTypes.includes(r.type));
  const sent = [];
  for (const item of preview) {
    const outputs = await logAndSendReminder({ type: item.type, quarter, employee: item.employee, subject: item.subject, message: item.message, channels: filteredChannels });
    sent.push({ type: item.type, employee: item.employee.name, outputs });
  }
  logAudit(req, 'Reminders sent', `${quarter}: ${sent.length} reminder target(s), channels ${filteredChannels.join(', ')}`);
  res.json({ quarter, count: sent.length, sent });
});


// General notifications
app.get('/api/notifications', requireAuth, (req, res) => {
  if (userCanReadAudit(req.user)) {
    const notifications = db.prepare('SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 300').all().map(notificationPublic);
    const recipients = db.prepare('SELECT * FROM notification_recipients ORDER BY createdAt DESC LIMIT 1000').all();
    return res.json({ notifications, recipients });
  }
  const recipientRows = db.prepare(`
    SELECT nr.*, n.subject, n.message, n.audience, n.createdByName, n.createdAt AS notificationCreatedAt
    FROM notification_recipients nr JOIN notifications n ON n.id = nr.notificationId
    WHERE nr.employeeId = ?
    ORDER BY n.createdAt DESC, nr.createdAt DESC
  `).all(req.user.id);
  const seen = new Map();
  recipientRows.forEach(row => {
    const existing = seen.get(row.notificationId) || {
      id: row.notificationId,
      subject: row.subject,
      message: row.message,
      audience: row.audience,
      createdByName: row.createdByName || '',
      createdAt: row.notificationCreatedAt || row.createdAt,
      readAt: row.readAt || '',
      channels: [],
      statuses: []
    };
    if (!existing.channels.includes(row.channel)) existing.channels.push(row.channel);
    existing.statuses.push({ channel: row.channel, status: row.status, destination: row.destination || '' });
    if (!existing.readAt && row.readAt) existing.readAt = row.readAt;
    seen.set(row.notificationId, existing);
  });
  res.json({ notifications: Array.from(seen.values()), recipients: recipientRows });
});

app.post('/api/notifications/preview', requireAuth, requireRSO, (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  if (!subject) return res.status(400).json({ error: 'Notification subject is required' });
  if (!message) return res.status(400).json({ error: 'Notification message is required' });
  const rows = buildNotificationPreview({
    audience: req.body.audience || 'allTldUsers',
    targetEmployeeId: req.body.targetEmployeeId || '',
    subject,
    message,
    channels: req.body.channels || ['portal']
  });
  res.json({ count: rows.length, recipients: rows });
});

app.post('/api/notifications', requireAuth, requireRSO, async (req, res) => {
  try {
    const result = await createAndSendNotification(req, {
      audience: req.body.audience || 'allTldUsers',
      targetEmployeeId: req.body.targetEmployeeId || '',
      subject: req.body.subject || '',
      message: req.body.message || '',
      channels: req.body.channels || ['portal']
    });
    logAudit(req, 'Notification generated', `${result.notification.subject}: ${result.count} recipient-channel record(s)`);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Notification could not be generated' });
  }
});

app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const exists = db.prepare('SELECT id FROM notifications WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Notification not found' });
  const ts = nowISO();
  const info = db.prepare('UPDATE notification_recipients SET readAt = COALESCE(readAt, ?) WHERE notificationId = ? AND employeeId = ?').run(ts, id, req.user.id);
  if (!info.changes && !userCanReadAudit(req.user)) return res.status(403).json({ error: 'Not allowed' });
  logAudit(req, 'Notification marked read', id);
  res.json({ ok: true, readAt: ts });
});

app.delete('/api/notifications/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Notification not found' });
  db.prepare('DELETE FROM notifications WHERE id = ?').run(row.id);
  logAudit(req, 'Notification deleted', row.subject);
  res.json({ ok: true });
});

// Radiation Safety Committee
// Read-only active committee member list for every authenticated user.
// Individual employees only receive members belonging to their own hospital/organization.
app.get('/api/rsc/member-list', requireAuth, (req, res) => {
  const role = String(req.user?.accessRole || '').toLowerCase();
  let sql = 'SELECT * FROM rsc_members WHERE active = 1';
  const params = [];

  if (role !== 'sysadmin') {
    const hospitalId = String(req.user?.hospitalId || '').trim();
    const organizationId = String(req.user?.organizationId || '').trim();
    if (hospitalId) {
      sql += " AND (hospitalId = ? OR (COALESCE(hospitalId, '') = '' AND organizationId = ?))";
      params.push(hospitalId, organizationId);
    } else if (organizationId) {
      sql += ' AND organizationId = ?';
      params.push(organizationId);
    } else {
      sql += " AND 1 = 0";
    }
  }

  sql += ' ORDER BY committeeRole COLLATE NOCASE, name COLLATE NOCASE';
  const rows = db.prepare(sql).all(...params).map(rscMemberPublic);
  res.json({ members: rows });
});

app.get('/api/rsc/members', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM rsc_members ORDER BY active DESC, committeeRole COLLATE NOCASE, name COLLATE NOCASE').all().map(rscMemberPublic);
  res.json({ members: rows });
});

app.post('/api/rsc/members', requireAuth, requireRSO, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Committee member name is required' });
  const id = makeId('rscm');
  const ts = nowISO();
  db.prepare(`INSERT INTO rsc_members (id, name, designation, department, committeeRole, email, phone, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    name,
    String(req.body.designation || '').trim(),
    String(req.body.department || '').trim(),
    String(req.body.committeeRole || '').trim(),
    String(req.body.email || '').trim(),
    String(req.body.phone || '').trim(),
    boolToInt(req.body.active !== false),
    ts,
    ts
  );
  logAudit(req, 'RSC member added', name);
  res.status(201).json({ member: rscMemberPublic(db.prepare('SELECT * FROM rsc_members WHERE id=?').get(id)) });
});

app.put('/api/rsc/members/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_members WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Committee member not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Committee member name is required' });
  db.prepare(`UPDATE rsc_members SET name=?, designation=?, department=?, committeeRole=?, email=?, phone=?, active=?, updatedAt=? WHERE id=?`).run(
    name,
    String(req.body.designation || '').trim(),
    String(req.body.department || '').trim(),
    String(req.body.committeeRole || '').trim(),
    String(req.body.email || '').trim(),
    String(req.body.phone || '').trim(),
    boolToInt(req.body.active !== false),
    nowISO(),
    row.id
  );
  logAudit(req, 'RSC member updated', name);
  res.json({ member: rscMemberPublic(db.prepare('SELECT * FROM rsc_members WHERE id=?').get(row.id)) });
});

app.delete('/api/rsc/members/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_members WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Committee member not found' });
  db.prepare('DELETE FROM rsc_members WHERE id = ?').run(row.id);
  logAudit(req, 'RSC member deleted', row.name);
  res.json({ ok: true });
});

app.get('/api/rsc/meetings', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM rsc_meetings ORDER BY meetingDate DESC, updatedAt DESC').all().map(rscMeetingPublic);
  res.json({ meetings: rows });
});

app.post('/api/rsc/meetings', requireAuth, requireRSO, (req, res) => {
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meetingDate || '').trim();
  if (!title) return res.status(400).json({ error: 'Meeting title is required' });
  if (!meetingDate) return res.status(400).json({ error: 'Meeting date is required' });
  const id = makeId('rscmtg');
  const ts = nowISO();
  db.prepare(`INSERT INTO rsc_meetings (id, meetingDate, title, venue, chairperson, agenda, minutes, decisions, actionItems, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    meetingDate,
    title,
    String(req.body.venue || '').trim(),
    String(req.body.chairperson || '').trim(),
    String(req.body.agenda || '').trim(),
    String(req.body.minutes || '').trim(),
    String(req.body.decisions || '').trim(),
    String(req.body.actionItems || '').trim(),
    String(req.body.status || 'Draft').trim() || 'Draft',
    ts,
    ts
  );
  logAudit(req, 'RSC meeting saved', `${meetingDate}: ${title}`);
  res.status(201).json({ meeting: rscMeetingPublic(db.prepare('SELECT * FROM rsc_meetings WHERE id=?').get(id)) });
});

app.put('/api/rsc/meetings/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_meetings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Committee meeting not found' });
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meetingDate || '').trim();
  if (!title) return res.status(400).json({ error: 'Meeting title is required' });
  if (!meetingDate) return res.status(400).json({ error: 'Meeting date is required' });
  db.prepare(`UPDATE rsc_meetings SET meetingDate=?, title=?, venue=?, chairperson=?, agenda=?, minutes=?, decisions=?, actionItems=?, status=?, updatedAt=? WHERE id=?`).run(
    meetingDate,
    title,
    String(req.body.venue || '').trim(),
    String(req.body.chairperson || '').trim(),
    String(req.body.agenda || '').trim(),
    String(req.body.minutes || '').trim(),
    String(req.body.decisions || '').trim(),
    String(req.body.actionItems || '').trim(),
    String(req.body.status || 'Draft').trim() || 'Draft',
    nowISO(),
    row.id
  );
  logAudit(req, 'RSC meeting updated', `${meetingDate}: ${title}`);
  res.json({ meeting: rscMeetingPublic(db.prepare('SELECT * FROM rsc_meetings WHERE id=?').get(row.id)) });
});

app.delete('/api/rsc/meetings/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_meetings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Committee meeting not found' });
  const docs = db.prepare('SELECT * FROM rsc_documents WHERE meetingId = ?').all(row.id);
  db.prepare('DELETE FROM rsc_documents WHERE meetingId = ?').run(row.id);
  db.prepare('DELETE FROM rsc_meetings WHERE id = ?').run(row.id);
  docs.forEach(doc => fs.unlink(path.join(UPLOAD_DIR, doc.storedName), () => {}));
  logAudit(req, 'RSC meeting deleted', `${row.meetingDate}: ${row.title}`);
  res.json({ ok: true });
});

app.get('/api/rsc/documents', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM rsc_documents ORDER BY createdAt DESC').all().map(rscDocumentPublic);
  res.json({ documents: rows });
});

app.post('/api/rsc/documents', requireAuth, requireRSO, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required' });
  const meetingId = String(req.body.meetingId || '').trim() || null;
  if (meetingId && !db.prepare('SELECT id FROM rsc_meetings WHERE id = ?').get(meetingId)) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Selected meeting not found' });
  }
  const id = makeId('rscdoc');
  db.prepare(`INSERT INTO rsc_documents (id, meetingId, documentType, title, description, originalName, storedName, mimeType, size, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    meetingId,
    String(req.body.documentType || 'Minutes of Meeting').trim(),
    String(req.body.title || req.file.originalname || '').trim(),
    String(req.body.description || '').trim(),
    req.file.originalname,
    req.file.filename,
    req.file.mimetype || 'application/octet-stream',
    req.file.size,
    req.user.name,
    nowISO()
  );
  logAudit(req, 'RSC document uploaded', req.file.originalname);
  res.status(201).json({ document: rscDocumentPublic(db.prepare('SELECT * FROM rsc_documents WHERE id=?').get(id)) });
});

app.get('/api/rsc/documents/:id/download', requireAuth, requireAuditAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_documents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'RSC document not found' });
  const filePath = path.join(UPLOAD_DIR, row.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Stored file missing' });
  const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', row.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${String(row.originalName || 'rsc_document').replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/rsc/documents/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM rsc_documents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'RSC document not found' });
  db.prepare('DELETE FROM rsc_documents WHERE id = ?').run(row.id);
  fs.unlink(path.join(UPLOAD_DIR, row.storedName), () => {});
  logAudit(req, 'RSC document deleted', row.originalName);
  res.json({ ok: true });
});

// Annual statement and investigation workflow
app.get('/api/reports/annual-statement/:employeeId', requireAuth, (req, res) => {
  const employeeId = req.params.employeeId;
  if (!userCanReadAudit(req.user) && req.user.id !== employeeId) return res.status(403).json({ error: 'Not allowed' });
  const employee = getEmployeeById(employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const year = Number(req.query.year || new Date().getFullYear());
  const doses = db.prepare('SELECT * FROM doses WHERE employeeId = ? ORDER BY quarter, period').all(employeeId).filter(d => String(d.quarter || d.period).includes(String(year)));
  const acknowledgements = db.prepare('SELECT * FROM acknowledgements WHERE employeeId = ?').all(employeeId);
  makeAnnualStatementPdf(res, employee, doses, acknowledgements, year);
});

app.get('/api/investigations', requireAuth, requireAuditAccess, (req, res) => {
  const status = String(req.query.status || 'all');
  let rows = investigationRows();
  if (status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ investigations: rows });
});

app.post('/api/investigations', requireAuth, requireRSO, (req, res) => {
  const doseId = String(req.body.doseId || '').trim();
  if (!doseId) return res.status(400).json({ error: 'Dose record is required' });
  const dose = db.prepare('SELECT * FROM doses WHERE id = ?').get(doseId);
  if (!dose) return res.status(404).json({ error: 'Dose record not found' });
  const existing = db.prepare('SELECT * FROM investigations WHERE doseId = ?').get(doseId);
  const ts = nowISO();
  if (existing) {
    db.prepare(`UPDATE investigations SET severity=?, status=?, rsoNote=?, immediateAction=?, updatedAt=? WHERE id=?`).run(
      String(req.body.severity || existing.severity || 'Investigate'),
      String(req.body.status || existing.status || 'Open'),
      String(req.body.rsoNote || existing.rsoNote || ''),
      String(req.body.immediateAction || existing.immediateAction || ''),
      ts,
      existing.id
    );
    logAudit(req, 'Investigation updated', `${dose.quarter} ${dose.tldNumber}`);
    return res.json({ investigation: investigationRows('WHERE i.id = ?', [existing.id])[0] });
  }
  const id = makeId('inv');
  db.prepare(`
    INSERT INTO investigations (id, doseId, employeeId, quarter, period, severity, status, rsoNote, immediateAction, openedBy, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    dose.id,
    dose.employeeId,
    dose.quarter,
    dose.period,
    String(req.body.severity || 'Investigate'),
    String(req.body.status || 'Open'),
    String(req.body.rsoNote || ''),
    String(req.body.immediateAction || ''),
    req.user.name,
    ts,
    ts
  );
  logAudit(req, 'Investigation opened', `${dose.quarter} ${dose.tldNumber}`);
  res.status(201).json({ investigation: investigationRows('WHERE i.id = ?', [id])[0] });
});

app.put('/api/investigations/:id', requireAuth, requireRSO, (req, res) => {
  const existing = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Investigation not found' });
  const status = String(req.body.status || existing.status || 'Open');
  const closedAt = status === 'Closed' ? (existing.closedAt || nowISO()) : null;
  db.prepare(`
    UPDATE investigations
    SET severity=?, status=?, rsoNote=?, rootCause=?, immediateAction=?, correctiveAction=?, closureStatus=?, rsoSignerName=?, rsoSignatureData=?, closedAt=?, updatedAt=?
    WHERE id=?
  `).run(
    String(req.body.severity || existing.severity || 'Investigate'),
    status,
    String(req.body.rsoNote || ''),
    String(req.body.rootCause || ''),
    String(req.body.immediateAction || ''),
    String(req.body.correctiveAction || ''),
    String(req.body.closureStatus || ''),
    String(req.body.rsoSignerName || ''),
    String(req.body.rsoSignatureData || ''),
    closedAt,
    nowISO(),
    existing.id
  );
  logAudit(req, 'Investigation saved', `${existing.quarter}: ${status}`);
  res.json({ investigation: investigationRows('WHERE i.id = ?', [existing.id])[0] });
});

app.get('/api/investigations/:id/pdf', requireAuth, requireAuditAccess, (req, res) => {
  const inv = investigationRows('WHERE i.id = ?', [req.params.id])[0];
  if (!inv) return res.status(404).json({ error: 'Investigation not found' });
  makeInvestigationPdf(res, inv);
});

app.get('/api/overexposure-cases', requireAuth, requireAuditAccess, (req, res) => {
  const status = String(req.query.status || 'all');
  let rows = overexposureCaseRows();
  if (status !== 'all') rows = rows.filter(r => r.status === status);
  res.json({ cases: rows });
});

app.post('/api/overexposure-cases', requireAuth, requireRSO, (req, res) => {
  const employeeId = String(req.body.employeeId || '').trim();
  const employee = getEmployeeById(employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee is required for overexposure case' });
  const doseId = String(req.body.doseId || '').trim();
  let dose = null;
  if (doseId) {
    dose = db.prepare('SELECT * FROM doses WHERE id = ?').get(doseId);
    if (!dose) return res.status(404).json({ error: 'Linked dose record not found' });
  }
  const status = String(req.body.status || 'Open');
  const closedAt = status === 'Closed' ? nowISO() : null;
  const id = makeId('case');
  const ts = nowISO();
  db.prepare(`
    INSERT INTO overexposure_cases (
      id, employeeId, doseId, incidentDate, incidentType, doseReportQuarter, receivedDose, doseUnit, doseType,
      severity, status, reportReference, incidentSummary, suspectedCause, immediateAction, medicalReview,
      actionTaken, correctiveAction, preventiveAction, regulatoryReportRequired, reportedTo, regulatoryReportDate,
      rscReviewDate, closureNote, closedBy, rsoSignerName, rsoSignatureData, employeeSignerName,
      employeeAcknowledgementText, employeeSignatureData, employeeSignedAt, openedBy, organizationId, hospitalId,
      createdAt, updatedAt, closedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    employee.id,
    dose ? dose.id : null,
    String(req.body.incidentDate || '').trim(),
    String(req.body.incidentType || 'Suspected overexposure').trim(),
    String(req.body.doseReportQuarter || dose?.quarter || '').trim(),
    Number(req.body.receivedDose || dose?.hp10 || 0),
    String(req.body.doseUnit || 'mSv').trim(),
    String(req.body.doseType || 'Hp(10)').trim(),
    String(req.body.severity || 'Investigate').trim(),
    status,
    String(req.body.reportReference || '').trim(),
    String(req.body.incidentSummary || '').trim(),
    String(req.body.suspectedCause || '').trim(),
    String(req.body.immediateAction || '').trim(),
    String(req.body.medicalReview || '').trim(),
    String(req.body.actionTaken || '').trim(),
    String(req.body.correctiveAction || '').trim(),
    String(req.body.preventiveAction || '').trim(),
    boolToInt(req.body.regulatoryReportRequired),
    String(req.body.reportedTo || '').trim(),
    String(req.body.regulatoryReportDate || '').trim(),
    String(req.body.rscReviewDate || '').trim(),
    String(req.body.closureNote || '').trim(),
    String(req.body.closedBy || (status === 'Closed' ? req.user.name : '')).trim(),
    String(req.body.rsoSignerName || '').trim(),
    String(req.body.rsoSignatureData || ''),
    String(req.body.employeeSignerName || '').trim(),
    String(req.body.employeeAcknowledgementText || '').trim(),
    String(req.body.employeeSignatureData || ''),
    req.body.employeeSignatureData ? nowISO() : null,
    req.user.name,
    employee.organizationId || req.user.organizationId || '',
    employee.hospitalId || req.user.hospitalId || '',
    ts,
    ts,
    closedAt
  );
  logAudit(req, 'Overexposure case opened', `${employee.name}: ${req.body.doseReportQuarter || dose?.quarter || ''} ${Number(req.body.receivedDose || dose?.hp10 || 0)} ${req.body.doseUnit || 'mSv'}`);
  res.status(201).json({ case: overexposureCaseRows('WHERE c.id = ?', [id])[0] });
});

app.put('/api/overexposure-cases/:id', requireAuth, requireRSO, (req, res) => {
  const existing = db.prepare('SELECT * FROM overexposure_cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Overexposure case not found' });
  const employeeId = String(req.body.employeeId || existing.employeeId || '').trim();
  const employee = getEmployeeById(employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const doseId = String(req.body.doseId || '').trim();
  let dose = null;
  if (doseId) {
    dose = db.prepare('SELECT * FROM doses WHERE id = ?').get(doseId);
    if (!dose) return res.status(404).json({ error: 'Linked dose record not found' });
  }
  const status = String(req.body.status || existing.status || 'Open');
  const closedAt = status === 'Closed' ? (existing.closedAt || nowISO()) : null;
  db.prepare(`
    UPDATE overexposure_cases
    SET employeeId=?, doseId=?, incidentDate=?, incidentType=?, doseReportQuarter=?, receivedDose=?, doseUnit=?, doseType=?,
      severity=?, status=?, reportReference=?, incidentSummary=?, suspectedCause=?, immediateAction=?, medicalReview=?,
      actionTaken=?, correctiveAction=?, preventiveAction=?, regulatoryReportRequired=?, reportedTo=?, regulatoryReportDate=?,
      rscReviewDate=?, closureNote=?, closedBy=?, rsoSignerName=?, rsoSignatureData=?, employeeSignerName=?,
      employeeAcknowledgementText=?, employeeSignatureData=?, employeeSignedAt=?, organizationId=?, hospitalId=?,
      updatedAt=?, closedAt=?
    WHERE id=?
  `).run(
    employee.id,
    dose ? dose.id : null,
    String(req.body.incidentDate || '').trim(),
    String(req.body.incidentType || 'Suspected overexposure').trim(),
    String(req.body.doseReportQuarter || dose?.quarter || '').trim(),
    Number(req.body.receivedDose || dose?.hp10 || 0),
    String(req.body.doseUnit || 'mSv').trim(),
    String(req.body.doseType || 'Hp(10)').trim(),
    String(req.body.severity || 'Investigate').trim(),
    status,
    String(req.body.reportReference || '').trim(),
    String(req.body.incidentSummary || '').trim(),
    String(req.body.suspectedCause || '').trim(),
    String(req.body.immediateAction || '').trim(),
    String(req.body.medicalReview || '').trim(),
    String(req.body.actionTaken || '').trim(),
    String(req.body.correctiveAction || '').trim(),
    String(req.body.preventiveAction || '').trim(),
    boolToInt(req.body.regulatoryReportRequired),
    String(req.body.reportedTo || '').trim(),
    String(req.body.regulatoryReportDate || '').trim(),
    String(req.body.rscReviewDate || '').trim(),
    String(req.body.closureNote || '').trim(),
    String(req.body.closedBy || (status === 'Closed' ? req.user.name : '')).trim(),
    String(req.body.rsoSignerName || '').trim(),
    String(req.body.rsoSignatureData || ''),
    String(req.body.employeeSignerName || '').trim(),
    String(req.body.employeeAcknowledgementText || '').trim(),
    String(req.body.employeeSignatureData || ''),
    req.body.employeeSignatureData ? (existing.employeeSignedAt || nowISO()) : null,
    employee.organizationId || req.user.organizationId || '',
    employee.hospitalId || req.user.hospitalId || '',
    nowISO(),
    closedAt,
    existing.id
  );
  logAudit(req, 'Overexposure case saved', `${employee.name}: ${status}`);
  res.json({ case: overexposureCaseRows('WHERE c.id = ?', [existing.id])[0] });
});

app.delete('/api/overexposure-cases/:id', requireAuth, requireRSO, (req, res) => {
  const row = db.prepare('SELECT * FROM overexposure_cases WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Overexposure case not found' });
  db.prepare('DELETE FROM overexposure_cases WHERE id = ?').run(row.id);
  logAudit(req, 'Overexposure case deleted', row.id);
  res.json({ ok: true });
});

app.get('/api/overexposure-cases/:id/pdf', requireAuth, requireAuditAccess, (req, res) => {
  const row = overexposureCaseRows('WHERE c.id = ?', [req.params.id])[0];
  if (!row) return res.status(404).json({ error: 'Overexposure case not found' });
  makeOverexposureCasePdf(res, row);
});

// Settings and audit

// Radiation safety training module
app.get('/api/training/module', requireAuth, (req, res) => {
  const quarter = String(req.query.quarter || currentQuarterFromDate()).trim();
  const quiz = getActiveTrainingQuiz(quarter);
  const attempts = db.prepare('SELECT * FROM training_attempts WHERE employeeId=? ORDER BY submittedAt DESC').all(req.user.id);
  res.json({
    module: {
      title: 'Radiation Safety Training Module: Diagnostic Radiology',
      sourceDoc: TRAINING_SOURCE_DOC,
      sourceName: 'Training for X-ray Technologist',
      questionBankSize: TRAINING_QUESTION_BANK.length,
      defaultQuestionCount: 10
    },
    quarter,
    activeQuiz: quiz ? { id: quiz.id, title: quiz.title, quarter: quiz.quarter, questionCount: quiz.questionCount, createdAt: quiz.createdAt } : null,
    attempts
  });
});

app.post('/api/training/generate', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.body.quarter || currentQuarterFromDate()).trim();
  const count = Math.max(1, Math.min(20, Number(req.body.questionCount || 10)));
  const quiz = createTrainingQuiz(req, quarter, count);
  logAudit(req, 'Training questionnaire generated', `${quarter}: ${count} questions from radiation safety module`);
  res.json({ quiz });
});

app.get('/api/training/questions', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || currentQuarterFromDate()).trim();
  const quiz = getActiveTrainingQuiz(quarter);
  if (!quiz) return res.json({ quiz: null, questions: [] });
  const questions = db.prepare('SELECT * FROM training_questions WHERE quizId=? ORDER BY sortOrder').all(quiz.id).map(q => trainingQuestionPublic(q, true));
  res.json({ quiz: { id: quiz.id, title: quiz.title, quarter: quiz.quarter, questionCount: quiz.questionCount, sourceDoc: quiz.sourceDoc, createdAt: quiz.createdAt }, questions });
});

app.get('/api/training/quiz', requireAuth, (req, res) => {
  const quarter = String(req.query.quarter || currentQuarterFromDate()).trim();
  const includeAnswer = userCanReadAudit(req.user) && req.query.answerKey === '1';
  const quiz = getActiveTrainingQuiz(quarter);
  const questions = db.prepare('SELECT * FROM training_questions WHERE quizId=? ORDER BY sortOrder').all(quiz.id).map(q => trainingQuestionPublic(q, includeAnswer));
  const attempt = db.prepare('SELECT * FROM training_attempts WHERE employeeId=? AND quizId=? ORDER BY submittedAt DESC LIMIT 1').get(req.user.id, quiz.id);
  res.json({ quiz: { id: quiz.id, title: quiz.title, quarter: quiz.quarter, questionCount: quiz.questionCount, sourceDoc: quiz.sourceDoc, createdAt: quiz.createdAt }, questions, attempt });
});

app.post('/api/training/submit', requireAuth, (req, res) => {
  if (userCanReadAudit(req.user)) return res.status(400).json({ error: 'Training test submission is for employee login only.' });
  const quizId = String(req.body.quizId || '').trim();
  const quiz = db.prepare('SELECT * FROM training_quizzes WHERE id=?').get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Training quiz not found' });
  const questions = db.prepare('SELECT * FROM training_questions WHERE quizId=? ORDER BY sortOrder').all(quiz.id);
  if (!questions.length) return res.status(400).json({ error: 'Quiz has no questions' });
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const answerMap = new Map(answers.map(a => [String(a.questionId || ''), String(a.selectedOption || '').toUpperCase()]));
  let score = 0;
  const checked = questions.map(q => {
    const selected = answerMap.get(q.id) || '';
    const correct = selected === q.correctOption;
    if (correct) score += 1;
    return { questionId: q.id, selectedOption: selected, correctOption: q.correctOption, correct, questionText: q.questionText, explanation: q.explanation, sourcePage: q.sourcePage };
  });
  const total = questions.length;
  const percentage = total ? Math.round((score / total) * 10000) / 100 : 0;
  const emp = getEmployeeById(req.user.id) || req.user;
  const id = makeId('trnattempt');
  db.prepare('INSERT INTO training_attempts (id, quizId, employeeId, quarter, score, totalQuestions, percentage, answersJson, startedAt, submittedAt, organizationId, hospitalId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, quiz.id, req.user.id, quiz.quarter, score, total, percentage, JSON.stringify(checked), String(req.body.startedAt || ''), nowISO(), emp.organizationId || '', emp.hospitalId || '');
  logAudit(req, 'Radiation safety training submitted', `${quiz.quarter}: ${score}/${total}`);
  res.json({ attempt: { id, quizId: quiz.id, quarter: quiz.quarter, score, totalQuestions: total, percentage, answers: checked } });
});

app.get('/api/training/results', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || 'all').trim();
  const rows = trainingResultRows(req, quarter);
  res.json({ results: rows });
});

app.get('/api/training/results.pdf', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || 'all').trim();
  const rows = trainingResultRows(req, quarter);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="radiation_safety_training_scores_${String(quarter || 'all').replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  doc.pipe(res);
  doc.fontSize(15).font('Helvetica-Bold').text('Radiation Safety Training Score Report', { align: 'center' });
  doc.moveDown(0.3).fontSize(9).font('Helvetica').text(`Quarter: ${quarter || 'All'}   |   Generated: ${new Date().toLocaleString()}   |   Total Attempts: ${rows.length}`, { align: 'center' });
  doc.moveDown(0.8);
  const widths = [130, 80, 80, 100, 70, 70, 80, 100];
  const headers = ['Employee', 'TLD No.', 'Department', 'Hospital', 'Quarter', 'Score', 'Percent', 'Submitted'];
  let y = doc.y;
  const x0 = 36;
  const row = (vals, bold=false) => {
    let x = x0;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    vals.forEach((v, i) => { doc.text(String(v || ''), x, y, { width: widths[i] }); x += widths[i]; });
    y += 22;
    if (y > 540) { doc.addPage(); y = 36; }
  };
  row(headers, true);
  rows.forEach(r => row([r.employeeName, r.tldNumber || '-', r.employeeDept || '-', r.hospitalName || '-', r.quarter, `${r.score}/${r.totalQuestions}`, `${Number(r.percentage || 0).toFixed(1)}%`, r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '-']));
  doc.moveDown().fontSize(8).font('Helvetica').text('Questionnaire is based on the uploaded Radiation Safety Training Module for X-ray Technologist. Each question carries 1 mark.', 36, 560, { align: 'center' });
  doc.end();
});


function ensureDepartmentsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    organizationId TEXT DEFAULT '',
    hospitalId TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_departments_hospital ON departments(hospitalId);
  CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organizationId);`);
}

function departmentScopeForRequest(req, requestedHospitalId = '') {
  const role = accessRoleFor(req.user);
  let hospitalId = String(requestedHospitalId || '').trim();
  let organizationId = req.user.organizationId || '';
  if (role === 'sysadmin') {
    if (!hospitalId) hospitalId = req.user.hospitalId || '';
    if (hospitalId) {
      const h = db.prepare('SELECT organizationId FROM hospitals WHERE id=?').get(hospitalId);
      if (h) organizationId = h.organizationId || organizationId;
    }
  } else if (role === 'org_admin') {
    if (!hospitalId) hospitalId = req.user.hospitalId || '';
    if (hospitalId) {
      const h = db.prepare('SELECT organizationId FROM hospitals WHERE id=?').get(hospitalId);
      if (!h || h.organizationId !== req.user.organizationId) return { error: 'Hospital is outside your organization' };
    }
    organizationId = req.user.organizationId || '';
  } else {
    hospitalId = req.user.hospitalId || '';
    organizationId = req.user.organizationId || '';
  }
  if (!hospitalId) return { error: 'Hospital is required for department management' };
  return { organizationId, hospitalId };
}

app.get('/api/departments', requireAuth, requireRSO, (req, res) => {
  ensureDepartmentsTable();
  const scope = departmentScopeForRequest(req, req.query.hospitalId);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const rows = db.prepare('SELECT * FROM departments WHERE hospitalId=? ORDER BY active DESC, name COLLATE NOCASE').all(scope.hospitalId);
  res.json({ departments: rows.map(r => ({ ...r, active: !!r.active })) });
});

app.post('/api/departments', requireAuth, requireRSO, (req, res) => {
  ensureDepartmentsTable();
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  const scope = departmentScopeForRequest(req, req.body.hospitalId);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const existing = db.prepare('SELECT * FROM departments WHERE hospitalId=? AND LOWER(TRIM(name))=LOWER(TRIM(?))').get(scope.hospitalId, name);
  if (existing) {
    if (!existing.active) db.prepare('UPDATE departments SET active=1, updatedAt=? WHERE id=?').run(nowISO(), existing.id);
    const row = db.prepare('SELECT * FROM departments WHERE id=?').get(existing.id);
    return res.json({ department: { ...row, active: !!row.active }, existing: true });
  }
  const ts = nowISO();
  const id = makeId('dept');
  db.prepare('INSERT INTO departments (id, organizationId, hospitalId, name, active, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
    .run(id, scope.organizationId, scope.hospitalId, name, req.user.id || '', ts, ts);
  const row = db.prepare('SELECT * FROM departments WHERE id=?').get(id);
  logAudit(req, 'Department created', `${name} · ${scope.hospitalId}`);
  res.status(201).json({ department: { ...row, active: !!row.active } });
});

app.put('/api/departments/:id', requireAuth, requireRSO, (req, res) => {
  ensureDepartmentsTable();
  const current = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Department not found' });
  const scope = departmentScopeForRequest(req, current.hospitalId);
  if (scope.error) return res.status(403).json({ error: scope.error });
  const name = String(req.body.name || current.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  const duplicate = db.prepare('SELECT id FROM departments WHERE hospitalId=? AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND id<>?').get(current.hospitalId, name, current.id);
  if (duplicate) return res.status(409).json({ error: 'A department with this name already exists' });
  const active = req.body.active === undefined ? !!current.active : !!req.body.active;
  db.prepare('UPDATE departments SET name=?, active=?, updatedAt=? WHERE id=?').run(name, active ? 1 : 0, nowISO(), current.id);
  const row = db.prepare('SELECT * FROM departments WHERE id=?').get(current.id);
  logAudit(req, 'Department updated', name);
  res.json({ department: { ...row, active: !!row.active } });
});

app.delete('/api/departments/:id', requireAuth, requireRSO, (req, res) => {
  ensureDepartmentsTable();
  const current = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Department not found' });
  const scope = departmentScopeForRequest(req, current.hospitalId);
  if (scope.error) return res.status(403).json({ error: scope.error });
  const used = db.prepare('SELECT COUNT(*) AS count FROM employees WHERE hospitalId=? AND LOWER(TRIM(dept))=LOWER(TRIM(?))').get(current.hospitalId, current.name);
  if (Number(used?.count || 0) > 0) return res.status(409).json({ error: `Department is assigned to ${used.count} employee(s). Deactivate it instead of deleting.` });
  db.prepare('DELETE FROM departments WHERE id=?').run(current.id);
  logAudit(req, 'Department deleted', current.name);
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (_req, res) => res.json({ settings: getSettingsObject() }));

app.put('/api/settings', requireAuth, requireRSO, (req, res) => {
  const entries = {
    deptName: String(req.body.deptName || ''),
    rsoNotes: String(req.body.rsoNotes || ''),
    annualLimit: String(req.body.annualLimit || '20'),
    doseAlertEnabled: String(req.body.doseAlertEnabled !== false),
    doseAlertLimit: String(req.body.doseAlertLimit || '0'),
    doseAlertChannels: JSON.stringify(sanitizeNotificationChannels(req.body.doseAlertChannels || 'portal')),
    dosePortalVisibility: ['all', 'aboveLimitOnly'].includes(String(req.body.dosePortalVisibility || 'all')) ? String(req.body.dosePortalVisibility || 'all') : 'all',
    awarenessMandatory: String(req.body.awarenessMandatory !== false),
    awarenessFrequency: 'quarterly',
    awarenessPosterVersion: String(req.body.awarenessPosterVersion || 'v1'),
    awarenessPosterUrl: '/assets/tld_awareness_hindi.jpg'
  };
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    Object.entries(entries).forEach(([key, value]) => upsert.run(key, value));
  });
  tx();
  logAudit(req, 'Settings saved', entries.deptName);
  res.json({ settings: getSettingsObject() });
});

app.get('/api/audit', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all();
  res.json({ logs: rows });
});

app.get('/api/audit/export.csv', requireAuth, requireAuditAccess, (_req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC').all();
  sendCsv(res, `radpro_tld_audit_log_${new Date().toISOString().slice(0, 10)}.csv`, ['id', 'actorName', 'action', 'details', 'createdAt'], rows);
});

app.get('/api/aerb/audit-pack', requireAuth, requireAuditAccess, (req, res) => {
  const quarter = String(req.query.quarter || 'all');
  const year = String(req.query.year || 'all');
  const qFilter = quarter !== 'all';
  const yFilter = year !== 'all';
  const matchesPeriod = (value) => (!qFilter || String(value || '') === quarter) && (!yFilter || String(value || '').includes(year));

  const employees = rowsFromTable('employees').map(publicEmployee);
  const doses = doseRowsWithEmployees().filter(d => matchesPeriod(d.quarter || d.period));
  const attachments = rowsFromTable('attachments').filter(a => matchesPeriod(a.quarter || a.periodLabel));
  const acknowledgements = ackRowsWithEmployees().filter(a => matchesPeriod(a.quarter || a.period));
  const awarenessAcknowledgements = rowsFromTable('awareness_acknowledgements').filter(a => matchesPeriod(a.quarter));
  const investigations = investigationRows().filter(i => matchesPeriod(i.quarter || i.period));
  const overexposureCases = overexposureCaseRows().filter(c => matchesPeriod(c.doseReportQuarter || c.linkedDoseQuarter || c.incidentDate));
  const auditRows = rowsFromTable('audit_logs');
  const notifications = rowsFromTable('notifications');
  const notificationRecipients = rowsFromTable('notification_recipients');
  const rscMembers = rowsFromTable('rsc_members');
  const rscMeetings = rowsFromTable('rsc_meetings').filter(m => !yFilter || String(m.meetingDate || '').includes(year));
  const rscMeetingIds = new Set(rscMeetings.map(m => m.id));
  const rscDocuments = rowsFromTable('rsc_documents').filter(d => !yFilter || !d.meetingId || rscMeetingIds.has(d.meetingId));

  logAudit(req, 'AERB audit pack exported', `${quarter} / ${year}: ${employees.length} employees, ${doses.length} dose records, ${rscMeetings.length} RSC meeting(s)`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="radpro_tld_aerb_audit_pack_${quarter.replace(/[^a-z0-9]+/gi, '_')}_${year}_${new Date().toISOString().slice(0, 10)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  });
  archive.pipe(res);

  archive.append(JSON.stringify({ generatedAt: nowISO(), quarter, year, counts: { employees: employees.length, doses: doses.length, attachments: attachments.length, acknowledgements: acknowledgements.length, awarenessAcknowledgements: awarenessAcknowledgements.length, investigations: investigations.length, overexposureCases: overexposureCases.length, notifications: notifications.length, rscMembers: rscMembers.length, rscMeetings: rscMeetings.length, rscDocuments: rscDocuments.length } }, null, 2), { name: '00_audit_pack_summary.json' });
  archive.append(rowsToCsv(['id', 'name', 'dept', 'role', 'tldNumber', 'email', 'phone', 'enabled', 'accessRole'], employees), { name: '01_employee_master.csv' });
  archive.append(rowsToCsv(['employeeName', 'employeeDept', 'employeeRole', 'tldNumber', 'quarter', 'period', 'hp10', 'hp007', 'remarks', 'createdAt'], doses), { name: '02_dose_history.csv' });
  archive.append(rowsToCsv(['employeeName', 'quarter', 'period', 'acknowledgedAt', 'signerName', 'signedIp', 'statementText'], acknowledgements), { name: '03_acknowledgements.csv' });
  archive.append(rowsToCsv(['employeeId', 'quarter', 'posterVersion', 'posterUrl', 'statementText', 'acknowledgedAt', 'signedIp'], awarenessAcknowledgements), { name: '03b_awareness_poster_acceptance.csv' });
  archive.append(rowsToCsv(['employeeName', 'quarter', 'period', 'severity', 'status', 'rsoNote', 'rootCause', 'immediateAction', 'correctiveAction', 'closureStatus', 'rsoSignerName', 'createdAt', 'updatedAt', 'closedAt'], investigations), { name: '04_investigations.csv' });
  archive.append(rowsToCsv(['employeeName', 'employeeDept', 'employeeRole', 'tldNumber', 'incidentDate', 'incidentType', 'doseReportQuarter', 'receivedDose', 'doseUnit', 'doseType', 'severity', 'status', 'reportReference', 'incidentSummary', 'suspectedCause', 'immediateAction', 'medicalReview', 'actionTaken', 'correctiveAction', 'preventiveAction', 'regulatoryReportRequired', 'reportedTo', 'regulatoryReportDate', 'rscReviewDate', 'employeeSignerName', 'employeeAcknowledgementText', 'employeeSignedAt', 'closureNote', 'closedBy', 'rsoSignerName', 'createdAt', 'updatedAt', 'closedAt'], overexposureCases), { name: '05_accidental_overexposure_cases.csv' });
  archive.append(rowsToCsv(['docType', 'employeeId', 'quarter', 'periodLabel', 'documentStatus', 'description', 'originalName', 'size', 'publishToEmployees', 'uploadedBy', 'createdAt'], attachments), { name: '06_attachment_index.csv' });
  archive.append(rowsToCsv(['id', 'subject', 'audience', 'targetEmployeeId', 'channels', 'createdByName', 'createdAt'], notifications), { name: '07_notifications.csv' });
  archive.append(rowsToCsv(['notificationId', 'employeeName', 'channel', 'destination', 'status', 'providerResponse', 'readAt', 'createdAt', 'sentAt'], notificationRecipients), { name: '08_notification_recipients.csv' });
  archive.append(rowsToCsv(['id', 'name', 'designation', 'department', 'committeeRole', 'email', 'phone', 'active', 'createdAt', 'updatedAt'], rscMembers), { name: '09_radiation_safety_committee_members.csv' });
  archive.append(rowsToCsv(['id', 'meetingDate', 'title', 'venue', 'chairperson', 'agenda', 'minutes', 'decisions', 'actionItems', 'status', 'createdAt', 'updatedAt'], rscMeetings), { name: '10_rsc_minutes_of_meeting.csv' });
  archive.append(rowsToCsv(['id', 'meetingId', 'documentType', 'title', 'description', 'originalName', 'size', 'uploadedBy', 'createdAt'], rscDocuments), { name: '11_rsc_document_index.csv' });
  archive.append(rowsToCsv(['id', 'actorName', 'action', 'details', 'createdAt'], auditRows), { name: '12_audit_log.csv' });
  attachments.forEach((att, index) => {
    const filePath = path.join(UPLOAD_DIR, att.storedName);
    if (fs.existsSync(filePath)) {
      const safeName = String(att.originalName || `attachment_${index}`).replace(/[^a-z0-9._-]+/gi, '_');
      const folder = att.docType === 'quarterReport' ? 'attachments/quarter_reports' : (att.docType === 'employeeForm' ? 'attachments/employee_forms' : 'attachments/general');
      archive.file(filePath, { name: `${folder}/${index + 1}_${safeName}` });
    }
  });
  rscDocuments.forEach((doc, index) => {
    const filePath = path.join(UPLOAD_DIR, doc.storedName);
    if (fs.existsSync(filePath)) {
      const safeName = String(doc.originalName || `rsc_document_${index}`).replace(/[^a-z0-9._-]+/gi, '_');
      archive.file(filePath, { name: `radiation_safety_committee/documents/${index + 1}_${safeName}` });
    }
  });
  archive.finalize();
});

// Backup / restore
app.get('/api/backup/export', requireAuth, requireRSO, (req, res) => {
  const data = {
    version: 'deployable-2.1-notifications-rsc',
    exportedAt: nowISO(),
    organizations: rowsFromTable('organizations'),
    hospitals: rowsFromTable('hospitals'),
    employees: rowsFromTable('employees'),
    doses: rowsFromTable('doses'),
    attachments: rowsFromTable('attachments').map(row => {
      const filePath = path.join(UPLOAD_DIR, row.storedName);
      let dataUrl = null;
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        dataUrl = `data:${row.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
      }
      return { ...row, dataUrl };
    }),
    acknowledgements: rowsFromTable('acknowledgements'),
    awarenessAcknowledgements: rowsFromTable('awareness_acknowledgements'),
    investigations: rowsFromTable('investigations'),
    overexposureCases: rowsFromTable('overexposure_cases'),
    reminderLogs: rowsFromTable('reminder_logs'),
    notifications: rowsFromTable('notifications'),
    notificationRecipients: rowsFromTable('notification_recipients'),
    rscMembers: rowsFromTable('rsc_members'),
    rscMeetings: rowsFromTable('rsc_meetings'),
    rscDocuments: rowsFromTable('rsc_documents').map(row => {
      const filePath = path.join(UPLOAD_DIR, row.storedName);
      let dataUrl = null;
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        dataUrl = `data:${row.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
      }
      return { ...row, dataUrl };
    }),
    settings: getSettingsObject(),
    auditLog: rowsFromTable('audit_logs')
  };
  let payload = data;
  let encrypted = false;
  if (req.query.encrypted === '1') {
    const password = String(req.query.password || req.headers['x-backup-password'] || '');
    if (!password || password.length < 8) return res.status(400).json({ error: 'Backup encryption password must be at least 8 characters' });
    payload = encryptPayload(data, password);
    encrypted = true;
  }
  logAudit(req, encrypted ? 'Encrypted backup exported' : 'Backup exported', `${data.employees.length} employees, ${data.attachments.length} attachments`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="radpro_tld_backup_${encrypted ? 'encrypted_' : ''}${new Date().toISOString().slice(0, 10)}.json"`);
  res.end(JSON.stringify(payload, null, 2));
});

app.post('/api/backup/import', requireAuth, requireRSO, (req, res) => {
  let data = req.body;
  try {
    if (data && data.encrypted) data = decryptPayload(data, String(req.body.password || req.query.password || ''));
  } catch (err) {
    return res.status(400).json({ error: `Could not decrypt backup: ${err.message}` });
  }
  if (!data || !Array.isArray(data.employees) || !Array.isArray(data.doses)) {
    return res.status(400).json({ error: 'Backup JSON must include employees and doses arrays' });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM notification_recipients').run();
    db.prepare('DELETE FROM notifications').run();
    db.prepare('DELETE FROM rsc_documents').run();
    db.prepare('DELETE FROM rsc_meetings').run();
    db.prepare('DELETE FROM rsc_members').run();
    db.prepare('DELETE FROM reminder_logs').run();
    db.prepare('DELETE FROM overexposure_cases').run();
    db.prepare('DELETE FROM investigations').run();
    db.prepare('DELETE FROM awareness_acknowledgements').run();
    db.prepare('DELETE FROM acknowledgements').run();
    db.prepare('DELETE FROM doses').run();
    db.prepare('DELETE FROM attachments').run();
    db.prepare('DELETE FROM employees').run();
    db.prepare('DELETE FROM hospitals').run();
    db.prepare('DELETE FROM organizations').run();
    db.prepare('DELETE FROM settings').run();

    if (Array.isArray(data.organizations)) {
      const insertOrg = db.prepare(`INSERT OR REPLACE INTO organizations (id, name, code, address, contactPerson, email, phone, packageName, licenseStatus, trialStartDate, trialEndDate, registrationDate, renewalDueDate, billingAmount, billingCycle, maxHospitals, maxTldUsers, billingNotes, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.organizations.forEach(o => insertOrg.run(o.id || makeId('org'), o.name || 'Organization', o.code || makeId('ORG').toUpperCase(), o.address || '', o.contactPerson || '', o.email || '', o.phone || '', o.packageName || 'Trial', o.licenseStatus || 'Trial', o.trialStartDate || '', o.trialEndDate || '', o.registrationDate || '', o.renewalDueDate || '', o.billingAmount || '', o.billingCycle || 'Trial', Number(o.maxHospitals || 1), Number(o.maxTldUsers || 100), o.billingNotes || '', boolToInt(o.active !== false), o.createdAt || nowISO(), o.updatedAt || nowISO()));
    }
    if (Array.isArray(data.hospitals)) {
      const insertHosp = db.prepare(`INSERT OR REPLACE INTO hospitals (id, organizationId, name, code, city, state, address, email, phone, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.hospitals.forEach(h => insertHosp.run(h.id || makeId('hosp'), h.organizationId || 'org_default', h.name || 'Hospital / Institute', h.code || makeId('HOSP').toUpperCase(), h.city || '', h.state || '', h.address || '', h.email || '', h.phone || '', boolToInt(h.active !== false), h.createdAt || nowISO(), h.updatedAt || nowISO()));
    }

    const insertEmployee = db.prepare(`
      INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    data.employees.forEach(emp => {
      const passwordHash = emp.passwordHash || bcrypt.hashSync(emp.password || 'ChangeMe123!', 10);
      const accessRole = ['sysadmin', 'org_admin', 'admin', 'rso', 'auditor', 'employee'].includes(String(emp.accessRole || '').toLowerCase()) ? String(emp.accessRole).toLowerCase() : (emp.isRSO ? 'rso' : 'employee');
      insertEmployee.run(
        emp.id || makeId('emp'),
        emp.name || 'Unnamed Employee',
        emp.dept || '',
        emp.role || 'Other',
        emp.tldNumber || '',
        emp.email || '',
        emp.phone || '',
        accessRole,
        boolToInt(emp.twoFactorEnabled),
        emp.username || `user_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        passwordHash,
        boolToInt(emp.enabled !== false),
        boolToInt(emp.isRSO || accessRole === 'admin' || accessRole === 'rso'),
        emp.organizationId || '',
        emp.hospitalId || '',
        emp.createdAt || nowISO(),
        emp.updatedAt || nowISO()
      );
    });

    const insertDose = db.prepare(`
      INSERT OR REPLACE INTO doses (id, employeeId, tldNumber, period, quarter, hp10, hp007, remarks, reportLabel, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    data.doses.forEach(dose => {
      insertDose.run(
        dose.id || makeId('dose'),
        dose.employeeId,
        dose.tldNumber || '',
        dose.period || 'Not specified',
        dose.quarter || dose.reportLabel || dose.period || 'Not specified',
        Number(dose.hp10 || 0),
        Number(dose.hp007 || 0),
        dose.remarks || '',
        dose.reportLabel || dose.period || '',
        dose.createdAt || nowISO(),
        dose.updatedAt || nowISO()
      );
    });

    const settings = data.settings || {};
    const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    Object.entries(settings).forEach(([key, value]) => upsertSetting.run(key, String(value || '')));

    const awarenessList = Array.isArray(data.awarenessAcknowledgements) ? data.awarenessAcknowledgements : [];
    const insertAware = db.prepare('INSERT OR REPLACE INTO awareness_acknowledgements (id, employeeId, quarter, posterVersion, posterUrl, statementText, acknowledgedAt, signedIp, userAgent, organizationId, hospitalId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    awarenessList.forEach(a => insertAware.run(a.id || makeId('aware'), a.employeeId, a.quarter || '', a.posterVersion || 'v1', a.posterUrl || '/assets/tld_awareness_hindi.jpg', a.statementText || '', a.acknowledgedAt || nowISO(), a.signedIp || '', a.userAgent || '', a.organizationId || '', a.hospitalId || ''));

    const ackList = Array.isArray(data.acknowledgements) ? data.acknowledgements : [];
    const insertAck = db.prepare('INSERT OR REPLACE INTO acknowledgements (id, employeeId, period, quarter, acknowledgedAt, signerName, signatureData, signedAt, signedIp, statementText) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    if (Array.isArray(ackList)) {
      if (ackList.length && !Array.isArray(ackList[0]) && typeof ackList[0] === 'object') {
        ackList.forEach(ack => insertAck.run(ack.id || makeId('ack'), ack.employeeId, ack.period || '', ack.quarter || ack.period || '', ack.acknowledgedAt || nowISO(), ack.signerName || '', ack.signatureData || '', ack.signedAt || ack.acknowledgedAt || nowISO(), ack.signedIp || '', ack.statementText || ''));
      }
    }

    if (data.acknowledgements && !Array.isArray(data.acknowledgements) && typeof data.acknowledgements === 'object') {
      Object.entries(data.acknowledgements).forEach(([key, checked]) => {
        if (!checked) return;
        const [employeeId, quarter] = key.split('|');
        insertAck.run(makeId('ack'), employeeId, quarter || '', quarter || '', nowISO(), '', '', nowISO(), '', '');
      });
    }

    if (Array.isArray(data.attachments)) {
      data.attachments.forEach(att => insertAttachmentFromBackup(att, req));
    }

    if (Array.isArray(data.investigations)) {
      const insertInv = db.prepare(`INSERT OR REPLACE INTO investigations (id, doseId, employeeId, quarter, period, severity, status, rsoNote, rootCause, immediateAction, correctiveAction, closureStatus, rsoSignerName, rsoSignatureData, openedBy, createdAt, updatedAt, closedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.investigations.forEach(inv => insertInv.run(inv.id || makeId('inv'), inv.doseId, inv.employeeId, inv.quarter || '', inv.period || '', inv.severity || 'Investigate', inv.status || 'Open', inv.rsoNote || '', inv.rootCause || '', inv.immediateAction || '', inv.correctiveAction || '', inv.closureStatus || '', inv.rsoSignerName || '', inv.rsoSignatureData || '', inv.openedBy || '', inv.createdAt || nowISO(), inv.updatedAt || nowISO(), inv.closedAt || null));
    }

    if (Array.isArray(data.overexposureCases)) {
      const insertCase = db.prepare(`INSERT OR REPLACE INTO overexposure_cases (id, employeeId, doseId, incidentDate, incidentType, doseReportQuarter, receivedDose, doseUnit, doseType, severity, status, reportReference, incidentSummary, suspectedCause, immediateAction, medicalReview, actionTaken, correctiveAction, preventiveAction, regulatoryReportRequired, reportedTo, regulatoryReportDate, rscReviewDate, closureNote, closedBy, rsoSignerName, rsoSignatureData, employeeSignerName, employeeAcknowledgementText, employeeSignatureData, employeeSignedAt, openedBy, organizationId, hospitalId, createdAt, updatedAt, closedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.overexposureCases.forEach(c => insertCase.run(c.id || makeId('case'), c.employeeId, c.doseId || null, c.incidentDate || '', c.incidentType || 'Suspected overexposure', c.doseReportQuarter || '', Number(c.receivedDose || 0), c.doseUnit || 'mSv', c.doseType || 'Hp(10)', c.severity || 'Investigate', c.status || 'Open', c.reportReference || '', c.incidentSummary || '', c.suspectedCause || '', c.immediateAction || '', c.medicalReview || '', c.actionTaken || '', c.correctiveAction || '', c.preventiveAction || '', boolToInt(c.regulatoryReportRequired), c.reportedTo || '', c.regulatoryReportDate || '', c.rscReviewDate || '', c.closureNote || '', c.closedBy || '', c.rsoSignerName || '', c.rsoSignatureData || '', c.employeeSignerName || '', c.employeeAcknowledgementText || '', c.employeeSignatureData || '', c.employeeSignedAt || null, c.openedBy || '', c.organizationId || '', c.hospitalId || '', c.createdAt || nowISO(), c.updatedAt || nowISO(), c.closedAt || null));
    }

    if (Array.isArray(data.reminderLogs)) {
      const insertRem = db.prepare(`INSERT OR REPLACE INTO reminder_logs (id, reminderType, quarter, channel, recipientEmployeeId, recipientName, destination, subject, message, status, providerResponse, createdAt, sentAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.reminderLogs.forEach(r => insertRem.run(r.id || makeId('rem'), r.reminderType || 'unknown', r.quarter || '', r.channel || '', r.recipientEmployeeId || null, r.recipientName || '', r.destination || '', r.subject || '', r.message || '', r.status || 'imported', r.providerResponse || '', r.createdAt || nowISO(), r.sentAt || null));
    }

    if (Array.isArray(data.notifications)) {
      const insertNot = db.prepare(`INSERT OR REPLACE INTO notifications (id, subject, message, audience, targetEmployeeId, channels, createdBy, createdByName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.notifications.forEach(n => insertNot.run(n.id || makeId('not'), n.subject || 'Notification', n.message || '', n.audience || 'allTldUsers', n.targetEmployeeId || null, n.channels || '["portal"]', n.createdBy || null, n.createdByName || '', n.createdAt || nowISO()));
    }
    if (Array.isArray(data.notificationRecipients)) {
      const insertNotRec = db.prepare(`INSERT OR REPLACE INTO notification_recipients (id, notificationId, employeeId, employeeName, channel, destination, status, providerResponse, readAt, createdAt, sentAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.notificationRecipients.forEach(r => insertNotRec.run(r.id || makeId('notrec'), r.notificationId, r.employeeId, r.employeeName || '', r.channel || 'portal', r.destination || '', r.status || 'imported', r.providerResponse || '', r.readAt || null, r.createdAt || nowISO(), r.sentAt || null));
    }
    if (Array.isArray(data.rscMembers)) {
      const insertMember = db.prepare(`INSERT OR REPLACE INTO rsc_members (id, name, designation, department, committeeRole, email, phone, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.rscMembers.forEach(m => insertMember.run(m.id || makeId('rscm'), m.name || 'Unnamed Member', m.designation || '', m.department || '', m.committeeRole || '', m.email || '', m.phone || '', boolToInt(m.active !== false), m.createdAt || nowISO(), m.updatedAt || nowISO()));
    }
    if (Array.isArray(data.rscMeetings)) {
      const insertMeeting = db.prepare(`INSERT OR REPLACE INTO rsc_meetings (id, meetingDate, title, venue, chairperson, agenda, minutes, decisions, actionItems, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.rscMeetings.forEach(m => insertMeeting.run(m.id || makeId('rscmtg'), m.meetingDate || nowISO().slice(0, 10), m.title || 'Radiation Safety Committee Meeting', m.venue || '', m.chairperson || '', m.agenda || '', m.minutes || '', m.decisions || '', m.actionItems || '', m.status || 'Draft', m.createdAt || nowISO(), m.updatedAt || nowISO()));
    }
    if (Array.isArray(data.rscDocuments)) {
      const insertDoc = db.prepare(`INSERT OR REPLACE INTO rsc_documents (id, meetingId, documentType, title, description, originalName, storedName, mimeType, size, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      data.rscDocuments.forEach(doc => {
        let storedName = doc.storedName || '';
        let size = Number(doc.size || 0);
        let mimeType = doc.mimeType || 'application/octet-stream';
        if (doc.dataUrl) {
          const decoded = decodeDataUrl(doc.dataUrl);
          if (decoded) {
            mimeType = decoded.mimeType || mimeType;
            size = decoded.buffer.length;
            const ext = path.extname(doc.originalName || 'rsc_document.bin').slice(0, 16);
            storedName = `${Date.now()}_${crypto.randomBytes(10).toString('hex')}${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, storedName), decoded.buffer);
          }
        }
        if (storedName) insertDoc.run(doc.id || makeId('rscdoc'), doc.meetingId || null, doc.documentType || 'Minutes of Meeting', doc.title || '', doc.description || '', doc.originalName || 'rsc_document.bin', storedName, mimeType, size, doc.uploadedBy || '', doc.createdAt || nowISO());
      });
    }
  });
  tx();
  
function ensureRadproSysadmin() {
  const ts = nowISO();
  const existing = db.prepare('SELECT * FROM employees WHERE username=?').get('radpro');
  if (existing) {
    db.prepare(`UPDATE employees SET accessRole='sysadmin', role='Radpro Super Admin', enabled=1, isRSO=1, updatedAt=? WHERE username=?`).run(ts, 'radpro');
    return;
  }
  const org = db.prepare('SELECT id FROM organizations ORDER BY createdAt LIMIT 1').get();
  const hosp = org ? db.prepare('SELECT id FROM hospitals WHERE organizationId=? ORDER BY createdAt LIMIT 1').get(org.id) : null;
  db.prepare(`INSERT INTO employees (id, name, dept, role, tldNumber, email, phone, accessRole, twoFactorEnabled, username, passwordHash, enabled, isRSO, organizationId, hospitalId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('sys_radpro', 'Radpro Panel Admin', 'Radpro Technologies', 'Radpro Super Admin', 'RADPRO', '', '', 'sysadmin', 0, 'radpro', bcrypt.hashSync('radpro123', 10), 1, 1, org ? org.id : '', hosp ? hosp.id : '', ts, ts);
}
ensureDefaultTenancy();
ensureDemoRSO();
ensureRadproSysadmin();
ensureDefaultTenancy();
  logAudit(req, 'Backup restored', `${data.employees.length} employees imported`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Radpro TLD Monitoring running on http://localhost:${PORT}`);
  let pgTarget = 'configured';
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    pgTarget = `${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '') || 'postgres'}`;
  } catch (_) {}
  console.log(`Database: PostgreSQL (${pgTarget})`);
  console.log(`Uploads: ${UPLOAD_DIR}`);
  logCloudStabilityStartup();
});

function currentQuarterLabelServer(date = new Date()) {
  return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
}

async function runAutomatedReminderSweep() {
  const quarter = currentQuarterLabelServer();
  const preview = buildReminderPreview(quarter).filter(r => ['missingForm', 'acknowledgement', 'reportUpload'].includes(r.type));
  let count = 0;
  for (const item of preview) {
    await logAndSendReminder({ type: item.type, quarter, employee: item.employee, subject: item.subject, message: item.message, channels: ['email', 'whatsapp'] });
    count += 1;
  }
  logSystem('Automated reminder sweep', `${quarter}: ${count} target(s)`);
}

if (AUTO_REMINDERS_ENABLED) {
  setTimeout(() => runAutomatedReminderSweep().catch(err => logSystem('Automated reminder error', err.message)), 60 * 1000);
  setInterval(() => runAutomatedReminderSweep().catch(err => logSystem('Automated reminder error', err.message)), Math.max(1, REMINDER_INTERVAL_HOURS) * 60 * 60 * 1000);
}
